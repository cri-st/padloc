# CH5 Auth (Padloc fork) — Security Audit, August 2026

**Scope:** `packages/core`, `packages/worker` (production surface: `app.example.com` /
`api.example.com`), `packages/app` (client shared by pwa/extension/cordova/electron),
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

### 2.1 The account-lockout / D1-authoritative-session subsystem is dead code — **FIXED 2026-08-04**
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
| 3.3 | ~~`Session.expires` never set~~ — **FIXED 2026-08-04**: was defined but **never set** by `completeCreateSession` (`core/src/server.ts:667-703`); the only real lifecycle control was a 14-day **idle-timeout** sweep, not an absolute cap. A session used at least once every 14 days was valid forever. Raised blast radius of any session-key exfiltration (e.g. via 3.1/3.2). | `core/src/session.ts:87-182`, `core/src/server.ts:196-199,2049-2075` | production worker + self-host (shared core) |
| 3.4 | ~~WebAuthn counter persisted before verify~~ — **FIXED 2026-08-04**: signature counter was persisted **before** the `verified` check — a failed/replayed assertion could corrupt the stored clone-detection baseline. Self-host only; the Worker doesn't register `WebAuthnServer` at all (only Email + TOTP), so `app.example.com` was never affected. | `packages/server/src/auth/webauthn.ts:171-188` | self-host Docker only |
| 3.5 | Production brute-force protection is a **single global per-IP rate limit** (100 req/60s, uniform across all routes, not login-specific), and it **fails open** if the KV binding is unavailable ("prevents the limiter from becoming a single point of failure" — by design, but that design choice means auth endpoints get zero protection during a KV outage). Combined with 2.1 being dead, there is no real per-account throttling for password/TOTP guessing in production. | `packages/worker/src/rate-limiter.ts:1-49`, `transport.ts:109-121` | production worker |

---

## 4. Low / Informational

- **`observability/log-redaction.ts` is dead code** — a full field-redaction module exists but has zero callers anywhere in `packages/worker/src`; the "logging-redaction" test only checks two narrow, already-safe call sites and never invokes the module itself. Today nothing leaks, but the module *implies* a guardrail that isn't wired in — the next `console.log(rawRequest)` added for debugging would bypass it silently. (`packages/worker/src/observability/log-redaction.ts`)
- **`AccountLockDO` is a concurrency mutex, not a lockout control**, despite the name and its Durable Object binding in `wrangler.toml` inviting the opposite conclusion. It's also unwired (nothing calls `withAccountLocks`). Rename to avoid misleading future audits. (`packages/worker/src/locks/account-lock.ts`)
- ~~`ALLOW_ORIGIN` falls back to `"*"` with no environment-aware guard~~ — **FIXED 2026-08-04**: `index.ts` now refuses to serve (clean 503) if `HQ_ENVIRONMENT` is `production`/`staging` and `ALLOW_ORIGIN` resolves to `"*"`.
- ~~Non-timing-safe `===` comparison~~ for one-time auth tokens — **FIXED 2026-08-04**: `core/src/server.ts`'s `_useAuthToken` now uses `getCryptoProvider().timingSafeEqual()`, matching the pattern already used for SRP/TOTP.
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

## 8. Follow-up audit — August 6, 2026 (new surface added since this report)

Substantial new security-relevant surface shipped after the original audit above:
WebAuthn ported into the Worker (`packages/worker/src/auth/webauthn.ts`), a
Durable-Object-backed rate limiter (`durable-objects/rate-limit.ts`), the
password-share-links feature (`core/src/share.ts`,
`durable-objects/share-link.ts`), a rewritten `idempotency.ts`, and the persistent
per-account lockout from Phase 1 item 4. This section covers a dedicated
re-audit of that new surface, run via six parallel adversarial reviews plus
direct code verification. Findings already fixed by the share-password feature's
own prior security review (commit `8a969eaa`) and the atomic share-view rate
limiter (`1413e165`, `37736a3d`) are NOT repeated here.

### 8.1 Critical — persistent lockout counter lost updates under concurrent guesses — **FIXED 2026-08-06**
**`packages/core/src/server.ts`'s `completeCreateSession`**

`Auth.failedLoginAttempts`/`lockedUntil` (Phase 1 item 4's own fix) were read
from storage, mutated in memory, and saved back with **no lock at all**.
`Storage.save()` is a blind upsert with no compare-and-swap on every backend
this repo ships (D1, MongoDB, Postgres, LevelDB). N concurrent wrong-password
`completeCreateSession` calls for the SAME account (each opened via its own
free, unlimited `startCreateSession`) each read the same stale counter value
before any of them saved — only the last write landed, so a burst of N
concurrent guesses only ever advanced the counter by 1 instead of N,
**completely defeating the 10-attempt lockout** for an attacker firing guesses
in parallel rather than sequentially.

**Fix:** added `packages/core/src/account-lock.ts` (`AccountLockProvider`
interface + an `InProcessAccountLockProvider` default) and wired
`Server.completeCreateSession`/`completeAuthRequest` to run their entire
read-check-increment-save critical section inside
`this.accountLock.withLock([email], ...)`. Both methods lock on the SAME
key — the account's **email**, matching how `Auth` records are keyed —
not on the account id: an earlier draft of this fix had
`completeCreateSession` lock on `account` (the account id) while
`completeAuthRequest` locked on `email`, two DIFFERENT keys guarding the
SAME shared counter, which is not mutual exclusion at all and would have
let a concurrent password guess and a concurrent MFA guess for the same
account race past each other. Caught during review and fixed by resolving
`completeCreateSession`'s account email BEFORE acquiring the lock (a plain
read, outside the raced critical section) and locking on that. Regression
test: `packages/core/test/lockout-shared-lock-key.spec.ts` asserts both
methods request the identical lock key for the same account (confirmed to
fail against the account-id-keyed version before this correction). The
Worker injects a cross-isolate implementation in `server-factory.ts`
backed by the existing (previously unused) `AccountLockDO`, falling back
to the in-process mutex if `ACCOUNT_LOCK` isn't bound. Self-host keeps the
in-process default, which fully closes the race for its
single-Node-process deployment model.

**A second, independent bug was found and fixed while verifying this fix**:
`AccountLockDO` (`packages/worker/src/locks/account-lock.ts`) — the exact
primitive this fix newly relies on — did not extend the runtime's
`DurableObject` base class, so a real caller invoking it through a namespace
binding would throw "does not support RPC" at runtime (this is why it had zero
real callers before). Fixed by extending `DurableObject<Env>`. Its
`acquire()`/`release()` logic also assigned the shared `_holder`/`_release`
fields **before** the queue-wait `await`, letting a later concurrent
`acquire()` call's synchronous prefix clobber an earlier caller's release
function before that caller ever became the real holder — the earlier
caller's `release()` then resolved the **wrong** (most recently registered)
caller's gate, permanently deadlocking every ticket queued in between. A
live 15-way concurrent `completeCreateSession` burst hung past its 30s test
timeout before this was found and fixed (assignment moved to *after* the
await, which is race-free since only one `acquire()` call can be executing
that statement at a time). `session-contract.test.mjs`'s existing "Lock
Serialization"/"Deadlock Prevention" tests exercise a hand-written
`MockAccountLockDO`, not this real class, so they never caught it — another
instance of this repo's known false-assurance-test pattern. New dedicated
coverage: `packages/worker/test/account-lock-do.test.mjs`
(`test:account-lock-do`, wired into `test:ci`), plus a genuine 15-way
concurrent regression test added to `test:account-lockout-e2e`.

### 8.2 High — MFA/auth-token verification has no persistent lockout, and its own per-request limit is trivially resettable — **FIXED 2026-08-06**
**`packages/core/src/server.ts`'s `completeAuthRequest`**

`auth.lockedUntil` was checked ONLY in `completeCreateSession` (the password
path). `completeAuthRequest` — the shared verification entrypoint for TOTP,
WebAuthn, and email-code authenticators, also used as the pre-password
"untrusted device" auth-token gate reached via `startCreateSession` — never
checked it, and its own `request.tries >= 3` guard is scoped to a single
`AuthRequest` object that `startAuthRequest` can mint fresh (tries=0) for free
and without limit. An account already locked from password guessing could
still be hammered via its MFA authenticators with no real ceiling.

**Fix:** `completeAuthRequest` now checks `auth.lockedUntil` up front and
feeds failures into the SAME persistent `auth.failedLoginAttempts` counter the
password path uses (also serialized via `accountLock`, see 8.1), so unlimited
free guesses via fresh `AuthRequest`s still eventually trip the shared
10-attempt/15-minute lockout.

### 8.3 Low — WebAuthn/email/TOTP auth requests are not invalidated as single-use at the application layer — **FIXED 2026-08-06**
**`packages/core/src/server.ts`'s `completeAuthRequest`, `packages/worker/src/auth/webauthn.ts`**

Unlike TOTP's explicit monotonic-counter check, nothing prevented
re-verifying an `AuthRequest` already marked `Verified`. For a platform
WebAuthn authenticator whose signature counter never increments (typical for
Touch ID/Face ID/Windows Hello, counter stays 0), the underlying library's own
clone-detection is a no-op (`(counter > 0 || credential.counter > 0) &&
counter <= credential.counter`), so a captured/replayed assertion could pass
verification a second time within the exploitation window. Requires the
attacker to already possess the exact signed assertion bytes (XSS/malicious
extension/compromised proxy, not plain network sniffing under TLS), and the
practical gain is marginal (no session is granted without the separately
single-use-consumed auth token) — hence low severity, but cheap and correct
to close regardless.

**Fix:** `completeAuthRequest` now rejects re-verification with
`request.status !== AuthRequestStatus.Started`.

### 8.4 Medium — session-scoped failed-login alert can be silently evaded — **FIXED 2026-08-06**
**`packages/core/src/server.ts`'s `completeCreateSession`**

The `FailedLoginAttemptMessage` alert email was gated on
`srpSession.failedAttempts >= 5` (resets on every fresh SRP session), fully
independent of the persistent `auth.failedLoginAttempts >= 10` lockout
threshold. An attacker pacing guesses at ≤4 per fresh session (e.g. 4, new
session, 4, new session, 2) could reach — and even trigger — the 10-attempt
lockout while never satisfying the alert's own condition, so the account
owner would get zero warning for the entire attack, including the exact
attempt that locked their account.

**Fix:** the alert now also fires the instant the persistent counter
transitions into a lockout (`auth.failedLoginAttempts >= 10 &&
!auth.lockedUntil` at the moment of increment), independent of the
per-session counter.

### 8.5 High — general-purpose (login/signup/password-reset) rate limiter was left on the KV race the share-view limiter was already hardened against — **FIXED 2026-08-06**
**`packages/worker/src/index.ts`, `rate-limiter.ts`**

The atomic, Durable-Object-backed `DurableObjectRateLimiter` (built to close
the KV `RateLimiter`'s documented get()-then-put() double-spend race) was
wired ONLY to the anonymous share-view throttle (`peekShare`/`revealShare`).
`config.rateLimiter` — the general-purpose limiter that gates every POST
request at the transport layer, before RPC dispatch, and therefore the ONLY
rate limit protecting `completeCreateSession`/`startCreateSession`/signup/
password-reset — was still the racy KV implementation. An attacker firing N
concurrent requests from one IP gets roughly N× the configured budget.

**Fix:** `config.rateLimiter` now uses `DurableObjectRateLimiter` bound to a
new `GENERAL_RATE_LIMIT` Durable Object binding (same `RateLimitDO` class,
separate namespace from the share-view limiter), added to `env.ts`,
`wrangler.toml` (dev/preview), `wrangler.local.toml.example`
(staging/production template), and this environment's real, git-ignored
`wrangler.local.toml` (the actual CrackIt staging deploy config present in
this workspace).

**⚠️ Deploy prerequisite — this fix is INERT until the next real deploy.**
`DurableObjectRateLimiter` fails open (always-allow) when its namespace
binding is undefined, by design (same as every other optional binding in
this file) — so on any deployed environment where `GENERAL_RATE_LIMIT`
isn't yet a live Cloudflare Durable Object binding, this change is a
silent no-op and the general rate limiter keeps running on the
**old, racy KV implementation** in production/staging until an operator
actually runs `wrangler deploy` (or the repo's `deploy:staging`/
`deploy:production` scripts) against the updated `wrangler.toml`/
`wrangler.local.toml`. No code-only fix in this repo can force that
redeploy; it requires the operator's own Cloudflare credentials per
AGENTS.md's Secrets/Hosting sections. The SAME caveat applies to 8.1's
`AccountLockDO` fix: `ACCOUNT_LOCK` is already a live binding, but the
corrected `acquire()`/`release()` code inside it only takes effect once
the updated Worker script is actually deployed.

### 8.6 Medium — idempotency cache-hit bypassed handler-internal state checks (e.g. the lockout) for unauthenticated requests — **FIXED 2026-08-06**
**`packages/worker/src/transport.ts`**

The idempotency cache short-circuits BEFORE `handler()` (and therefore before
`Controller.authenticate()` and any handler-internal state check) runs. It
already excluded the two anonymous share-view methods for exactly this
reason, but the same reasoning wasn't generalized: replaying a byte-identical
prior successful `completeCreateSession` request (which has no `req.auth` —
there's no session yet) within the 1h idempotency TTL would skip the
persistent lockout re-check entirely. Requires the attacker to already
possess a previous successful request's exact bytes (a strong precondition —
not a way to forge a new login), so this was scored medium, not high.

**Fix:** idempotency caching is now skipped for every request with no
`req.auth`, not just the two share methods (which remain excluded too, for
clarity). Authenticated requests are unaffected and still cached/replayed as
before.

### 8.7 Low — anonymous pre-reveal status never reported a revoked share as revoked — **FIXED 2026-08-06**
**`packages/worker/src/durable-objects/share-link.ts`**

`ShareLinkDO.peek()` (backing the anonymous `peekShare` RPC the share-view
landing page polls on load) returned only `{expired, viewed}`, never
`revoked`, even though the sibling `getStatus()` and the underlying row both
track it. A recipient loading a link the sender had already revoked still
saw the normal "Reveal" button as if the link were valid; clicking it then
failed with the generic content-free "not found" state. No secret was ever
disclosed (`revealShare`'s SQL independently re-checks `revoked=0`), so this
was a state-integrity/UX bug, not a confidentiality bypass.

**Fix:** `peek()` now returns `revoked`, threaded through
`SharePeekResult`/`ShareStorage.peek()`/`_shareStatusOrNotFound`/
`ShareStatus`. The share-view page now has a dedicated "Link Revoked" state
instead of falling back to the generic invalid-link message.

### 8.8 Informational — no action taken this round
- Anonymous share-link field scoping (which item fields get shared) is
  enforced only client-side (architecturally unavoidable — the server never
  decrypts the payload); `packages/app/src/lib/share.ts`'s doc comments
  overstate this as "structurally impossible... regardless of user choice."
  Worth softening the wording so a future reviewer doesn't rely on a
  server-side guarantee that doesn't exist.
- KDBX import fully delegates untrusted binary/XML parsing to the `kdbxweb`
  dependency (2021, v2.1.1) with no sandboxing; no vulnerability found in the
  actual browser runtime path (native `DOMParser`, no XXE), but it's a new
  trust-boundary shift worth tracking as the dependency ages.
- Raw parser/crypto exception messages are shown verbatim in the KeePass
  import dialog on failure (client-only, no cross-user impact).

---

---

## Healing Plan — prioritized

**Phase 0 — ship this week (exploitable now, production):**
1. ✅ **FIXED** Fix 1.1 (email HTML injection) — `resend.ts` now entity-escapes every interpolated value before it reaches the `*_html` templates (`escapeHtml()` + `renderTemplate()`), while `*_txt` templates keep raw substitution. Verified against a live `<img onerror=...>` payload.
2. ✅ **FIXED** Fix 2.2 (MockMessenger silent fallback) — `server-factory.ts`'s `createMessenger()` now throws `Err(SERVER_ERROR)` instead of silently degrading when `EMAIL_BACKEND !== "mock"` and Resend credentials are missing; the duplicate unused throwing `createMessenger` in `resend.ts` was removed. `index.ts`'s `fetch()` handler wraps the now-throwing `createServer(env)` call in a try/catch that returns a clean `503 {"error":"server_misconfigured"}` (reported via `captureHqException`) instead of letting the exception escape uncaught — `/healthcheck` still reports `degraded` independently for monitoring. Verified the mock/resend/throw decision table against all 4 wrangler envs (dev/preview stay mock, staging/production only throw on genuine misconfiguration).
3. ✅ **FIXED** Fix 3.2 (reverse tabnabbing) — `WebPlatform.openExternalUrl()` now passes `"noopener,noreferrer"` to `window.open`; the DOMPurify `afterSanitizeAttributes` hook in `markdown.ts` now sets `rel="noopener noreferrer"` alongside `target="_blank"`.

**Phase 1 — next 1–2 weeks:**
4. ✅ **FIXED** Resolve 2.1: implemented a real persistent per-account lockout — **without a D1 schema migration**, by adding `Auth.failedLoginAttempts`/`Auth.lockedUntil` fields (serialized in the existing opaque `data` blob column, so it works identically for D1 and self-host storages) instead of the old dead module's raw-SQL approach. `completeCreateSession` now checks/increments/resets these fields, locking the account for 15 minutes after 10 persistent failed password attempts — this survives fresh SRP sessions, closing the exact loophole the per-session-only `SRPSession.failedAttempts`/`AuthRequest.tries` counters left open. Deleted the dead `packages/worker/src/session.ts` module entirely (zero real importers, confirmed). Rewrote `session-contract.test.mjs` to remove the fake KV/D1-mock rate-limit test and added a genuine end-to-end test (`test/account-lockout-e2e.worker.ts` + `test/run-account-lockout-e2e.mjs`, wired into `test:ci`) that drives real SRP logins against a real wrangler dev + D1 instance, proving an attacker can't bypass the lockout by requesting a fresh session per guess, and that the correct password is also rejected once locked.
5. ✅ **FIXED** Bump `dompurify` to current 3.x in `app` and `server`; add an explicit `ALLOWED_TAGS`/`ALLOWED_ATTR` allowlist scoped to what markdown actually needs. (Shipped in the same batch as items 6/7/8/9 below.)
6. ✅ **FIXED** Set `session.expires` to an absolute 90-day cap in `completeCreateSession`, independent of the idle-timeout sweep.
7. ✅ **FIXED** Fix WebAuthn counter-before-verify ordering (self-host).
8. ✅ **FIXED** Add a startup assertion: refuse to serve if `HQ_ENVIRONMENT` is `production`/`staging` and `ALLOW_ORIGIN` is unset or `"*"`.
9. ✅ **FIXED** Swap the auth-token `===` to `timingSafeEqual`.

**Phase 2 — hardening & prevent re-rot:**
10. `log-redaction.ts` remains unwired dead code (still 0 real callers; the associated test still only checks unrelated call sites, never imports the module — same false-assurance pattern as before). `AccountLockDO` is no longer misleadingly named: Phase 3 below actually wired it in for real per-account request serialization (fixing a genuine deadlock bug in the process), so the binding name now matches a real security control.
11. ~~Add per-account/per-purpose rate limiting for login/signup/password-reset~~ — **PARTIALLY FIXED**: Phase 1 item 4 already added persistent per-account lockout for login (password guessing), and Phase 3 below closes the matching gap for the MFA/auth-token path and hardens the general per-IP limiter. Signup and password-reset (`AuthPurpose.Signup`/`Recover` token requests) still have no per-account throttle beyond the general per-IP limiter. Fail-open vs. fail-closed for auth routes specifically (when the rate-limit DO/KV binding is unavailable) is still undecided — both implementations fail open by design.
12. Self-host (`packages/server` + nginx) Docker-root and missing CSP/HSTS/`X-Content-Type-Options` — **still fully pending, unchanged**. The PRODUCTION Worker surface's equivalent gap is already closed: `packages/worker/src/observability/security-headers.ts` (added after this report, undocumented until now) sets CSP/HSTS/`X-Content-Type-Options`/etc. on effectively every real Worker response via `responseHeaders()` in `transport.ts`/`index.ts` — with one confirmed minor gap: `index.ts`'s pre-config `ALLOW_ORIGIN`-misconfigured 503 used manual headers instead of `responseHeaders()` (**FIXED 2026-08-06**, same session as Phase 3).
13. Add Dependabot/Renovate + an `npm audit`/`audit-ci` CI gate scoped to production runtime deps (not dev tooling) so staleness surfaces continuously instead of accumulating for years again.
14. Decide and document whether `packages/server` (self-host, Postgres/Mongo/S3-backed) remains a supported target going forward, or whether the Worker is now the sole production surface per AGENTS.md — this determines whether items 4/7/6-self-host-deps are worth the investment or whether that path should be formally deprecated.
15. Optional: RSA-3072 for newly-created org/account keys (needs a migration path for existing 2048-bit keys — not urgent, current NIST-approved through ~2030).

**Phase 3 — follow-up audit fixes, 2026-08-06 (see Section 8 for full detail):**
16. ✅ **FIXED (code) — ⚠️ NOT YET LIVE, needs deploy** 8.1 (critical): persistent lockout counter race under concurrent guesses, closed via a new `accountLock` abstraction (`core/src/account-lock.ts`) wired into `completeCreateSession`/`completeAuthRequest`, both locking on the SAME key (account email — an earlier draft had them on two different keys, caught in review and corrected). Backed by `AccountLockDO` on the Worker. Also fixed a genuine pre-existing deadlock bug in `AccountLockDO` itself (missing `extends DurableObject`, plus a holder/release race), found while verifying this fix. New tests: `test:account-lock-do`, `core/test/lockout-shared-lock-key.spec.ts`, a 15-way concurrent case added to `test:account-lockout-e2e`. **Takes effect only on the next real Worker deploy.**
17. ✅ **FIXED** 8.2 (high): MFA/auth-token path (`completeAuthRequest`) now checks the persistent lockout and feeds it on failure, closing the "fresh `AuthRequest` = free tries" gap.
18. ✅ **FIXED** 8.3 (low): `completeAuthRequest` now rejects re-verifying an already-`Verified` request (WebAuthn single-use hardening).
19. ✅ **FIXED** 8.4 (medium): failed-login alert email now also fires on the persistent-counter lockout transition, not just the resettable per-session counter.
20. ✅ **FIXED (code) — ⚠️ NOT YET LIVE, needs deploy** 8.5 (high): general-purpose per-IP rate limiter (gating login/signup/password-reset) migrated from the racy KV implementation to the atomic `DurableObjectRateLimiter` (`GENERAL_RATE_LIMIT` binding, new — must be provisioned by an actual `wrangler deploy` before it stops failing open).
21. ✅ **FIXED** 8.6 (medium): idempotency cache now excludes every unauthenticated request, not just the two anonymous share methods.
22. ✅ **FIXED** 8.7 (low): anonymous `peekShare` now reports `revoked`; share-view page has a dedicated revoked state.
23. ✅ **FIXED**: `index.ts`'s pre-config `ALLOW_ORIGIN` 503 now uses `responseHeaders()` like every other response (closes the one gap noted in item 12 above).
