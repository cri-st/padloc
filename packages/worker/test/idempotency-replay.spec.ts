/**
 * Regression test for a real idempotency-replay bug found and independently
 * verified during the `share-password` change's verify phase (see
 * openspec/changes/archive/2026-08-05-share-password/verify-report.md,
 * "Critical Security Analysis: Idempotency-Store Replay Bug").
 *
 * Bug: `WorkerReceiver._handlePost()` cached the WRONG shape on a
 * successful RPC call -- `store()` was called with
 * `{ code: raw.error, message: raw.message || "", status: 200 }`, discarding
 * `raw.result` entirely. On a byte-identical replay (only reachable for
 * anonymous, session/nonce-less RPCs like `peekShare`/`revealShare`), the
 * handler wrapped WHATEVER was cached under `{ error: existing }` --
 * unconditionally, even for a genuinely successful original call -- so every
 * replay was misreported to the client as an error.
 *
 * Independently confirmed (see verify-report) that the bug could NEVER cause
 * a second real handler invocation (the idempotency lookup short-circuits
 * BEFORE `handler(req)` is ever called), so it could never compromise
 * share-password's single-view guarantee. It was purely a mislabeling bug:
 * a genuinely successful call, if replayed, showed as a generic error.
 *
 * Fix: cache and replay the REAL raw response (`res.toRaw()`) verbatim, for
 * both success and error cases, instead of a synthetic always-error shape.
 *
 * Run: npx ts-node --transpile-only --compiler-options '{"module":"commonjs"}' packages/worker/test/idempotency-replay.spec.ts
 */

import { WorkerReceiver, WorkerReceiverConfig } from "../src/transport";
import { Request as PlRequest, Response as PlResponse } from "@padloc/core/src/transport";
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

function buildHttpRequest(method: string, params: unknown[]): globalThis.Request {
    const req = new PlRequest();
    req.method = method;
    req.params = params;
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

    console.log(`\n${passed} passed, ${failed} failed`);
    if (failed > 0) {
        process.exitCode = 1;
    }
}

main();
