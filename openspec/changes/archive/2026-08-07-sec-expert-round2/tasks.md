# Tasks: sec-expert Round 2 — Enterprise-Grade Gap Closure

## Review Workload Forecast

- Estimated changed lines: ~150-400 (3 surgical fixes + dependency lockfile churn + webauthn.ts v13 API adaptation)
- 400-line budget risk: Medium (lockfile diffs inflate line count but are not authored/reviewer-risk lines)
- Chained PRs recommended: No — repo has no PR flow (topic branch, exact-SHA CI, fast-forward to main)
- Delivery strategy: single-pr (continuing on `security/sec-expert-remediation`, same branch as Round 1 — this is the same engagement)

```text
Decision needed before apply: No
Chained PRs recommended: No
Chain strategy: pending
400-line budget risk: Medium
```

User already granted the size-exception equivalent for this whole engagement ("SIII, modo auto"); Round 2 is a continuation of the same authorized branch, not a new decision point.

### Suggested Work Units
1. Reachability fixes (http.ts + init.ts) — test: `tsc --skipLibCheck` + disposable-process smoke test; rollback: their own commits.
2. Session revocation (core/server.ts) — test: 2-session live exercise; rollback: own commit.
3. Dependency bumps (server: webauthn+nodemailer+aws-sdk; admin: diff) — test: `tsc` + full webauthn test suite + `npm audit` re-run; rollback: own commits, revertible independently of 1-2.
4. Documentation (Round 2 report + register additions) — no code risk.

## Phase 1: Reachability & Crash-Safety Fixes

- [x] 1.1 `packages/server/src/transport/http.ts` — wrap the entire `createServer` callback body in `try/catch` (not just the `POST` branch) — commit `503e9ac9`
- [x] 1.2 `packages/server/src/init.ts` — add `process.on("unhandledRejection", ...)`: log + best-effort admin email via existing `emailSender`/`reportErrors` pattern; explicitly NO `process.exit()`; permanent inline rationale comment — commit `503e9ac9`
- [x] 1.3 Verify: `packages/server` pinned `tsc --noEmit --skipLibCheck`; live smoke test triggering a real unhandled rejection in a disposable local process — process survived, exactly one log line

## Phase 2: Session Revocation on Password Change

- [x] 2.1 `packages/core/src/server.ts`'s `updateAuth()` — revoke all OTHER sessions on a real password change (verifier update), preserve the current session — commit `a9b6a67a`
- [x] 2.2 Verify: real live 2-session exercise (real SRP signup + 2 real login handshakes) — 8/8 assertions passed; `session-contract.test.mjs` (6/6) and `run-account-lockout-e2e.mjs` against real `wrangler dev` (3/3), no regression

## Phase 3: Dependency Remediation

- [x] 3.1 `packages/server`: bump `@simplewebauthn/server` 5.4.3 → 13.3.2, migrate `webauthn.ts` to the v13 API (verified against the real installed `.d.ts` files) — commit `db8bdcd4`
- [x] 3.2 Verify 3.1: `tsc --skipLibCheck` clean; 11/11 mocha (incl. new real registration+authentication round-trip test against a genuine software authenticator); `npm audit` confirms all 4 prior CRITICAL findings (elliptic/jsrsasign chain) closed; required companion TypeScript bump 4.4.3→4.9.5 (v13's `.d.ts` files need TS 4.5+ syntax support), discovered during this task and disclosed
- [x] 3.3 `packages/server`: bump `nodemailer` 6.6.1 → 9.0.4 (scope-deviated from the originally-researched 6.10.x — disclosed: 6.10.x closes zero currently-known CVEs, so the major bump was necessary for real security value) + `@aws-sdk/client-s3`/`@aws-sdk/types` (non-major) — commit `868064b7`
- [x] 3.4 `packages/admin`: bump `diff` 5.1.0 → 5.2.2 (non-major) — commit `58da1c3d`
- [x] 3.5 Document `drizzle-orm` (worker) and `http-server`'s transitive chain (app) as accepted-risk-not-exploitable, plus the additional `form-data`/`tar`/`lodash`/`qs`/`ws`/`minimatch`/`brace-expansion` findings discovered during final verification — all traced to their real dependency chains and confirmed non-exploitable via this codebase's actual usage patterns — done in `findings-register.md`

## Phase 4: Documentation & Report

- [x] 4.1 Write Round 2 findings register: dependency audit table (all 7 packages, before/after counts), secret-scan result (clean), `packages/admin` re-review (no new findings), `packages/pwa` re-review (no additional app logic), CSRF posture (resistant by construction, verified), session lifecycle integrity posture — `openspec/changes/sec-expert-round2/findings-register.md`
- [x] 4.2 Round 2 findings get their own register (Round 1's archived register stays frozen) — done
- [x] 4.3 Confirm zero unaddressed CRITICAL/HIGH from Round 2's own findings at close — confirmed: all 3 HIGH findings fixed+verified; every dependency-audit CRITICAL/HIGH is either fixed or documented accepted-risk with codebase-specific exploitability evidence
- [x] 4.4 Hand off to `sdd-verify`
