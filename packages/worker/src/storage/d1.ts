/**
 * D1Storage — SQLite storage via Drizzle ORM.
 *
 * Implements the @padloc/core Storage interface:
 *   save / get / delete / clear / list / count
 *
 * Serialization strategy:
 *   Each Storable's full toRaw() JSON lives in the `data` column.
 *   Domain tables declare additional denormalized columns for indexed lookups;
 *   the authoritative payload is always `data`.
 *
 * Transactional writes use db.batch() for atomic multi-row writes.
 */
import { eq, and, or, not, asc, desc, sql, SQLWrapper, getTableName } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { SQLiteColumn } from "drizzle-orm/sqlite-core";

import { Storable, StorableConstructor, Storage, StorageListOptions, StorageQuery } from "@padloc/core/src/storage";
import { Err, ErrorCode } from "@padloc/core/src/error";
import { hexToBytes } from "@padloc/core/src/encoding";

import {
    accounts,
    auth,
    sessions,
    vaults,
    orgs,
    orgMembers,
    invites,
    keyStoreEntries,
    attachments,
    emailVerifications,
    changeLog,
    requestLog,
} from "./schema";

// ──────────────────────────────────────────────────────────────
// Table map — kind → Drizzle table
// ──────────────────────────────────────────────────────────────

const TABLES = {
    account: accounts,
    session: sessions,
    vault: vaults,
    org: orgs,
    orgmember: orgMembers,
    invite: invites,
    keystoreentry: keyStoreEntries,
    attachment: attachments,
    emailverification: emailVerifications,
    auth: auth,
    changelog: changeLog,
    requestlog: requestLog,
} as const;

type KnownKind = keyof typeof TABLES;

/** Convert a BigInteger session key to Uint8Array so @AsBytes() serializes correctly */
function normalizeSessionKey(obj: Storable): void {
    if (obj.kind === "session") {
        const key = (obj as any).key;
        if (key && !(key instanceof Uint8Array)) {
            const hex = key.toString(16);
            (obj as any).key = hexToBytes(hex.length % 2 ? "0" + hex : hex);
        }
    }
}

function tableFor(kind: string): (typeof TABLES)[KnownKind] {
    const canonical = kind.toLowerCase() as KnownKind;
    const tbl = TABLES[canonical];
    if (!tbl) {
        throw new Err(ErrorCode.NOT_FOUND, `D1 storage: unknown table for kind "${kind}"`);
    }
    return tbl;
}

// ──────────────────────────────────────────────────────────────
// getTableColumns helper — extract column map from a Drizzle table
// ──────────────────────────────────────────────────────────────

function getTableColumns(tbl: (typeof TABLES)[KnownKind]): Record<string, SQLiteColumn> {
    return tbl as any as Record<string, SQLiteColumn>;
}

// ──────────────────────────────────────────────────────────────
// Query builder: StorageQuery → Drizzle SQL
// ──────────────────────────────────────────────────────────────

/** Build WHERE clause for any StorageQuery */
function buildWhere<T extends (typeof TABLES)[KnownKind]>(table: T, query: StorageQuery): SQLWrapper {
    const cols = getTableColumns(table);
    switch (query.op) {
        case "and":
            return and(...query.queries.map((q) => buildWhere(table, q)))!;
        case "or":
            return or(...query.queries.map((q) => buildWhere(table, q)))!;
        case "not":
            return not(buildWhere(table, query.query));
        case "regex": {
            const col = resolveSqlColumn(cols, query.path);
            return sql`${col} REGEXP ${query.value}`;
        }
        case "negex": {
            const col = resolveSqlColumn(cols, query.path);
            return sql`NOT (${col} REGEXP ${query.value})`;
        }
        case "gt": {
            const col = resolveSqlColumn(cols, query.path);
            return sql`${col} > ${query.value}`;
        }
        case "gte": {
            const col = resolveSqlColumn(cols, query.path);
            return sql`${col} >= ${query.value}`;
        }
        case "lt": {
            const col = resolveSqlColumn(cols, query.path);
            return sql`${col} < ${query.value}`;
        }
        case "lte": {
            const col = resolveSqlColumn(cols, query.path);
            return sql`${col} <= ${query.value}`;
        }
        case "ne": {
            const col = resolveSqlColumn(cols, query.path);
            return sql`${col} <> ${query.value}`;
        }
        default: {
            if (query.value === null || query.value === undefined) {
                const col = resolveSqlColumn(cols, query.path);
                return sql`${col} IS NULL`;
            }
            const col = resolveSqlColumn(cols, query.path);
            return sql`${col} = ${query.value}`;
        }
    }
}

/** Resolve path to a Drizzle column (or SQL fallback for nested json fields) */
function resolveSqlColumn(cols: Record<string, SQLiteColumn>, path: string): SQLiteColumn | SQLWrapper {
    const parts = path.split(".");
    const topLevel = parts[0].toLowerCase();
    if (cols[topLevel]) {
        return cols[topLevel];
    }
    return sql`json_extract(data, ${`$.${parts.join(".")}`})`;
}

// ──────────────────────────────────────────────────────────────
// D1Storage
// ──────────────────────────────────────────────────────────────

export class D1Storage implements Storage {
    private db: ReturnType<typeof drizzle>;

    constructor(d1Database: any) {
        this.db = drizzle(d1Database);
    }

    get client() {
        return this.db;
    }

    // save

    async save<T extends Storable>(obj: T): Promise<void> {
        normalizeSessionKey(obj);
        const tbl = tableFor(obj.kind);
        const raw = obj.toRaw();

        try {
            if (obj.kind === "orgmember") {
                await this.saveOrgMember(tbl as typeof orgMembers, raw);
            } else {
                // Drizzle's onConflictDoUpdate generates ON CONFLICT("id") which
                // D1's SQLite rejects. Use raw SQL via the underlying D1 client.
                // Also extract denormalized columns from the raw data for indexed lookups.
                const tableName = getTableName(tbl);
                const email = (raw as any).email || null;
                const createdAt = (raw as any).created || (raw as any).created_at || new Date().toISOString();
                const updatedAt = (raw as any).updated || (raw as any).updated_at || new Date().toISOString();

                let stmt: string;
                let bindings: unknown[];

                if (tableName === "accounts") {
                    stmt = `INSERT INTO ${tableName} (id, email, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET email = ?, data = ?, updated_at = ?`;
                    bindings = [
                        obj.id,
                        email,
                        JSON.stringify(raw),
                        createdAt,
                        updatedAt,
                        email,
                        JSON.stringify(raw),
                        updatedAt,
                    ];
                } else if (tableName === "auth") {
                    const accountId = (raw as any).account || (raw as any).account_id || "";
                    stmt = `INSERT INTO ${tableName} (id, account_id, email, data, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET account_id = ?, email = ?, data = ?, updated_at = ?`;
                    bindings = [
                        obj.id,
                        accountId,
                        email,
                        JSON.stringify(raw),
                        updatedAt,
                        accountId,
                        email,
                        JSON.stringify(raw),
                        updatedAt,
                    ];
                } else if (tableName === "sessions") {
                    const accountId = (raw as any).account || (raw as any).account_id || "";
                    const keyBlob = (raw as any).key || "";
                    const expiresAt = (raw as any).expires ? new Date(raw.expires).toISOString() : "";
                    const lastUsedAt = (raw as any).lastUsed
                        ? new Date(raw.lastUsed).toISOString()
                        : new Date().toISOString();
                    const deviceJson = (raw as any).device ? JSON.stringify(raw.device) : null;
                    const dataJson = JSON.stringify(raw);
                    stmt = `INSERT INTO ${tableName} (id, account_id, data, key_blob, expires_at, last_used_at, device_json) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET account_id = ?, data = ?, key_blob = ?, expires_at = ?, last_used_at = ?, device_json = ?`;
                    bindings = [
                        obj.id,
                        accountId,
                        dataJson,
                        keyBlob,
                        expiresAt,
                        lastUsedAt,
                        deviceJson,
                        accountId,
                        dataJson,
                        keyBlob,
                        expiresAt,
                        lastUsedAt,
                        deviceJson,
                    ];
                } else if (tableName === "vaults") {
                    const ownerId = (raw as any).owner || "";
                    const orgId = (raw as any).org?.id || null;
                    const revision = (raw as any).revision || "";
                    stmt = `INSERT INTO ${tableName} (id, owner_account_id, org_id, data, revision, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET owner_account_id = ?, org_id = ?, data = ?, revision = ?, updated_at = ?`;
                    bindings = [
                        obj.id,
                        ownerId,
                        orgId,
                        JSON.stringify(raw),
                        revision,
                        updatedAt,
                        ownerId,
                        orgId,
                        JSON.stringify(raw),
                        revision,
                        updatedAt,
                    ];
                } else if (tableName === "orgs") {
                    const ownerId = (raw as any).owner?.accountId || (raw as any).owner_account_id || "";
                    const revision = (raw as any).revision || "";
                    stmt = `INSERT INTO ${tableName} (id, name, owner_account_id, data, revision) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET name = ?, owner_account_id = ?, data = ?, revision = ?`;
                    const orgName = (raw as any).name || "";
                    bindings = [
                        obj.id,
                        orgName,
                        ownerId,
                        JSON.stringify(raw),
                        revision,
                        orgName,
                        ownerId,
                        JSON.stringify(raw),
                        revision,
                    ];
                } else if (tableName === "key_store_entries") {
                    // key_store_entries.account_id is NOT NULL -- the generic
                    // fallback below only writes (id, data), which fails the
                    // constraint when the app saves a biometric-unlock key.
                    const accountId = (raw as any).accountId || (raw as any).account_id || "";
                    stmt = `INSERT INTO ${tableName} (id, account_id, data) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET account_id = ?, data = ?`;
                    bindings = [obj.id, accountId, JSON.stringify(raw), accountId, JSON.stringify(raw)];
                } else {
                    // Generic fallback: just id and data
                    stmt = `INSERT INTO ${tableName} (id, data) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET data = ?`;
                    bindings = [obj.id, JSON.stringify(raw), JSON.stringify(raw)];
                }

                const d1Client = (this.db as any).session.client;
                await d1Client
                    .prepare(stmt)
                    .bind(...bindings)
                    .run();
            }
        } catch (err: any) {
            if (isUniqueViolation(err)) {
                throw new Err(ErrorCode.ACCOUNT_EXISTS, `Duplicate entry for ${obj.kind}: ${obj.id}`, {
                    error: err,
                });
            }
            throw new Err(ErrorCode.SERVER_ERROR, `D1 storage save failed: ${err.message}`, { error: err });
        }
    }

    private async saveOrgMember(tbl: typeof orgMembers, raw: any) {
        const orgId = raw.orgId ?? raw.org_id;
        const accountId = raw.accountId ?? raw.account_id;

        await this.db
            .insert(tbl)
            .values({
                org_id: orgId,
                account_id: accountId,
                role: raw.role,
                status: raw.status,
            })
            .onConflictDoUpdate({
                target: [tbl.org_id, tbl.account_id],
                set: { role: raw.role, status: raw.status },
            });
    }

    // get

    async get<T extends Storable>(cls: StorableConstructor<T> | T, id: string): Promise<T> {
        const res = cls instanceof Storable ? cls : new cls();
        const tbl = tableFor(res.kind);

        const results: Array<{ data: string }> = await this.db
            .select({ data: (tbl as any).data })
            .from(tbl)
            .where(eq((tbl as any).id, id))
            .limit(1);

        if (!results || results.length === 0) {
            throw new Err(ErrorCode.NOT_FOUND, `Cannot find object: ${res.kind}_${id}`);
        }

        try {
            return res.fromRaw(JSON.parse(results[0].data));
        } catch {
            throw new Err(ErrorCode.ENCODING_ERROR, `Failed to deserialize ${res.kind}_${id}`);
        }
    }

    // delete

    async delete<T extends Storable>(obj: T): Promise<void> {
        const tbl = tableFor(obj.kind);

        if (obj.kind === "orgmember") {
            const raw = obj.toRaw();
            const orgId = raw.orgId ?? raw.org_id;
            const accountId = raw.accountId ?? raw.account_id;
            await this.db
                .delete(tbl)
                .where(and(eq((tbl as any).org_id, orgId), eq((tbl as any).account_id, accountId)));
            return;
        }

        await this.db.delete(tbl).where(eq((tbl as any).id, obj.id));
    }

    // clear

    async clear(): Promise<void> {
        const domainKinds: KnownKind[] = [
            "account",
            "session",
            "vault",
            "org",
            "orgmember",
            "invite",
            "keystoreentry",
            "attachment",
            "emailverification",
            "auth",
        ];

        await this.db.batch(domainKinds.map((kind) => this.db.delete(TABLES[kind])) as any);
    }

    // list

    async list<T extends Storable>(cls: StorableConstructor<T>, opts: StorageListOptions = {}): Promise<T[]> {
        const kind = new cls().kind;
        const tbl = tableFor(kind);
        const cols = getTableColumns(tbl);
        const { offset = 0, limit: rowLimit, query: where, orderBy, orderByDirection = "asc" } = opts;

        let q: any = this.db.select({ data: (tbl as any).data }).from(tbl);

        if (where) {
            q = q.where(buildWhere(tbl, where));
        }

        if (orderBy) {
            const col = resolveSqlColumn(cols, orderBy);
            q = q.orderBy(orderByDirection === "desc" ? desc(col) : asc(col));
        }

        if (rowLimit && rowLimit !== Infinity) {
            q = q.limit(Number(rowLimit));
        }

        if (offset) {
            q = q.offset(Number(offset));
        }

        const results: Array<{ data: string }> = await q;
        return results.map((row) => new cls().fromRaw(JSON.parse(row.data)));
    }

    // count

    async count<T extends Storable>(cls: StorableConstructor<T>, query?: StorageQuery): Promise<number> {
        const kind = new cls().kind;
        const tbl = tableFor(kind);

        let q: any = this.db.select({ count: sql<number>`count(*)` }).from(tbl);

        if (query) {
            q = q.where(buildWhere(tbl, query));
        }

        const result = await q;
        return result[0]?.count ?? 0;
    }

    // batch write

    async saveBatch<T extends Storable>(objs: T[]): Promise<void> {
        const statements = objs.map((obj) => {
            const tbl = tableFor(obj.kind);
            const raw = obj.toRaw();

            if (obj.kind === "orgmember") {
                const orgId = raw.orgId ?? raw.org_id;
                const accountId = raw.accountId ?? raw.account_id;
                return this.db
                    .insert(tbl as typeof orgMembers)
                    .values({
                        org_id: orgId,
                        account_id: accountId,
                        role: raw.role,
                        status: raw.status,
                    })
                    .onConflictDoUpdate({
                        target: [(tbl as typeof orgMembers).org_id, (tbl as typeof orgMembers).account_id],
                        set: { role: raw.role, status: raw.status },
                    });
            }

            return this.db
                .insert(tbl)
                .values({ id: obj.id, data: JSON.stringify(raw) } as any)
                .onConflictDoUpdate({
                    target: "id" as any,
                    set: { data: JSON.stringify(raw) } as any,
                });
        });

        await this.db.batch(statements as any);
    }
}

// ──────────────────────────────────────────────────────────────
// Error helpers
// ──────────────────────────────────────────────────────────────

function isUniqueViolation(err: unknown): boolean {
    if (err && typeof err === "object") {
        const e = err as Record<string, unknown>;
        if ("code" in e) {
            const c = e.code;
            return c === "SQLITE_CONSTRAINT" || c === 2067 || String(c).includes("CONSTRAINT");
        }
        if ("message" in e) {
            return String(e.message).toLowerCase().includes("unique");
        }
    }
    return false;
}
