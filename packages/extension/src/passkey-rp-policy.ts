/**
 * Canary allowlist used until the extension ships a complete bundled Public
 * Suffix List policy. Keeping this explicit prevents a page on an unrelated
 * domain from activating the provider.
 *
 * Self-hosted/personal forks can append trusted roots at build time via the
 * `PL_PASSKEY_RP_ROOTS` env var (comma-separated), without editing this
 * committed default list. The Google baseline always stays allowed.
 */
const ADDITIONAL_PASSKEY_RP_ROOTS = (process.env.PL_PASSKEY_RP_ROOTS || "")
    .split(",")
    .map((root) => root.trim().toLowerCase())
    .filter(Boolean);

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
