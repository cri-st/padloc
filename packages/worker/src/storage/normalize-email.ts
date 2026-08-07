/**
 * M3: `schema.ts` documents `accounts.email`/`auth.email` as "stored
 * lowercased" (accounts.email has a unique index on it), but the raw
 * value written by `D1Storage.save()` traces back to `Account.email`,
 * caller-controlled at signup/update. Extracted as its own dependency-free
 * module (rather than an inline expression in `d1.ts`) so the exact
 * normalization -- and only it, not the whole storage stack -- has a
 * direct unit test: `d1.ts` transitively imports `@padloc/core`, which
 * has an unrelated pre-existing circular-import ordering issue that
 * crashes when standalone-imported outside a full bundle (confirmed
 * present on an unmodified checkout, independent of this fix).
 */
export function normalizeEmailForStorage(rawEmail: unknown): string | null {
    return typeof rawEmail === "string" ? rawEmail.toLowerCase() : null;
}
