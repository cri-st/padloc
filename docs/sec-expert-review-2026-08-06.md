# Independent Security Review — padloc (sec-expert engagement)

**Date**: 2026-08-06
**Scope**: `packages/{worker,server,core,app,pwa,extension,admin,locale}`, `config/`, `assets/email/*`, Cloudflare deploy/runtime config per `AGENTS.md`.
**Explicitly excluded**: `packages/electron`, `packages/tauri`, `packages/macos`, `packages/cordova` (all confirmed deprecated/out of scope by the requester).
**Methodology**: independent, from-scratch re-derivation (per `docs/external-security-audit-scope-2026-08-06.md` §6's own instruction to future auditors: internal audit docs are situational context, never a checklist substitute). 7 parallel anti-bias reviewers, one per surface, none read prior audit findings before reviewing (one dedicated verification assignment explicitly did, to check prior claims). Consolidated into one severity-ranked register, then remediated in severity rounds (critical→high→medium→low) with real exploit-reproduction-on-baseline verification for every fix, not just "should work."

## Executive Summary

37 findings: **3 CRITICAL, 5 HIGH, 8 MEDIUM, 17 LOW (deduplicated from 7 raw reports)**.

**All 3 CRITICAL and all 5 HIGH findings are fixed and independently verified** (real exploit reproduced against the pre-fix baseline via `git stash`, then confirmed closed post-fix — not just a passing compiler). **7 of 8 MEDIUM findings are fixed**; the remaining one (SRP `PAD()`) is deliberately deferred with a detailed technical rationale, not silently dropped. **6 of 17 LOW findings are fixed**; the other 11 are documented with an explicit deferral rationale each (2 already had adequate pre-existing in-code documentation).

**Zero unaddressed CRITICAL or HIGH findings at close** — meets the enterprise-grade bar defined in this engagement's `openspec/specs/security-baseline/spec.md`.

20 commits on branch `security/sec-expert-remediation` (topic branch off `main`, not pushed, no PR — this repo does not use PRs per `AGENTS.md`). Full regression suite green after all changes: `packages/worker` `test:ci` (all sub-suites, 0 failed), `packages/extension` `npm test` (56/56), `packages/server` real mocha suite (10/10), plus ~15 new tests added specifically to prove each non-trivial fix. Per-package `tsc --noEmit --skipLibCheck` clean for `server`, `app`, `extension`; `worker`'s bundle verified via `npm run deploy:dry-run` (the correct gate for that package — its own `tsc` fails on unrelated pre-existing `drizzle-orm`/`zod` `.d.ts` parse errors, a known repo toolchain issue, not a real signal).

## What this review can and cannot claim

This was a thorough **static, code-level review plus real functional fix verification** performed by an AI agent with full repository read/write access and the ability to run local tools, tests, and disposable local services (e.g. a throwaway MongoDB container for C2). It is **not** a substitute for the workstreams `docs/external-security-audit-scope-2026-08-06.md` recommends for a real third-party engagement, and does not claim to cover them:

- **Formal cryptographic protocol proof** (SRP-6a security proof, side-channel analysis) — out of reach; this review found and fixed concrete implementation gaps (PBKDF2 floor, method-confusion signing) but did not perform a formal proof that the protocol is sound.
- **Real black-box penetration testing / fuzzing** — not performed; all exploit verification was white-box, against the actual source, using disposable local infrastructure.
- **Cloudflare account access-list / MFA / API-token-scope audit** — not performed, no account access available. `AccountLockDO`/`GENERAL_RATE_LIMIT` Durable Object bindings are confirmed present in every committed/local config file (dev, preview, and the real git-ignored staging `wrangler.local.toml`), but **true live production/staging deployment status is unconfirmed** — both primitives fail open silently if a binding is actually missing at runtime in a stale, un-redeployed Worker. **Action item for the operator**: confirm the current production Worker was redeployed after these commits (and after the prior internal audit's §8.1/§8.5 fixes) before treating those two issues as closed in production.
- **SBOM / CVE dependency scanning** — not performed.
- **Compliance gap assessment (GDPR/SOC2/etc.)** — not performed, out of an AI code reviewer's competence.
- **Account-recovery social-engineering / support-process testing** — not performed (no human support process exists to test against in this repo).

## Findings Register

Full register with file:line, exploit scenarios, fixes, and verification evidence for all 37 findings: `openspec/changes/sec-expert/findings-register.md`.

### CRITICAL (3/3 fixed)
| ID | Title | Commit |
|---|---|---|
| C1 | Method-confusion signature forgery (shared `core`, affects both Worker and self-hosted Server) | `94babfc7` |
| C2 | NoSQL injection in MongoDB storage backend | `61dfceed` |
| C3 | Unauthenticated single-request Node process crash | `3ba26aef` |

### HIGH (5/5 fixed)
| ID | Title | Commit |
|---|---|---|
| H1 | Cross-origin iframe credential leak via autofill broadcast | `9770f004` |
| H2 | Agentic autofill broker: no cross-step tab/origin binding | `9770f004` |
| H3 | Attachment preview MIME-type confusion (cross-account XSS risk) | `fb1d8e6d` |
| H4 | Extension session key stored unencrypted at rest | `f7e69bcc` |
| H5 | PBKDF2 key-derivation has no server-side floor | `cef8396e` |

### MEDIUM (7/8 fixed, 1 deferred)
M1, M3–M8 fixed (commits `0535cbf0`, `b54261ae`, `de25edfa`, `200b645c`, `07ada1c6`, `f77d2b98`, `596e9230`). M2 (SRP RFC 5054 `PAD()` gap) deliberately deferred — see register for the detailed technical rationale (a rushed per-argument padding fix risks a simultaneous, unrecoverable login outage across every cached client with no protocol-version negotiation; not independently exploitable today since client and server run byte-identical code).

### LOW (6/17 fixed, 11 documented deferrals)
See register. Deferrals are genuine tradeoffs (compat breaks, product/UX decisions, infra-topology-dependent, or already safely fails-closed) — never silent omissions.

## New issues discovered during remediation (disclosed, not in original register)
- `packages/server/src/init.ts` has a process-level `uncaughtException` handler but **no `unhandledRejection` handler**. The C3 fix removes the one reachable trigger this audit found, but any other unhandled promise rejection elsewhere in the codebase still has no process-level safety net. This is a genuine design decision (crash-and-restart vs. log-only semantics) intentionally left to the maintainers rather than guessed at.

## Severity disagreements, reconciled transparently
- **H4** (extension session key at rest): one reviewer rated HIGH, a second (verifying the already-disclosed item) rated MEDIUM. Resolved HIGH for remediation ordering given the low fix cost and full API-impersonation capability; both perspectives are recorded in the register.
- **H5** (PBKDF2 floor): originally flagged "MEDIUM/HIGH"; escalated to HIGH given it directly weakens the zero-knowledge crypto floor the external scope brief names as its top-priority workstream.

## Recommendations for the operator
1. **Merge and deploy** `security/sec-expert-remediation` — confirm the live Worker is redeployed so C1/C2/C3/H1-H5/M1-M8 take effect in production, and independently confirm `AccountLockDO`/`GENERAL_RATE_LIMIT` are live-bound (this review could only confirm code/config, not the live account).
2. Commission a **real third-party engagement** for the workstreams listed above as out of reach — this review materially reduces their starting workload (37 known-and-mostly-fixed issues off the table) but does not replace it, per `docs/external-security-audit-scope-2026-08-06.md`'s own guidance.
3. Decide the `unhandledRejection` handler design (new finding above) and the two deferred items requiring product/compat sign-off (L12 CSP `blob:` narrowing, L13 markdown remote images) — these are legitimate decisions for the team, not defects this review could resolve unilaterally.
4. Re-run `docs/external-security-audit-scope-2026-08-06.md`'s §2 "5 issues explicitly left unfixed" cross-check: 2 of those 3 are now addressed differently than originally scoped (H4/session-key is fixed here; the presigned-URL and blob-preview items remain confirmed dead-code/LOW as originally assessed, see register).
