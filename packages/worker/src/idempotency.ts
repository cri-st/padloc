/**
 * Simple idempotency store backed by KVNamespace (hint-only, non-blocking).
 *
 * Key format: `idem:<requestHash>` → the exact raw RPC response body
 * (`Response.toRaw()` shape: `{ result, error?, auth? }`), verbatim.
 * TTL: 3600 seconds (1 hour) — long enough for retry windows.
 *
 * Idempotency is contract-level: the hash covers the full request body so
 * duplicate sends of the same marshalled request replay the SAME raw
 * response the first call produced -- success replays as success, error
 * replays as the same error. Storing anything other than the verbatim raw
 * response (e.g. a synthetic always-error wrapper) would misreport a
 * genuinely successful call as failed on replay.
 */
export class IdempotencyStore {
    private kv?: KVNamespace;

    constructor(kv?: KVNamespace) {
        this.kv = kv;
    }

    async lookup(requestHash: string): Promise<Record<string, unknown> | null> {
        if (!this.kv) return null;
        return this.kv.get<Record<string, unknown>>(`idem:${requestHash}`, "json");
    }

    async store(requestHash: string, rawResponse: Record<string, unknown>): Promise<void> {
        if (!this.kv) return;
        await this.kv.put(`idem:${requestHash}`, JSON.stringify(rawResponse), {
            expirationTtl: 3600,
        });
    }
}

/**
 * Simple SHA-256 hex hash for request body content.
 * Uses the Web Crypto Subtle digest API — available in Workers.
 */
export async function hashRequestBody(body: string): Promise<string> {
    const data = new TextEncoder().encode(body);
    const digest = await crypto.subtle.digest("SHA-256", data.buffer as ArrayBuffer);
    return Array.from(new Uint8Array(digest))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
}
