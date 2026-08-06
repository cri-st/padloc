import { Receiver, Request, Sender, Response as CoreResponse } from "@padloc/core/src/transport";
import { marshal, unmarshal } from "@padloc/core/src/encoding";
import { Err, ErrorCode } from "@padloc/core/src/error";
import { IdempotencyStore, hashRequestBody } from "./idempotency";
import { sanitizeError } from "./error";
import { RateLimiter } from "./rate-limiter";
import { responseHeaders } from "./observability/security-headers";
import { captureHqException } from "./hq-instrumentation";

const DEFAULT_MAX_REQUEST_SIZE = 25 * 1024 * 1024;
const DEFAULT_MAX_REQUEST_AGE_MS = 5 * 60 * 1000;
const DEFAULT_CLOCK_SKEW_TOLERANCE_MS = 30 * 1000;

function errorResponse(err: Err, allowOrigin: string): Response {
    return new Response(JSON.stringify({ error: { code: err.code, message: err.message } }), {
        status: statusForError(err),
        headers: responseHeaders({ allowOrigin: allowOrigin || "*" }, undefined, {
            "Content-Type": "application/json; charset=utf-8",
        }),
    });
}

function statusForError(err: Err): number {
    switch (err.code) {
        case ErrorCode.INVALID_REQUEST:
        case ErrorCode.BAD_REQUEST:
        case ErrorCode.MAX_REQUEST_SIZE_EXCEEDED:
        case ErrorCode.MAX_REQUEST_AGE_EXCEEDED:
            return 400;
        case ErrorCode.INVALID_SESSION:
        case ErrorCode.SESSION_EXPIRED:
        case ErrorCode.INVALID_CREDENTIALS:
        case ErrorCode.AUTHENTICATION_REQUIRED:
        case ErrorCode.AUTHENTICATION_FAILED:
            return 401;
        case ErrorCode.INSUFFICIENT_PERMISSIONS:
        case ErrorCode.MISSING_ACCESS:
            return 403;
        case ErrorCode.NOT_FOUND:
            return 404;
        default:
            return 500;
    }
}

export class WorkerReceiverConfig {
    allowOrigin: string = "*";
    maxRequestSize: number = DEFAULT_MAX_REQUEST_SIZE;
    maxRequestAgeMs: number = DEFAULT_MAX_REQUEST_AGE_MS;
    clockSkewToleranceMs: number = DEFAULT_CLOCK_SKEW_TOLERANCE_MS;
    healthCheckPath: string = "/healthcheck";
    idempotencyStore?: IdempotencyStore;
    rateLimiter?: RateLimiter;
}

export class WorkerReceiver implements Receiver {
    constructor(public readonly config: WorkerReceiverConfig = new WorkerReceiverConfig()) {}

    listen(_handler: (req: Request) => Promise<CoreResponse>): void {
        // Workers are per-request; use handleFetch instead.
    }

    async handleFetch(
        request: globalThis.Request,
        handler: (req: Request) => Promise<CoreResponse>,
        _env: unknown,
        _ctx: unknown
    ): Promise<Response> {
        return this._route(request, handler);
    }

    private async _route(
        request: globalThis.Request,
        handler: (req: Request) => Promise<CoreResponse>
    ): Promise<Response> {
        const url = new URL(request.url);
        const allowOrigin = this.config.allowOrigin;

        if (request.method === "OPTIONS") {
            return new Response(null, {
                status: 204,
                headers: responseHeaders({ allowOrigin: allowOrigin || "*" }),
            });
        }

        if (request.method === "GET" && url.pathname === this.config.healthCheckPath) {
            return new Response(null, {
                status: 200,
                headers: responseHeaders({ allowOrigin: allowOrigin || "*" }),
            });
        }

        if (request.method === "POST" && url.pathname === "/") {
            return this._handlePost(request, handler);
        }

        return new Response(JSON.stringify({ error: { code: ErrorCode.BAD_REQUEST, message: "Method not allowed" } }), {
            status: 405,
            headers: responseHeaders({ allowOrigin: allowOrigin || "*" }, undefined, {
                "Content-Type": "application/json; charset=utf-8",
            }),
        });
    }

    private async _handlePost(
        request: globalThis.Request,
        handler: (req: Request) => Promise<CoreResponse>
    ): Promise<Response> {
        const allowOrigin = this.config.allowOrigin;
        const identity =
            request.headers.get("cf-connecting-ip") || request.headers.get("x-forwarded-for") || "anonymous";

        if (this.config.rateLimiter) {
            const rateResult = await this.config.rateLimiter.check(identity);
            if (!rateResult.allowed) {
                return new Response(
                    JSON.stringify({
                        error: {
                            code: ErrorCode.BAD_REQUEST,
                            message: "Too many requests. Please try again later.",
                        },
                    }),
                    {
                        status: 429,
                        headers: responseHeaders({ allowOrigin: allowOrigin || "*" }, undefined, {
                            "Content-Type": "application/json; charset=utf-8",
                            "Retry-After": String(Math.ceil((rateResult.retryAfterMs || 0) / 1000)),
                        }),
                    }
                );
            }
        }

        const bodyText = await request.text();

        const byteLength = new TextEncoder().encode(bodyText).byteLength;
        if (byteLength > this.config.maxRequestSize) {
            const err = new Err(
                ErrorCode.MAX_REQUEST_SIZE_EXCEEDED,
                `Request body exceeds maximum size of ${this.config.maxRequestSize} bytes`
            );
            return errorResponse(err, allowOrigin);
        }

        let req: Request;
        let rawRequest: Record<string, unknown>;
        try {
            rawRequest = unmarshal(bodyText);
            req = new Request().fromRaw(rawRequest);
        } catch {
            return errorResponse(new Err(ErrorCode.INVALID_REQUEST, "Failed to parse request body"), allowOrigin);
        }

        const cfConnectingIp = request.headers.get("cf-connecting-ip");
        const forwardedFor = request.headers.get("x-forwarded-for");
        req.ipAddress = cfConnectingIp || forwardedFor || undefined;

        if (!validateRequestAge(rawRequest, this.config)) {
            return errorResponse(
                new Err(ErrorCode.MAX_REQUEST_AGE_EXCEEDED, "Request timestamp outside acceptable window"),
                allowOrigin
            );
        }

        const bodyHash = await hashRequestBody(bodyText);
        const existing = await this.config.idempotencyStore?.lookup(bodyHash);
        if (existing) {
            const replayBody = marshal(existing);
            return new Response(replayBody, {
                status: 200,
                headers: {
                    "Content-Type": "application/json; charset=utf-8",
                    "Content-Length": String(new TextEncoder().encode(replayBody).byteLength),
                    "Idempotency-Replayed": "true",
                    ...responseHeaders({ allowOrigin: allowOrigin || "*" }),
                },
            });
        }

        let res: CoreResponse;
        try {
            res = await handler(req);
        } catch (unknown) {
            if (unknown instanceof Err) {
                if (unknown.report) {
                    captureHqException(unknown.originalError || unknown, {
                        "padloc.error.code": unknown.code,
                        "padloc.error.report": true,
                    });
                }
                return errorResponse(unknown, allowOrigin);
            }
            const sanitized = sanitizeError(unknown);
            if (sanitized.report) {
                captureHqException(sanitized.originalError || unknown, {
                    "padloc.error.code": sanitized.code,
                    "padloc.error.report": true,
                });
            }
            return errorResponse(sanitized, allowOrigin);
        }

        const clientVersion = req.device?.appVersion;
        const raw = res.toRaw(clientVersion);

        await this.config.idempotencyStore?.store(bodyHash, raw);

        const resBody = marshal(raw);

        return new Response(resBody, {
            status: 200,
            headers: responseHeaders({ allowOrigin: allowOrigin || "*" }, undefined, {
                "Content-Type": "application/json; charset=utf-8",
                "Content-Length": String(new TextEncoder().encode(resBody).byteLength),
            }),
        });
    }
}

function validateRequestAge(rawRequest: Record<string, unknown>, config: WorkerReceiverConfig): boolean {
    const requestTime = rawRequest.time as number | undefined;
    if (!requestTime) return true;

    const now = Date.now();
    const age = Math.abs(now - requestTime);
    const maxAge = config.maxRequestAgeMs + config.clockSkewToleranceMs;

    return age <= maxAge;
}

export class WorkerSender implements Sender {
    constructor(public url: string) {}

    async send(req: Request): Promise<CoreResponse> {
        const body = marshal(req.toRaw());

        const res = await fetch(this.url, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Accept: "application/json",
            },
            body,
        });

        const resBody = await res.text();

        if (!res.ok) {
            throw new Err(ErrorCode.FAILED_CONNECTION, `HTTP ${res.status} - ${res.statusText}: ${resBody}`);
        }

        return new CoreResponse().fromRaw(unmarshal(resBody));
    }
}

export function marshalRequest(req: Request, clientVersion?: string): string {
    return marshal(req.toRaw(clientVersion));
}

export function unmarshalRequest(body: string): Request {
    const r = new Request();
    r.fromRaw(unmarshal(body));
    return r;
}

export function marshalResponse(res: CoreResponse, clientVersion?: string): string {
    return marshal(res.toRaw(clientVersion));
}

export function unmarshalResponse(body: string): CoreResponse {
    const r = new CoreResponse();
    r.fromRaw(unmarshal(body));
    return r;
}
