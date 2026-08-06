/**
 * Regression tests for the idempotency store (packages/worker/src/transport.ts
 * + idempotency.ts):
 *
 * 1. General mechanism: replaying a byte-identical request for an ORDINARY
 *    (non-anonymous-share) method must preserve the real result/error
 *    verbatim, not a synthetic always-error shape (the original bug fixed
 *    in this file, safe for methods with per-caller entropy).
 *
 * 2. Anonymous share-view methods (peekShare/revealShare) MUST NEVER be
 *    idempotency-cached or replayed AT ALL. A security review of the
 *    share-password feature found that (1)'s fix, while correct for
 *    ordinary methods, is UNSAFE for these two specifically: their request
 *    bodies have no session/nonce (anonymous by design) and the web
 *    client's `DeviceInfo.id` is always `""`, so two different real
 *    visitors requesting the SAME share id can hash to the SAME cache key.
 *    Without this exclusion, whoever calls second within the 1h KV TTL
 *    would silently receive the FIRST caller's cached successful
 *    `revealShare` result -- including the real ciphertext of an
 *    already-consumed one-time share -- defeating the feature's central
 *    single-view guarantee. See
 *    openspec/changes/archive/2026-08-05-share-password/verify-report.md's
 *    "Critical Security Analysis" section for the ORIGINAL (now-superseded)
 *    analysis, and this session's follow-up security audit for the
 *    corrected understanding: the fix must EXCLUDE these methods entirely,
 *    not just cache them "correctly".
 *
 * Run: npx ts-node --transpile-only --compiler-options '{"module":"commonjs"}' packages/worker/test/idempotency-replay.spec.ts
 */

import { WorkerReceiver, WorkerReceiverConfig } from "../src/transport";
import { Request as PlRequest, Response as PlResponse, RequestAuthentication } from "@padloc/core/src/transport";
import { marshal } from "@padloc/core/src/encoding";
import { IdempotencyStore } from "../src/idempotency";

interface RpcWireBody {
    result: unknown;
    error?: { code: string; message: string };
}

class InMemoryKV {
    private store = new Map<string, string>();

    async get(key: string, type?: string): Promise<unknown> {
        const raw = this.store.get(key);
        if (raw === undefined) {
            return null;
        }
        return type === "json" ? JSON.parse(raw) : raw;
    }

    async put(key: string, value: string): Promise<void> {
        this.store.set(key, value);
    }
}

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

function buildHttpRequest(method: string, params: unknown[], opts: { authenticated?: boolean } = {}): globalThis.Request {
    const req = new PlRequest();
    req.method = method;
    req.params = params;
    // General-purpose idempotency caching now only applies to AUTHENTICATED
    // requests (see transport.ts's `skipIdempotencyCache`) -- an
    // unauthenticated request has no per-caller entropy (signature) and may
    // hit handler-internal, state-dependent gates (e.g. the persistent
    // login lockout) that a cache hit would silently bypass. Scenarios 1-3
    // exercise the general mechanism, so they attach a minimal `auth` block
    // by default; pass `authenticated: false` to simulate a pre-session call.
    if (opts.authenticated !== false) {
        req.auth = new RequestAuthentication({
            session: "session-1",
            // Fixed (not `new Date()`) so two calls built for the SAME
            // logical request marshal to byte-identical bodies -- a fresh
            // timestamp per call would make the idempotency hash differ
            // between "first call" and "replay", defeating the very
            // scenarios this test simulates.
            time: new Date(0),
            signature: new Uint8Array([1, 2, 3]),
        });
    }
    const body = marshal(req.toRaw());
    return new globalThis.Request("http://localhost/", {
        method: "POST",
        body,
        headers: { "Content-Type": "application/json" },
    });
}

async function readBody(res: globalThis.Response): Promise<RpcWireBody> {
    return (await res.json()) as RpcWireBody;
}

function newReceiver(): WorkerReceiver {
    const kv = new InMemoryKV() as unknown as KVNamespace;
    const config = new WorkerReceiverConfig();
    config.idempotencyStore = new IdempotencyStore(kv);
    return new WorkerReceiver(config);
}

async function main() {
    console.log("Idempotency replay tests (packages/worker/src/transport.ts + idempotency.ts):");

    // ─── Scenario 1: replaying a SUCCESSFUL call must preserve the result ──
    {
        const receiver = newReceiver();
        const handler = async (req: PlRequest): Promise<PlResponse> => {
            const res = new PlResponse();
            res.result = { echoed: req.params };
            return res;
        };

        const res1 = await receiver.handleFetch(buildHttpRequest("echo", [1, 2, 3]), handler, {}, {});
        const body1 = await readBody(res1);
        ok(!body1.error, "first call: no error");
        ok(JSON.stringify(body1.result) === JSON.stringify({ echoed: [1, 2, 3] }), "first call: correct result");

        // Byte-identical replay (same method+params -> same marshalled body)
        const res2 = await receiver.handleFetch(buildHttpRequest("echo", [1, 2, 3]), handler, {}, {});
        ok(res2.headers.get("Idempotency-Replayed") === "true", "replay: marked as replayed");
        const body2 = await readBody(res2);
        ok(!body2.error, "replay of a SUCCESSFUL call must NOT be reported as an error");
        ok(
            JSON.stringify(body2.result) === JSON.stringify({ echoed: [1, 2, 3] }),
            "replay of a SUCCESSFUL call must return the SAME real result, not a synthetic error"
        );
    }

    // ─── Scenario 2: replaying a FAILED call must still surface the SAME error ──
    {
        const receiver = newReceiver();
        const handler = async (): Promise<PlResponse> => {
            const res = new PlResponse();
            res.error = { code: "bad_request", message: "nope" };
            return res;
        };

        const res1 = await receiver.handleFetch(buildHttpRequest("boom", []), handler, {}, {});
        const body1 = await readBody(res1);
        ok(body1.error?.code === "bad_request", "first call: real error surfaced");

        const res2 = await receiver.handleFetch(buildHttpRequest("boom", []), handler, {}, {});
        const body2 = await readBody(res2);
        ok(body2.error?.code === "bad_request", "replay: same error code preserved (not lost/blanked)");
        ok(body2.error?.message === "nope", "replay: same error message preserved");
    }

    // ─── Scenario 3: different params never collide (sanity check) ─────────
    {
        const receiver = newReceiver();
        const handler = async (req: PlRequest): Promise<PlResponse> => {
            const res = new PlResponse();
            res.result = { echoed: req.params };
            return res;
        };

        await receiver.handleFetch(buildHttpRequest("echo", [1]), handler, {}, {});
        const res = await receiver.handleFetch(buildHttpRequest("echo", [2]), handler, {}, {});
        ok(res.headers.get("Idempotency-Replayed") !== "true", "different params: not treated as a replay");
        const body = await readBody(res);
        ok(JSON.stringify(body.result) === JSON.stringify({ echoed: [2] }), "different params: fresh result returned");
    }

    // ─── Scenario 4 (SECURITY): anonymous share methods NEVER get cached ──
    // Simulates two DIFFERENT real visitors (e.g. the legitimate recipient
    // and someone who later obtained the same link) sending the exact same
    // revealShare(<id>) body -- realistic since these calls carry no
    // session/nonce. A call-counting handler proves the DO-equivalent
    // logic runs on EVERY call, never short-circuited by a cache hit.
    for (const method of ["peekShare", "revealShare"]) {
        const receiver = newReceiver();
        let handlerCallCount = 0;
        const handler = async (req: PlRequest): Promise<PlResponse> => {
            handlerCallCount++;
            const res = new PlResponse();
            // First call succeeds (like a fresh/unviewed share); every call
            // after re-runs the "real" one-time-view check and correctly
            // reports not-found (like the DO would for an already-viewed
            // or never-existed share) -- this is what MUST happen on every
            // single call, never skipped via a cache hit.
            if (handlerCallCount === 1) {
                res.result = { secret: "only-once" };
            } else {
                res.error = { code: "not_found", message: "Share not found." };
            }
            return res;
        };

        const res1 = await receiver.handleFetch(buildHttpRequest(method, ["shareid123"]), handler, {}, {});
        const body1 = await readBody(res1);
        ok(!body1.error, `${method} first call: succeeds (fresh share)`);
        ok(res1.headers.get("Idempotency-Replayed") !== "true", `${method} first call: never marked as a replay`);

        // Byte-identical second request (same method+params) -- simulates
        // a DIFFERENT visitor who obtained the same link, or a retry.
        const res2 = await receiver.handleFetch(buildHttpRequest(method, ["shareid123"]), handler, {}, {});
        ok(
            res2.headers.get("Idempotency-Replayed") !== "true",
            `${method} replay attempt: NEVER served from cache (no Idempotency-Replayed header)`
        );
        const body2 = await readBody(res2);
        ok(
            body2.error?.code === "not_found",
            `${method} replay attempt: handler ran AGAIN and correctly reported not-found (real one-time-view check), not a cached success`
        );
        ok(handlerCallCount === 2, `${method}: handler invoked on EVERY call (2/2), never short-circuited by a cache hit`);
    }

    // ─── Scenario 5 (SECURITY): unauthenticated non-share methods are ALSO
    // never cached ── generalizes Scenario 4's protection: `completeCreateSession`
    // has no `req.auth` (there's no session yet) and checks handler-internal
    // state (the persistent login lockout) on every call. A cache hit would
    // silently skip that re-check for a byte-identical replayed request.
    {
        const receiver = newReceiver();
        let handlerCallCount = 0;
        const handler = async (): Promise<PlResponse> => {
            handlerCallCount++;
            const res = new PlResponse();
            res.result = { call: handlerCallCount };
            return res;
        };

        const res1 = await receiver.handleFetch(
            buildHttpRequest("completeCreateSession", ["acct1"], { authenticated: false }),
            handler,
            {},
            {}
        );
        ok(res1.headers.get("Idempotency-Replayed") !== "true", "unauthenticated method first call: never a replay");

        const res2 = await receiver.handleFetch(
            buildHttpRequest("completeCreateSession", ["acct1"], { authenticated: false }),
            handler,
            {},
            {}
        );
        ok(
            res2.headers.get("Idempotency-Replayed") !== "true",
            "unauthenticated method replay attempt: NEVER served from cache"
        );
        ok(handlerCallCount === 2, "unauthenticated method: handler invoked on EVERY call, never short-circuited");
    }

    // ─── Scenario 6: authenticated requests are unaffected by Scenario 5's
    // exclusion -- the general caching mechanism (Scenario 1) still applies
    // when `req.auth` is present, confirming the fix narrows correctly
    // rather than disabling caching altogether.
    {
        const receiver = newReceiver();
        let handlerCallCount = 0;
        const handler = async (): Promise<PlResponse> => {
            handlerCallCount++;
            const res = new PlResponse();
            res.result = { call: handlerCallCount };
            return res;
        };

        await receiver.handleFetch(buildHttpRequest("updateAccount", ["x"]), handler, {}, {});
        const res2 = await receiver.handleFetch(buildHttpRequest("updateAccount", ["x"]), handler, {}, {});
        ok(res2.headers.get("Idempotency-Replayed") === "true", "authenticated method replay: still served from cache");
        ok(handlerCallCount === 1, "authenticated method: handler invoked only ONCE, second call was a cache hit");
    }

    console.log(`\n${passed} passed, ${failed} failed`);
    if (failed > 0) {
        process.exitCode = 1;
    }
}

main();
