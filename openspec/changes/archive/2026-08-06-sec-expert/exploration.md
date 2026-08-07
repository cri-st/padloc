## Exploration: Independent external-security-expert review of padloc (change `sec-expert`)

### Current State

padloc (cri-st/padloc, "CH5 Auth" fork) is a zero-knowledge password manager with a Cloudflare
Worker API backend (`packages/worker`: D1, R2, KV, Durable Objects) plus a legacy/alternative
self-hosted Node backend (`packages/server`: Postgres/MongoDB/LevelDB storage, SCIM
provisioning, Stripe billing). All auth, crypto, vault, and business logic shared by both
backends lives in `packages/core`. Client surfaces are a Lit-based web app (`packages/app`,
built into the static PWA `packages/pwa`), a Chrome extension with a native passkey broker
(`packages/extension`), and a small Lit admin console (`packages/admin`) that reuses
`@padloc/app` components against the same core `Client`/`App` RPC layer — it carries no
separate privileged API, authorization is enforced server-side by org-owner role checks in
`core/src/server.ts`.

This is not a clean-slate target. The repo already went through an extensive internal,
AI-assisted security review this same week:

- **`docs/security-audit-2026-08.md`** — the primary internal audit report. Section 1–7 is the
  original pass (production Worker + self-host + core + app), dated within the 2026-08 cycle.
  **Section 8** ("Follow-up audit — August 6, 2026") is a second, dedicated re-audit of surface
  added *after* the first pass: WebAuthn-on-Worker, the DO-backed rate limiter, password-share-
  links, and the rewritten idempotency cache. The git log corroborates this: 20+ commits titled
  `fix(security): ...` land in the current history, covering account-lockout bypass, SQL
  injection (Postgres admin query builder), NoSQL/operator injection (MongoDB), a SCIM auth
  bypass, prototype pollution via SCIM, path traversal in filesystem attachment storage, missing
  auth on the provisioning/Stripe API, attachment quota bypass, unauthenticated extension
  message-source spoofing, insecure OAuth `postMessage` origin handling, and more. Most items in
  both audit sections are marked `FIXED`, with two explicit exceptions flagged as
  **code-fixed but NOT YET LIVE until the next real Worker deploy** (§8.1 the `AccountLockDO`
  concurrency fix behind the `ACCOUNT_LOCK` binding, and §8.5 the `GENERAL_RATE_LIMIT`
  Durable-Object-backed limiter) — both fail open (always-allow) if their binding is undefined,
  so "fixed in code" does not yet mean "fixed in production" for those two.
- **`docs/external-security-audit-scope-2026-08-06.md`** — the most recent commit in the repo
  (`26c1a325`). A scope brief explicitly prepared to hand to a *third-party* auditor, written by
  the same internal review session. It self-reports what the internal pass found/fixed (47
  issues, 42 fixed), the 3 explicitly left unfixed (unencrypted extension session token in
  `chrome.storage.local`; a currently-dead-code presigned-upload flow with reusable-URL and
  unverified-hash gaps; blob:-URL attachment preview lacking sandboxing), and — critically — an
  explicit list of what it could **not** cover: formal cryptographic protocol proof, native
  mobile apps, real penetration testing, dependency/supply-chain scanning, cloud
  infrastructure/access-control review, recovery-flow social engineering, compliance, and
  operational maturity. It explicitly instructs future auditors *not* to treat its own findings
  as a checklist to re-verify.

The user's persona framing for this change — a 20-year external infosec expert running a
**complete, independent** review — lands on top of this pre-existing internal-review cycle. The
central tension the propose phase must resolve: does "complete and independent" mean ignoring
the internal audit's conclusions and re-deriving findings from scratch (the documented
anti-bias pattern in `padloc-fresh-security-audit-workflow`), or does it mean treating the
internal audit as a baseline to *verify* (especially the two not-yet-deployed fixes) while
extending coverage into what it explicitly could not cover (packages/admin, packages/locale,
infra/access-control, supply-chain) and what this session's confirmed scope additionally pulls
in that neither prior document mentions at all: **`packages/admin`**.

### Affected Areas

**In scope (per user confirmation this session):**

- `packages/worker/src` — Cloudflare Worker API. `auth/webauthn.ts` (WebAuthn, ported from
  self-host, uses `@simplewebauthn/server` v13+/WebCrypto), `locks/account-lock.ts`
  (`AccountLockDO` — per-account mutex backing the persistent lockout), `storage/d1.ts`
  (D1 queries, template-literal table-name interpolation gated by an allowlist),
  `storage/share-do-storage.ts` + `durable-objects/share-link.ts` (anonymous single-use share
  links), `durable-objects/rate-limit.ts` (atomic rate limiter), `attachments/r2.ts` (R2
  presigned uploads), `email/resend.ts` + `email/templates.ts` (transactional email, HTML
  escaping fixed here), `transport.ts` (request dispatch, idempotency gating, CORS/security
  headers), `idempotency.ts` (anonymous-endpoint replay-cache exclusion), `rate-limiter.ts`
  (KV-backed general limiter, still used as fallback), `server-factory.ts` (messenger/backend
  wiring, `MockMessenger` fallback), `observability/security-headers.ts` + `log-redaction.ts`
  (the latter still confirmed dead code — zero callers), `hq-instrumentation.ts` (telemetry —
  potential PII leak surface), `index.ts` (top-level fetch handler, origin/CORS enforcement).
- `packages/server/src` — self-hosted Node backend. `scim.ts` (directory sync, SQL/NoSQL
  injection + auth-bypass history), `provisioning/{api,stripe,directory,oauth}.ts` (admin query
  API, billing, OAuth), `storage/{postgres,mongodb,leveldb}.ts` (raw query construction),
  `attachments/{fs,s3}.ts` (`fs.ts` had a fixed path-traversal bug), `auth/webauthn.ts`
  (self-host WebAuthn, older `@simplewebauthn/server` 5.4.3, Buffer-based), `email/smtp.ts`
  (the DOMPurify-sanitizing path the Worker rewrite originally dropped), `transport/http.ts`,
  `repl.ts` (admin REPL — privileged local tooling).
- `packages/core/src` — shared logic used by *every* surface, so bugs here are maximally
  impactful. `server.ts` (97KB — the RPC controller: auth, sessions, org membership,
  provisioning dispatch; houses the persistent lockout logic from the recent fixes),
  `crypto.ts`/`srp.ts`/`container.ts`/`otp.ts` (primitives — audit rated these sound but
  unformal), `account-lock.ts` (the shared-lock abstraction, in-process default), `share.ts`
  (anonymous share-link crypto/lifecycle), `session.ts` (absolute + idle expiry), `auth.ts`,
  `invite.ts`, `item.ts` (vault item shape — field/passkey/history/attachment sensitivity),
  `webauthn-authenticator.ts`, `encoding.ts` (`Serializable._fromRaw` — prototype-pollution
  shape, previously verified non-exploitable via an existing guard, worth re-verifying not
  regressed), `api.ts` (RPC method surface enumeration — the authoritative list of what's
  reachable).
- `packages/app/src` — shared Lit UI/client logic consumed by both `pwa` and `extension`.
  `elements/share-dialog.ts` + `lib/share.ts` (field-scope selection — prior duplicate-type
  default-selection bug, fixed), `elements/import-dialog.ts` + `lib/import.ts` +
  `lib/keepass-kdbx-parser.ts` (untrusted file parsing, KDBX/CSV import), `elements/rich-content.ts`
  + `lib/markdown.ts` (DOMPurify-based rendering — version/allowlist bumped per audit),
  `mixins/auto-lock.ts` (session/vault lock timing), `elements/login-signup.ts` (41KB — auth UI
  flows), `elements/unlock.ts`, `lib/platform.ts` (`WebPlatform`, `openExternalUrl` —
  reverse-tabnabbing fix location), `elements/app.ts`.
- `packages/pwa` — static PWA build wrapper; security surface here is mostly build-time
  (`PL_SERVER_URL` baking) and the self-hosted static server headers (CSP/HSTS gap noted as
  still-pending in the audit for the self-host nginx path — verify current status for the PWA's
  own static-serving path too).
- `packages/extension/src` — browser extension + native passkey broker. `background.ts` (48KB,
  message routing — validated-source fix landed here), `content.ts`, `passkey-provider-engine.ts`
  + `passkey-approval-coordinator.ts` + `passkey-selection-coordinator.ts` + `passkey-rp-policy.ts`
  (native passkey broker — RP-ID/origin binding is the security-critical invariant),
  `webauthn-page.ts`, `storage.ts` (session token storage — the confirmed *unfixed*
  plaintext-in-`chrome.storage.local` gap from the scope brief), `popup.ts` (had an
  unescaped-`innerHTML` footgun noted as low-confidence-exploitable), `manifest.json`
  (permission scope).
- `packages/admin/src` — admin web UI (`accounts.ts`, `orgs.ts`, `logs.ts`, `app.ts`,
  request/change-log dialogs). **Not mentioned in either prior audit document at all** — this is
  new scope for this review. It is a privileged surface (account/org management, audit-log
  viewing) built on the same `@padloc/app` component library and RPC client; its own security
  posture depends entirely on server-side role checks in `core/server.ts` (no separate admin
  API token model observed at a glance) — needs first-pass verification that role/permission
  checks are actually enforced per-RPC-method server-side, not just hidden client-side by
  routing.
- `packages/locale` — i18n resources (`res/translations/*.json`, `res/wordlists/`,
  `src/translate.ts`). Lower priority per the user's confirmed scope; worth a cursory pass for
  injection risk if any translated string is interpolated into HTML (email templates already
  pull from `assets/email/*`, not `packages/locale`, so the intersection is narrow — mainly
  whether `$l()`-translated strings ever flow into `unsafeHTML`/`innerHTML` sinks in `app`/`admin`).
- `config/environment-targets.json`, `config/runtime-requirements.json` — per-stage hostnames
  (all `*.example.com` placeholders, no live secrets committed), and the vars/secrets contract
  (`delivery: secret` vs `derived`) `npm run runtime-config:check` validates structurally only —
  it does **not** cross-check the live Cloudflare deployment, so this file's completeness says
  nothing about whether staging/production secrets are actually rotated, scoped, or match.
- `assets/email/*.html`/`*.txt` — source templates compiled into `packages/worker/src/email/templates.ts`
  (118KB generated file) and `packages/server/src/email/smtp.ts`'s consumption path; both
  interpolation sites already audited and fixed for HTML injection (§1.1) — worth a spot-check
  that the fix generalizes to any new template added since.
- Cloudflare deployment/runtime config per `AGENTS.md` "Secrets"/"Hosting"/"Sharp Edges" — no
  file to read (Cloudflare-side state), but material to the review: deploy-token scope,
  which of the two "code-fixed but not yet live" Durable Object bindings are actually live per
  environment, and whether `wrangler.local.toml` (gitignored, operator-specific) diverges from
  the committed `.example` template in a way that matters.

**Explicitly excluded (user-confirmed, deprecated surfaces — acknowledged only, not read beyond
directory existence checks):** `packages/electron`, `packages/tauri`, `packages/macos`,
`packages/cordova`. All four exist in the repo tree; none were opened or evaluated for this
exploration, matching the confirmed exclusion.

### Sharp Edges a Fresh Auditor Must Not Misdiagnose

1. **Recurring "dead security code with self-deceiving tests" anti-pattern (confirmed 3
   times).** A module implements a real-sounding control with doc comments claiming it's
   load-bearing, but has zero real callers — and its own test reimplements local mocks with
   matching names instead of importing the real module, so CI stays green while the control is
   absent. Confirmed instances: the now-deleted `worker/src/session.ts`; `AccountLockDO` before
   its 2026-08-06 fix (didn't even `extends DurableObject`, so it would throw if called for
   real); and **`worker/src/observability/log-redaction.ts`, still dead as of the latest audit
   pass** — zero callers, its own test only checks unrelated call sites. Before trusting any
   "this is handled" claim, grep for actual callers across the whole package, not just the
   module's own file/test.
2. **Two fixes are code-complete but confirmed NOT YET LIVE**: the `AccountLockDO`
   acquire/release race fix (§8.1) and the `GENERAL_RATE_LIMIT` DO-backed limiter migration
   (§8.5) both require an operator to run `wrangler deploy` with updated
   `wrangler.toml`/`wrangler.local.toml` before they take effect — every optional DO/KV binding
   in this codebase **fails open** when unbound, so a fresh auditor probing the *live*
   staging/production environment (not just source) should expect these to still exhibit the
   pre-fix (racy) behavior unless deploy status is independently confirmed.
3. **Idempotency-cache vs. anonymous single-use endpoints.** `transport.ts`'s idempotency layer
   replays a cached response by request-body hash before ever calling the handler again — actively
   dangerous for anonymous, single-use-by-design RPCs (share-link reveal, etc.) because
   `WebPlatform.getDeviceInfo()` hardcodes an empty device id for web clients, so two different
   real visitors can hash-collide on distinguishing fields. Already patched for the two known
   share methods and generalized to "skip caching for any unauthenticated request" (§8.6) — but
   any *new* anonymous single-use RPC added since needs to be added to the same exclusion set on
   day one, not discovered later by audit.
4. **Account-recovery is destructive-by-design, and the real gate is the email inbox, not the
   device.** "Anyone with device access can wipe my vault via forgot-password" is a common but
   false claim about this codebase — `AuthPurpose.Recover` never hits the device-trust
   auto-verify shortcut that `AuthPurpose.Login` uses; it always requires an emailed one-time
   code, max 3 tries. The residual risk to disclose honestly is email-account compromise, not a
   Padloc-side device-trust bypass.
5. **Share-link field scoping is enforced client-side only, by architectural necessity** (the
   server never decrypts share payloads) — `app/src/lib/share.ts`'s own doc comments currently
   overstate this as a structural server-side guarantee; a fresh auditor should not assume the
   server can or does enforce which fields a share link exposes.
6. **Toolchain gotchas that will look like new bugs but aren't**: the shell's default `node`
   may resolve to v14 unless PATH is fixed to pick up v24 arm64; root/worker `tsc` fails on
   `drizzle-orm`/`zod` `.d.ts` parse errors unrelated to any real change; each of
   `server`/`app`/`extension` has its own pinned `tsc` that is the correct verification gate
   (`--skipLibCheck`); `packages/extension`'s webpack build has a pre-existing unrelated
   `kdbxweb`→`crypto` resolution failure; `packages/worker/test/r2-lifecycle.ts` is pre-existing
   broken test infra, not a regression signal.
7. **`AGENTS.md`'s "Sharp Edges" note on `MockMessenger`** currently reads as if the fallback is
   still silent/dangerous — the audit log shows this was fixed 2026-08-04 (`createMessenger` now
   throws instead of silently degrading in non-mock environments). Treat `AGENTS.md` prose as
   possibly stale relative to the actual current code; verify behavior directly rather than
   citing the doc.
8. **`packages/admin` has no prior audit coverage at all** — do not assume its access-control
   model was reviewed as part of "the internal review already covered the client apps"; it is
   net-new scope for this change.

### Approaches — How to Structure the Full Audit (for the propose/tasks phases)

1. **Single sequential deep-dive agent across all in-scope surfaces.**
   - Pros: one continuous context accumulates cross-surface understanding (e.g. a `core`
     finding's blast radius across worker+server+app is easy to trace inline); simplest to
     reason about and narrate; no consolidation-pass overhead or cross-agent duplication.
   - Cons: this repo has ~7 in-scope package surfaces plus config/infra concerns — a single
     agent context will either run very long or truncate depth per surface; no parallelism, so
     wall-clock cost scales linearly with total surface size; higher risk of fatigue-driven
     shallow coverage on later surfaces (self-host `packages/server` historically produced the
     most CRITICAL findings and is exactly the kind of surface that suffers if reviewed last and
     rushed).
   - Effort: High (wall-clock), Low (coordination).

2. **Parallel per-surface `security-reviewer` sub-agents + a consolidation pass** — the
   established pattern in `padloc-fresh-security-audit-workflow`, which is how the existing
   internal audit was actually produced (6 parallel reviewers, single session, cited in the
   scope brief).
   - Pros: proven pattern for this exact repo; each reviewer gets full depth on a bounded
     surface within its own context; wall-clock cost is roughly `max(surface)` not `sum(surfaces)`;
     natural place to enforce the documented anti-bias rule ("do not read the prior audit or its
     findings before reviewing your assigned surface") per reviewer; consolidation pass produces
     one severity-ordered report with de-duplication across surfaces that share code (e.g. `core`
     bugs surfacing identically in both `worker`- and `server`-mediated call paths).
   - Cons: cross-surface findings (a bug in `core` reachable differently through `worker` vs
     `server`) can be reported twice or missed once if boundaries are drawn too strictly, unless
     the consolidation pass explicitly reconciles by shared-file overlap; requires someone to
     own the split boundaries up front (this exploration proposes them, but the propose/tasks
     phase should confirm); slightly higher coordination overhead than approach 1.
   - Effort: Medium (wall-clock, parallelized), Medium (coordination).

3. **Hybrid: parallel per-surface fresh (anti-bias) reviewers, plus a dedicated independent
   verification pass targeted at the prior audit's own claims** — same fan-out as approach 2,
   with one added, explicitly-scoped reviewer/pass whose only job is to (a) confirm whether the
   two "code-fixed but not yet live" items (§8.1, §8.5) are actually live in the real
   staging/production Cloudflare environment today, (b) spot-check a sample of "FIXED" claims
   against current source rather than trusting the doc, and (c) independently assess the 3
   explicitly-left-unfixed items from the scope brief for current severity/priority.
   - Pros: directly serves the persona's "complete, independent, top-tier" framing — a real
     external auditor would neither blindly trust nor blindly ignore a vendor-supplied internal
     report; catches exactly the class of bug this repo has already demonstrated 3 times
     (a fix that looks closed in a doc/commit message but isn't actually wired in or actually
     deployed); produces a deliverable directly comparable to what
     `external-security-audit-scope-2026-08-06.md` asked a real third-party firm to do, so this
     review can serve as (or meaningfully inform) that engagement.
   - Cons: highest coordination overhead of the three (N surface reviewers + 1 verification
     pass + 1 consolidation); verification-pass reviewer needs either live-deployment access (per
     `padloc-worker-dead-security-code-audit`'s note that DO-binding fixes are code-only until
     redeployed — confirming this may require checking actual `wrangler.local.toml`/deployment
     state rather than only source) or must explicitly caveat what it could not verify without
     that access.
   - Effort: Medium-High (wall-clock, mostly parallelized), Medium-High (coordination).

### Recommendation

**Approach 3 (hybrid: parallel per-surface anti-bias review + dedicated prior-claims
verification pass).** Given the persona explicitly requested for this change — an external,
20-year expert running an independent review, not a rubber stamp — and given this repo has a
documented, repeated failure mode of "claimed fixed" controls that were dead code, unwired, or
still-undeployed, a review that only re-derives new findings (approach 2) without also
adversarially checking the *existing* claims would itself repeat the anti-pattern it should be
guarding against. Approach 3 is a modest increment over the already-proven approach 2 pattern
(same split, same anti-bias discipline per reviewer, same consolidation step), with one
additional bounded workstream. Recommend adopting the 6-surface split outlined in "Affected
Areas" above (Worker Auth/Core, Worker Storage/Email, Core Crypto+Business-Logic, Web
Client [app+pwa+admin], Extension Client, Server Self-Hosted), folding `packages/locale`'s
cursory pass into whichever reviewer covers rendering sinks (Web Client), and running the
verification pass as a 7th, narrower assignment — this should be finalized in `sdd-propose`,
not decided unilaterally here.

### Risks

- **Scope ambiguity for propose**: whether this review should be positioned as "from-scratch,
  ignore the prior audit" or "build on and verify the prior audit" materially changes reviewer
  instructions and is not yet resolved — flagged as an explicit open question for `sdd-propose`.
- **Live-deployment verification may be out of reach for a code-only reviewer.** Confirming
  whether `AccountLockDO`/`GENERAL_RATE_LIMIT` fixes are actually deployed requires either
  Cloudflare account access or a live `wrangler.local.toml` check that may not be available in
  every environment this review runs in; the propose/tasks phase should decide whether to accept
  a caveated "cannot verify, flag as inherited risk" outcome for that sub-item rather than
  blocking on infra access.
- **`packages/admin`'s access-control model is unverified at exploration depth** — this
  exploration confirmed it reuses `@padloc/app` components and the shared RPC client with no
  separate token model, but did NOT trace every admin-facing RPC method in `core/server.ts` for
  a missing/weak role check; that is real, first-pass work for whichever surface reviewer
  inherits it (recommended: fold into the Web Client reviewer given the shared component
  library).
- **Cross-surface duplication risk** inherent to the parallel-reviewer pattern: a `core/server.ts`
  bug reachable via both `worker` and `server` entry points could be reported twice (harmless)
  or, worse, found by only one reviewer and assumed to be worker-only when it also affects
  self-host — the consolidation pass must explicitly check shared-file findings against both
  entry points, not just de-duplicate by text similarity.
- **This is not a substitute for the workstreams the internal review already flagged as fully
  out of reach** (formal crypto protocol proof, real penetration testing, native
  Cordova/Electron/Tauri/macOS apps, cloud infra/access-control, compliance) — those exclusions
  from `external-security-audit-scope-2026-08-06.md` still apply; this change's review remains a
  code-level, static, single-session exercise like its predecessor, just wider in package scope
  (adds `admin`, `locale`, revisits `config`/deploy hygiene) and adversarial toward prior claims.

### Ready for Proposal

**Yes.** The codebase, existing audit artifacts, in-scope surfaces, and known sharp edges are
mapped in enough detail to write a proposal. The orchestrator should tell the user: this review
sits on top of an already-extensive internal remediation cycle (documented in
`docs/security-audit-2026-08.md` and `docs/external-security-audit-scope-2026-08-06.md`) — the
proposal phase needs one explicit decision before scoping tasks: **should this fresh review
treat the prior internal audit as ground truth to build on and re-verify (faster, lower
duplication risk), or as an untrusted vendor report to independently re-derive from scratch
(slower, matches the "independent" framing most literally, and is the only way to catch a
4th instance of this repo's recurring dead-code/false-assurance pattern)?** The recommended
hybrid approach above (independent per-surface review + a dedicated pass verifying prior
claims) is a middle path that answers this without forcing an all-or-nothing choice, but the
user/orchestrator should confirm it explicitly before `sdd-tasks` commits to reviewer
assignments.

---

**Status**: success
**Summary**: Mapped the padloc security-relevant architecture across all 7 confirmed in-scope
package surfaces (worker, server, core, app, pwa, extension, admin, plus locale/config/assets),
confirmed and summarized two existing internal audit artifacts (`docs/security-audit-2026-08.md`,
`docs/external-security-audit-scope-2026-08-06.md`) and 20+ related `fix(security)` commits
already in git history, identified `packages/admin` as genuinely new (previously unaudited)
scope, catalogued 8 sharp edges a fresh auditor must not misdiagnose, and recommended a hybrid
parallel-per-surface-plus-verification-pass structure for the actual deep audit in a later SDD
phase.
**Artifacts**: Engram `sdd/sec-expert/explore` | `openspec/changes/sec-expert/exploration.md`
**Next**: sdd-propose
**Risks**: Scope decision needed (from-scratch vs. verify-and-extend prior audit); live-deployment
verification of two pending DO-binding fixes may be out of reach without Cloudflare access;
`packages/admin`'s RPC-level authorization is unverified at exploration depth; cross-surface
duplication risk in the parallel-reviewer pattern; this review remains code-level/static like its
predecessor and does not cover crypto-protocol proof, real pentesting, native shells, or infra/
compliance review (all previously and explicitly out of scope).
**Skill Resolution**: paths-injected — 5 padloc-specific skills (padloc-fresh-security-audit-workflow,
padloc-worker-dead-security-code-audit, padloc-account-recovery-security-gate,
padloc-idempotency-cache-vs-anonymous-single-use-endpoints, padloc-share-link-field-scope-security)

## Key Learnings

1. The padloc repo already completed an extensive internal security-remediation cycle this week, with 20+ `fix(security)` commits and two audit documents (`docs/security-audit-2026-08.md`, `docs/external-security-audit-scope-2026-08-06.md`) already present before this exploration began.
2. Two security fixes (`AccountLockDO` race fix, `GENERAL_RATE_LIMIT` Durable Object rate limiter) are confirmed code-complete but not yet live in any deployed environment, because Durable Object/KV bindings in this codebase fail open when unbound.
3. `packages/admin` is a Lit-based admin console reusing `@padloc/app` components against the shared core RPC client, with no separate privileged API model, and it was not covered by either prior audit document.
4. This repo has a confirmed, recurring anti-pattern of security controls implemented as dead code with self-deceiving tests that reimplement mocks instead of importing the real module — three prior instances found, with `observability/log-redaction.ts` still unresolved as of the latest audit pass.
5. The user's persona framing ("complete, independent" external review) creates a scope decision the propose phase must resolve explicitly: whether to treat the existing internal audit as verified ground truth or as an unverified report to independently re-derive from scratch.
