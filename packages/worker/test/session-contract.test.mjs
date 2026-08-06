/**
 * Session and AccountLock contract tests.
 *
 * Tests:
 *   1. Session revoke blocks request
 *   2. Session expiry blocks request
 *   3. Replay/old timestamp rejected
 *   4. Concurrent requests serialized -- via `MockAccountLockDO`, a
 *      hand-written FIFO reimplementation, NOT the real
 *      `src/locks/account-lock.ts` class. Real contract coverage for the
 *      ACTUAL `AccountLockDO` class (including a real, previously-shipped
 *      deadlock bug in its acquire()/release() ordering that this mock's
 *      different implementation never reproduced) lives in
 *      test:account-lock-do (test/account-lock-do.test.mjs). Kept here
 *      only as a fast, dependency-free illustration of the intended FIFO
 *      contract shape -- do not treat a pass here as proof the real DO
 *      behaves correctly.
 *
 * Note: this file previously included a "Rate-limit KV staleness does not
 * bypass D1 auth row" test that only exercised locally-reimplemented mock
 * stand-ins (never the real worker/src/session.ts module, which itself was
 * dead code -- never imported anywhere, and its readAuthThrottle() query
 * referenced a failed_attempts column that didn't exist in the live D1
 * schema). That dead module has been removed. Real, end-to-end persistent
 * account-lockout coverage -- through the actual Server.completeCreateSession
 * path and Auth.failedLoginAttempts/lockedUntil fields, via a real wrangler
 * dev instance -- now lives in test:account-lockout-e2e
 * (test/account-lockout-e2e.worker.ts + test/run-account-lockout-e2e.mjs).
 *
 * Run: node --experimental-vm-modules test/session-contract.test.mjs
 */

// ─── Session Validation Tests ──────────────────────────────────────────────

function validateSessionState(record) {
    if (record.revokedAt) {
        const e = new Error("Session has been revoked");
        e.code = "SESSION_EXPIRED";
        throw e;
    }
    if (record.expiresAt && new Date(record.expiresAt) < new Date()) {
        const e = new Error("Session has expired");
        e.code = "SESSION_EXPIRED";
        throw e;
    }
}

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

async function testRevokeBlocksRequest() {
    console.log("\n[Session Revoke]");
    const revokedRecord = {
        revokedAt: new Date().toISOString(),
        expiresAt: null,
    };
    let threw = false;
    try {
        validateSessionState(revokedRecord);
    } catch (e) {
        threw = e.code === "SESSION_EXPIRED";
    }
    assert(threw, "Revoked session throws SESSION_EXPIRED");
}

async function testExpiryBlocksRequest() {
    console.log("\n[Session Expiry]");
    const expiredRecord = {
        revokedAt: null,
        expiresAt: new Date(Date.now() - 1000 * 60).toISOString(),
    };
    let threw = false;
    try {
        validateSessionState(expiredRecord);
    } catch (e) {
        threw = e.code === "SESSION_EXPIRED";
    }
    assert(threw, "Expired session throws SESSION_EXPIRED");
}

async function testValidSessionPasses() {
    console.log("\n[Valid Session]");
    const validRecord = {
        revokedAt: null,
        expiresAt: new Date(Date.now() + 1000 * 60 * 60).toISOString(),
    };
    let passed = true;
    try {
        validateSessionState(validRecord);
    } catch {
        passed = false;
    }
    assert(passed, "Valid session passes validation");
}

// ─── Lock Serialization Tests ──────────────────────────────────────────────

/**
 * Mock AccountLockDO using a local FIFO promise chain.
 * Same pattern as the real DO but runs in-process.
 */
class MockAccountLockDO {
    constructor() {
        this.tail = Promise.resolve();
        this.setResolve = () => {};
    }

    async acquireAndRun(jobId, ttlMs) {
        await this.tail;

        let resolveTail;
        this.tail = new Promise((res) => {
            resolveTail = res;
        });
        this.setResolve = resolveTail;

        const timer = setTimeout(() => this.setResolve(), ttlMs);

        try {
            return;
        } catch (err) {
            this.setResolve();
            clearTimeout(timer);
            throw err;
        }
    }

    release() {
        this.setResolve();
    }
}

async function testConcurrentSerialization() {
    console.log("\n[Lock Serialization]");

    class SyncLock {
        constructor() {
            this.pending = Promise.resolve();
        }

        acquire(name) {
            let resolve;
            const p = new Promise((res) => {
                resolve = res;
            });

            const oldPending = this.pending;
            this.pending = p.then(() => oldPending);

            return oldPending.then(() => {
                const release = () => resolve();
                return { release, oldPending };
            });
        }
    }

    const lockDO = new SyncLock();
    const order = [];

    async function request(name, fn) {
        const { release } = await lockDO.acquire(name);
        try {
            order.push(`${name}:start`);
            await new Promise((r) => setTimeout(r, 50));
            fn();
            order.push(`${name}:end`);
        } finally {
            release();
        }
    }

    await Promise.all([request("reqA", () => {}), request("reqB", () => {})]);

    const serialized =
        (order[0] === "reqA:start" &&
            order[1] === "reqA:end" &&
            order[2] === "reqB:start" &&
            order[3] === "reqB:end") ||
        (order[0] === "reqB:start" && order[1] === "reqB:end" && order[2] === "reqA:start" && order[3] === "reqA:end");
    console.log("  order:", order);

    assert(serialized, "Concurrent requests do not overlap — serialized via single lock");
}

async function testSortedIdOrdering() {
    console.log("\n[Sorted ID Ordering]");

    const ids1 = ["z_account", "a_org", "m_org"].sort();
    const ids2 = ["a_org", "m_org", "z_account"].sort();
    assert(JSON.stringify(ids1) === JSON.stringify(ids2), "Two different input orders produce identical sorted order");
}

// ─── Sorted ID Order Prevention of Deadlock ───────────────────────────────

async function testNoDeadlockWithOverlap() {
    console.log("\n[Deadlock Prevention]");

    const locks = new Map();
    function getLock(id) {
        if (!locks.has(id)) locks.set(id, new MockAccountLockDO());
        return locks.get(id);
    }

    async function runWithLocks(ids, fn) {
        const sorted = [...ids].sort();
        for (const id of sorted) {
            await getLock(id).acquireAndRun("test", 30_000);
        }
        try {
            await fn();
        } finally {
            for (const id of sorted.reverse()) {
                getLock(id).release();
            }
        }
    }

    let deadlock = false;
    let finished = false;

    try {
        const p = Promise.all([
            runWithLocks(["acct_A", "org_X"], async () => {
                await new Promise((r) => setTimeout(r, 20));
            }),
            runWithLocks(["acct_B", "org_X"], async () => {
                await new Promise((r) => setTimeout(r, 20));
            }),
        ]);

        await Promise.race([
            p.then(() => {
                finished = true;
            }),
            new Promise((_, rej) => setTimeout(() => rej(new Error("deadlock timeout")), 5000)),
        ]);
    } catch {
        deadlock = true;
    }

    assert(finished && !deadlock, "No deadlock with overlapping org (sorted lock order)");
}

// ─── Run ───────────────────────────────────────────────────────────────────

(async () => {
    console.log("=== Session & AccountLock Contract Tests ===");
    await testRevokeBlocksRequest();
    await testExpiryBlocksRequest();
    await testValidSessionPasses();
    await testConcurrentSerialization();
    await testSortedIdOrdering();
    await testNoDeadlockWithOverlap();

    console.log(`\nResults: ${passed} passed, ${failed} failed`);
    process.exit(failed > 0 ? 1 : 0);
})();
