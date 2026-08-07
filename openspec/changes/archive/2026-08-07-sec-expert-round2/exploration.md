## Exploration: sec-expert-round2 — 7 enterprise-grade gap areas

### Current State

Round 1 (`openspec/changes/archive/2026-08-06-sec-expert/`, report `docs/sec-expert-review-2026-08-06.md`) fixed all 3 CRITICAL + 5 HIGH + 7/8 MEDIUM + 6/17 LOW findings across worker/server/core/app/pwa/extension/admin via a fresh parallel `security-reviewer` pass per surface. That pass never ran `npm audit`, never scanned for committed secrets, gave `packages/admin` a single shared pass (zero findings) alongside app+pwa+locale, only checked `packages/pwa`'s build config, and left an explicit deferred decision on `unhandledRejection`. Session-fixation/logout and CSRF posture were never explicitly stated as findings even though the underlying design already has opinions baked in (see below).

This exploration actually executed the 7 gaps end-to-end (not just scoped them) since #1/#2 are cheap to just run, and #3–#7 required reading real code, not estimating effort.

### Affected Areas

- `packages/worker/package.json`, `packages/server/package.json`, `packages/app/package.json`, `packages/admin/package.json` — outdated direct/transitive deps flagged by `npm audit`.
- `packages/admin/src/*.ts` — re-reviewed all 11 files; no new findings, but the "Raw Data" dump pattern and destructive-action gating were independently re-verified rather than trusted from Round 1.
- `packages/pwa/src/*`, `packages/pwa/scripts/serve.js`, `packages/pwa/webpack.config.js` — re-confirmed pwa has no app logic beyond bootstrapping; Round 1's build-config coverage was already complete.
- `packages/server/src/init.ts` — `uncaughtException` handler exists (crash + optional admin email + `process.exit(1)`); no `unhandledRejection` handler.
- `packages/server/src/transport/http.ts` — concrete architectural gap found: the `createServer(async (httpReq, httpRes) => {...})` callback only wraps the `POST` case body in `try/catch`; a synchronous throw in the `GET` branch (or before the `switch`) would reject the outer async function's promise, which `http.createServer` never awaits — a real unhandled-rejection source, not a hypothetical one.
- `packages/core/src/server.ts` — `revokeSession` (logout), `recoverAccount` (full session revocation), `updateAuth`/`changePassword` (no session revocation) — traced the actual authorization/invalidation code paths.
- `packages/core/src/session.ts`, `packages/core/src/transport.ts` — confirmed HMAC-signed-body auth model (no cookies anywhere in worker/server/app).

### 1. Dependency vulnerability scan — REAL RESULTS

Ran `npm audit --production --json` in each in-scope package (Node v24.13.0, confirmed via `export PATH="/usr/local/bin:$PATH"; hash -r`).

| Package | critical | high | moderate | low | total |
|---|---|---|---|---|---|
| worker | 0 | 1 | 0 | 0 | 1 |
| server | 4 | 8 | 13 | 2 | 27 |
| core | 0 | 0 | 0 | 0 | 0 |
| app | 0 | 2 | 1 | 0 | 3 |
| pwa | 0 | 0 | 0 | 0 | 0 |
| extension | 0 | 0 | 0 | 0 | 0 |
| admin | 0 | 0 | 0 | 1 | 1 |

**worker (1 high)** — `drizzle-orm@0.38.4` (direct dep, pinned `^0.38.0`), GHSA-gpj5-g38j-94v9 "SQL injection via improperly escaped SQL identifiers". Traced actual usage in `packages/worker/src/storage/d1.ts`'s `resolveSqlColumn()`: every call site passes a real Drizzle `Column` object (or a parameterized `json_extract(data, ${value})` value) into the `sql` template tag — never `sql.raw()` with a string built from request input. **Not exploitable via this codebase's usage pattern**, but the library version itself carries the CVE; upgrading to `drizzle-orm@0.45.2` is a semver-major bump (`fixAvailable.isSemVerMajor: true`) and needs a compile+test pass, not a blind bump.

**server (4 critical / 8 high / 13 moderate / 2 low)** — the three CRITICALs that matter trace to `@simplewebauthn/server@5.4.3` (direct dep, pinned to the pre-Round-1-integration major version):
- `elliptic@6.5.4` (transitive via `@simplewebauthn/server` → `jwk-to-pem`) — 7 advisories including ECDSA private-key extraction on malformed input, missing signature-length checks, BER-encoded-signature acceptance, and a signature-verification omission (GHSA-vjh7-7g9h-fjfh, GHSA-f7q4-pwc6-w24p, GHSA-977x-g7h5-7qgw, GHSA-49q7-c7j4-3p7m, GHSA-434g-2637-qmqr, others).
- `jsrsasign@10.4.0` (transitive via `@simplewebauthn/server`) — 8 advisories including JWS/JWT signature-validation bypass via special characters, DSA private-key extraction, negative-exponent signature-verification bypass, and forgeable DSA signatures/certificates (GHSA-3fvg-4v2m-98jf, GHSA-w8q8-93cx-6h7r, GHSA-8qwj-4jxw-m8jw, GHSA-wvqx-v3f6-w8rh, others).
  This is directly relevant: these two libraries sit in the cryptographic verification path of the exact WebAuthn feature Round 1 wired in (`packages/server/src/auth/webauthn.ts`). A signature-verification-bypass CVE in a dependency of an MFA verification library is a real risk, not boilerplate noise.
- `form-data@4.0.0` (transitive via `jsdom@19.0.0`, used for server-side DOMPurify sanitization) — unsafe boundary RNG + CRLF injection in multipart field names (GHSA-fjxv-7rqg-78g4, GHSA-hmw2-7cc7-3qxx).
- `tar@6.1.13` (transitive via `geolite2-redist@2.0.4`, used for IP geolocation) — 13 advisories, mostly path-traversal/arbitrary-file-write during archive extraction; exploitable only if a malicious `.tar` is ever extracted (geolite2-redist downloads MaxMind's DB at install/update time from a fixed URL — not attacker-influenced input in normal operation, but still worth pinning up if a fix is available with a minor bump).

Other server HIGHs: `nodemailer@6.6.1` (direct dep, used for all transactional email) — SMTP command injection via `envelope.size`, CRLF injection via transport name (EHLO/HELO) and `List-*` headers, TLS cert validation gap in OAuth2 token fetch, `jsonTransport`/raw-option bypasses of `disableFileAccess`/`disableUrlAccess` (SSRF-adjacent). `ws@8.0.0-8.20.1` (header-count DoS, memory exhaustion), `minimatch`/`brace-expansion` (ReDoS, likely dev-tooling transitive), `@aws-sdk/client-s3@3.25.0` family (moderate, very old — 2021-era SDK).

**app (2 high, 1 moderate)** — all three (`lodash`, `qs`, `follow-redirects`) trace exclusively through `http-server@14.1.0`, which IS a real (non-dev) dependency of `packages/app` (added in Round 1 as the self-hosted PWA static-file server per `packages/pwa/scripts/serve.js`). `http-server` only serves static files in this codebase's usage — it never acts as an HTTP proxy (`http-proxy`/`follow-redirects` path) or template engine (`lodash.template` path) — so these are attack-surface-present-but-not-exercised, similar risk profile to the worker drizzle-orm finding.

**admin (1 low)** — `diff@5.1.0` (direct dep, used by `change-log-entry-dialog.ts`'s `diffJson()` to render change-log diffs) — GHSA-73rr-hh4g-fpgx, a DoS in `parsePatch`/`applyPatch`. Admin's usage only calls `diffJson()` (in-memory object diff), never `parsePatch`/`applyPatch` (those parse unified-diff text) — **not exploitable via this codebase's usage pattern** either, but cheap to bump (`diff@5.2.2`, non-major).

**core, pwa, extension: 0 findings.**

### 2. Secret scanning — REAL RESULTS

**Tracked working tree** (953 non-lockfile/non-dist files, heuristic patterns for PEM keys, AWS/Stripe/Slack/GitHub/Resend key formats, JWT-shaped strings, generic `key`/`secret`/`password` literal assignments, DB connection strings with embedded creds): 37 hits, **all false positives** — test fixtures (`cypress/e2e/*.cy.ts`, `packages/extension/test*/*.ts`, `packages/worker/test/*-e2e.worker.ts`) using obviously-fake values (`"secret123"`, `"CorrectPassword123!"`, `"password"`), enum member declarations in `packages/core/src/item.ts` (`WeakPassword = "weak_password"` etc. — field-type labels, not credentials), and one redaction-test sentinel string. `cypress.env.json` (tracked both currently and in full history) contains only placeholder values (`password: "password"`, `email: "user@example.com"`). Zero real credentials found in the tracked tree.

**Git history** (last 100 commits touching non-lockfile files, `git log -p`, same pattern set restricted to high-confidence formats — PEM headers, `AKIA...`, `sk_live_`/`sk_test_`, `xox[baprs]-`, `ghp_`/`github_pat_`, `re_...`, Mongo/Postgres URIs with embedded creds): **0 hits** on added (`+`) lines.

**Env-file audit**: only `cypress.env.json` has ever been committed among env-like filenames; `deploy/.env.example`, `docs/examples/config/example.env`, `docs/examples/hosting/docker/postgres-nginx-letsencrypt/.env`, `identity.local.env.example` are all documentation/example files — read all four, confirmed placeholder-only values (`smtp_username`, `***`, `test.padloc.app`).

**Conclusion: no secret-scanning findings.** This is a clean result, stated with confidence rather than "out of reach."

### 3. `packages/admin` deep re-review

Read all 11 files (`app.ts`, `accounts.ts`, `account-dialog.ts`, `orgs.ts`, `org-dialog.ts`, `logs.ts`, `change-log-entry-dialog.ts`, `request-log-entry-dialog.ts`, `index.ts`, `index.html`, plus `webpack.config.js` for CSP parity with pwa).

- **Destructive actions gated correctly, client AND server side.** `_deleteAccount()`/`_deleteOrg()` both show a `type: "destructive"` confirm dialog before calling `app.api.deleteAccount(id)`/`deleteOrg(id)`. Traced server-side: `Server.deleteOrg()` requires `org.isOwner(account)` OR `this._requireAuth(true)` (super-admin); `Server.deleteAccount(id)` requires `this._requireAuth(true)` when deleting another account. `_requireAuth(true)` checks BOTH `config.admins.includes(email)` AND `session.asAdmin === true` (a session flag only set via the explicit admin-login flow) — a stolen regular session cannot escalate.
- **CSP has parity with pwa.** `packages/admin/webpack.config.js` injects the same `default-src 'none'; base-uri 'none'; ...` meta CSP pattern as `packages/pwa/webpack.config.js` (both source `index.html` files ship with no CSP meta of their own — it's injected at build time in both packages identically).
- **No raw HTML injection in admin's own code.** Zero `unsafeHTML`/`innerHTML` usage in `packages/admin/src`. The only place untrusted-ish data (JSON dumps, log diffs) reaches `unsafeHTML` is via the shared `highlightJson()` helper (`packages/app/src/lib/util.ts`), which HTML-entity-escapes `&`/`<`/`>` before wrapping each token in a `<span class="...">` AND additionally runs `DOMPurify.sanitize(match, { ALLOWED_TAGS: [] })` per token — double-defended, already shared/reviewed code, not admin-specific risk.
- **"Raw Data" dump is not a secret leak.** `account-dialog.ts` renders `highlightJson(JSON.stringify(account.toRaw(), null, 2))` directly in the admin UI. Verified `Account.privateKey` and `Account.signingKey` are both decorated `@Exclude()` in `packages/core/src/account.ts`, and `Serializable._toRaw()` (`packages/core/src/encoding.ts:268`) explicitly skips any property with `opts.exclude === true`. So the dump cannot leak the account's private/signing key material — this is the same redaction pattern flagged as a real past gotcha for `Config`, independently re-verified here and confirmed safe for `Account`.
- **No new findings in `packages/admin`.** Round 1's "zero findings" for this surface holds up under independent re-review.

### 4. `packages/pwa` deep re-review

`packages/pwa/src` is genuinely tiny: `index.ts` (15 lines — sets platform, lazy-imports `@padloc/app/src/elements/app`, mounts `<pl-app>`) and `index.html` (147 lines, entirely presentational — theme-color/status-bar meta tags, a loading spinner, iOS Liquid-Glass status-bar workaround divs; no inline `<script>`, no CSP meta of its own — injected by webpack same as admin). `packages/pwa/scripts/serve.js` and `packages/pwa/webpack.config.js` (self-hosted static server + build-time CSP injection) were already the subject of Round 1's coverage per `padloc-fix-verification-gotchas`. **There is no additional pwa-specific application logic to review** — all real UI/business logic Round 1's WebClient reviewer needed to cover lives in `packages/app`, which it did cover. This gap is confirmed closed with no new findings, not deferred.

### 5. `unhandledRejection` gap — design scoping

`packages/server/src/init.ts:369-384` registers `process.on("uncaughtException", ...)`: logs, optionally emails `config.server.reportErrors` via `emailSender.send()`, then unconditionally `process.exit(1)`. No `process.on("unhandledRejection", ...)` exists anywhere in `packages/server/src`.

Found a **concrete, currently-reachable** source of unhandled rejections while tracing this: `packages/server/src/transport/http.ts`'s `createServer(async (httpReq, httpRes) => {...})` callback wraps only the `POST` branch's body in `try/catch` (lines 98–120). The `GET` branch (`const url = new URL(...)`) and anything above the `switch` execute unguarded; a synchronous throw there rejects the outer async callback's promise, which Node's `http.Server` never awaits — a genuine unhandled-rejection source, not a hypothetical one manufactured for this exercise.

Design implication for `sdd-design`: **the two fixes are not equivalent and must be decided together, not conflated**:
1. **Root-cause fix** (uncontroversial): wrap the entire `createServer` callback body in `try/catch`, matching the discipline already used for the `POST` branch. Removes the specific reachable gap.
2. **Process-level `unhandledRejection` handler** (needs a real decision, cannot defer again): Node's own guidance increasingly treats an unhandled rejection as seriously as `uncaughtException`, but blindly mirroring `uncaughtException`'s `process.exit(1)` risks turning ANY missed `.catch()` anywhere in the codebase (not just the http.ts gap, which is being fixed anyway) into a remotely-triggerable single-request DoS — one crafted request against a code path with a missed `.catch()` kills the whole process. Recommend: log + best-effort admin email (same shape as the existing handler) but do NOT `process.exit()` on `unhandledRejection` alone — treat it as "recoverable, log loudly, keep serving other requests," reserving hard-exit for `uncaughtException` (which Node's docs still treat as leaving the process in an undefined state). This diverges from `uncaughtException`'s posture deliberately, with the reasoning stated inline as a comment (matching this codebase's existing convention of `SECURITY:`-tagged inline rationale comments in `init.ts`/`http.ts`).

### 6. Session fixation / logout invalidation posture — traced, real findings

- **Logout DOES invalidate server-side**, not just client-side. `App._logout()` (`packages/core/src/app.ts:768`) calls `api.revokeSession(this.state.session!.id)`. `Server.revokeSession()` (`packages/core/src/server.ts:923`) verifies session ownership, removes the entry from `auth.sessions`, and `storage.delete(session)`s the actual `Session` record. Every request is authenticated by looking up `storage.get(Session, req.auth.session)` (`server.ts:266`) and throwing `INVALID_SESSION` on `NOT_FOUND` — so a deleted session is immediately and unconditionally rejected on the next request, regardless of client-side state. **Confirmed secure.**
- **Full account recovery DOES revoke all sessions.** `Server.recoverAccount()` (`server.ts:1195`, the "forgot master password" flow) explicitly does `auth.sessions.forEach((s) => this.storage.delete(...))` (line 1244) — every device is logged out. Correct treatment for a flow that's effectively a full credential reset.
- **Gap: a normal password change does NOT revoke other sessions.** `App.changePassword()` → `api.updateAuth({ verifier, keyParams })` → `Server.updateAuth()` (`server.ts:646`) only updates `auth.verifier`/`auth.keyParams`/`auth.mfaOrder` and saves — it never touches `auth.sessions` or deletes any `Session` records. If an attacker has a live stolen session (device compromise, malware, session-token exfiltration), the legitimate user changing their password afterward does **not** evict that attacker; the stolen session remains valid until it naturally expires. This is the standard OWASP-recommended control ("invalidate other sessions on password change") and it's genuinely missing here — this is a real, actionable finding, not documentation-only.
- **MFA enrollment/removal also does not revoke sessions.** Checked `Server.completeRegisterAuthenticator()` (`server.ts:362`) and `Server.deleteAuthenticator()` (`server.ts:385`) — neither touches `auth.sessions`. Lower priority than the password-change gap (adding a second factor is additive, not a compromise-recovery event) but worth noting for completeness.
- **Minor correctness note (not a security hole):** `recoverAccount()` deletes the underlying `Session` storage records but never clears the `auth.sessions` metadata array itself before `storage.save(auth)` — cosmetically stale entries could linger in the "Active Sessions" list until overwritten, but since authentication re-checks `storage.get(Session, id)` on every request (not the `auth.sessions` array), this has no security impact, only a possible stale-UI-list nit. Flagging for completeness, not proposing a fix for it.

### 7. CSRF posture — traced, confirmed by design (not just assumed)

`packages/core/src/session.ts`'s `Session._sign()`/`_verify()`: every request/response is authenticated by `signature = HMAC(sessionKey, "{sessionId}_{method}_{timestamp}_{marshal(body)}")`, sent as a `RequestAuthentication` object (`session`, `time`, `signature`) that is a **field inside the request body itself** (`packages/core/src/transport.ts`'s `Request.auth`), never a cookie or any other ambient browser-attached credential. `session.key` (the HMAC secret) is generated server-side at session creation and delivered once over the authenticated channel — it is never placed in a cookie, and `grep`ing `set-cookie|Set-Cookie|document.cookie|credentials:\s*["']include|withCredentials` across `packages/worker/src`, `packages/server/src`, and `packages/app/src` returns **zero matches** — confirmed no cookie-based session mechanism exists anywhere in either client-facing surface (Cloudflare Worker HTTP API or self-hosted Node HTTP API).

This means a malicious cross-origin page cannot forge a valid request: it has no way to obtain `session.key`, and browsers don't auto-attach it (unlike a cookie). **This architecture is CSRF-resistant by construction**, not by an add-on mitigation — there is no CSRF token to lose or forget because there is no ambient credential to begin with.

Notably, `packages/server/src/transport/http.ts:52-63` already carries a Round-1-era inline comment making exactly this argument to justify not hardening the self-hosted server's default `allowOrigin: "*"` CORS setting further ("Padloc's request authentication is HMAC-signed in the body, not cookie-based, so an open CORS origin alone can't forge authenticated requests"). The reasoning already exists in the code; it was never promoted to an explicit, disclosed audit finding. This gap is closed by **documentation**, not by a code change: formally state "CSRF: not applicable — signed-request architecture, verified against worker + self-hosted server, no cookie usage found" in the Round 2 report.

### Approaches

1. **Fix-what's-actionable, disclose-what-isn't** — Treat #1 (dep bumps), #5 (unhandledRejection handler + http.ts try/catch), and #6 (password-change session revocation) as real code changes for `sdd-apply`. Treat #2, #3, #4, #7 as **documentation-only findings** for the Round 2 report (clean scan results / confirmed-secure architecture / no new findings), since they came back clean or already-correct.
   - Pros: matches actual evidence gathered; no manufactured work; each finding gets the treatment its evidence supports.
   - Cons: none — this is simply following the evidence.
   - Effort: dep bumps = Medium-High (the `@simplewebauthn/server` 5→13 major bump is the biggest single item, needs API-surface diff against Round 1's webauthn.ts integration); `unhandledRejection` = Low; password-change session revocation = Low-Medium (needs a design decision on "revoke all EXCEPT current session" vs "revoke all", since revoking the session that just made the request would immediately log the user out mid-flow).

2. **Bump every vulnerable dependency to latest regardless of exploitability** — including `drizzle-orm` (worker) and `http-server`'s transitive deps (app) even though the codebase's usage pattern isn't exploitable.
   - Pros: defense-in-depth, closes the audit finding completely rather than "accepted risk."
   - Cons: `drizzle-orm` 0.38→0.45 and any http-server replacement are both semver-major/breaking-surface changes for zero measured exploitability gain; risks introducing real regressions to fix a theoretical one.
   - Effort: High.

3. **Defer non-exploitable audit findings with an explicit written risk-acceptance, prioritize only the exploitable/CRITICAL-path ones** (server's `@simplewebauthn/server` chain, `nodemailer`, session-revocation-on-password-change).
   - Pros: fastest path to closing the genuinely risky items; avoids burning the Round 2 budget on cosmetic dependency churn.
   - Cons: leaves `npm audit` non-clean, which a future "just run npm audit" ask will re-surface — needs the risk-acceptance written down (in the report) so it isn't rediscovered as a surprise.
   - Effort: Medium.

### Recommendation

**Approach 1** (fix-what's-actionable, disclose-what-isn't), informed by Approach 3's prioritization: run the scans as this exploration already did (no need to re-delegate — the real numbers are already gathered above), then in `sdd-apply` fix, in priority order:
1. `packages/server/src/transport/http.ts` — wrap the whole `createServer` callback in `try/catch` (root cause, small, no design ambiguity).
2. `packages/server/src/init.ts` — add `process.on("unhandledRejection", ...)`: log + best-effort admin email, explicitly NOT `process.exit()` (documented rationale inline, per the design note above).
3. `packages/core/src/server.ts`'s `updateAuth()`/`changePassword` path — revoke all OTHER sessions (not the one making the request) on a successful password change. Needs a design decision on exact scope (just `verifier` changes, or also `keyParams` changes, or also MFA enrollment) before implementation — recommend scoping to verifier changes (password change) only for Round 2, matching the OWASP-standard trigger, and explicitly noting MFA enrollment as an accepted-risk non-fix (lower severity, additive not destructive action).
4. Dependency bumps: `@simplewebauthn/server` 5.4.3→13.3.2 (server, addresses all 3 CRITICALs — biggest item, needs the webauthn.ts integration re-verified against the new major API), `nodemailer` 6.6.1→6.10.1 (server), `@aws-sdk/client-s3` family (server, non-major per `fixAvailable`), `diff` 5.1.0→5.2.2 (admin, non-major). Explicitly document `drizzle-orm` (worker) and `http-server`'s transitive chain (app) as accepted-risk-not-exploitable rather than forcing a major bump for zero measured benefit, unless the user wants full audit-clean.
5. Document #2 (secret scan: clean), #3 (admin: no new findings), #4 (pwa: no new findings), #7 (CSRF: resistant by design, verified) directly in the Round 2 report — no code changes needed for these four.

### Risks

- The `@simplewebauthn/server` major-version bump (5→13) is the single highest-effort, highest-regression-risk item in this batch — its API surface changed significantly across 8 major versions; Round 1's `packages/server/src/auth/webauthn.ts` integration will need re-verification against the new API, not a blind version bump.
- "Revoke other sessions on password change" needs a UX decision (does the CURRENT session survive the change, or does the user get logged out everywhere including their own active tab?) — this is a real design fork, not a mechanical fix; flagging for `sdd-design` rather than deciding unilaterally here.
- `unhandledRejection`'s no-`process.exit()` design choice is a deliberate divergence from `uncaughtException`'s posture and needs to be stated explicitly (with rationale) in the design doc so it isn't later "corrected" back into a DoS-enabling mirror of the exception handler by someone pattern-matching without re-deriving the reasoning.
- Bumping `tar`/`form-data`/`elliptic`/`jsrsasign` indirectly via their parent packages (`geolite2-redist`, `jsdom`, `@simplewebauthn/server`) means their own `fixAvailable` targets are the PARENT package version, not a direct override — verify with a fresh `npm audit` after each parent bump rather than assuming the advisory is closed.

### Ready for Proposal

Yes. All 7 gap areas have concrete, evidence-backed scope: 3 areas need real code changes (http.ts try/catch, unhandledRejection handler, session revocation on password change) plus a prioritized dependency-bump list; 4 areas are confirmed-clean/confirmed-secure and need only be written up as findings in the Round 2 report, not implemented. The orchestrator should proceed to `sdd-propose` with this scope.

## Key Learnings

1. `npm audit --production` on `packages/server` surfaces 4 CRITICAL findings that trace to `@simplewebauthn/server@5.4.3`'s transitive `elliptic`/`jsrsasign` deps — directly relevant to Round 1's WebAuthn MFA feature, not generic dependency noise.
2. `packages/server/src/transport/http.ts`'s `createServer` callback only try/catches the POST branch, leaving a real (not hypothetical) unhandled-rejection source in the GET branch that motivates both a root-cause fix and a process-level `unhandledRejection` handler.
3. Password change (`updateAuth`) does not revoke other active sessions server-side, unlike full account recovery (`recoverAccount`, which does via `auth.sessions.forEach(...)` deletion) — a genuine session-fixation-adjacent gap distinct from logout, which IS correctly server-side-invalidated.
4. Padloc's HMAC-signed-request-body auth model (`session.ts`'s `_sign`/`_verify`) has zero cookie usage anywhere in worker/server/app source, confirming CSRF-resistance by construction rather than by an add-on mitigation that could be misconfigured.
5. `Account.privateKey`/`signingKey` are `@Exclude()`-decorated and correctly omitted from `toRaw()`, so `packages/admin`'s raw-JSON account dump does not leak vault key material — independently re-verified rather than assumed safe.
