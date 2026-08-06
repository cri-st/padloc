# External Security Audit — Scope Brief

**Status:** Draft, prepared for engaging a third-party security firm.
**Prepared:** 2026-08-06, following an internal automated security review of this repo.
**Do not treat the internal review referenced below as a substitute for this engagement.**
It was AI-assisted, single-session, code-review-based, and has known blind spots
(enumerated in "What the internal review could NOT cover" below). Hand this whole document
to the auditor as-is; it is written to be handed off, not just read internally.

## 1. What this system is

A password manager (fork of the open-source Padloc project) with:
- A web client (PWA) and a Chrome extension, both built from a shared client codebase.
- A Cloudflare Worker backend (D1, R2, KV, Durable Objects) as the primary hosted API.
- An alternative self-hosted Node.js server backend (Postgres/MongoDB/LevelDB storage
  options), used for on-prem/self-hosted deployments.
- Native iOS/Android shells (Cordova) — **not covered by the internal review and not
  covered by this scope brief either; audit separately before trusting them.**
- Intended use: production credential storage for a company (not just personal use).

Client-side, zero-knowledge encryption is the core security assumption: vault contents are
encrypted/decrypted on the client with a key derived from the user's master password: the
server is designed to never see plaintext vault data. **Verifying that this assumption
actually holds end-to-end (not just architecturally intended) should be the auditor's
highest-priority workstream** — if it doesn't hold, everything else is secondary.

## 2. What the internal review already found and fixed (for the auditor's context, not for re-verification of already-closed items)

An internal, AI-assisted review (6 parallel automated reviewers, single session) found 47
issues across the webapp, extension, Worker backend, shared core library, and self-hosted
server. 42 were fixed and verified (compilation, automated tests, and live smoke tests
against a real deployment). Full detail lives in this session's git history
(`fix(security): ...` commits) and engram memory. Categories fixed, for the auditor's
situational awareness:

- Full account-takeover path via a legacy auth-compatibility endpoint that bypassed lockout.
- Distributed-lock key normalization bug that weakened the login-lockout mutex.
- Path traversal in self-hosted attachment storage (arbitrary file read/delete).
- SQL injection (Postgres backend) and NoSQL operator injection (MongoDB backend) in an
  admin query API.
- Missing authentication check on a directory-sync (SCIM) read endpoint.
- Prototype-pollution vulnerability reachable via SCIM.
- Various information-disclosure, rate-limiting, and logging-hygiene issues.

**5 issues were found and explicitly left unfixed** — these should be in scope for the
auditor to independently assess and prioritize:

1. Extension session token stored unencrypted in `chrome.storage.local` (disk-persisted,
   plaintext-accessible to local malware/forensics with disk access).
2. A presigned-URL attachment upload flow has two gaps (reusable upload URL after
   confirmation; client-declared hash never verified) — currently unreachable from any
   real API endpoint (dead code), but should be fixed or removed before ever being wired up.
3. Attachment preview (PDF/image) renders via a same-origin `blob:` URL rather than a
   sandboxed context — defense-in-depth gap, not independently exploitable without an
   additional browser vulnerability.

## 3. What the internal review could NOT cover (treat as full scope for the auditor, not spot-checks)

Be explicit with the auditor that these were NOT meaningfully covered:

- **Formal cryptographic protocol review.** The internal review checked for obviously wrong
  primitive usage (weak comparisons, short IVs, etc.) but did not perform a formal security
  proof or side-channel analysis of the SRP-6a implementation, key derivation parameters,
  or the HMAC-based request-signing scheme. This needs a cryptographer, not a code reviewer.
- **Native mobile apps (Cordova/iOS/Android).** Completely out of scope of the internal
  review. Deep-link handling, native storage, platform keychain usage, and any
  native-bridge attack surface are all unaudited.
- **Real penetration testing.** No fuzzing, no dynamic/black-box testing, no authenticated
  multi-account abuse testing, no infrastructure scanning.
- **Dependency / supply-chain risk.** No SBOM was generated, no CVE scan was run against
  the dependency tree (this codebase pulls in cryptographic libraries like `kdbxweb`,
  sanitizers like `dompurify`, and dozens of transitive dependencies).
- **Cloud infrastructure and access-control review.** The Worker deployment runs under a
  company-dedicated Cloudflare account. The internal review did not and could not verify:
  who has access to that account, whether MFA is enforced, how scoped the deploy API
  token's permissions are, whether secrets (API keys, database credentials) are rotated,
  or whether Cloudflare's own security features (WAF rules, bot management, rate limiting
  at the edge) are configured.
- **Account-recovery / support-flow social engineering.** The recovery flow was reviewed
  for code-level bugs, not for whether a human attacker could talk a real support process
  into resetting an account.
- **Compliance.** No GDPR/SOC2/ISO27001 gap assessment was performed. If this stores
  employee or customer data subject to any regulatory framework, that gap assessment is a
  distinct, necessary workstream.
- **Production operational maturity.** No review of backup/disaster-recovery process, secret
  rotation cadence, or incident-response readiness.

## 4. Recommended audit workstreams (in priority order)

1. **Cryptographic protocol review.** SRP-6a implementation, master-key derivation (KDF
   parameters, salt handling), per-vault/per-item encryption, HMAC request signing and its
   replay window, WebAuthn/passkey implementation, TOTP implementation. Confirm the
   zero-knowledge assumption actually holds against a hostile server.
2. **Backend API penetration test.** Both backends (Cloudflare Worker and the self-hosted
   Node server) — authorization/IDOR testing across every RPC method, injection testing,
   rate-limit/lockout bypass attempts, multi-tenant isolation testing (SCIM/org boundaries),
   business-logic abuse (quota bypass, sharing/invite abuse).
3. **Web client + extension penetration test.** XSS (including stored/DOM-based across every
   place user- or org-controlled content is rendered), CSRF, extension permission abuse,
   content-script/background-script message spoofing, autofill domain-matching correctness,
   clickjacking, CSP effectiveness in the real deployed environment (not just source review).
4. **Native app audit.** Cordova/iOS/Android — deep links, platform storage, keychain usage,
   WebView configuration, native bridge surface.
5. **Cloud infrastructure & access-control review.** Cloudflare account access list and MFA
   enforcement, API token scoping (least privilege per binding), D1/R2/KV access policies,
   DNS/zone configuration (the zone hosts other unrelated services — verify no cross-service
   exposure), secrets management and rotation policy, WAF/edge protection configuration.
6. **Dependency / supply-chain audit.** SBOM generation, CVE scanning, license review,
   verification that cryptography-adjacent dependencies (kdbxweb, sanitizers, crypto
   polyfills) are current and were installed from a trusted source.
7. **Account-recovery and social-engineering testing.** Attempt real recovery-flow abuse,
   including any human-in-the-loop support process if one exists.
8. **Compliance gap assessment.** Map actual data handling against whatever regulatory
   framework applies to the company's users/employees/customers.
9. **Operational maturity review.** Logging/monitoring coverage (note: the internal audit
   log was found completely broken and has since been fixed — verify it's actually
   populating in the real deployment), backup/DR process, incident-response runbook.

## 5. Suggested deliverables from the engagement

- A findings report with CVSS or equivalent severity scoring, evidence, and reproduction
  steps for each issue.
- Explicit sign-off (or explicit non-sign-off with blocking conditions) on whether this
  system is fit to store real company-sensitive credentials at the requested scale.
- A remediation-priority list distinguishing "must fix before production trust" from
  "should fix" from "accepted risk with compensating controls."
- Re-test of any critical/high findings after remediation.

## 6. Practical note for whoever engages the auditor

Do not hand the auditor this repo's own `docs/security-audit-2026-08.md` or this session's
commit messages as a substitute for their own independent findings — they exist as internal
context, not as a checklist to confirm. An auditor who only re-verifies known findings will
miss whatever neither review caught.
