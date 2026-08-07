# sec-expert — Consolidated Findings Register (Phase 2)

Consolidated from 7 independent parallel reviews (WorkerAuthCore, WorkerStorageEmail,
CoreCryptoBusinessLogic, WebClient, ExtensionClient, ServerSelfHosted,
PriorClaimsVerification). Deduplicated across surfaces; `packages/core` findings
cross-checked for both worker and self-hosted-server reachability.

Status legend: `OPEN` = not yet remediated. Updated in place through Phases 3-5.

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

### M1. Rate-limit Durable Object bindings fail open with no operator alert — OPEN
- **Where**: `packages/worker/src/rate-limiter.ts:100-114`, contrast `server-factory.ts:47-56` (ACCOUNT_LOCK has an alert, this doesn't)
- Reported independently by WorkerAuthCore AND WorkerStorageEmail — deduplicated here.
- **Exploit**: missing `GENERAL_RATE_LIMIT`/`SHARE_VIEW_RATE_LIMIT` bindings silently disable all brute-force throttling, zero telemetry.

### M2. SRP hash inputs omit RFC 5054 `PAD()` step — OPEN
- **Where**: `packages/core/src/srp.ts:132-165` (`i2b`, `Core.u/k/M1/M2`)
- Deviation from spec's anti-ambiguity requirement in the most security-critical component.

### M3. D1 email columns don't enforce documented lowercase invariant — OPEN
- **Where**: `packages/worker/src/storage/schema.ts:38-40`, `d1.ts:187-193`
- Not currently exploitable (ID-hash lookup saves it) but a violated storage invariant with admin-authorization blast radius if any future code trusts it.

### M4. Self-hosted passkey RP-root env var not validated as a real registrable domain — OPEN
- **Where**: `packages/extension/src/passkey-rp-policy.ts:9-15,29-40`
- Operator-misconfiguration path to RP impersonation (default build only trusts `google.com`+localhost).

### M5. S3 attachment backend has no path validation (unlike hardened `fs.ts` sibling) — OPEN
- **Where**: `packages/server/src/attachments/s3.ts:60-98`
- `deleteAll`'s bulk-delete-by-prefix has no local safety net for a malformed `vault` value.

### M6. Prototype pollution via `Object.assign` in self-hosted provisioning entries — OPEN
- **Where**: `packages/server/src/provisioning/api.ts:66-70` (`ProvisioningEntry` constructor)
- No equivalent guard to `core`'s `setPath` `FORBIDDEN_PATH_SEGMENTS` protection.

### M7. AccountLockDO fixed 30s TTL can auto-release mid-operation under contention — OPEN
- **Where**: `packages/worker/src/locks/account-lock.ts:60-84,173`
- Reintroduces the exact race the DO exists to prevent, under slow-path/cold-start conditions.

### M8. Request body fully buffered before size-limit enforcement — OPEN
- **Where**: `packages/worker/src/transport.ts:135-141`
- Resource-amplification DoS gap against unauthenticated endpoints.

## LOW (14)

L1. IP identity trusts `x-forwarded-for` fallback with no trust-boundary assertion — `worker/transport.ts:113-114`, `index.ts:238-241`
L2. Lock key normalization mismatch (`toLowerCase` vs `toLocaleLowerCase`) — `worker/locks/account-lock.ts` vs `core/server.ts` (deduped from 2 reports)
L3. Transport-level request-age replay check is a permanent no-op — `worker/transport.ts:159,267-292`
L4. Dead `errorResponse()` export missing security headers, latent-regression risk — `worker/error.ts:113-124`
L5. WebAuthn cross-platform authenticators don't require user verification — `worker/auth/webauthn.ts:100-102,195-197,219`
L6. Presigned-URL attachment flow: TTL-reuse + unverified hash (confirmed dead/unreachable code) — `worker/attachments/r2.ts:243-371`
L7. `MockMessenger`/`EMAIL_BACKEND=mock` misconfig has no production alert (fails closed otherwise) — `worker/server-factory.ts:130-146`
L8. Dead wildcard `DEFAULT_CORS.allowOrigin: '*'` constant, unused but attractive nuisance — `worker/observability/security-headers.ts:34-39`
L9. AES params permit 64-bit GCM auth tags — `core/crypto.ts:15-31`
L10. `getKeyStoreEntry` has only implicit (not explicit) ownership check — `core/server.ts:~2228-2242`
L11. `startAuthRequest` has no visible rate limit at the `core` layer (mitigated at worker layer, unverified here) — `core/server.ts:~410-475`
L12. CSP allows `blob:` broadly for script-src/object-src/frame-src, weakening defense-in-depth for H3 — `pwa/webpack.config.js:31`
L13. Markdown `<img>` allows arbitrary remote URLs (tracking-pixel IP/UA disclosure) — `app/lib/markdown.ts:12-46`
L14. `isExtensionDocumentSender` guard drops ALL legitimate content-script messages, silently breaking the save-password prompt (fails safe, not a vuln, but a broken control) — `extension/background.ts:473-478`
L15. Orphaned second WebAuthn interceptor (dev-only, unshipped) with no RP validation + unencrypted key storage in dev tooling — `extension/webauthn-page.ts`, `scripts/agentic-extension-cdp.mjs`
L16. `email/smtp.ts` template corruption via unescaped `String.replace` replacement patterns — `server/email/smtp.ts:75-90`
L17. `mongo2postgres.ts` hardcodes `rejectUnauthorized:false` regardless of config (one-shot migration tool) — `server/tools/mongo2postgres.ts:23-36`

(Note: tasks.md/spec allowed LOW items to be documented rather than all fixed — see Phase 5.)

## PriorClaimsVerification results (no register entries — informational)

- **10/10 previously-FIXED items spot-checked**: no regressions (email HTML injection, dead lockout module removal, MockMessenger fail-closed, reverse tabnabbing, session absolute expiry, timing-safe comparisons x2, AccountLockDO race/deadlock fix, rate-limiter DO migration, WebAuthn single-use, idempotency-cache scoping).
- **AccountLockDO / GENERAL_RATE_LIMIT DO bindings**: CONFIRMED present in code/config for dev, preview, AND the real git-ignored staging `wrangler.local.toml` in this workspace. **Live Cloudflare production/staging deploy status remains UNCONFIRMED** — no account access available; both primitives fail open silently if a binding is actually missing live. Disclose as caveated in the final report, not claimed closed.
- **Presigned-URL gaps (L6)** and **blob: preview (superseded by H3)**: re-confirmed at their original LOW severity; H3 is a NEW, more specific and more severe finding on the same general attachment-preview area.

## Coverage Check (security-baseline Req.1)
All 7 surfaces reviewed exhaustively; every surface produced findings or an explicit no-findings statement for its sub-areas (see individual reports). No surface silently omitted. ✅
