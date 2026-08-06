import { Pool } from "pg";
import { Storable, StorableConstructor, Storage, StorageListOptions, StorageQuery } from "@padloc/core/src/storage";
import { ConfigParam } from "@padloc/core/src/config";
import { Config } from "@padloc/core/src/config";
import { Err, ErrorCode } from "@padloc/core/src/error";
import { readFileSync } from "fs";
import { resolve } from "path";

export class PostgresConfig extends Config {
    @ConfigParam()
    host: string = "localhost";

    @ConfigParam()
    user!: string;

    @ConfigParam("string", true)
    password!: string;

    @ConfigParam("number")
    port: number = 5432;

    @ConfigParam()
    database = "padloc";

    @ConfigParam("boolean")
    tls?: boolean;

    @ConfigParam()
    tlsCAFile?: string;

    @ConfigParam()
    tlsCAFileContents?: string;

    @ConfigParam("boolean")
    tlsRejectUnauthorized?: boolean = true;
}

// SECURITY: `path`/`orderBy` ultimately come from client-controlled
// `ListParams` (via listAccounts/listOrgs/listChangeLogEntries/
// listRequestLogEntries, all admin-gated but still untrusted input) and
// used to be interpolated directly into the SQL string. `assertSafeKey`
// restricts every path segment to a safe identifier shape before it is
// ever concatenated into a query, and `queryToSQL` now binds `value` as a
// real parameterized placeholder instead of a quoted string literal.
const SAFE_KEY = /^[a-zA-Z0-9_]+$/;

function assertSafeKey(key: string) {
    if (typeof key !== "string" || !SAFE_KEY.test(key)) {
        throw new Err(ErrorCode.BAD_REQUEST, `Invalid query field: ${JSON.stringify(key)}`);
    }
}

function toJsonbPath(path: string) {
    const pathParts = path.split(".");
    pathParts.forEach(assertSafeKey);
    return (
        "data" +
        pathParts
            .slice(0, -1)
            .map((part) => `->'${part}'`)
            .join("") +
        `->>'${pathParts[pathParts.length - 1]}'`
    );
}

const QUERY_OPERATORS: Record<string, string> = {
    eq: "=",
    ne: "!=",
    gt: ">",
    lt: "<",
    gte: ">=",
    lte: "<=",
    regex: "~*",
    negex: "!~*",
};

function queryToSQL(query: StorageQuery, params: unknown[]): string {
    switch (query.op) {
        case "and":
            return `(${query.queries.map((q) => queryToSQL(q, params)).join(" AND ")})`;
        case "or":
            return `(${query.queries.map((q) => queryToSQL(q, params)).join(" OR ")})`;
        case "not":
            return `NOT (${queryToSQL(query.query, params)})`;
        default: {
            const op = QUERY_OPERATORS[query.op || "eq"];
            if (!op) {
                throw new Err(ErrorCode.BAD_REQUEST, `Unsupported query operator: ${JSON.stringify(query.op)}`);
            }
            switch (typeof query.value) {
                case "string":
                case "boolean":
                case "number":
                    params.push(query.value.toString());
                    return `${toJsonbPath(query.path)} ${op} $${params.length}`;
                default:
                    return `${toJsonbPath(query.path)} IS NULL`;
            }
        }
    }
}

export class PostgresStorage implements Storage {
    private _pool: Pool;

    private _ensuredTables = new Map<string, Promise<void>>();

    constructor(public config: PostgresConfig) {
        const { host, user, password, port, database, tls, tlsCAFile, tlsCAFileContents, tlsRejectUnauthorized } =
            config;
        const tlsCAFilePath = tlsCAFile && resolve(process.cwd(), tlsCAFile);
        const ca = tlsCAFileContents || (tlsCAFilePath && readFileSync(tlsCAFilePath).toString());
        this._pool = new Pool({
            host,
            user,
            password,
            port,
            database,
            ssl: tls
                ? {
                      rejectUnauthorized: tlsRejectUnauthorized,
                      ca,
                  }
                : undefined,
        });
    }

    private _ensureTable(kind: string) {
        if (!this._ensuredTables.has(kind)) {
            this._ensuredTables.set(
                kind,
                this._pool
                    .query(
                        `
                            CREATE TABLE IF NOT EXISTS ${kind} (
                                id text PRIMARY KEY,
                                data jsonb NOT NULL
                            )
                        `
                    )
                    .then(() => {})
            );
        }
        return this._ensuredTables.get(kind);
    }

    async save<T extends Storable>(obj: T): Promise<void> {
        await this._ensureTable(obj.kind);
        await this._pool.query(
            `
            INSERT INTO ${obj.kind} (id, data) values($1, $2) ON CONFLICT (id) DO
                UPDATE SET data=$2
        `,
            [obj.id, obj.toRaw()]
        );
    }

    async get<T extends Storable>(cls: T | StorableConstructor<T>, id: string): Promise<T> {
        const res = cls instanceof Storable ? cls : new cls();
        await this._ensureTable(res.kind);
        const {
            rows: [row],
        } = await this._pool.query(`SELECT data FROM ${res.kind} WHERE id=$1`, [id]);
        if (!row) {
            throw new Err(ErrorCode.NOT_FOUND, `Cannot find object: ${res.kind}_${id}`);
        }
        return res.fromRaw(row.data);
    }

    async delete<T extends Storable>(obj: T): Promise<void> {
        await this._ensureTable(obj.kind);
        await this._pool.query(`DELETE FROM ${obj.kind} WHERE id=$1`, [obj.id]);
    }

    clear(): Promise<void> {
        throw new Error("Method not implemented.");
    }

    async list<T extends Storable>(
        cls: StorableConstructor<T>,
        { limit, offset, query: where, orderBy, orderByDirection = "asc" }: StorageListOptions = {}
    ): Promise<T[]> {
        const kind = new cls().kind;
        await this._ensureTable(kind);

        const params: unknown[] = [];
        let query = `SELECT data FROM ${kind}`;

        if (where) {
            query += ` WHERE ${queryToSQL(where, params)}`;
        }

        if (orderBy) {
            // orderByDirection is validated (not interpolated as-is) since
            // it's client-controlled and would otherwise be a second SQL
            // injection point alongside the path itself.
            const direction = orderByDirection === "desc" ? "DESC" : "ASC";
            query += ` ORDER BY ${toJsonbPath(orderBy)} ${direction}`;
        }

        if (offset) {
            if (!Number.isInteger(offset) || offset < 0) {
                throw new Err(ErrorCode.BAD_REQUEST, "Invalid offset.");
            }
            query += ` OFFSET ${offset}`;
        }

        if (limit) {
            if (!Number.isInteger(limit) || limit < 0) {
                throw new Err(ErrorCode.BAD_REQUEST, "Invalid limit.");
            }
            query += ` LIMIT ${limit}`;
        }

        const { rows } = await this._pool.query(query, params);
        return rows.map((row) => new cls().fromRaw(row.data));
    }

    async count<T extends Storable>(cls: StorableConstructor<T>, query?: StorageQuery) {
        const kind = new cls().kind;
        await this._ensureTable(kind);
        const params: unknown[] = [];
        const sql = `SELECT COUNT(*) FROM ${kind}${query ? ` WHERE ${queryToSQL(query, params)}` : ""}`;
        const {
            rows: [{ count }],
        } = await this._pool.query(sql, params);
        return Number(count);
    }
}
