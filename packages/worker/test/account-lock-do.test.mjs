/**
 * AccountLockDO contract tests.
 *
 * Exercises the REAL `packages/worker/src/locks/account-lock.ts` class
 * (transpiled in-process via esbuild -- no bundling), mirroring
 * `rate-limit-do.test.mjs`/`share-link-do.test.mjs`'s harness exactly.
 *
 * Security context: `session-contract.test.mjs`'s "Lock Serialization"/
 * "Deadlock Prevention" tests exercise a hand-written `MockAccountLockDO`
 * reimplementation, NOT this real class -- the exact "false-assurance
 * test" anti-pattern flagged in this repo's own security audit history
 * (a test whose name implies it verifies a real module, but which only
 * imports/reimplements matching function names). That mock happened to be
 * implemented correctly while the REAL `AccountLockDO.acquire()`/
 * `release()` had a genuine, severe concurrency bug: `_holder`/`_release`
 * were assigned BEFORE the queue-wait `await`, so a later concurrent
 * `acquire()` call's synchronous prefix could overwrite an earlier
 * caller's release function before that earlier caller ever became the
 * real holder -- the earlier caller's `release()` then resolved the WRONG
 * (most recently registered) caller's gate, permanently deadlocking every
 * ticket queued in between. This was only caught by a live end-to-end test
 * firing 15 concurrent `completeCreateSession` guesses through a real
 * wrangler dev instance (`test/account-lockout-e2e.worker.ts`), which hung
 * past its 30s timeout before the fix below existed.
 *
 * Tests:
 *   1. Sequential acquire/release maintains the correct holder.
 *   2. A burst of concurrent acquire() calls (well beyond 2) all eventually
 *      settle -- no deadlock -- and run in strict FIFO order, never
 *      overlapping.
 *   3. TTL auto-release fires if a holder never calls release().
 *   4. renew() extends the TTL past the original window for the current
 *      holder (M7 fix), and is a no-op for any other jobId.
 *
 * Run: node test/account-lock-do.test.mjs
 */

import { buildSync } from "esbuild";
import Module from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const originalRequire = Module.prototype.require;
Module.prototype.require = function (id) {
    if (id === "cloudflare:workers") {
        return {
            DurableObject: class DurableObject {
                constructor(ctx, env) {
                    this.ctx = ctx;
                    this.env = env;
                }
            },
        };
    }
    return originalRequire.apply(this, arguments);
};

// ─── TS loader (esbuild transpile, no bundling) ────────────────────────────

function loadTs(relPath) {
    const absPath = path.resolve(__dirname, relPath);
    const result = buildSync({
        entryPoints: [absPath],
        bundle: false,
        write: false,
        format: "cjs",
        platform: "node",
        target: "es2020",
    });
    const code = result.outputFiles[0].text;
    const mod = new Module(absPath);
    mod.filename = absPath;
    mod.paths = Module._nodeModulePaths(path.dirname(absPath));
    mod._compile(code, absPath);
    return mod.exports;
}

const { AccountLockDO } = loadTs("../src/locks/account-lock.ts");

function makeState() {
    // AccountLockDO keeps no Durable Object storage -- pure in-memory FIFO
    // state -- so the fake state only needs to exist, not implement `.storage`.
    return {};
}

// ─── assert helper (matches share-link-do.test.mjs / rate-limit-do.test.mjs style) ──

let passed = 0;
let failed = 0;

function assert(condition, label) {
    if (condition) {
        passed++;
        console.log(`  ✓ ${label}`);
    } else {
        failed++;
        console.log(`  ✗ ${label}`);
    }
}

// ─── Tests ──────────────────────────────────────────────────────────────

async function testSequentialAcquireRelease() {
    console.log("Sequential acquire/release:");
    const lock = new AccountLockDO(makeState(), {});

    await lock.acquire("job-1", 30_000);
    assert((await lock.getHolder()) === "job-1", "holder is job-1 after acquire");

    await lock.release();
    assert((await lock.getHolder()) === null, "holder is null after release");

    await lock.acquire("job-2", 30_000);
    assert((await lock.getHolder()) === "job-2", "holder is job-2 after a second acquire");
    await lock.release();
}

async function testConcurrentBurstNeverDeadlocksAndStaysOrdered() {
    console.log("\nConcurrent acquire() burst -- no deadlock, strict FIFO, never overlapping:");
    const lock = new AccountLockDO(makeState(), {});

    const N = 15;
    const order = [];
    let overlapping = false;
    let activeCount = 0;

    async function runJob(id) {
        await lock.acquire(id, 30_000);
        activeCount++;
        if (activeCount > 1) overlapping = true;
        order.push(`${id}:start`);
        // Yield a tick to give a buggy implementation a chance to let a
        // second "holder" run concurrently.
        await new Promise((resolve) => setTimeout(resolve, 1));
        order.push(`${id}:end`);
        activeCount--;
        await lock.release();
    }

    const jobIds = Array.from({ length: N }, (_, i) => `job-${i}`);

    // This is the exact shape that hung the real e2e test before the fix:
    // N concurrent acquire() calls fired via Promise.all against the SAME
    // DO instance. A timeout race proves this settles rather than hanging.
    const settled = await Promise.race([
        Promise.all(jobIds.map((id) => runJob(id))).then(() => "settled"),
        new Promise((resolve) => setTimeout(() => resolve("timed-out"), 5000)),
    ]);

    assert(settled === "settled", `all ${N} concurrent acquire()/release() calls settled without deadlocking`);
    assert(!overlapping, "no two jobs ever held the lock at the same time");

    const expectedOrder = jobIds.flatMap((id) => [`${id}:start`, `${id}:end`]);
    assert(
        JSON.stringify(order) === JSON.stringify(expectedOrder),
        "jobs ran in strict FIFO (arrival) order, each fully completing before the next started"
    );
}

async function testTtlAutoRelease() {
    console.log("\nTTL auto-release:");
    const lock = new AccountLockDO(makeState(), {});

    await lock.acquire("stuck-job", 20);
    assert((await lock.getHolder()) === "stuck-job", "holder is stuck-job immediately after acquire");

    // Never call release() for "stuck-job" -- the TTL timer must free the
    // lock on its own so a subsequent acquire() doesn't hang forever.
    const nextAcquire = await Promise.race([
        lock.acquire("next-job", 30_000).then(() => "acquired"),
        new Promise((resolve) => setTimeout(() => resolve("timed-out"), 2000)),
    ]);

    assert(nextAcquire === "acquired", "a queued acquire() is freed by the stuck holder's TTL auto-release");
    assert((await lock.getHolder()) === "next-job", "holder is next-job after TTL freed the stuck holder");
}

async function testRenewExtendsTtlPastOriginalWindow() {
    console.log("\nrenew() heartbeat extends TTL:");
    const lock = new AccountLockDO(makeState(), {});

    await lock.acquire("slow-job", 100);
    // Without renewal, "slow-job" would auto-release at ~100ms. Renew
    // partway through with a fresh 300ms window, mirroring
    // `acquireLock`'s periodic heartbeat while a real caller's work is
    // still running.
    await new Promise((resolve) => setTimeout(resolve, 60));
    const renewed = await lock.renew("slow-job", 300);
    assert(renewed === true, "renew() succeeds for the current holder");

    // Wait past the ORIGINAL 100ms TTL (now 160ms elapsed total) -- the
    // lock must still be held because renew() reset the timer.
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert((await lock.getHolder()) === "slow-job", "holder survives past the original TTL after renewal");

    // Wait past the RENEWED window too -- the safety valve must still
    // fire eventually if the holder never releases.
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert((await lock.getHolder()) === null, "the renewed TTL still auto-releases if never released");
}

async function testRenewNoOpForWrongHolder() {
    console.log("\nrenew() rejects a stale/wrong holder:");
    const lock = new AccountLockDO(makeState(), {});

    await lock.acquire("real-holder", 20);
    const renewedByImposter = await lock.renew("imposter", 30_000);
    assert(renewedByImposter === false, "renew() returns false for a jobId that isn't the current holder");

    // The imposter's failed renew() must not have disturbed the real
    // holder's original short TTL.
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert((await lock.getHolder()) === null, "real holder's original TTL still auto-releases untouched");
}

// ─── Run ───────────────────────────────────────────────────────────────────

(async () => {
    console.log("=== AccountLockDO Contract Tests ===");
    await testSequentialAcquireRelease();
    await testConcurrentBurstNeverDeadlocksAndStaysOrdered();
    await testTtlAutoRelease();
    await testRenewExtendsTtlPastOriginalWindow();
    await testRenewNoOpForWrongHolder();

    console.log(`\nResults: ${passed} passed, ${failed} failed`);
    process.exit(failed > 0 ? 1 : 0);
})();
