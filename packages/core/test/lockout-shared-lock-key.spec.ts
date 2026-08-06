/**
 * Regression test: completeCreateSession and completeAuthRequest MUST lock
 * on the SAME key for the same account.
 *
 * Both methods read/increment the SAME per-email `Auth.failedLoginAttempts`/
 * `lockedUntil` record (see account-lock.ts, completeCreateSession,
 * completeAuthRequest). If they were to lock on different keys -- e.g.
 * completeCreateSession locking by account id while completeAuthRequest
 * locks by email -- a concurrent password guess and a concurrent MFA/
 * auth-token guess for the SAME account would run under two DIFFERENT
 * Durable Object / mutex instances, so they would NOT serialize against
 * each other at all: two different lock keys guarding one shared counter
 * is not mutual exclusion, and the exact "lost update" race the account
 * lock exists to close would reopen across the two RPC methods (even
 * though same-method concurrent bursts would still be correctly
 * serialized on their own).
 *
 * This is a real bug that was introduced and then found and fixed in the
 * same review cycle as the original completeCreateSession-only fix: the
 * concurrency e2e test in test:account-lockout-e2e only fires bursts
 * against a SINGLE endpoint, so it could not have caught a cross-endpoint
 * key mismatch. This spec verifies the invariant directly and cheaply,
 * with no real SRP/crypto needed -- both calls are expected to fail
 * downstream (no matching SRP session / no matching auth request), which
 * is fine: we only care about the lock key each call requests BEFORE that
 * failure.
 *
 * Run: npx ts-node --transpile-only --compiler-options '{"module":"commonjs"}' \
 *          packages/core/test/lockout-shared-lock-key.spec.ts
 */
import { Server, ServerConfig } from "../src/server";
import { VoidLogger } from "../src/logging";
import { StubMessenger } from "../src/messenger";
import { MemoryAttachmentStorage } from "../src/attachment";
import { MemoryStorage } from "../src/storage";
import { Account } from "../src/account";
import { Auth } from "../src/auth";
import { AccountLockProvider } from "../src/account-lock";
import { Err } from "../src/error";

let passed = 0;
let failed = 0;

function ok(cond: boolean, label: string) {
    if (cond) {
        passed++;
        console.log(`  \u2713 ${label}`);
    } else {
        failed++;
        console.log(`  \u2717 ${label}`);
    }
}

async function main() {
    console.log("[completeCreateSession / completeAuthRequest share the same account-lock key]");

    const email = "lockout-key-test@example.com";
    const accountId = "acct1";

    const recordedLockKeys: string[][] = [];
    const recordingLock: AccountLockProvider = {
        withLock: async (ids, fn) => {
            recordedLockKeys.push(ids);
            return fn();
        },
    };

    const storage = new MemoryStorage();

    const account = new Account();
    account.id = accountId;
    account.email = email;
    await storage.save(account);

    const auth = new Auth(email);
    await auth.init();
    await storage.save(auth);

    const server = new Server(
        new ServerConfig(),
        storage,
        new StubMessenger(),
        new VoidLogger(),
        [],
        new MemoryAttachmentStorage(),
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        recordingLock
    );

    const controller = server.makeController({ id: "req-1" });

    try {
        await controller.completeCreateSession({
            accountId,
            srpId: "nonexistent-srp-session",
            A: new Uint8Array([1]),
            M: new Uint8Array([2]),
            addTrustedDevice: false,
        } as never);
    } catch (e) {
        ok(e instanceof Err, "completeCreateSession failed downstream as expected (no matching SRP session)");
    }

    try {
        await controller.completeAuthRequest({
            email,
            id: "nonexistent-auth-request",
            data: {},
        } as never);
    } catch (e) {
        ok(e instanceof Err, "completeAuthRequest failed downstream as expected (no matching auth request)");
    }

    ok(recordedLockKeys.length === 2, "both calls acquired the account lock exactly once each");
    ok(
        JSON.stringify(recordedLockKeys[0]) === JSON.stringify([email]),
        `completeCreateSession locked on [email] (got ${JSON.stringify(recordedLockKeys[0])})`
    );
    ok(
        JSON.stringify(recordedLockKeys[1]) === JSON.stringify([email]),
        `completeAuthRequest locked on [email] (got ${JSON.stringify(recordedLockKeys[1])})`
    );
    ok(
        JSON.stringify(recordedLockKeys[0]) === JSON.stringify(recordedLockKeys[1]),
        "completeCreateSession and completeAuthRequest lock on the IDENTICAL key for the same account -- a concurrent guess against either endpoint serializes against the other"
    );

    console.log(`\n${passed} passed, ${failed} failed`);
    if (failed > 0) {
        process.exitCode = 1;
    }
}

main();
