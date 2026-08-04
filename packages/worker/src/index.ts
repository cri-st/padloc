import { Request as PlRequest, Response as PlResponse } from "@padloc/core/src/transport";
import { WorkerReceiver, WorkerReceiverConfig } from "./transport";
import { IdempotencyStore } from "./idempotency";
import { Env } from "./env";
import { createServer } from "./server-factory";
import { AccountLockDO } from "./locks/account-lock";
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

export { AccountLockDO };

export default {
    async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
        initializeHqInstrumentationFromEnv(env, ctx);

        const allowOrigin = env.ALLOW_ORIGIN || "*";
        const config = new WorkerReceiverConfig();
        config.allowOrigin = allowOrigin;
        config.idempotencyStore = new IdempotencyStore(env.HINTS);
        config.rateLimiter = new RateLimiter(env.HINTS, {
            maxRequests: Number(env.RATE_LIMIT_MAX_REQUESTS || 100),
            windowMs: Number(env.RATE_LIMIT_WINDOW_MS || 60000),
        });
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
