import { DurableObject } from "cloudflare:workers";
import { Env } from "../env";

/**
 * AccountLockDO — replaces the in-memory Map-based _requestQueue from
 * packages/core/src/server.ts:2188 with a Durable Object for per-account/
 * per-org request serialization.
 *
 * One DO class keyed by identity string (AccountID or OrgID). Each instance
 * maintains a FIFO deferred queue. acquire() resolves only when the previous
 * caller releases, so RPC callers that "own" the lock hold it until they call
 * release().
 *
 * MUST extend the runtime's `DurableObject` base class (from
 * `cloudflare:workers`) -- a plain class throws "does not support RPC...
 * class was not declared with `extends DurableObject`" the moment a REAL
 * caller (not a test's direct in-memory instantiation) invokes a stub
 * method through a namespace binding, exactly like `ShareLinkDO`/
 * `RateLimitDO`. This class keeps no Durable Object storage (pure
 * in-memory FIFO state), so it stays compatible with the existing
 * `new_classes` (non-SQLite) migration in `wrangler.toml`.
 */
export class AccountLockDO extends DurableObject<Env> {
    private _tail: Promise<void> = Promise.resolve();
    private _release: () => void = () => {};
    private _holder: string | null = null;
    // `setTimeout` returns a `number` handle in the Workers runtime (not
    // Node's `Timeout` object), so this is the concrete return type, not
    // an alias derived via `ReturnType<typeof setTimeout>`.
    private _timer: number | null = null;

    constructor(state: DurableObjectState, env: Env) {
        super(state, env);
    }

    /**
     * Wait until the previous holder has released the lock, then claim it.
     * Returns when the caller owns the lock.
     *
     * @param jobId Identifier for the lock holder (logging/telemetry).
     * @param ttlMs Maximum hold duration before auto-release.
     */
    async acquire(jobId: string, ttlMs: number): Promise<void> {
        // Register ourselves at the tail of the FIFO queue BEFORE awaiting,
        // capturing the PREVIOUS tail as the gate we must wait on. This
        // part is race-free on its own: each concurrent `acquire()` call's
        // synchronous prefix (up to its own `await`) runs to completion
        // without interruption, so the chain of `myTurn`/`myGate` promises
        // always links up in arrival order.
        const myTurn = this._tail;
        let releaseMe!: () => void;
        const myGate = new Promise<void>((res) => {
            releaseMe = res;
        });
        this._tail = myGate;

        // Wait for every previously-queued caller to finish.
        await myTurn;

        // We are now the exclusive current holder. Assigning `_holder`/
        // `_release` HERE -- after the await, not before -- is what makes
        // this race-free: only one `acquire()` call can be executing this
        // statement at a time (nothing else can resume between `await
        // myTurn` settling and this line running). The previous version
        // assigned these fields BEFORE the await, which let a LATER
        // concurrent `acquire()` call's synchronous prefix overwrite an
        // EARLIER caller's `_release`/`_holder` before the earlier caller
        // ever became the real holder -- the earlier caller's `release()`
        // then resolved the WRONG (most recently registered) caller's
        // gate, corrupting the FIFO order and permanently deadlocking
        // every ticket queued in between (confirmed live: a 15-way
        // concurrent `acquire()` burst hung the whole request past its
        // 30s test timeout before this fix).
        this._holder = jobId;
        this._release = releaseMe;
        this._timer = setTimeout(() => {
            if (this._holder === jobId) {
                this.release();
            }
        }, ttlMs);
    }

    /** Release the lock so the next queued caller may proceed. */
    async release(): Promise<void> {
        if (this._timer) {
            clearTimeout(this._timer);
            this._timer = null;
        }
        this._holder = null;
        const release = this._release;
        this._release = () => {};
        release();
    }

    /**
     * Extends the current holder's TTL without re-queuing (unlike calling
     * `acquire()` again, which would push the caller to the BACK of its
     * own queue and self-deadlock). Returns `false` (no-op) if `jobId` is
     * not the current holder -- e.g. it already lost the lock to the TTL
     * safety valve, or was never the holder to begin with.
     */
    async renew(jobId: string, ttlMs: number): Promise<boolean> {
        if (this._holder !== jobId) {
            return false;
        }
        clearTimeout(this._timer);
        this._timer = setTimeout(() => {
            if (this._holder === jobId) {
                this.release();
            }
        }, ttlMs);
        return true;
    }

    /** Returns the current holder's jobId or null. */
    async getHolder(): Promise<string | null> {
        return this._holder;
    }

    /**
     * Convenience: acquire, run job inside DO, release. Uses the FIFO
     * pattern — only one job runs at a time per DO instance.
     */
    async acquireAndRun(jobId: string, ttlMs: number, payload?: never): Promise<void>;
    async acquireAndRun(jobId: string, ttlMs: number, payload: Record<string, unknown>): Promise<unknown>;
    async acquireAndRun(jobId: string, ttlMs: number, payload?: Record<string, unknown>): Promise<unknown> {
        await this.acquire(jobId, ttlMs);
        try {
            if (payload) return this.handleJob(payload);
        } finally {
            await this.release();
        }
    }

    protected async handleJob(_payload: Record<string, unknown>): Promise<unknown> {
        return undefined;
    }
}

interface LockTicket {
    release(): Promise<void>;
}

/**
 * Fixed safety-valve TTL: auto-releases a holder that crashes/gets
 * evicted without calling `release()`. Kept short (rather than simply
 * lengthened) via heartbeat renewal in `acquireLock` below -- a longer
 * fixed TTL would slow recovery from a genuinely abandoned lock, while a
 * short TTL alone reintroduces the exact race this DO exists to prevent
 * for a legitimately slow-but-alive holder under contention.
 */
const ACCOUNT_LOCK_TTL_MS = 30_000;

/** Stub returned by DurableObjectNamespace.get() for AccountLockDO. */
interface AccountLockStub {
    acquire(jobId: string, ttlMs: number): Promise<void>;
    renew(jobId: string, ttlMs: number): Promise<boolean>;
    release(): Promise<void>;
    getHolder(): Promise<string | null>;
}

async function acquireLock(id: string, lockNamespace: DurableObjectNamespace): Promise<LockTicket> {
    // SECURITY: always normalize before deriving the DO name. `idFromName`
    // is case-sensitive, so an unnormalized caller-controlled id (e.g. an
    // email straight from a request body) would let two differently-cased
    // variants of the SAME logical identity map to two DIFFERENT DO
    // instances -- defeating the mutual exclusion this lock exists to
    // provide (see completeAuthRequest, which locks by raw client email).
    // Normalizing unconditionally here makes this safe regardless of what
    // any current or future caller passes in.
    const key = id.trim().toLowerCase();
    const stub = lockNamespace.get(lockNamespace.idFromName(key)) as unknown as AccountLockStub;
    await stub.acquire(key, ACCOUNT_LOCK_TTL_MS);

    // M7 fix: a FIXED TTL alone auto-releases a still-running holder
    // under contention (cold start, queued critical-section work),
    // silently letting a second caller acquire the "same" logical lock
    // and reintroducing the exact race this DO exists to prevent.
    // Heartbeat renewal at 1/3 of the TTL keeps a genuinely alive
    // holder's lock from expiring while preserving the safety valve: if
    // the holder's own execution context is gone (crash/eviction),
    // renewal simply stops firing and the DO's own timer still reclaims
    // the lock after one more TTL window.
    const heartbeat = setInterval(() => {
        stub.renew(key, ACCOUNT_LOCK_TTL_MS).catch(() => {});
    }, ACCOUNT_LOCK_TTL_MS / 3);

    return {
        release: async () => {
            clearInterval(heartbeat);
            await stub.release();
        },
    };
}

/**
 * Acquire locks for given identity IDs in sorted order, execute the callback,
 * and release all locks.
 *
 * Sorted ordering prevents deadlock when two requests touch overlapping
 * identities (e.g. account A + org X vs account B + org X).
 */
export async function withAccountLocks<T>(
    ids: string[],
    lockNamespace: DurableObjectNamespace,
    fn: () => Promise<T>
): Promise<T> {
    if (ids.length === 0) {
        return fn();
    }
    if (!lockNamespace) {
        throw new Error("ACCOUNT_LOCK durable object namespace not configured");
    }

    // Normalize + dedupe: acquireLock() also normalizes (defense in depth),
    // but deduping HERE on the normalized form is what prevents a caller
    // that passes the same identity twice (or two different-cased spellings
    // of it) from acquiring its own lock a second time and deadlocking
    // itself for up to the 30s TTL.
    const sorted = [...new Set(ids.map((id) => id.trim().toLowerCase()))].sort();

    const tickets: LockTicket[] = [];
    for (const id of sorted) {
        const ticket = await acquireLock(id, lockNamespace);
        tickets.push(ticket);
    }

    try {
        return await fn();
    } finally {
        const reversed = [...tickets].reverse();
        for (const ticket of reversed) {
            ticket.release().catch(() => {});
        }
    }
}
