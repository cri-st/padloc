import { Env } from "./env";
import { redact } from "./observability/log-redaction";

export type HqTelemetryStatus = "disabled" | "ready" | "degraded";

export interface HqInstrumentationConfig {
    sentryDsn?: string;
    otlpEndpoint?: string;
    serviceName?: string;
    serviceVersion?: string;
    environment?: string;
    release?: string;
    enabled?: boolean;
    allowLocalEndpoints?: boolean;
    fetchImpl?: typeof fetch;
    warn?: (message: string) => void;
    waitUntil?: (promise: Promise<void>) => void;
}

export interface HqSpanOptions {
    attributes?: Record<string, unknown>;
}

interface HqRuntimeConfig {
    sentryDsn: string;
    sentryEnvelopeUrl: string;
    otlpTracesUrl: string;
    serviceName: string;
    serviceVersion: string;
    environment: string;
    release: string;
    fetchImpl: typeof fetch;
    warn: (message: string) => void;
    waitUntil?: (promise: Promise<void>) => void;
}

interface HqSpanData {
    name: string;
    startUnixNano: string;
    endUnixNano: string;
    attributes: Record<string, unknown>;
    status: "ok" | "error";
}

interface HqState {
    status: HqTelemetryStatus;
    config: HqRuntimeConfig | null;
    warningEmitted: Set<string>;
    pending: Set<Promise<void>>;
}

const INTERNAL_HOSTS = new Set(["logs.example.com", "staging.logs.example.com"]);
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);
const state: HqState = {
    status: "disabled",
    config: null,
    warningEmitted: new Set(),
    pending: new Set(),
};

// Cave rule: no outside Sentry. Only CH5 logs cave, or local proof cave.
export function initializeHqInstrumentation(config: HqInstrumentationConfig = {}): HqTelemetryStatus {
    const enabled = config.enabled ?? true;
    if (!enabled) {
        state.status = "disabled";
        state.config = null;
        return state.status;
    }

    const sentryDsn = config.sentryDsn;
    const otlpEndpoint = config.otlpEndpoint;
    const warn = config.warn ?? ((message) => console.warn(message));
    const allowLocalEndpoints = config.allowLocalEndpoints ?? false;

    if (!sentryDsn && !otlpEndpoint) {
        warnOnce(
            warn,
            "missing-config",
            "[padloc-worker:hq] HQ instrumentation disabled: set HQ_SENTRY_DSN and HQ_OTLP_ENDPOINT via Hush-backed Worker secrets."
        );
        state.status = "disabled";
        state.config = null;
        return state.status;
    }
    if (!sentryDsn || !otlpEndpoint) {
        throw new Error("HQ instrumentation mis-wired: both HQ_SENTRY_DSN and HQ_OTLP_ENDPOINT must be set.");
    }

    state.config = {
        sentryDsn,
        sentryEnvelopeUrl: parseInternalSentryDsn(sentryDsn, allowLocalEndpoints),
        otlpTracesUrl: parseInternalOtlpEndpoint(otlpEndpoint, allowLocalEndpoints),
        serviceName: config.serviceName ?? "padloc-worker",
        serviceVersion: config.serviceVersion ?? "0.0.0",
        environment: config.environment ?? "development",
        release: config.release ?? `padloc-worker@${config.serviceVersion ?? "0.0.0"}`,
        fetchImpl: config.fetchImpl ?? fetch,
        warn,
        waitUntil: config.waitUntil,
    };
    state.status = "ready";
    return state.status;
}

export function initializeHqInstrumentationFromEnv(env: Env, ctx?: ExecutionContext): HqTelemetryStatus {
    return initializeHqInstrumentation({
        sentryDsn: env.HQ_SENTRY_DSN,
        otlpEndpoint: env.HQ_OTLP_ENDPOINT,
        serviceName: env.HQ_SERVICE_NAME || "padloc-worker",
        serviceVersion: env.VERSION || "0.0.0",
        environment: env.HQ_ENVIRONMENT || "development",
        release: env.HQ_RELEASE || `padloc-worker@${env.VERSION || "0.0.0"}`,
        allowLocalEndpoints: env.HQ_ALLOW_LOCAL_ENDPOINTS === "1",
        waitUntil: ctx ? (promise) => ctx.waitUntil(promise) : undefined,
    });
}

export function hqInstrumentationStatus(): HqTelemetryStatus {
    return state.status;
}

export function captureHqException(error: unknown, attributes: Record<string, unknown> = {}): void {
    const config = state.config;
    if (!config) return;
    enqueue(sendSentryEvent(config, error, attributes), config);
}

export async function withHqSpan<T>(name: string, options: HqSpanOptions, fn: () => Promise<T>): Promise<T> {
    const span = startHqSpan(name, options);
    try {
        const result = await fn();
        span.end({ status: "ok" });
        return result;
    } catch (error) {
        span.recordException(error);
        span.end({ status: "error" });
        throw error;
    }
}

export function startHqSpan(
    name: string,
    options: HqSpanOptions = {}
): {
    setAttribute: (key: string, value: unknown) => void;
    recordException: (error: unknown) => void;
    end: (result?: { status?: "ok" | "error"; attributes?: Record<string, unknown> }) => void;
} {
    const config = state.config;
    const startUnixNano = nowUnixNano();
    const attributes = sanitizeAttributes(options.attributes ?? {});
    let ended = false;
    return {
        setAttribute(key, value) {
            attributes[key] = sanitizeValue(value);
        },
        recordException(error) {
            captureHqException(error, { ...attributes, "span.name": name });
        },
        end(result = {}) {
            if (ended || !config) return;
            ended = true;
            const payload = buildOtlpTracePayload(config, {
                name,
                startUnixNano,
                endUnixNano: nowUnixNano(),
                attributes: { ...attributes, ...(result.attributes ? sanitizeAttributes(result.attributes) : {}) },
                status: result.status ?? "ok",
            });
            enqueue(postJson(config, config.otlpTracesUrl, payload), config);
        },
    };
}

export async function flushHqInstrumentation(): Promise<void> {
    const pending = [...state.pending];
    if (pending.length === 0) return;
    await Promise.allSettled(pending);
}

export function resetHqInstrumentationForTests(): void {
    state.status = "disabled";
    state.config = null;
    state.warningEmitted.clear();
    state.pending.clear();
}

function parseInternalSentryDsn(dsn: string, allowLocalEndpoints: boolean): string {
    let url: URL;
    try {
        url = new URL(dsn);
    } catch {
        throw new Error("HQ instrumentation mis-wired: HQ_SENTRY_DSN is not a valid URL.");
    }
    assertInternalHost(url, "HQ_SENTRY_DSN", allowLocalEndpoints);
    if (/sentry\.io$/i.test(url.hostname) || url.hostname.includes("ingest.sentry.io")) {
        throw new Error("HQ instrumentation mis-wired: HQ_SENTRY_DSN must target logs.example.com, not sentry.io.");
    }
    const pathParts = url.pathname.split("/").filter(Boolean);
    const projectId = pathParts[pathParts.length - 1] || url.username || "padloc-worker";
    return `${url.origin}/api/${projectId}/envelope/`;
}

function parseInternalOtlpEndpoint(endpoint: string, allowLocalEndpoints: boolean): string {
    let url: URL;
    try {
        url = new URL(endpoint);
    } catch {
        throw new Error("HQ instrumentation mis-wired: HQ_OTLP_ENDPOINT is not a valid URL.");
    }
    assertInternalHost(url, "HQ_OTLP_ENDPOINT", allowLocalEndpoints);
    if (url.pathname === "/" || url.pathname === "") {
        url.pathname = "/v1/traces";
    } else if (!url.pathname.endsWith("/v1/traces")) {
        url.pathname = `${url.pathname.replace(/\/$/, "")}/v1/traces`;
    }
    return url.toString();
}

function assertInternalHost(url: URL, label: string, allowLocalEndpoints: boolean): void {
    const host = url.hostname.toLowerCase();
    if (INTERNAL_HOSTS.has(host)) return;
    if (allowLocalEndpoints && LOCAL_HOSTS.has(host)) return;
    throw new Error(`HQ instrumentation mis-wired: ${label} must target logs.example.com or staging.logs.example.com.`);
}

async function sendSentryEvent(
    config: HqRuntimeConfig,
    error: unknown,
    attributes: Record<string, unknown>
): Promise<void> {
    const eventId = randomHex(16);
    const normalized = normalizeError(error);
    const body = [
        JSON.stringify({ event_id: eventId, dsn: config.sentryDsn, sent_at: new Date().toISOString() }),
        JSON.stringify({ type: "event" }),
        JSON.stringify({
            event_id: eventId,
            timestamp: new Date().toISOString(),
            platform: "javascript",
            level: "error",
            environment: config.environment,
            release: config.release,
            logger: "padloc-worker",
            exception: {
                values: [
                    {
                        type: normalized.name,
                        value: normalized.message,
                        stacktrace: normalized.stack
                            ? { frames: [{ filename: "padloc-worker", function: normalized.stack }] }
                            : undefined,
                    },
                ],
            },
            tags: {
                service: config.serviceName,
                "ch5.source": "padloc-worker",
            },
            extra: sanitizeAttributes(attributes),
        }),
    ].join("\n");
    await post(config, config.sentryEnvelopeUrl, body, "application/x-sentry-envelope");
}

function buildOtlpTracePayload(config: HqRuntimeConfig, span: HqSpanData): unknown {
    return {
        resourceSpans: [
            {
                resource: {
                    attributes: otlpAttributes({
                        "service.name": config.serviceName,
                        "service.version": config.serviceVersion,
                        "deployment.environment": config.environment,
                        "ch5.source": "padloc-worker",
                    }),
                },
                scopeSpans: [
                    {
                        scope: { name: "padloc-worker.hq", version: config.serviceVersion },
                        spans: [
                            {
                                traceId: randomHex(16),
                                spanId: randomHex(8),
                                name: span.name,
                                kind: 2,
                                startTimeUnixNano: span.startUnixNano,
                                endTimeUnixNano: span.endUnixNano,
                                attributes: otlpAttributes(span.attributes),
                                status: { code: span.status === "error" ? 2 : 1 },
                            },
                        ],
                    },
                ],
            },
        ],
    };
}

async function postJson(config: HqRuntimeConfig, url: string, payload: unknown): Promise<void> {
    await post(config, url, JSON.stringify(payload), "application/json");
}

async function post(config: HqRuntimeConfig, url: string, body: string, contentType: string): Promise<void> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 1500);
    try {
        const response = await config.fetchImpl(url, {
            method: "POST",
            headers: { "content-type": contentType },
            body,
            signal: controller.signal,
        });
        if (!response.ok) {
            throw new Error(`HQ responded ${response.status}`);
        }
    } finally {
        clearTimeout(timeout);
    }
}

function enqueue(promise: Promise<void>, config: HqRuntimeConfig): void {
    // Cave rule: telemetry fall down, Worker keep serving, human sees smoke.
    const tracked = promise
        .catch((error) => {
            const message = error instanceof Error ? error.message : String(error);
            state.status = "degraded";
            warnOnce(
                config.warn,
                "unreachable",
                `[padloc-worker:hq] HQ telemetry unreachable; continuing without crash: ${message}`
            );
        })
        .finally(() => {
            state.pending.delete(tracked);
        });
    state.pending.add(tracked);
    config.waitUntil?.(tracked);
}

function warnOnce(warn: (message: string) => void, key: string, message: string): void {
    if (state.warningEmitted.has(key)) return;
    state.warningEmitted.add(key);
    warn(message);
}

function normalizeError(error: unknown): { name: string; message: string; stack?: string } {
    if (error instanceof Error) {
        return { name: error.name, message: error.message, stack: error.stack };
    }
    return { name: "Error", message: String(error) };
}

function sanitizeAttributes(attributes: Record<string, unknown>): Record<string, unknown> {
    // SECURITY: field-name-based redaction (password/key/vault/session/...
    // patterns, see observability/log-redaction.ts) runs BEFORE the
    // existing length-truncation below. Previously this module had its
    // OWN weaker sanitization (truncate long strings to 160 chars) that
    // never filtered by field name at all, while log-redaction.ts's
    // `redact()`/`isSensitiveField()` -- written specifically for this
    // purpose -- sat completely unused/uncalled anywhere in the codebase.
    // Deliberately NOT applied to the exception name/message/stack in
    // sendSentryEvent(): those are intentionally passed through in full so
    // operators can actually debug `report: true` errors (see error.ts's
    // sanitizeError() design) -- only the surrounding `attributes`/`extra`
    // span data (which can carry arbitrary structured caller-supplied
    // fields) needs this.
    const redacted = redact(attributes);
    return Object.fromEntries(Object.entries(redacted).map(([key, value]) => [key, sanitizeValue(value)]));
}

function sanitizeValue(value: unknown): unknown {
    if (value === null || value === undefined) return value;
    if (typeof value === "string") return value.length > 160 ? `${value.slice(0, 157)}...` : value;
    if (typeof value === "number" || typeof value === "boolean") return value;
    if (Array.isArray(value)) return value.length;
    return String(value);
}

function otlpAttributes(attributes: Record<string, unknown>): Array<{ key: string; value: Record<string, unknown> }> {
    return Object.entries(attributes).map(([key, value]) => ({ key, value: otlpAnyValue(value) }));
}

function otlpAnyValue(value: unknown): Record<string, unknown> {
    if (typeof value === "boolean") return { boolValue: value };
    if (typeof value === "number") return Number.isInteger(value) ? { intValue: value } : { doubleValue: value };
    return { stringValue: value === undefined || value === null ? "" : String(value) };
}

function randomHex(bytes: number): string {
    const values = new Uint8Array(bytes);
    crypto.getRandomValues(values);
    return [...values].map((value) => value.toString(16).padStart(2, "0")).join("");
}

function nowUnixNano(): string {
    return String(BigInt(Date.now()) * 1_000_000n);
}
