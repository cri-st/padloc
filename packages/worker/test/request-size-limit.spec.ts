/**
 * Regression tests for M8: `packages/worker/src/transport.ts`'s
 * `WorkerReceiver._handlePost` request-size enforcement.
 *
 * Exercises the REAL `WorkerReceiver`/`readBodyWithLimit` (not a
 * reimplementation) against real `globalThis.Request`/`ReadableStream`
 * instances -- see `idempotency-replay.spec.ts`'s header comment for why
 * this repo insists on testing the real module rather than a mock.
 *
 * Tests:
 *   1. A truthful, oversized `Content-Length` header is rejected WITHOUT
 *      ever reading the body stream (fast-path precheck).
 *   2. A body with no (or an understated) `Content-Length` that exceeds
 *      the limit is rejected by the streaming byte-counter, which stops
 *      pulling further chunks once the running total crosses the limit
 *      (bounded worst-case buffering, not "read everything, then check").
 *   3. A body within the limit still round-trips correctly (happy path,
 *      guards against a false-positive rejection).
 *
 * Run: npx ts-node --transpile-only --compiler-options '{"module":"commonjs"}' packages/worker/test/request-size-limit.spec.ts
 */

import { WorkerReceiver, WorkerReceiverConfig } from "../src/transport";
import { Request as PlRequest, Response as PlResponse } from "@padloc/core/src/transport";
import { marshal } from "@padloc/core/src/encoding";

interface RpcWireBody {
    result: unknown;
    error?: { code: string; message: string };
}

let passed = 0;
let failed = 0;

function ok(cond: boolean, label: string) {
    if (cond) {
        passed++;
        console.log(`  ✓ ${label}`);
    } else {
        failed++;
        console.log(`  ✗ ${label}`);
    }
}

async function readBody(res: globalThis.Response): Promise<RpcWireBody> {
    return (await res.json()) as RpcWireBody;
}

function newReceiver(maxRequestSize: number): WorkerReceiver {
    const config = new WorkerReceiverConfig();
    config.maxRequestSize = maxRequestSize;
    return new WorkerReceiver(config);
}

const echoHandler = async (req: PlRequest): Promise<PlResponse> => {
    const res = new PlResponse();
    res.result = { echoed: req.params };
    return res;
};

async function main() {
    console.log("Request-size-limit tests (packages/worker/src/transport.ts, M8):");

    // ─── Scenario 1: oversized Content-Length rejects WITHOUT reading the body ──
    {
        const maxRequestSize = 100;
        const receiver = newReceiver(maxRequestSize);
        // A stream whose `pull()` never resolves. If `_handlePost` ever
        // attempted to actually read this body (i.e. the Content-Length
        // precheck didn't short-circuit first), `handleFetch` would hang
        // forever waiting on it -- racing against a short timeout turns
        // that hang into a definitive, fast-failing assertion instead of
        // an unreliable pull-call-count check (Node's own `Request`
        // implementation may eagerly touch a streaming body once as an
        // internal implementation detail, independent of application
        // code, which makes counting `pull()` calls an unreliable signal
        // here).
        const neverResolvingBody = new ReadableStream<Uint8Array>({
            pull() {
                return Promise.withResolvers<void>().promise;
            },
        });

        const req = new globalThis.Request("http://localhost/", {
            method: "POST",
            // @ts-expect-error -- undici requires `duplex` for streaming request bodies
            duplex: "half",
            body: neverResolvingBody,
            headers: { "content-length": String(maxRequestSize + 1) },
        });

        const timeout = Promise.withResolvers<"timed-out">();
        setTimeout(() => timeout.resolve("timed-out"), 500);
        const res = await Promise.race([receiver.handleFetch(req, echoHandler, {}, {}), timeout.promise]);
        ok(res !== "timed-out", "Content-Length precheck resolves without ever reading the (hanging) body stream");
        if (res !== "timed-out") {
            const body = await readBody(res);
            ok(body.error?.code === "max_request_size_exceeded", "response reports max_request_size_exceeded");
            ok(res.status === 400, "response status is 400");
        }
    }

    // ─── Scenario 2: no Content-Length, streamed body exceeds the limit ─────
    {
        const maxRequestSize = 50;
        const receiver = newReceiver(maxRequestSize);
        const chunk = new TextEncoder().encode("x".repeat(20));
        let chunksPulled = 0;
        const oversizedStream = new ReadableStream<Uint8Array>({
            pull(controller) {
                chunksPulled++;
                // An attacker-controlled body has no natural end here --
                // if the fix didn't cancel early, this would hang the test
                // (or, with a finite malicious body, force buffering the
                // whole thing). Cap at a small finite number of chunks so
                // an unbounded-read regression fails loudly instead of
                // hanging forever.
                if (chunksPulled > 1000) {
                    controller.error(new Error("read far more chunks than the limit should ever allow"));
                    return;
                }
                controller.enqueue(chunk);
            },
        });

        const req = new globalThis.Request("http://localhost/", {
            method: "POST",
            // @ts-expect-error -- undici requires `duplex` for streaming request bodies
            duplex: "half",
            body: oversizedStream,
        });

        const res = await receiver.handleFetch(req, echoHandler, {}, {});
        const body = await readBody(res);
        ok(body.error?.code === "max_request_size_exceeded", "streaming check rejects an oversized undeclared body");
        ok(res.status === 400, "response status is 400");
        // 50-byte limit / 20-byte chunks: the 3rd chunk (60 bytes total)
        // crosses the limit, so the reader must stop soon after -- nowhere
        // near the 1000-chunk escape hatch above. This is the actual
        // bounded-buffering assertion: the fix reads a handful of chunks,
        // not "the entire stream, then checks".
        ok(chunksPulled <= 5, `reader stopped early after crossing the limit (pulled ${chunksPulled} chunks)`);
    }

    // ─── Scenario 3: a body within the limit still works (no false positive) ──
    {
        const maxRequestSize = 10_000;
        const receiver = newReceiver(maxRequestSize);
        const plReq = new PlRequest();
        plReq.method = "echo";
        plReq.params = [1, 2, 3];
        const body = marshal(plReq.toRaw());

        const req = new globalThis.Request("http://localhost/", {
            method: "POST",
            body,
            headers: { "Content-Type": "application/json" },
        });

        const res = await receiver.handleFetch(req, echoHandler, {}, {});
        const parsed = await readBody(res);
        ok(!parsed.error, "a body within the limit is not rejected");
        ok(JSON.stringify(parsed.result) === JSON.stringify({ echoed: [1, 2, 3] }), "correct result for an in-limit request");
    }

    console.log(`\nResults: ${passed} passed, ${failed} failed`);
    process.exitCode = failed > 0 ? 1 : 0;
}

main();
