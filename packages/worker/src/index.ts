import { Request as PlRequest, Response as PlResponse } from "@padloc/core/src/transport";
import { ErrorCode } from "@padloc/core/src/error";
import { WorkerReceiver, WorkerReceiverConfig } from "./transport";
import { IdempotencyStore } from "./idempotency";
import { Env } from "./env";
import { createServer } from "./server-factory";
import { AccountLockDO } from "./locks/account-lock";
import { ShareLinkDO } from "./durable-objects/share-link";
import { Server } from "@padloc/core/src/server";
import { responseHeaders } from "./observability/security-headers";
import { RateLimiter } from "./rate-limiter";
import { captureHqException, initializeHqInstrumentationFromEnv, withHqSpan } from "./hq-instrumentation";

let cachedServer: Server | undefined;

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

export { AccountLockDO, ShareLinkDO };

/** RPC methods gated by the share-view rate limiter (anonymous, brute-forceable). */
const SHARE_VIEW_METHODS = new Set(["peekShare", "revealShare"]);

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
 * Checks the share-view rate limiter for a request. Returns `true` when the
 * request is allowed (including every request whose method isn't
 * `peekShare`/`revealShare`, which this limiter doesn't apply to).
 */
export async function checkShareViewRateLimit(
    method: string,
    params: unknown[] | undefined,
    ip: string,
    limiter: RateLimiter
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
        if (allowOrigin === "*" && (env.HQ_ENVIRONMENT === "production" || env.HQ_ENVIRONMENT === "staging")) {
            captureHqException(
                new Error(`ALLOW_ORIGIN misconfigured: resolved to '*' in ${env.HQ_ENVIRONMENT}`),
                requestAttributes(request)
            );
            return new Response(JSON.stringify({ error: "server_misconfigured" }), {
                status: 503,
                headers: { "Content-Type": "application/json; charset=utf-8" },
            });
        }
        const config = new WorkerReceiverConfig();
        config.allowOrigin = allowOrigin;
        config.idempotencyStore = new IdempotencyStore(env.HINTS);
        config.rateLimiter = new RateLimiter(env.HINTS, {
            maxRequests: Number(env.RATE_LIMIT_MAX_REQUESTS || 100),
            windowMs: Number(env.RATE_LIMIT_WINDOW_MS || 60000),
        });
        // Conservative fixed default (design.md open question: "10/min/IP, tune
        // post-launch") -- no dedicated Env surface yet, unlike the generic
        // limiter above, to keep this batch's worker/env.ts untouched.
        const shareViewRateLimiter = new RateLimiter(env.HINTS, { maxRequests: 10, windowMs: 60_000 });
        const receiver = new WorkerReceiver(config);

        const url = new URL(request.url);
        if (request.method === "GET" && url.pathname === config.healthCheckPath) {
            const health = await withHqSpan(
                "padloc.worker.healthcheck",
                { attributes: requestAttributes(request) },
                () => healthcheck(env)
            );
            return new Response(JSON.stringify(health), {
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
