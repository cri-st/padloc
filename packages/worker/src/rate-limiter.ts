/**
 * Token-bucket rate limiting. Two implementations share the same
 * `RateLimiterLike` interface:
 *
 * - `RateLimiter` (KV-backed): get()-then-put(), no compare-and-swap.
 *   Best-effort only -- two concurrent requests for the same identity can
 *   both read the same token count before either write lands, letting
 *   both through for the price of one token. Kept as the storage-layer
 *   implementation for tests/reference; no longer wired into a real
 *   request path (see below).
 * - `DurableObjectRateLimiter` (DO-backed, see
 *   `durable-objects/rate-limit.ts`): structurally atomic, the same
 *   guarantee `ShareLinkDO` relies on for single-view atomicity. Used for
 *   BOTH the anonymous share-view throttle (`SHARE_VIEW_RATE_LIMIT`
 *   binding) and the general-purpose per-IP limiter that gates every POST
 *   request before RPC dispatch (`GENERAL_RATE_LIMIT` binding, see
 *   `index.ts`) -- a security audit found the KV race meaningfully erodes
 *   brute-force defenses on BOTH surfaces, including
 *   completeCreateSession/startCreateSession/signup/password-reset, which
 *   only the general-purpose limiter protects.
 *
 * Per-identity (IP or account ID) with configurable:
 * - maxRequests: tokens per window
 * - windowMs: refill window in milliseconds
 *
 * Returns { allowed: boolean, remaining: number, retryAfterMs?: number }.
 *
 * When the underlying binding is unavailable, both implementations no-op
 * and always allow -- this prevents the limiter from becoming a single
 * point of failure.
 */
import { RateLimitStub } from "./durable-objects/rate-limit";

export interface RateLimitResult {
    allowed: boolean;
    remaining: number;
    retryAfterMs?: number;
}

export interface RateLimiterLike {
    check(identity: string): Promise<RateLimitResult>;
}

export class RateLimiter implements RateLimiterLike {
    private kv?: KVNamespace;
    private maxRequests: number;
    private windowMs: number;

    constructor(kv?: KVNamespace, opts?: { maxRequests?: number; windowMs?: number }) {
        this.kv = kv;
        this.maxRequests = opts?.maxRequests ?? 100;
        this.windowMs = opts?.windowMs ?? 60_000;
    }

    async check(identity: string): Promise<RateLimitResult> {
        if (!this.kv) {
            return { allowed: true, remaining: this.maxRequests };
        }

        const key = `rl:${identity}`;
        const raw = await this.kv.get<{ tokens: number; windowStart: number }>(key, "json");
        const now = Date.now();

        if (!raw || now - raw.windowStart >= this.windowMs) {
            await this.kv.put(key, JSON.stringify({ tokens: this.maxRequests - 1, windowStart: now }), {
                expirationTtl: Math.ceil(this.windowMs / 1000) + 60,
            });
            return { allowed: true, remaining: this.maxRequests - 1 };
        }

        if (raw.tokens <= 0) {
            const retryAfterMs = this.windowMs - (now - raw.windowStart);
            return { allowed: false, remaining: 0, retryAfterMs };
        }

        raw.tokens -= 1;
        await this.kv.put(key, JSON.stringify(raw), {
            expirationTtl: Math.ceil(this.windowMs / 1000) + 60,
        });
        return { allowed: true, remaining: raw.tokens };
    }
}

/** Structurally atomic rate limiter backed by `RateLimitDO`. */
export class DurableObjectRateLimiter implements RateLimiterLike {
    constructor(
        private namespace: DurableObjectNamespace | undefined,
        private opts?: { maxRequests?: number; windowMs?: number }
    ) {}

    async check(identity: string): Promise<RateLimitResult> {
        const maxRequests = this.opts?.maxRequests ?? 100;
        const windowMs = this.opts?.windowMs ?? 60_000;

        if (!this.namespace) {
            return { allowed: true, remaining: maxRequests };
        }

        const stub = this.namespace.get(this.namespace.idFromName(identity)) as unknown as RateLimitStub;
        return stub.consume(maxRequests, windowMs);
    }
}
