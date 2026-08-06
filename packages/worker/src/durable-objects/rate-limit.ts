import { DurableObject } from "cloudflare:workers";
import { Env } from "../env";

/**
 * RateLimitDO -- per-identity Durable Object providing a STRUCTURALLY
 * atomic token-bucket counter. One instance per rate-limited identity
 * (keyed via `idFromName` in `DurableObjectRateLimiter`, `rate-limiter.ts`),
 * invoked as an RPC stub. Extends the runtime's `DurableObject` base class
 * (from `cloudflare:workers`) -- required for stub method calls to use RPC
 * at all, exactly like `ShareLinkDO`. It does NOT extend `@padloc/core`'s
 * `Config`/`Serializable` and uses none of its decorators -- see
 * `~/.omp/agent/managed-skills/padloc-worker-decorator-tsconfig-crash` for
 * why mixing those into a worker-local class crashes the whole isolate at
 * startup.
 *
 * Security context: this DO exists because the original `RateLimiter`
 * (KV-backed, `rate-limiter.ts`) does a `get()` then a separate `put()` --
 * KV has no compare-and-swap, so two concurrent requests for the same
 * identity can both read the same token count before either write lands,
 * letting both through for the price of one token (found during the
 * share-password feature's security audit; see verify-report/archive for
 * the original write-up). A Durable Object closes this the same way
 * `ShareLinkDO` closes the equivalent race for single-view atomicity:
 * every RPC call into ONE DO instance is handled on a single thread, so a
 * second concurrent `consume()` call cannot begin until the first has
 * fully read, updated, and returned.
 *
 * Storage is SQLite-backed (`new_sqlite_classes` migration in
 * `wrangler.toml`), one singleton row per DO instance (per identity).
 */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS bucket (
    id INTEGER PRIMARY KEY CHECK (id = 0),
    tokens INTEGER NOT NULL,
    window_start INTEGER NOT NULL
)`;

const SELECT_BUCKET = `SELECT tokens, window_start FROM bucket WHERE id = 0`;

const RESET_BUCKET = `
INSERT INTO bucket (id, tokens, window_start) VALUES (0, ?, ?)
ON CONFLICT(id) DO UPDATE SET tokens = excluded.tokens, window_start = excluded.window_start`;

const DECREMENT_BUCKET = `UPDATE bucket SET tokens = tokens - 1 WHERE id = 0`;

export interface RateLimitConsumeResult {
    allowed: boolean;
    remaining: number;
    retryAfterMs?: number;
}

interface BucketRow {
    tokens: number;
    window_start: number;
}

export class RateLimitDO extends DurableObject<Env> {
    private sql: SqlStorage;

    constructor(state: DurableObjectState, env: Env) {
        super(state, env);
        this.sql = state.storage.sql;
        this.sql.exec(SCHEMA);
    }

    /**
     * Atomically checks and consumes one token for this identity's
     * current window, resetting the window if it has elapsed. The whole
     * read-decide-write sequence runs to completion within one DO call
     * before a second concurrent `consume()` can begin -- there is no
     * point where two callers can both observe the same pre-decrement
     * token count.
     */
    async consume(maxRequests: number, windowMs: number): Promise<RateLimitConsumeResult> {
        const now = Date.now();
        const row = this._getRow();

        if (!row || now - row.window_start >= windowMs) {
            this.sql.exec(RESET_BUCKET, maxRequests - 1, now);
            return { allowed: true, remaining: maxRequests - 1 };
        }

        if (row.tokens <= 0) {
            return { allowed: false, remaining: 0, retryAfterMs: windowMs - (now - row.window_start) };
        }

        this.sql.exec(DECREMENT_BUCKET);
        return { allowed: true, remaining: row.tokens - 1 };
    }

    private _getRow(): BucketRow | null {
        const rows = this.sql.exec(SELECT_BUCKET).toArray() as unknown as BucketRow[];
        return rows[0] ?? null;
    }
}

/** Stub returned by DurableObjectNamespace.get() for RateLimitDO. */
export interface RateLimitStub {
    consume(maxRequests: number, windowMs: number): Promise<RateLimitConsumeResult>;
}
