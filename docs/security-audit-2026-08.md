# CH5 Auth (Padloc fork) — Security Audit, August 2026

**Scope:** `packages/core`, `packages/worker` (production surface: `pad.ch5.me` /
`api-pad.ch5.me`), `packages/app` (client shared by pwa/extension/cordova/electron),
`packages/server` (legacy self-host Docker path), dependency tree, Docker/self-host
deploy config.

**Method:** static, read-only review — no upstream Padloc CVEs exist publicly (no
GHSA/CVE entries for `padloc/padloc` as of this audit; confirmed via GitHub Security
Advisories search), so the actual risk surface is (a) dependency-level CVEs disclosed
*after* this codebase's dependencies were frozen, and (b) regressions introduced by
this fork's own Cloudflare Worker rewrite. Both are covered below with file:line
evidence.

**Note on scale:** `npm audit` on the full root lockfile reports 165 advisories
(17 critical / 66 high / 72 moderate / 20 low as of the legacy audit endpoint). The
overwhelming majority are transitive dependencies of **dev/build tooling only**
(`lerna`, `cypress`, `wrangler`'s bundled `miniflare`/`undici`/`sharp`, `concurrently`,
`ts-node`, `http-server`) — none of these ship in the deployed Worker bundle or the
self-host server runtime. They are a real CI/contributor-workstation supply-chain
risk, not a production runtime one. Section 5 lists what's actually shipped and
therefore actually exploitable.

---

## 1. Critical

### 1.1 Unsanitized HTML injection in production transactional emails — **FIXED 2026-08-04**
**`packages/worker/src/email/templates.ts:359-361`, `1175-176`, `resend.ts:44-50`**

`interpolate()` does raw string substitution into HTML email templates with **zero
escaping**. `Org.name` (`core/src/org.ts:236`, client-controlled at org creation,
`core/src/server.ts:809`) and `Account.name` (`core/src/account.ts:73`, editable
display name) flow unsanitized into `<strong>{{ orgName }}</strong>` in the org-invite
family of emails, sent via Resend under Padloc's own sending domain to **any email
address**, including non-Padloc recipients.

Any authenticated account can rename their org/account to arbitrary markup and invite
an arbitrary target email to receive it — phishing/UI-redress content or tracking
pixels delivered from a trusted sender.

**This is a regression, not inherited legacy debt**: `packages/server/src/email/smtp.ts:79-81`
(the legacy self-host path) correctly calls `dompurify.sanitize(value)` before
interpolation. The Worker rewrite dropped that step.

**Fix:** HTML-entity-escape every interpolated value in `*_html` templates (or port a
lightweight sanitizer — `jsdom` isn't available in Workers) before substitution,
mirroring the self-host pattern. Keep raw substitution only for `*_txt` templates.

---

## 2. High

### 2.1 The account-lockout / D1-authoritative-session subsystem is dead code
**`packages/worker/src/session.ts` (whole file), `storage/schema.ts:54-70`**

`resolveSession`, `checkRateLimit`, `readAuthThrottle` exist with doc comments
explicitly claiming they close an auth-bypass vector ("KV staleness is an auth bypass
vector, so the sessions table is the single source of truth"). **None of these
functions are called anywhere** — not from `index.ts`, `transport.ts`, or
`server-factory.ts`. The real request path validates sessions only via core's generic
`Storage.get(Session, ...)` and applies just the global per-IP rate limiter (2.2).

`readAuthThrottle` queries `SELECT failed_attempts FROM auth WHERE account_id = ?`,
but the live `auth` table has **no `failed_attempts` column** — this path has never
executed against production.

Worse: `test/session-contract.test.mjs` (the test AGENTS.md-adjacent docs point to as
proof this works) **reimplements local mocks of the same function names** instead of
importing the real module, so CI stays green while the control is absent. This is a
false-assurance test, not a false-negative gap.

**Fix:** either wire `resolveSession`/`checkRateLimit`/`readAuthThrottle` into
`transport.ts`'s request path for real (adding the missing `failed_attempts` column
and increment/reset logic), or delete the module so it stops misleading future
reviewers — and rewrite the contract test to import and exercise the real module.

### 2.2 MockMessenger silently swallows auth codes and compromise alerts — **FIXED 2026-08-04**
**`packages/worker/src/server-factory.ts:65-85`** (production path) vs.
**`packages/worker/src/email/resend.ts:42-52,108-119`** (unused, correct, throwing twin)

`createMessenger()` falls back to an in-memory `MockMessenger` — `console.warn` only,
no exception — whenever `RESEND_API_KEY`/`EMAIL_FROM_ADDRESS` is missing and
`EMAIL_BACKEND !== "mock"`. This silently drops signup verification, password reset,
org invites, `FailedLoginAttemptMessage`, and `NewLoginMessage` security
notifications, while the API still returns success to the caller. A safer,
already-written `createMessenger` that throws `Err(SERVER_ERROR)` on the identical
condition exists in `resend.ts` but is dead code, never imported.

Partial mitigation: `index.ts`'s `/healthcheck` reports `status: "degraded"` on the
same condition, so external polling *would* catch a misconfiguration — but nothing in
the hot path fails loudly, and a silently-dropped "someone logged in from a new
device" alert defeats the point of that control.

**Fix:** swap the local `createMessenger` for the throwing variant in `resend.ts` (or
make the local one throw); delete the duplicate. Alert on `/healthcheck` degraded
status.

---

## 3. Medium

| # | Finding | Location | Reachability |
|---|---|---|---|
| 3.1 | DOMPurify resolved to **2.4.1** (app pins `^2.3.3`, server pins `2.3.8`) at both call sites with **no `ALLOWED_TAGS`/`ALLOWED_ATTR` restriction** (only additive `ADD_TAGS`/`ADD_ATTR`), rendering stored markdown/rich-content via `unsafeHTML`. This version predates ~2 years and dozens of disclosed DOMPurify XSS/mXSS/prototype-pollution bypasses (fixed through the current 3.4.x line — see the `npm audit` advisory list in this repo's history). Not a demonstrated bypass today, but it maximizes exposure to any future or already-fixed-upstream bypass. | `packages/app/src/lib/markdown.ts:86`, `elements/rich-content.ts:41-42` | production PWA, shared vault notes |
| 3.2 | ~~Reverse tabnabbing~~ — **FIXED 2026-08-04**: `WebPlatform.openExternalUrl()` calls `window.open(url, "_blank")` **without `noopener`**. Every link inside rendered markdown (shared vault note fields, editable by any org member) routes through this. A malicious link opens with a live `window.opener`, letting the new tab redirect the original authenticated Padloc tab to a phishing/credential page. The DOMPurify `afterSanitizeAttributes` hook forces `target="_blank"` on links but never pairs it with `rel="noopener noreferrer"`, compounding this. | `packages/app/src/lib/platform.ts:177-179`, `lib/markdown.ts:73-79` | production PWA |
| 3.3 | `Session.expires` is defined but **never set** by `completeCreateSession` (`core/src/server.ts:667-703`); the only real lifecycle control is a 14-day **idle-timeout** sweep, not an absolute cap. A session used at least once every 14 days is valid forever. Raises blast radius of any session-key exfiltration (e.g. via 3.1/3.2). | `core/src/session.ts:87-182`, `core/src/server.ts:196-199,2049-2075` | production worker + self-host (shared core) |
| 3.4 | WebAuthn signature counter is persisted **before** the `verified` check — a failed/replayed assertion can still corrupt the stored clone-detection baseline. Self-host only; the Worker doesn't register `WebAuthnServer` at all (only Email + TOTP), so `pad.ch5.me` isn't affected. | `packages/server/src/auth/webauthn.ts:171-188` | self-host Docker only |
| 3.5 | Production brute-force protection is a **single global per-IP rate limit** (100 req/60s, uniform across all routes, not login-specific), and it **fails open** if the KV binding is unavailable ("prevents the limiter from becoming a single point of failure" — by design, but that design choice means auth endpoints get zero protection during a KV outage). Combined with 2.1 being dead, there is no real per-account throttling for password/TOTP guessing in production. | `packages/worker/src/rate-limiter.ts:1-49`, `transport.ts:109-121` | production worker |

---

## 4. Low / Informational

- **`observability/log-redaction.ts` is dead code** — a full field-redaction module exists but has zero callers anywhere in `packages/worker/src`; the "logging-redaction" test only checks two narrow, already-safe call sites and never invokes the module itself. Today nothing leaks, but the module *implies* a guardrail that isn't wired in — the next `console.log(rawRequest)` added for debugging would bypass it silently. (`packages/worker/src/observability/log-redaction.ts`)
- **`AccountLockDO` is a concurrency mutex, not a lockout control**, despite the name and its Durable Object binding in `wrangler.toml` inviting the opposite conclusion. It's also unwired (nothing calls `withAccountLocks`). Rename to avoid misleading future audits. (`packages/worker/src/locks/account-lock.ts`)
- **`ALLOW_ORIGIN` falls back to `"*"` with no environment-aware guard** (`index.ts:66-69`). Safe today only because `wrangler.toml` correctly scopes staging/production — there's no assertion preventing a future config edit from silently reopening CORS on a password manager API.
- **Non-timing-safe `===` comparison** for one-time auth tokens (`core/src/server.ts:2136-2143`), inconsistent with `timingSafeEqual` used elsewhere for SRP/TOTP. Low practical risk (128-bit CSPRNG token) but bad precedent.
- **D1 queries build table names via template-literal interpolation** instead of the drizzle-orm query builder API. Currently safe — `tableFor()` enforces a closed whitelist that throws on unknown input — but it's an anti-pattern that would become exploitable if that whitelist were ever loosened. (`packages/worker/src/storage/d1.ts:175-276`)
- **Extension popup writes `error.message` into `document.body.innerHTML`** unescaped on startup failure (`packages/extension/src/popup.ts:10-17`). No confirmed attacker-controlled propagation into that specific `.message` was found, but it's a footgun in a higher-privilege surface.

## 5. Crypto core — sound, no action-critical findings

Full read of `packages/core/src/crypto.ts`, `container.ts`, `srp.ts`, `otp.ts`:

- PBKDF2: **1,000,000 iterations, SHA-256** — above current OWASP guidance (~600k).
- AES-256-GCM with a **fresh 16-byte CSPRNG IV per encryption** (`container.ts:43-44`) — confirmed no IV reuse anywhere.
- RSA for org/account shared-key encryption: **2048-bit, RSA-OAEP/PSS with SHA-256** — modern padding, no PKCS#1v1.5. 2048-bit is NIST-approved through ~2030 but not the most conservative choice for fresh hardening (3072+ recommended for new designs — optional, needs a migration path for existing keys).
- SRP: RFC5054 **4096-bit** groups, SHA-256.
- No MD5, no security-relevant SHA-1 (the two SHA-1 uses found — HIBP k-anonymity check, deterministic email→storage-key hash — don't need collision resistance), no ECB, no static IVs anywhere in core/worker/server/app.

This is the one area where "3 years abandoned" did **not** rot the design — the whitepaper's claims hold up against the actual implementation.

## 6. Actually-shipped dependency staleness (excludes dev/CI-only tooling from the 165-advisory `npm audit` count)

| Package | Pinned/resolved | Where it ships | Notes |
|---|---|---|---|
| `dompurify` | 2.4.1 (app + server) | production PWA/extension client, self-host email | See 3.1 — bump to current 3.x + add `ALLOWED_TAGS` |
| `nodemailer` | 6.6.1 | self-host server only (`packages/server`) | Several years behind; not in the Worker's dependency tree at all |
| `@simplewebauthn/server` | 5.4.3 | self-host server only | Current upstream is v9+/v10+; old major, review before re-enabling WebAuthn on self-host |
| `@simplewebauthn/browser` | 5.4.0 | app (all client shells) | Same major-version gap |
| `mongodb` / `pg` driver / `@aws-sdk/client-s3` / `stripe` | 4.1.0 / 8.7.1 / v3.25.0 / 8.212.0 | self-host server only, if those backends are still used | Only relevant if the self-host Docker path (Postgres-backed per current `docker-compose.yml`) is actively maintained going forward |
| `@padloc/worker` runtime deps | `@padloc/core`, `@padloc/locale`, `drizzle-orm@^0.38` | production Worker | Clean, small, modern — the Worker rewrite's dependency footprint itself is *not* part of this staleness problem |

## 7. Deploy/infra hygiene (self-host Docker path)

- `Dockerfile-server` runs `npm ci --unsafe-perm` and never adds a `USER` directive — the container runs **as root** for both install and runtime. Standard hardening: create a non-root user, drop `--unsafe-perm` if no native postinstall script actually needs it.
- `nginx.conf` (generated inline in `docker-compose.yml`) sets `X-Frame-Options: deny` but no `Content-Security-Policy`, `Strict-Transport-Security`, or `X-Content-Type-Options`.
- No secrets were found committed to the repo (`cypress.env.json` and `docs/examples/**/.env` are placeholder values only); `.gitignore` correctly excludes `/.env` and `packages/server/.env`.
- No CI dependency scanning exists (no Dependabot config, no `npm audit`/`audit-ci` step in `.github/workflows`) — this is *why* the staleness in Section 6 accumulated silently for years and will recur without a mechanism.

---

## Healing Plan — prioritized

**Phase 0 — ship this week (exploitable now, production):**
1. ✅ **FIXED** Fix 1.1 (email HTML injection) — `resend.ts` now entity-escapes every interpolated value before it reaches the `*_html` templates (`escapeHtml()` + `renderTemplate()`), while `*_txt` templates keep raw substitution. Verified against a live `<img onerror=...>` payload.
2. ✅ **FIXED** Fix 2.2 (MockMessenger silent fallback) — `server-factory.ts`'s `createMessenger()` now throws `Err(SERVER_ERROR)` instead of silently degrading when `EMAIL_BACKEND !== "mock"` and Resend credentials are missing; the duplicate unused throwing `createMessenger` in `resend.ts` was removed. `index.ts`'s `fetch()` handler wraps the now-throwing `createServer(env)` call in a try/catch that returns a clean `503 {"error":"server_misconfigured"}` (reported via `captureHqException`) instead of letting the exception escape uncaught — `/healthcheck` still reports `degraded` independently for monitoring. Verified the mock/resend/throw decision table against all 4 wrangler envs (dev/preview stay mock, staging/production only throw on genuine misconfiguration).
3. ✅ **FIXED** Fix 3.2 (reverse tabnabbing) — `WebPlatform.openExternalUrl()` now passes `"noopener,noreferrer"` to `window.open`; the DOMPurify `afterSanitizeAttributes` hook in `markdown.ts` now sets `rel="noopener noreferrer"` alongside `target="_blank"`.

**Phase 1 — next 1–2 weeks:**
4. Resolve 2.1: wire the real per-account lockout (add `failed_attempts` column, increment/reset logic, call it from `transport.ts`) **or** delete the dead module — either way, rewrite `session-contract.test.mjs` to import and exercise the real code so CI can't lie about this again.
5. Bump `dompurify` to current 3.x in `app` and `server`; add an explicit `ALLOWED_TAGS`/`ALLOWED_ATTR` allowlist scoped to what markdown actually needs.
6. Set `session.expires` to an absolute cap (e.g. 30–90 days) in `completeCreateSession`, independent of the idle-timeout sweep.
7. Fix WebAuthn counter-before-verify ordering (self-host).
8. Add a startup assertion: refuse to serve if `HQ_ENVIRONMENT` is `production`/`staging` and `ALLOW_ORIGIN` is unset or `"*"`.
9. Swap the auth-token `===` to `timingSafeEqual`.

**Phase 2 — hardening & prevent re-rot:**
10. Wire or delete `log-redaction.ts`; rename `AccountLockDO` → `RequestSerializationDO` (or actually wire it if the race-condition protection is still needed).
11. Add per-account/per-purpose rate limiting for login/signup/password-reset (keyed on email, not just IP) — decide fail-open vs. fail-closed for auth routes specifically when KV is unavailable.
12. Non-root Docker user for `packages/server`; add CSP/HSTS/`X-Content-Type-Options` to nginx.
13. Add Dependabot/Renovate + an `npm audit`/`audit-ci` CI gate scoped to production runtime deps (not dev tooling) so staleness surfaces continuously instead of accumulating for years again.
14. Decide and document whether `packages/server` (self-host, Postgres/Mongo/S3-backed) remains a supported target going forward, or whether the Worker is now the sole production surface per AGENTS.md — this determines whether items 4/7/6-self-host-deps are worth the investment or whether that path should be formally deprecated.
15. Optional: RSA-3072 for newly-created org/account keys (needs a migration path for existing 2048-bit keys — not urgent, current NIST-approved through ~2030).
