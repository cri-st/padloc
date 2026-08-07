/**
 * Canary allowlist used until the extension ships a complete bundled Public
 * Suffix List policy. Keeping this explicit prevents a page on an unrelated
 * domain from activating the provider.
 *
 * Self-hosted/personal forks can append trusted roots at build time via the
 * `PL_PASSKEY_RP_ROOTS` env var (comma-separated), without editing this
 * committed default list. The Google baseline always stays allowed.
 *
 * SECURITY: `PL_PASSKEY_RP_ROOTS` is an operator-supplied build-time env
 * var with no validation -- a misconfigured value (a bare public suffix
 * like "com", or an entry that's actually a multi-tenant hosting suffix
 * like "github.io"/"herokuapp.com") would let ANY page hosted under that
 * suffix -- not just the operator's own site -- activate the passkey
 * provider, i.e. RP impersonation. `REJECTED_RP_ROOT_SUFFIXES` below is
 * not a full Public Suffix List parser -- it's a cheap floor rejecting
 * the most common misconfiguration shapes: single-label entries and a
 * short hardcoded list of well-known multi-tenant suffixes. An obscure
 * multi-tenant suffix outside this list is a residual, accepted risk for
 * this operator-trusted, build-time-only setting.
 */
const REJECTED_RP_ROOT_SUFFIXES: Record<string, true> = {
    com: true,
    org: true,
    net: true,
    io: true,
    co: true,
    app: true,
    dev: true,
    me: true,
    info: true,
    biz: true,
    "github.io": true,
    "herokuapp.com": true,
    "vercel.app": true,
    "netlify.app": true,
    "pages.dev": true,
    "workers.dev": true,
    "web.app": true,
    "firebaseapp.com": true,
    "azurewebsites.net": true,
    "blogspot.com": true,
    "wordpress.com": true,
};

const ADDITIONAL_PASSKEY_RP_ROOTS = (process.env.PL_PASSKEY_RP_ROOTS || "")
    .split(",")
    .map((root) => root.trim().toLowerCase())
    .filter(Boolean)
    .filter((root) => root.includes(".") && !REJECTED_RP_ROOT_SUFFIXES[root]);

export const PASSKEY_APPROVED_RP_ROOTS = Object.freeze(["google.com", ...ADDITIONAL_PASSKEY_RP_ROOTS]);

export function isPasskeyProviderOriginEnabled(origin: string): boolean {
    try {
        const parsed = new URL(origin);
        const host = normalizeHost(parsed.hostname);
        if (
            (parsed.protocol === "http:" || parsed.protocol === "https:") &&
            (host === "localhost" || host === "127.0.0.1" || host === "[::1]")
        ) {
            return true;
        }
        return parsed.protocol === "https:" && PASSKEY_APPROVED_RP_ROOTS.some((root) => isAtOrBelow(host, root));
    } catch {
        return false;
    }
}

/** Trusted suffix policy passed into the core WebAuthn RP/origin validator. */
export function approvePasskeyRpSuffix(rpId: string, originHost: string): boolean {
    const normalizedRpId = normalizeHost(rpId);
    const normalizedOriginHost = normalizeHost(originHost);
    return PASSKEY_APPROVED_RP_ROOTS.some(
        (root) =>
            isAtOrBelow(normalizedRpId, root) &&
            (normalizedOriginHost === normalizedRpId || normalizedOriginHost.endsWith(`.${normalizedRpId}`))
    );
}

function normalizeHost(value: string): string {
    return value.toLowerCase().replace(/\.$/, "");
}

function isAtOrBelow(host: string, root: string): boolean {
    return host === root || host.endsWith(`.${root}`);
}
