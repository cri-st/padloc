import { Request as PlRequest, Response as PlResponse } from "@padloc/core/src/transport";
import { ErrorCode } from "@padloc/core/src/error";
import { ANONYMOUS_SHARE_METHODS } from "@padloc/core/src/share";
import { WorkerReceiver, WorkerReceiverConfig } from "./transport";
import { IdempotencyStore } from "./idempotency";
import { Env } from "./env";
import { createServer } from "./server-factory";
import { AccountLockDO } from "./locks/account-lock";
import { ShareLinkDO } from "./durable-objects/share-link";
import { RateLimitDO } from "./durable-objects/rate-limit";
import { Server } from "@padloc/core/src/server";
import { responseHeaders } from "./observability/security-headers";
import { DurableObjectRateLimiter, RateLimiterLike } from "./rate-limiter";
import { captureHqException, initializeHqInstrumentationFromEnv, withHqSpan } from "./hq-instrumentation";

let cachedServer: Server | undefined;

/** Parses a numeric env var, falling back to `fallback` for anything that
 * isn't a finite positive number (missing, empty, non-numeric, zero,
 * negative) -- see RateLimitDO.consume()'s matching guard for why a bare
 * `Number(...)` here was a fail-open bug. */
function safeParsePositiveNumber(value: string | undefined, fallback: number): number {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : fallback;
}

interface HealthcheckStatus {
    status: "ok" | "degraded";
    version: string;
    d1: "ok" | "unavailable";
    r2: "ok" | "unavailable";
    resend: "ok" | "unavailable";
}

async function healthcheck(env: Env): Promise<HealthcheckStatus> {
    const health: HealthcheckStatus = {
        status: "ok",
        version: env.VERSION || "0.0.0",
        d1: "unavailable",
        r2: "unavailable",
        resend: "unavailable",
    };

    if (env.DB) {
        try {
            await env.DB.prepare("SELECT 1").first();
            health.d1 = "ok";
        } catch {
            health.d1 = "unavailable";
        }
    }

    if (env.ATTACHMENTS) {
        try {
            await env.ATTACHMENTS.list({ limit: 1 });
            health.r2 = "ok";
        } catch {
            health.r2 = "unavailable";
        }
    }

    if (env.EMAIL_BACKEND === "mock" || (env.RESEND_API_KEY && env.EMAIL_FROM_ADDRESS)) {
        health.resend = "ok";
    }

    if (health.d1 !== "ok" || health.r2 !== "ok" || health.resend !== "ok") {
        health.status = "degraded";
    }

    return health;
}

export { AccountLockDO, ShareLinkDO, RateLimitDO };

/**
 * RPC methods gated by the share-view rate limiter (anonymous,
 * brute-forceable). Same set `@padloc/core`'s `ANONYMOUS_SHARE_METHODS`
 * uses to keep the client/server identity-free -- re-exported under the
 * historical local name here rather than duplicated, so the two lists
 * can never drift apart.
 */
const SHARE_VIEW_METHODS = ANONYMOUS_SHARE_METHODS;

/**
 * Derives the rate-limit identities for an anonymous share-view request --
 * both an IP-scoped key (blocks enumeration across many share ids from one
 * origin) and a share-scoped key (blocks brute-forcing one share id from
 * many origins). Returns `null` for any other RPC method, meaning no
 * share-view limit applies.
 */
export function shareViewRateLimitKeys(method: string, params: unknown[] | undefined, ip: string): string[] | null {
    if (!SHARE_VIEW_METHODS.has(method)) {
        return null;
    }
    const shareId = typeof params?.[0] === "string" ? params[0] : "unknown";
    return [`share-view:ip:${ip}`, `share-view:share:${shareId}`];
}

/**
 * RPC methods that touch the login/signup/account-recovery critical path.
 * These are already protected by the persistent account-lockout counter
 * (per-email, see account-lock.ts) and the coarse 100/min-per-IP general
 * limiter above, but neither of those is method-scoped: the general
 * limiter budget is shared with every other RPC call a legitimate client
 * makes (vault sync, item CRUD, ...), so an attacker distributing guesses
 * across many different accounts (never tripping any single account's
 * lockout) can still consume a large fraction of that shared 100/min
 * budget on login attempts alone. A tighter, method-scoped limiter here
 * closes that gap without affecting normal usage of every other endpoint.
 */
const AUTH_SENSITIVE_METHODS = new Set([
    "startCreateSession",
    "completeCreateSession",
    "startAuthRequest",
    "completeAuthRequest",
    "createAccount",
    "recoverAccount",
    // Legacy (V3Compat) equivalents -- see core/src/v3-compat.ts.
    "initAuth",
    "createSession",
    "requestMFACode",
    "retrieveMFAToken",
]);

/**
 * Checks the auth-sensitive rate limiter for a request. Returns `true`
 * when the request is allowed (including every request whose method isn't
 * in `AUTH_SENSITIVE_METHODS`, which this limiter doesn't apply to).
 */
export async function checkAuthRateLimit(method: string, ip: string, limiter: RateLimiterLike): Promise<boolean> {
    if (!AUTH_SENSITIVE_METHODS.has(method)) {
        return true;
    }
    const result = await limiter.check(`auth-strict:ip:${ip}`);
    return result.allowed;
}

/**
 * Checks the share-view rate limiter for a request. Returns `true` when the
 * request is allowed (including every request whose method isn't
 * `peekShare`/`revealShare`, which this limiter doesn't apply to).
 */
export async function checkShareViewRateLimit(
    method: string,
    params: unknown[] | undefined,
    ip: string,
    limiter: RateLimiterLike
): Promise<boolean> {
    const keys = shareViewRateLimitKeys(method, params, ip);
    if (!keys) {
        return true;
    }
    const results = await Promise.all(keys.map((key) => limiter.check(key)));
    return results.every((result) => result.allowed);
}

export default {
    async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
        initializeHqInstrumentationFromEnv(env, ctx);

        const allowOrigin = env.ALLOW_ORIGIN || "*";
        // SECURITY: previously blocked wildcard CORS only when
        // HQ_ENVIRONMENT was EXACTLY "production"/"staging" -- an
        // operator who deploys without setting that (optional, telemetry
        // -oriented) var at all silently got wildcard CORS with no
        // warning. Inverted to an allowlist of known-safe environments
        // instead: any deployment whose HQ_ENVIRONMENT is missing,
        // misspelled, or simply not one of the local/dev-oriented values
        // below now fails closed rather than fails open. The committed
        // wrangler.toml (dev) and wrangler.local.toml.example
        // (staging/production) templates already set HQ_ENVIRONMENT
        // correctly, so this doesn't change behavior for a deployment
        // following those templates -- only for one that doesn't.
        const WILDCARD_CORS_SAFE_ENVIRONMENTS = new Set(["development", "preview", "test", "local"]);
        if (allowOrigin === "*" && !WILDCARD_CORS_SAFE_ENVIRONMENTS.has(env.HQ_ENVIRONMENT || "")) {
            captureHqException(
                new Error(
                    `ALLOW_ORIGIN misconfigured: resolved to '*' in HQ_ENVIRONMENT=${JSON.stringify(
                        env.HQ_ENVIRONMENT || null
                    )} (not a recognized safe-for-wildcard environment)`
                ),
                requestAttributes(request)
            );
            return new Response(JSON.stringify({ error: "server_misconfigured" }), {
                status: 503,
                headers: responseHeaders(
                    { allowOrigin: "*" },
                    undefined,
                    { "Content-Type": "application/json; charset=utf-8" }
                ),
            });
        }
        const config = new WorkerReceiverConfig();
        config.allowOrigin = allowOrigin;
        config.idempotencyStore = new IdempotencyStore(env.HINTS);
        // Structurally atomic (Durable-Object-backed) -- this is the exact
        // race the share-view limiter below was already hardened against
        // (KV get()-then-put() has no compare-and-swap, letting concurrent
        // requests for the same identity double-spend a token). This
        // general-purpose limiter gates EVERY POST request before RPC
        // dispatch (see WorkerReceiver._handlePost), including
        // completeCreateSession/startCreateSession/signup/password-reset,
        // so leaving it on the racy KV implementation left the login/
        // account-creation surface without the same fix. `GENERAL_RATE_LIMIT`
        // binding is optional (falls back to always-allow, same as every
        // other optional binding in this file) so deployments that haven't
        // added the migration yet degrade safely rather than 500ing.
        // SECURITY: validated instead of a bare Number(...) -- an invalid
        // (non-numeric) env var value produces NaN, and NaN comparisons
        // are always false, which silently disabled rate limiting
        // entirely (see RateLimitDO.consume()'s matching defense).
        config.rateLimiter = new DurableObjectRateLimiter(env.GENERAL_RATE_LIMIT, {
            maxRequests: safeParsePositiveNumber(env.RATE_LIMIT_MAX_REQUESTS, 100),
            windowMs: safeParsePositiveNumber(env.RATE_LIMIT_WINDOW_MS, 60000),
        });
        // Structurally atomic (Durable-Object-backed) -- a security audit
        // found the KV-backed RateLimiter's get()-then-put() has no
        // compare-and-swap, letting concurrent requests double-spend a
        // token and erode this throttle. `SHARE_VIEW_RATE_LIMIT` binding
        // is optional (falls back to always-allow, same as every other
        // optional binding in this file) so deployments that haven't
        // added the migration yet degrade safely rather than 500ing.
        const shareViewRateLimiter = new DurableObjectRateLimiter(env.SHARE_VIEW_RATE_LIMIT, {
            maxRequests: 10,
            windowMs: 60_000,
        });
        // Reuses the SAME `GENERAL_RATE_LIMIT` Durable Object namespace as
        // the general-purpose limiter above (no new binding/migration
        // needed) -- `RateLimitDO` instances are keyed per-identity via
        // `idFromName`, so the distinct "auth-strict:" key prefix in
        // `checkAuthRateLimit` maps to entirely separate DO instances with
        // their own independent bucket state and limits.
        const authRateLimiter = new DurableObjectRateLimiter(env.GENERAL_RATE_LIMIT, {
            maxRequests: 20,
            windowMs: 60_000,
        });
        const receiver = new WorkerReceiver(config);

        const url = new URL(request.url);
        if (request.method === "GET" && url.pathname === config.healthCheckPath) {
            const health = await withHqSpan(
                "padloc.worker.healthcheck",
                { attributes: requestAttributes(request) },
                () => healthcheck(env)
            );
            // SECURITY: this endpoint is intentionally reachable with no
            // auth and no rate limiting (load balancers need it to work
            // unconditionally), so it must not hand an unauthenticated
            // caller a per-subsystem breakdown (which of D1/R2/Resend is
            // currently degraded) -- low-value recon, but recon
            // nonetheless. `healthcheck(env)` still computes and returns
            // the full per-subsystem detail (kept for any future
            // operator-facing surface), but only status/version are put
            // in the public HTTP response below.
            return new Response(JSON.stringify({ status: health.status, version: health.version }), {
                status: 200,
                headers: responseHeaders({ allowOrigin }, undefined, {
                    "Content-Type": "application/json; charset=utf-8",
                }),
            });
        }

        if (!cachedServer) {
            try {
                cachedServer = createServer(env);
            } catch (error) {
                captureHqException(error, requestAttributes(request));
                return new Response(JSON.stringify({ error: "server_misconfigured" }), {
                    status: 503,
                    headers: responseHeaders({ allowOrigin }, undefined, {
                        "Content-Type": "application/json; charset=utf-8",
                    }),
                });
            }
        }
        const server = cachedServer;

        return withHqSpan("padloc.worker.fetch", { attributes: requestAttributes(request) }, async () => {
            try {
                return await receiver.handleFetch(
                    request,
                    async (req: PlRequest): Promise<PlResponse> => {
                        const ip =
                            request.headers.get("cf-connecting-ip") ||
                            request.headers.get("x-forwarded-for") ||
                            "anonymous";
                        const shareViewAllowed = await checkShareViewRateLimit(
                            req.method,
                            req.params,
                            ip,
                            shareViewRateLimiter
                        );
                        if (!shareViewAllowed) {
                            const res = new PlResponse();
                            res.error = {
                                code: ErrorCode.BAD_REQUEST,
                                message: "Too many requests. Please try again later.",
                            };
                            return res;
                        }
                        const authAllowed = await checkAuthRateLimit(req.method, ip, authRateLimiter);
                        if (!authAllowed) {
                            const res = new PlResponse();
                            res.error = {
                                code: ErrorCode.BAD_REQUEST,
                                message: "Too many requests. Please try again later.",
                            };
                            return res;
                        }
                        return withHqSpan(
                            "padloc.worker.core_request",
                            {
                                attributes: {
                                    ...requestAttributes(request),
                                    "padloc.request.kind": req.kind,
                                    "padloc.request.device": req.device?.appName,
                                },
                            },
                            () => server.handle(req)
                        );
                    },
                    env,
                    ctx
                );
            } catch (error) {
                captureHqException(error, requestAttributes(request));
                throw error;
            }
        });
    },
};

function requestAttributes(request: Request): Record<string, unknown> {
    const url = new URL(request.url);
    return {
        "http.request.method": request.method,
        "url.path": url.pathname,
        "url.host": url.host,
        "user_agent.original": request.headers.get("user-agent") || "",
    };
}
