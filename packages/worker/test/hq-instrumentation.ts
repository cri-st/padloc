import {
    captureHqException,
    flushHqInstrumentation,
    hqInstrumentationStatus,
    initializeHqInstrumentation,
    resetHqInstrumentationForTests,
    startHqSpan,
} from "../src/hq-instrumentation";

export interface HqInstrumentationResult {
    name: string;
    ok: boolean;
    detail: string;
}

export interface HqInstrumentationReport {
    ok: boolean;
    runtime: "worker";
    generatedAt: string;
    summary: { total: number; passed: number; failed: number };
    results: HqInstrumentationResult[];
}

function assertTrue(value: boolean, label: string) {
    if (!value) throw new Error(label);
}

function assertEqual<T>(actual: T, expected: T, label: string) {
    if (actual !== expected) throw new Error(`${label}: expected ${expected}, got ${actual}`);
}

export async function runHqInstrumentationTests(): Promise<HqInstrumentationReport> {
    const results: HqInstrumentationResult[] = [];

    await check("init rejects sentry.io DSN", results, async () => {
        resetHqInstrumentationForTests();
        let threw = false;
        try {
            initializeHqInstrumentation({
                sentryDsn: "https://public@o0.ingest.sentry.io/1",
                otlpEndpoint: "https://logs.example.com/otlp",
            });
        } catch (error) {
            threw = String(error).includes("sentry.io") || String(error).includes("logs.example.com");
        }
        assertTrue(threw, "sentry.io rejected");
    });

    await check("init rejects non-CH5 OTLP host", results, async () => {
        resetHqInstrumentationForTests();
        let threw = false;
        try {
            initializeHqInstrumentation({
                sentryDsn: "https://public@logs.example.com/1",
                otlpEndpoint: "https://collector.example.com/v1/traces",
            });
        } catch (error) {
            threw = String(error).includes("HQ_OTLP_ENDPOINT");
        }
        assertTrue(threw, "non-CH5 OTLP host rejected");
    });

    await check("missing one endpoint fails loud", results, async () => {
        resetHqInstrumentationForTests();
        let threw = false;
        try {
            initializeHqInstrumentation({ sentryDsn: "https://public@logs.example.com/1" });
        } catch (error) {
            threw = String(error).includes("both HQ_SENTRY_DSN and HQ_OTLP_ENDPOINT");
        }
        assertTrue(threw, "partial config throws");
    });

    await check("error capture sends Sentry envelope and OTLP span", results, async () => {
        resetHqInstrumentationForTests();
        const posts: Array<{ url: string; body: string; contentType: string }> = [];
        initializeHqInstrumentation({
            sentryDsn: "https://public@logs.example.com/42",
            otlpEndpoint: "https://logs.example.com/otlp",
            environment: "test",
            release: "padloc-worker@test",
            fetchImpl: async (url, init) => {
                posts.push({
                    url: String(url),
                    body: String(init?.body || ""),
                    contentType: String(new Headers(init?.headers).get("content-type") || ""),
                });
                return new Response("ok", { status: 200 });
            },
        });
        assertEqual(hqInstrumentationStatus(), "ready", "status ready");
        captureHqException(new Error("boom"), { "test.case": "capture" });
        const span = startHqSpan("padloc.worker.test", { attributes: { "test.attr": "value" } });
        span.end({ status: "ok" });
        await flushHqInstrumentation();
        assertEqual(posts.length, 2, "two telemetry posts");
        assertTrue(
            posts.some((post) => post.url === "https://logs.example.com/api/42/envelope/"),
            "envelope URL used"
        );
        assertTrue(
            posts.some((post) => post.url === "https://logs.example.com/otlp/v1/traces"),
            "OTLP URL used"
        );
        assertTrue(
            posts.some((post) => post.body.includes("boom")),
            "error included in envelope"
        );
        assertTrue(
            posts.some((post) => post.body.includes("padloc.worker.test")),
            "span included in trace"
        );
    });

    await check("HQ unreachable degrades with visible warning", results, async () => {
        resetHqInstrumentationForTests();
        const warnings: string[] = [];
        initializeHqInstrumentation({
            sentryDsn: "https://public@logs.example.com/42",
            otlpEndpoint: "https://logs.example.com/otlp",
            warn: (message) => warnings.push(message),
            fetchImpl: async () => new Response("down", { status: 503 }),
        });
        captureHqException(new Error("hq down"));
        await flushHqInstrumentation();
        assertEqual(hqInstrumentationStatus(), "degraded", "status degraded");
        assertTrue(
            warnings.some((message) => message.includes("HQ telemetry unreachable")),
            "visible warning emitted"
        );
    });

    const passed = results.filter((result) => result.ok).length;
    return {
        ok: passed === results.length,
        runtime: "worker",
        generatedAt: new Date().toISOString(),
        summary: { total: results.length, passed, failed: results.length - passed },
        results,
    };
}

async function check(name: string, results: HqInstrumentationResult[], fn: () => Promise<void>) {
    try {
        await fn();
        results.push({ name, ok: true, detail: "passed" });
    } catch (error) {
        results.push({ name, ok: false, detail: error instanceof Error ? error.message : String(error) });
    }
}
