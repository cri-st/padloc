import { DurableObject } from "cloudflare:workers";
import { Env } from "../env";

/**
 * ShareLinkDO -- per-share Durable Object backing one-time, expiring
 * password share links (openspec/changes/share-password). One instance per
 * share id (keyed via `idFromName` in `storage/share-do-storage.ts`),
 * invoked as an RPC stub. Extends the runtime's `DurableObject` base class
 * (from `cloudflare:workers`) -- required for stub method calls to use RPC
 * at all; a plain class (as `locks/account-lock.ts` uses) throws
 * "does not support RPC... class was not declared with `extends
 * DurableObject`" the moment a real caller invokes a stub method. It does
 * NOT extend `@padloc/core`'s `Config`/`Serializable` and uses none of its
 * decorators -- see
 * `~/.omp/agent/managed-skills/padloc-worker-decorator-tsconfig-crash` for
 * why mixing those into a worker-local class crashes the whole isolate at
 * startup. This class only ever sees opaque ciphertext bytes and a raw JSON
 * string for encryption params; `@padloc/core` types are translated at the
 * `DurableObjectShareStorage` boundary, keeping `packages/core`
 * platform-agnostic.
 *
 * Storage is SQLite-backed (`new_sqlite_classes` migration in
 * `wrangler.toml`), one singleton row per DO instance. Single-view
 * atomicity is structural, not merely SQL-level: `SqlStorage.exec()` is
 * synchronous and every RPC call into a DO instance is handled on a single
 * thread, so the `UPDATE ... RETURNING` in `reveal()` runs to completion
 * before a second concurrent `reveal()` call can begin -- exactly one
 * caller ever observes a non-empty result set. `alarm()` provides
 * best-effort storage cleanup once the TTL elapses, but correctness never
 * depends on its timing: `peek()`, `reveal()`, and `getStatus()` all
 * independently re-check `expiresAt` against the current wall clock first.
 */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS share (
    id INTEGER PRIMARY KEY CHECK (id = 0),
    owner TEXT NOT NULL,
    encrypted_data BLOB NOT NULL,
    encryption_params_json TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    viewed INTEGER NOT NULL DEFAULT 0,
    viewed_at INTEGER,
    revoked INTEGER NOT NULL DEFAULT 0
)`;

const UPSERT_SHARE = `
INSERT INTO share (id, owner, encrypted_data, encryption_params_json, created_at, expires_at, viewed, viewed_at, revoked)
VALUES (0, ?, ?, ?, ?, ?, 0, NULL, 0)
ON CONFLICT(id) DO UPDATE SET
    owner = excluded.owner,
    encrypted_data = excluded.encrypted_data,
    encryption_params_json = excluded.encryption_params_json,
    created_at = excluded.created_at,
    expires_at = excluded.expires_at,
    viewed = 0,
    viewed_at = NULL,
    revoked = 0`;

const SELECT_SHARE = `SELECT * FROM share WHERE id = 0`;

const REVEAL_SHARE = `
UPDATE share SET viewed = 1, viewed_at = ?
WHERE id = 0 AND viewed = 0 AND revoked = 0 AND expires_at > ?
RETURNING encrypted_data, encryption_params_json`;

const REVOKE_SHARE = `UPDATE share SET revoked = 1 WHERE id = 0 AND viewed = 0`;

const DELETE_EXPIRED_SHARE = `DELETE FROM share WHERE id = 0 AND expires_at <= ?`;

export interface CreateShareInput {
    owner: string;
    encryptedData: Uint8Array;
    encryptionParamsJson: string;
    ttlSeconds: number;
}

export interface SharePeekResult {
    expired: boolean;
    viewed: boolean;
    revoked: boolean;
}

export interface ShareRevealResult {
    encryptedData: Uint8Array;
    encryptionParamsJson: string;
}

export interface ShareStatusResult {
    expired: boolean;
    viewed: boolean;
    viewedAt: number | null;
    revoked: boolean;
}

interface ShareRow {
    id: number;
    owner: string;
    encrypted_data: ArrayBuffer;
    encryption_params_json: string;
    created_at: number;
    expires_at: number;
    viewed: number;
    viewed_at: number | null;
    revoked: number;
}

export class ShareLinkDO extends DurableObject<Env> {
    private sql: SqlStorage;

    constructor(state: DurableObjectState, env: Env) {
        super(state, env);
        this.sql = state.storage.sql;
        this.sql.exec(SCHEMA);
    }

    /** Persists the (single) share for this DO instance. Overwrites any prior row. */
    async create(input: CreateShareInput): Promise<void> {
        const now = Date.now();
        const expiresAt = now + input.ttlSeconds * 1000;

        this.sql.exec(
            UPSERT_SHARE,
            input.owner,
            input.encryptedData,
            input.encryptionParamsJson,
            now,
            expiresAt
        );

        await this.ctx.storage.setAlarm(expiresAt);
    }

    /** Non-destructive lookup for anonymous page loads. MUST NOT burn the view. */
    async peek(): Promise<SharePeekResult | null> {
        const row = this._getRow();
        if (!row) {
            return null;
        }
        return { expired: Date.now() >= row.expires_at, viewed: !!row.viewed, revoked: !!row.revoked };
    }

    /**
     * Atomically flips the share to "viewed" and returns its ciphertext.
     * Returns `null` if the share is missing, already viewed, revoked, or
     * expired -- callers cannot distinguish these from the return value
     * alone; use `peek()`/`getStatus()` beforehand to report why.
     */
    async reveal(): Promise<ShareRevealResult | null> {
        const now = Date.now();

        const rows = this.sql
            .exec(REVEAL_SHARE, now, now)
            .toArray() as unknown as Pick<ShareRow, "encrypted_data" | "encryption_params_json">[];

        if (rows.length === 0) {
            return null;
        }

        return {
            encryptedData: new Uint8Array(rows[0].encrypted_data),
            encryptionParamsJson: rows[0].encryption_params_json,
        };
    }

    /** Owner-facing status lookup, including the view receipt. */
    async getStatus(owner: string): Promise<ShareStatusResult | null> {
        const row = this._getRow();
        if (!row || row.owner !== owner) {
            return null;
        }
        return {
            expired: Date.now() >= row.expires_at,
            viewed: !!row.viewed,
            viewedAt: row.viewed_at,
            revoked: !!row.revoked,
        };
    }

    /** Revokes an unviewed share. Returns `false` if there was nothing to revoke. */
    async revoke(owner: string): Promise<boolean> {
        const row = this._getRow();
        if (!row || row.owner !== owner || row.viewed) {
            return false;
        }

        this.sql.exec(REVOKE_SHARE);
        return true;
    }

    /**
     * Fires once the TTL elapses (scheduled by `create()`). Best-effort
     * storage cleanup -- correctness of `peek`/`reveal`/`getStatus` never
     * depends on this having run yet.
     */
    async alarm(): Promise<void> {
        this.sql.exec(DELETE_EXPIRED_SHARE, Date.now());
    }

    private _getRow(): ShareRow | null {
        const rows = this.sql.exec(SELECT_SHARE).toArray() as unknown as ShareRow[];
        return rows[0] ?? null;
    }
}

/** Stub returned by DurableObjectNamespace.get() for ShareLinkDO. */
export interface ShareLinkStub {
    create(input: CreateShareInput): Promise<void>;
    peek(): Promise<SharePeekResult | null>;
    reveal(): Promise<ShareRevealResult | null>;
    getStatus(owner: string): Promise<ShareStatusResult | null>;
    revoke(owner: string): Promise<boolean>;
}
