/**
 * Serializes concurrent operations for a set of identities (typically an
 * account id or email) so that a read-modify-write critical section --
 * e.g. the persistent login-lockout counter in `Server.completeCreateSession`
 * / `completeAuthRequest` -- can't be raced by concurrent requests for the
 * same identity.
 *
 * Security context: `Auth.failedLoginAttempts`/`lockedUntil` used to be
 * read from storage, mutated in memory, and saved back with no lock at
 * all. Two (or more) concurrent wrong-password/wrong-MFA-code requests for
 * the SAME account each read the same stale counter value before any of
 * them saved, so only the last write landed -- a burst of N concurrent
 * guesses only ever advanced the persistent counter by 1 instead of N,
 * completely defeating the 10-attempt lockout. `Storage.save()` is a blind
 * upsert with no compare-and-swap across every backend this repo ships
 * (D1, MongoDB, Postgres, LevelDB), so the race can only be closed with an
 * explicit lock around the critical section, not a storage-layer fix.
 *
 * `packages/core` is platform-agnostic and can't reference a Cloudflare
 * Durable Object directly, so hosts inject a real distributed
 * implementation via `Server`'s constructor (see
 * `packages/worker/src/locks/account-lock.ts`'s `AccountLockDO`-backed
 * `withAccountLocks`, wired in `server-factory.ts`). The default here is
 * an in-process FIFO queue: it fully closes the race for a single-process
 * deployment (self-host), and for a Worker without a distributed lock
 * injected it still narrows the window to a single isolate instead of
 * leaving it fully open across every concurrent request.
 */
export interface AccountLockProvider {
    /** Runs `fn` with exclusive access to every id in `ids`, one caller at a time per id. */
    withLock<T>(ids: string[], fn: () => Promise<T>): Promise<T>;
}

/**
 * In-process, single-isolate FIFO mutex. Sorts ids before acquiring (like
 * the DO-backed implementation) so overlapping multi-id lock requests
 * can't deadlock each other.
 */
export class InProcessAccountLockProvider implements AccountLockProvider {
    private _tails = new Map<string, Promise<void>>();

    async withLock<T>(ids: string[], fn: () => Promise<T>): Promise<T> {
        // Normalize before deduping/sorting: identities are typically
        // emails, and case differences must not defeat mutual exclusion
        // (see the DO-backed sibling implementation in
        // packages/worker/src/locks/account-lock.ts for the concrete bug
        // this closes).
        const sorted = [...new Set(ids.map((id) => id.trim().toLowerCase()))].sort();
        const releases: (() => void)[] = [];

        for (const id of sorted) {
            const prevTail = this._tails.get(id) || Promise.resolve();
            let release!: () => void;
            const gate = new Promise<void>((res) => (release = res));
            this._tails.set(
                id,
                prevTail.then(() => gate)
            );
            releases.push(release);
            await prevTail;
        }

        try {
            return await fn();
        } finally {
            releases.forEach((release) => release());
        }
    }
}
