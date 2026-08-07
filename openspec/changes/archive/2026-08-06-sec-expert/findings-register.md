# sec-expert — Consolidated Findings Register (Phase 2)

Consolidated from 7 independent parallel reviews (WorkerAuthCore, WorkerStorageEmail,
CoreCryptoBusinessLogic, WebClient, ExtensionClient, ServerSelfHosted,
PriorClaimsVerification). Deduplicated across surfaces; `packages/core` findings
cross-checked for both worker and self-hosted-server reachability.

Status legend: `OPEN` = not yet remediated; `FIXED (commit <sha>)` = remediated with a linked commit; `DOCUMENTED AS DEFERRED` = intentionally not fixed this round, with rationale. Phase 5 (this pass) closed all 8 MEDIUM findings (7 fixed, 1 documented deferral) and triaged all 17 LOW findings (6 fixed, 11 documented deferral — 2 of which were already pre-existing in-code documentation from earlier phases).

## CRITICAL (3)

### C1. Request signatures don't bind the RPC method — method-confusion forgery — FIXED (commit 94babfc7)
- **Where**: `packages/core/src/session.ts:159-176` (`_sign`/`_verify`), `packages/core/src/transport.ts:28-33` (`Request`), `packages/core/src/server.ts` `process()` ~L323-336
- **Exploit**: HMAC signature covers `${session}_${time}_${marshal(params)}` but never `method`. Anyone who observes one legitimately signed request (malicious extension, logging proxy, compromised CDN) can replay the identical envelope with `method` swapped to any other RPC accepting a structurally-compatible param shape (e.g. capture `getVault("<id>")`, replay as `deleteVault`) within the 5-minute window — no session key, password, or MFA needed.
- **Fix**: `Session._sign`/`_verify` now bind the RPC method into the signed message (`${session}_${method}_${time}_${marshal(data)}`); `Response` has no `method` field and consistently signs/verifies with `method=""`, leaving that path's behavior unchanged.
- **Backward compatibility**: no hazard confirmed — session keys are negotiated via SRP, not derived from this signing scheme, and every request is signed fresh client-side per-call (`packages/core/src/client.ts`'s `call()`), so no persisted/cached signature survives the deploy. Any in-flight request signed under the old scheme fails verification post-deploy (correct fail-closed behavior) and the client's next call re-signs under the new scheme automatically.
- **Verified**: `packages/server`'s pinned `tsc --noEmit --skipLibCheck` clean; `packages/worker`'s `test/session-contract.test.mjs` (6/6 passing, no regression); live smoke test via `ts-node` against the real `Session` class proved (a) legit same-method sign/verify round-trips true, (b) a captured `getVault` envelope replayed as `deleteVault` now verifies false (confirmed true/exploitable on pre-fix code via `git stash`), (c) `Response` signing round-trip unaffected.
- **Reachable via**: both Worker and self-hosted Server (shared `core`).
- **Surface**: CoreCryptoBusinessLogic

### C2. NoSQL injection in MongoDB storage backend — FIXED (commit 61dfceed)
- **Where**: `packages/server/src/storage/mongodb.ts:64-101` (`queryToMongoFilter`)
- **Exploit**: `query.path` used unsanitized as a Mongo filter key in every branch; `path='$where'` yields arbitrary server-side JS execution, cross-tenant query-scope bypass, or DoS. Sibling `storage/postgres.ts` already validates via `assertSafeKey` — this backend doesn't.
- **Fix**: added `assertSafePath()`, mirroring `postgres.ts`'s `assertSafeKey` — every dot-separated `query.path` segment must match `/^[a-zA-Z0-9_]+$/` before being used as a filter object key; called in the `regex`, `negex`, `eq`/`undefined`, and operator-`default` branches (every leaf that reads `query.path`).
- **Verified**: `tsc --noEmit --skipLibCheck` clean; live smoke test against a real disposable MongoDB 6 container (docker) via the actual `MongoDBStorage.list()` path proved (a) legit `eq` and safe dotted-path queries still return correct results, (b) `path: "$where"`, `path: "email.$ne"`, and `path: "$expr"` (default-branch) are all rejected with `BAD_REQUEST` before reaching Mongo — confirmed exploitable (`$where` accepted, no error) on pre-fix code via `git stash`.
- **Surface**: ServerSelfHosted

### C3. Unauthenticated single-request Node process crash — FIXED (commit 3ba26aef)
- **Where**: `packages/server/src/provisioning/stripe.ts` `_handlePortalRequest` (~L925-956)
- **Exploit**: missing `return` after failed portal-URL signature check; falls through to `httpRes.writeHead(302,...)` on an already-ended response → `ERR_HTTP_HEADERS_SENT` unhandled rejection (no `.catch`, no process-level handler) → crashes the entire backend process. Single unauthenticated `GET /portal?email=<known-email>`.
- **Fix**: added the missing `return` immediately after the failed-verification branch writes its 401 response.
- **Verified**: `tsc --noEmit --skipLibCheck` clean; existing `mocha` suite in `test/` still 10/10 passing (unrelated crypto tests, only real suite in this package); live smoke test directly invoking the real `_handlePortalRequest` with a fake `IncomingMessage`/`ServerResponse` and stubbed downstream account/Stripe lookups reproduced the EXACT crash (`ERR_HTTP_HEADERS_SENT` thrown from the fallthrough `writeHead(302)` call) on pre-fix code via `git stash`, and confirmed the fix now returns a single clean 401 response with no exception.
- **Additional finding (documented, not fixed — out of Critical-round scope)**: `packages/server/src/init.ts:369` registers a process-level `uncaughtException` handler (admin email alert + `process.exit(1)`), but there is **no `unhandledRejection` handler**. `uncaughtException` does NOT catch rejected promises — only synchronous throws and re-thrown async errors surface there. This C3 fix removes the one reachable trigger found in this audit, but any *other* unhandled promise rejection elsewhere in the codebase still has no process-level safety net (no admin alert, and Node's default `unhandledRejection` behavior is to crash the process with no report). Adding a handler is a genuine design decision (should an unhandled rejection crash-and-restart like `uncaughtException` does, or only log?) — left undecided/unfixed here per honest-disclosure discipline; recommend addressing in a follow-up MEDIUM/HIGH-round task rather than guessing the intended restart semantics.
- **Surface**: ServerSelfHosted

## HIGH (5)

### H1. Cross-origin iframe credential leak via autofill broadcast — FIXED (commit 9770f004)
- **Where**: `packages/extension/src/message.ts:144`, `content.ts:113-122`, `manifest.json` (`all_frames: true`)
- **Exploit**: `messageTab()` delivers `fillFields`/`fillActive` to every frame in the tab, no `frameId` scoping, no origin check on receipt. A third-party iframe (ads/widgets) with a planted password field on a page the victim has real credentials for gets the real password filled into attacker-controlled cross-origin DOM.
- **Fix**: `messageTab()` now always passes `{ frameId: 0 }` to `browser.tabs.sendMessage`/checks `isContentReady` on frame 0 only, so `fillActive`/`fillFields` are delivered exclusively to the tab's top-level document — a cross-origin iframe's content-script instance no longer receives the message at all, regardless of its own `document.activeElement` state. Added a same-frame guard in `content.ts`'s `_handleMessage` (`window.self !== window.top` rejects `fillActive`/`fillFields`) as defense-in-depth in case any transport path ever delivers to a subframe anyway. `AutofillBrokerBinding.frameId` was investigated but found to be an opaque string label (`"main"`) from the Magic Browser protocol, not a numeric Chrome extension `frameId` — wiring it directly wasn't meaningful; frame 0 is always the correct target for every current fill flow.
- **Surface**: ExtensionClient

### H2. Agentic autofill broker has no cross-step tab/origin binding — FIXED (commit 9770f004)
- **Where**: `packages/extension/src/background.ts:1078,1094,1102-1106,1129`, `message.ts:133-147`
- **Exploit**: plan→approve→mint→apply re-queries "active tab" independently at each step; if focus changes mid-flow (plausible given real elapsed time for popup approval), plaintext credentials get delivered to whatever tab is active at apply time. Sibling passkey flow enforces this binding; autofill broker doesn't.
- **Fix**: `PendingBrokerPlan` now captures a `{ tabId, origin }` binding at plan-fill/classify time (`autofill-broker.ts`'s new `BrokerTabBinding`/`isBrokerTabBindingCurrent`, mirroring `passkey-request-binding.ts`'s `isPasskeyRequestBindingCurrent` exactly). `mint-fill-bundle` and `apply-fill-bundle` both re-verify the current active tab against that binding via a new `assertBrokerTabBindingCurrent()` and fail closed (throw) on any tab/origin mismatch before sourcing items or delivering the fill; `apply-fill-bundle` also now passes the verified `tabId` explicitly into `messageTab()` instead of letting it re-query "the active tab" a third time.
- **Surface**: ExtensionClient

### H3. Attachment preview MIME-type confusion — cross-account XSS risk — FIXED (commit fb1d8e6d)
- **Where**: `packages/app/src/elements/attachment-dialog.ts:179-186`, `packages/core/src/attachment.ts:129-157`
- **Exploit**: `Attachment.type` is fully client-controlled (server is zero-knowledge, can't validate it), yet drives `<object type="application/pdf" data="blob:...">` rendering. A malicious org member renames an HTML/SVG payload to declare `type: application/pdf`; victim's preview may execute it same-origin with their unlocked vault. Severity bounded by browser PDF-viewer hardening (not independently confirmed live).
- **Fix**: added `looksLikePdf()` to `core/attachment.ts`, checking the actual decrypted bytes for the `%PDF-` magic header. `attachment-dialog.ts`'s `_getPreview()` now decrypts once, sniffs the real bytes, and only renders the `<object type="application/pdf">` embed when the sniff passes (using a freshly-constructed `Blob`/File forcing `type: "application/pdf"`, never the client-declared `Attachment.type`). Anything that fails the sniff falls back to the pre-existing safe "No preview available" download-only presentation.
- **Surface**: WebClient

### H4. Extension session (API-auth) key stored unencrypted at rest — FIXED (commit f7e69bcc) — **severity disputed, see note**
- **Where**: `packages/extension/src/storage.ts:75-79`, `packages/core/src/session.ts:87-114` (`Session.key`)
- **Exploit**: `Session.key` (HMAC request-signing key) has no `@Exclude()`/PBES2 wrapper, unlike `Account.privateKey`. Local disk/forensic access to the extension's `chrome.storage.local` LevelDB backing lets an attacker forge signed API requests as the victim for up to 90 days, without the master password. Does NOT expose vault plaintext (master key is correctly isolated in `chrome.storage.session`).
- **Reconciliation note**: ExtensionClient (fresh independent review) rated this HIGH; PriorClaimsVerification (re-assessing the previously-disclosed item) rated it MEDIUM, citing the strong local-compromise precondition. **Consolidation decision: keep HIGH for remediation ordering** (full API impersonation capability, asymmetric fix cost is low — reuse the already-correct `chrome.storage.session` pattern already built for the master key) — disclosed as a reconciled-from-disagreement severity per honest-disclosure discipline.
- **Fix**: `ExtensionStorage` now special-cases `AppState`: `session.key` is stripped from the record written to `browser.storage.local` and mirrored instead into `browser.storage.session` (memory-only, `TRUSTED_CONTEXTS`) via new `saveSessionSigningKey`/`getSessionSigningKey`/`clearSessionSigningKey` helpers, mirroring the existing `saveSessionMasterKey` pattern exactly. On load, `session.key` is transparently re-hydrated from session storage; as with the master key, it does not survive a full browser restart (matching existing precedent rather than inventing a new lifecycle). This is the full intended fix, not a reduced fallback.
- **Surface**: ExtensionClient / PriorClaimsVerification

### H5. PBKDF2 key-derivation parameters have no server-side floor — FIXED (commit cef8396e)
- **Where**: `packages/core/src/crypto.ts:80-96` (`PBKDF2Params.validate()`)
- **Exploit**: no minimum iteration count, no minimum salt length (empty salt passes). A malicious/compromised client can set `iterations: 1`, empty salt; if the verifier store ever leaks, offline brute force becomes dramatically cheaper. Silently and permanently weakens the crypto floor the zero-knowledge model depends on.
- **Reconciliation note**: CoreCryptoBusinessLogic flagged this as "MEDIUM/HIGH" — escalated to HIGH here given the crypto-floor blast radius is exactly what the external scope brief's #1 priority workstream (verify the zero-knowledge assumption holds) is about.
- **Fix**: added `PBKDF2_ITER_MIN` (100,000) and `PBKDF2_SALT_MIN_LENGTH` (8 bytes) constants plus an explicit `isSecurePBKDF2Params()` check to `core/crypto.ts` — deliberately NOT folded into `PBKDF2Params.validate()` itself, since that class is also reused by `Index.hashParams` (`core/app.ts`) for a purely local, non-secret hostname-hashing index that intentionally uses `iterations: 1` for speed (confirmed by tracing every real usage of `PBKDF2Params` before implementing; folding the floor into `validate()` would have broken `AppState` (de)serialization on every platform). Wired into `server.ts`'s `createAccount`, `updateAuth`, `updateAccount`, and `recoverAccount` — both the SRP verifier's `keyParams` (the exploit scenario named in the finding) and `Account.keyParams` (the same vulnerable pattern, one call away in the same handlers) are now rejected server-side below the floor. `packages/worker`'s e2e test fixtures used `iterations: 1000`/`10000` for test speed (below the new floor); bumped to `PBKDF2_ITER_MIN` rather than weakening the floor to accommodate them.
- **Surface**: CoreCryptoBusinessLogic

## MEDIUM (8)

### M1. Rate-limit Durable Object bindings fail open with no operator alert — FIXED (commit 0535cbf0)
- **Where**: `packages/worker/src/rate-limiter.ts:100-114`, contrast `server-factory.ts:47-56` (ACCOUNT_LOCK had an alert, this didn't)
- Reported independently by WorkerAuthCore AND WorkerStorageEmail — deduplicated here.
- **Exploit**: missing `GENERAL_RATE_LIMIT`/`SHARE_VIEW_RATE_LIMIT` bindings silently disabled all brute-force throttling, zero telemetry.
- **Fix**: `index.ts`'s `fetch()` now calls `captureHqException` for each binding when missing in `production`/`staging`, mirroring the existing `ACCOUNT_LOCK` check exactly.
- **Verified**: `npm run deploy:dry-run` (clean esbuild bundle) and the full `packages/worker` `test:ci` suite (78 assertions, 0 failed).

### M2. SRP hash inputs omit RFC 5054 `PAD()` step — DEFERRED (commit 4e0b155b, documentation only)
- **Where**: `packages/core/src/srp.ts:116-163` (`i2b`, `Core.H`/`u`/`k`/`M1`/`M2`)
- Deviation from RFC 5054 §2.5.4's anti-ambiguity requirement in the most security-critical component.
- **Deferral rationale**: not independently exploitable today — client and server are the only two parties, always run byte-identical `i2b`/`H()` code, so the concatenation ambiguity RFC 5054's PAD() guards against (two different (A,B) pairs hashing to the same bytes) has no forgery path here; this implementation also follows the simpler srp.stanford.edu SRP-6a design rather than RFC 5054's literal M1/M2 construction, so "PAD() per RFC 5054" isn't a drop-in fix regardless. A correct fix needs PER-ARGUMENT canonical widths (group-byte-length for A/B/v/g, which itself varies 384–1024 bytes across configured `SRPGroupLength`; digest-byte-length for K/M1) — a single blanket `i2b` change would be wrong. With no SRP wire-format version negotiation and aggressively-cached clients (PWA/extension/electron/cordova), a byte-for-byte mismatch between an old cached client and a freshly deployed server would break EVERY login/signup simultaneously and irrecoverably until every client re-fetches. Detailed `SECURITY:` comment added at the exact gap explaining what a correct fix requires (per-argument padding, byte-level test vectors, a protocol-version bump) rather than rushing it.
- **Verified**: comment-only change — `packages/server`'s pinned `tsc --skipLibCheck` clean; `packages/worker`'s `test:crypto-parity` (SRP/session M1/M2 vector, passing) and `test:session-contract` (6/6) confirm zero behavior change.

### M3. D1 email columns don't enforce documented lowercase invariant — FIXED (commit b54261ae)
- **Where**: `packages/worker/src/storage/schema.ts:38-40`, `d1.ts` (`save()`), new `storage/normalize-email.ts`
- Not currently exploitable (ID-hash lookup saves it) but a violated storage invariant with admin-authorization blast radius if any future code trusts it.
- **Fix**: extracted `normalizeEmailForStorage()` into its own dependency-free module and wired it into `D1Storage.save()`'s `accounts`/`auth` INSERT and ON-CONFLICT-UPDATE email bindings.
- **Verified**: new `test:normalize-email` unit test (6/6, real function, not a reimplementation) wired into `test:ci`; the extraction was necessary because directly importing `d1.ts` standalone hits a pre-existing, unrelated `@padloc/core` circular-import crash (confirmed present on an unmodified checkout via `git stash`, independent of this fix) — `normalize-email.ts` has zero `@padloc/core` imports so it sidesteps that entirely. Full `test:ci` green.

### M4. Self-hosted passkey RP-root env var not validated as a real registrable domain — FIXED (commit de25edfa)
- **Where**: `packages/extension/src/passkey-rp-policy.ts:9-15,29-40`
- Operator-misconfiguration path to RP impersonation (default build only trusts `google.com`+localhost).
- **Fix**: added a registrable-domain sanity floor — reject single-label `PL_PASSKEY_RP_ROOTS` entries and a short hardcoded reject-list of common public/multi-tenant suffixes (`com`, `io`, `github.io`, `herokuapp.com`, `vercel.app`, etc.). Not a full Public Suffix List parser by design (documented residual risk for suffixes outside the list).
- **Verified**: existing mocha suite (3/3, no regression) plus a new module-reload test exercising the real env-var-driven filtering (rejects `com`/`github.io`/`io`, accepts `my-real-domain.com`, Google baseline always survives) — 4/4 passing.

### M5. S3 attachment backend has no path validation (unlike hardened `fs.ts` sibling) — FIXED (commit 200b645c)
- **Where**: `packages/server/src/attachments/s3.ts:60-98`
- `deleteAll`'s bulk-delete-by-prefix had no local safety net for a malformed `vault` value.
- **Fix**: added `assertSafeSegment()` mirroring `fs.ts`, called at the top of `get`/`put`/`delete`/`deleteAll`/`getUsage` before `vault`/`id` reach any S3 Key/Prefix.
- **Verified**: `packages/server`'s pinned `tsc --skipLibCheck` clean.

### M6. Prototype pollution via `Object.assign` in self-hosted provisioning entries — FIXED (commit 07ada1c6)
- **Where**: `packages/server/src/provisioning/api.ts:61-94` (`ProvisioningEntry` constructor)
- No equivalent guard to `core`'s `setPath` `FORBIDDEN_PATH_SEGMENTS` protection; `vals` traces to a client-controlled JSON request body.
- **Fix**: replaced the raw `Object.assign(this, vals)` with an explicit per-key loop skipping `__proto__`/`constructor`/`prototype`. Deliberately used a plain array (not a `Record` object literal) for the reject-list — confirmed via a direct Node probe that `{__proto__: true, ...}` as an object literal does NOT create an own `"__proto__"` property at all (it silently tries to set the object's actual prototype instead), which would have made a Record-based check unreliable.
- **Verified**: confirmed the exact JSON.parse own-key behavior live (`Object.keys(JSON.parse('{"__proto__":...}'))` includes `"__proto__"` as a real own key, unlike object-literal syntax) and that the fix strips it; `packages/server`'s pinned `tsc --skipLibCheck` clean.

### M7. AccountLockDO fixed 30s TTL can auto-release mid-operation under contention — FIXED (commit f77d2b98)
- **Where**: `packages/worker/src/locks/account-lock.ts:36-93,150-194`
- Reintroduces the exact race the DO exists to prevent, under slow-path/cold-start conditions.
- **Fix**: added `AccountLockDO.renew(jobId, ttlMs)` (extends the timer only if `jobId` is still the current holder, no re-queuing) and a periodic heartbeat in `acquireLock()` at 1/3 of the TTL. If the holder's execution context is itself gone (crash/eviction), the heartbeat simply stops firing and the DO's own timer still reclaims the lock — the safety valve is preserved, not removed.
- **Verified**: two new real-`AccountLockDO`-class tests — `renew()` extends the lock past its original TTL window and the auto-release-if-never-released safety valve still eventually fires; `renew()` is a no-op (returns `false`) for a jobId that isn't the current holder and doesn't disturb the real holder's TTL. Full `account-lock-do.test.mjs` suite: 14/14 passing (no regression in the pre-existing sequential/concurrent-burst/TTL tests).

### M8. Request body fully buffered before size-limit enforcement — FIXED (commit 596e9230)
- **Where**: `packages/worker/src/transport.ts:47-99,189-210` (`readBodyWithLimit`, `_handlePost`)
- Resource-amplification DoS gap against unauthenticated endpoints.
- **Fix**: added a `Content-Length` fast-path precheck (rejects a truthful oversized declared length before touching the body at all) plus `readBodyWithLimit()`, which reads the body stream in chunks, tracks a running total, and cancels the reader the instant the total exceeds `maxRequestSize` — capping worst-case buffered memory at roughly the limit plus one chunk, regardless of the caller's declared or actual body size.
- **Verified**: 3 new tests against the real `WorkerReceiver`/real `Request`/`ReadableStream` — (1) a hanging body stream is never touched when Content-Length alone already exceeds the limit (raced against a timeout, not a flaky pull-count check — Node's own `Request` implementation eagerly touches a streaming body once as an internal detail, which made pull-counting unreliable), (2) an undeclared oversized body is rejected after ~3 chunks (150 bytes), not the whole stream, (3) an in-limit body still round-trips correctly. Full worker `test:ci` green.
## LOW (17)

L1. IP identity trusts `x-forwarded-for` fallback with no trust-boundary assertion — `worker/transport.ts:113-114`, `index.ts:238-241`
  **DOCUMENTED AS DEFERRED**: not code-fixable in isolation — asserting a trust boundary requires knowing the real deployment's proxy topology (Cloudflare-only vs. behind an additional corporate/CDN proxy chain), which is an operator/infra decision, not something this code can determine.
L2. Lock key normalization mismatch (`toLowerCase` vs `toLocaleLowerCase`) — **FIXED (commit 48ae3f3b)**: `core/server.ts`'s two `accountLock.withLock(...)` call sites now use `.toLowerCase()`, matching both `AccountLockProvider` implementations. Verified via `packages/server` tsc, `session-contract.test.mjs`, and the real `account-lockout-e2e` wrangler suite.
L3. Transport-level request-age replay check is a permanent no-op — `worker/transport.ts:159,267-292`
  **DOCUMENTED AS DEFERRED**: already has a thorough, honest, pre-existing in-code `SECURITY:` comment explaining exactly why it's a no-op and why the two anonymous share-view methods it would have covered are already fully protected by the DO's atomic one-time-view flag instead. No further action needed.
L4. Dead `errorResponse()` export missing security headers, latent-regression risk — **FIXED (commit 7e340121)**: removed the dead export from `worker/error.ts` entirely (confirmed zero importers). Verified via `deploy:dry-run` + full `test:ci`.
L5. WebAuthn cross-platform authenticators don't require user verification — `worker/auth/webauthn.ts:100-102,195-197,219`
  **DOCUMENTED AS DEFERRED**: forcing `userVerification: "required"` for cross-platform authenticators is a real compat/security tradeoff — some FIDO U2F-style security keys don't support UV at all, so a blanket change could break registration for existing users' hardware keys. Needs a deliberate compatibility decision, not a rushed change; correctly triaged as LOW (not MEDIUM) already.
L6. Presigned-URL attachment flow: TTL-reuse + unverified hash (confirmed dead/unreachable code) — `worker/attachments/r2.ts:243-371`
  **DOCUMENTED AS DEFERRED**: already has a thorough, honest, pre-existing in-code `SECURITY:` comment confirming zero RPC callers (dead code) and listing the exact two gaps to close before ever wiring it up. No live exploit path; no further action needed.
L7. `MockMessenger`/`EMAIL_BACKEND=mock` misconfig has no production alert — **FIXED (commit 7e340121)**: added the same `captureHqException` alert pattern as the `ACCOUNT_LOCK`/rate-limit DO checks. Verified via `deploy:dry-run` + full `test:ci`.
L8. Dead wildcard `DEFAULT_CORS.allowOrigin: '*'` constant, unused but attractive nuisance — **FIXED (commit 7e340121)**: retyped `DEFAULT_CORS` to `Omit<CorsConfig, "allowOrigin">` and dropped the field; `corsHeaders()` never had a fallback path reading it. Verified via `deploy:dry-run` + full `test:ci`.
L9. AES params permit 64-bit GCM auth tags — `core/crypto.ts:15-31`
  **DOCUMENTED AS DEFERRED**: same legacy-compat landmine as H5's PBKDF2 floor — `legacy.ts`'s `parseLegacyContainer()` constructs `AESEncryptionParams` with `tagSize: raw.ts` for importing real Padlock 1.x/2.x vaults, which historically used 64-bit SJCL tags; tightening the shared `validate()` would break those legitimate legacy imports. A correct fix needs the same dual-gate approach as H5 (a separate floor enforced only at NEW-encryption call sites, confirmed by tracing every real `AESEncryptionParams` construction site first) — a genuine design decision, not a 2-line change.
L10. `getKeyStoreEntry` has only implicit (not explicit) ownership check — **FIXED (commit 48ae3f3b)**: added the same explicit `entry.accountId !== account.id` guard its sibling `deleteKeyStoreEntry` already has. Verified via `packages/server` tsc --skipLibCheck.
L11. `startAuthRequest` has no visible rate limit at the `core` layer — `core/server.ts:~410-475`
  **DOCUMENTED AS DEFERRED**: architectural, not a gap — `core` is platform-agnostic by design (mirrors `AccountLockProvider`'s host-injection pattern) and this path is already gated by the worker transport layer's `authRateLimiter` (`checkAuthRateLimit`, 20 req/60s on `AUTH_SENSITIVE_METHODS`, confirmed present in `index.ts`). Threading a rate limiter through `core`'s `Server` constructor for redundant defense-in-depth is a real design change, not a trivial fix.
L12. CSP allows `blob:` broadly for script-src/object-src/frame-src — `pwa/webpack.config.js:31`
  **DOCUMENTED AS DEFERRED**: narrowing requires first auditing every legitimate `blob:` consumer (WASM crypto workers, PDF/attachment preview blobs, etc.) to avoid silently breaking real functionality — a compat-sensitive change, not a safe mechanical one within this round's scope.
L13. Markdown `<img>` allows arbitrary remote URLs (tracking-pixel IP/UA disclosure) — `app/lib/markdown.ts:12-46`
  **DOCUMENTED AS DEFERRED**: remote image support in markdown notes is intentional product behavior; restricting it (stripping `img`, proxying, or referrer-stripping) is a UX-affecting product decision requiring explicit sign-off, not a mechanical security patch.
L14. `isExtensionDocumentSender` guard drops ALL legitimate content-script messages — `extension/background.ts:473-478`
  **DOCUMENTED AS DEFERRED**: explicitly NOT a vulnerability per the original finding itself (fails safe) — it's a functional bug (broken save-password prompt), out of scope for a security remediation round.
L15. Orphaned second WebAuthn interceptor (dev-only, unshipped) — `extension/webauthn-page.ts`, `scripts/agentic-extension-cdp.mjs`
  **DOCUMENTED AS DEFERRED**: confirmed genuinely unreferenced by the real `manifest.json`/`webpack.config.js` (only consumed by the dev-only `agentic-extension-cdp.mjs` CDP tooling script) — no real-user attack surface. Left alone rather than risk breaking the agentic dev/test tooling for a change with no production security benefit.
L16. `email/smtp.ts` template corruption via unescaped `String.replace` replacement patterns — **FIXED (commit ebb7bace)**: switched to replacer functions, which never receive `$`-pattern treatment. Verified directly: pre-fix, a value containing `$&` re-inserted the matched placeholder text into the output; post-fix, the literal value is preserved byte-for-byte.
L17. `mongo2postgres.ts` hardcodes `rejectUnauthorized:false` regardless of config — **FIXED (commit ebb7bace)**: now respects `tlsRejectUnauthorized` from config (defaulting `true`), matching the real `storage/postgres.ts` backend it was copied from. Verified via `packages/server` tsc --skipLibCheck.

(Note: tasks.md/spec allowed LOW items to be documented rather than all fixed — see Phase 5. 6/17 fixed with commits; 11/17 documented with deferral rationale.)

## PriorClaimsVerification results (no register entries — informational)

- **10/10 previously-FIXED items spot-checked**: no regressions (email HTML injection, dead lockout module removal, MockMessenger fail-closed, reverse tabnabbing, session absolute expiry, timing-safe comparisons x2, AccountLockDO race/deadlock fix, rate-limiter DO migration, WebAuthn single-use, idempotency-cache scoping).
- **AccountLockDO / GENERAL_RATE_LIMIT DO bindings**: CONFIRMED present in code/config for dev, preview, AND the real git-ignored staging `wrangler.local.toml` in this workspace. **Live Cloudflare production/staging deploy status remains UNCONFIRMED** — no account access available; both primitives fail open silently if a binding is actually missing live. Disclose as caveated in the final report, not claimed closed.
- **Presigned-URL gaps (L6)** and **blob: preview (superseded by H3)**: re-confirmed at their original LOW severity; H3 is a NEW, more specific and more severe finding on the same general attachment-preview area.

## Per-Surface No-Findings Statements (appendix — closes sdd-verify WARNING re: transcript-only evidence)

Copied from each Stage-1 reviewer's original report so this register is self-contained without needing sub-agent session transcripts.

**WorkerAuthCore**: CORS wildcard-origin fail-closed logic — no findings, correct guard. Idempotency anonymous/replay exclusion — no findings, comprehensively excludes every unauthenticated method. `account-lock.ts` FIFO ordering/race-safety of `acquire()` — no findings, correctly ordered, could not reintroduce the previously-fixed race. WebAuthn origin/RPID pinning — no findings, sourced from static server config only. Healthcheck endpoint — no findings, correctly minimal response.

**WorkerStorageEmail**: D1 query building — no SQL injection, all values parameter-bound via Drizzle. R2 attachment row-scoping — no cross-vault key collision possible. Attachment upload quota bypass — already fixed in the reachable path. Email template injection — uniform HTML-entity-escaping, no injection vector. ShareLinkDO/RateLimitDO atomicity — no race condition in either DO. Log redaction / HQ telemetry — field-name redaction correctly applied, no attacker-controlled data found flowing into unredacted fields; internal-host allowlist prevents exfiltration. Security headers/CORS — conservative, no findings beyond one dead-code note.

**CoreCryptoBusinessLogic**: zero-knowledge assumption — holds structurally across every RPC handler, no server-side plaintext handling found. TOTP/HOTP — RFC-conformant, timing-safe, no findings. Session-expiry/lockout logic — well-reasoned. IDOR/cross-account/cross-org checks — every authenticated handler beyond one LOW exception has explicit ownership/role/admin checks. Share-link field-scope handling — correctly designed server-side lifecycle. SRP-6a correctness — zero-value checks present and correct, group parameters match RFC 5054, strong default iteration count.

**WebClient (incl. Admin surface, security-baseline Req.5)**: **Admin console RPC authorization — no findings.** Every admin-surfaced RPC (`listAccounts`, `listOrgs`, `listChangeLogEntries`, `listRequestLogEntries`, `getAccount`/`getOrg`/`deleteAccount` for a foreign id) independently calls `_requireAuth(true)` server-side, gated on `_isAdmin(email)` against the server-owned `config.admins` allowlist (never client-supplied); `startCreateSession`'s `asAdmin` flag is independently re-validated. The client-side admin app has no gating of its own, but authorization is enforced entirely server-side per call — zero gaps found tracing every admin RPC to its `core` role check. XSS via DOMPurify sinks — no findings beyond one LOW tracking-pixel note; `unsafeHTML` always downstream of `sanitize()`. Auto-lock bypass — no findings. Untrusted file parsing (KeePass/CSV) — no findings in the app's own glue code. `packages/locale` — no `innerHTML`/`unsafeHTML` matches. PWA build/static-serving — correct security headers. OAuth `postMessage` handling — origin checked before accepting redirect messages.

**ExtensionClient**: vault master-key session storage — correctly memory-only/scoped/cleared, no findings. Passkey binding/coordinator layer — origin/tab binding, constant-time nonce comparison, TTL bounds, sender-URL pinning, re-validation at every async step all correct. Core WebAuthn ceremony logic — strict validation, correct attachment/attestation rejection, correct trust boundary. MAIN↔ISOLATED↔background message chain — `event.source !== window` checks at every hop, top-frame-only installation. Manifest permission scope — broad but consistent with an all-sites autofill password manager, `identity`/`nativeMessaging` used narrowly.

**ServerSelfHosted**: full file coverage confirmed (`scim.ts`, `init.ts`, `repl.ts`, `geoip.ts`, `legacy.ts`, `config.ts`, `transport/http.ts`, all storage/tools/logging/provisioning/attachments/email/auth/platform/crypto modules) — all findings already itemized above; no additional no-findings areas beyond what's implied by the itemized findings being localized rather than systemic.

**PriorClaimsVerification**: no regressions in any of 10 spot-checked previously-FIXED items (see below).

## Coverage Check (security-baseline Req.1)
All 7 surfaces reviewed exhaustively; every surface produced findings or an explicit no-findings statement for its sub-areas (see individual reports). No surface silently omitted. ✅
