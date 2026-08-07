# Tasks: Independent Security Review of padloc (sec-expert)

## Review Workload Forecast

- Estimated changed lines: unknown pre-Stage-1; ~300-600 (report) + 800-2000+ (remediation; multi-CRITICAL history)
- 400-line budget risk: High
- Chained PRs recommended: No — repo has no PR flow (topic branch, exact-SHA CI, fast-forward to main)
- Delivery strategy: single-pr; Chain strategy: pending — re-confirmation required

```text
Decision needed before apply: Yes
Chained PRs recommended: No
Chain strategy: pending
400-line budget risk: High
```

**Why re-confirm**: "no limit" was accepted for a report-only change; scope expanded to remediation with a CRITICAL-bug history, zero PR checkpoints — re-confirm `size:exception`-equivalent before Phase 3.

### Suggested Work Units

1. Stage 1 + register (Ph1-2) — test: N/A; harness: N/A; rollback: register commit.
2. Critical round (Ph3) — test: per-pkg `tsc --skipLibCheck`+suite; harness: `wrangler dev`+curl / pkg run / manual; rollback: Ph3 commits.
3. High round (Ph4) — same; rollback: Ph4 commits.
4. Medium/Low+report (Ph5-6) — same; rollback: Ph5-6 commits.

## Phase 1: Stage 1 — Parallel Anti-Bias Review

Per `padloc-fresh-security-audit-workflow`, no prior-audit reading; severity-first, file:line+exploit+justification (`security-baseline` Req.1-2).

- [x] 1.1 WorkerAuthCore — `worker/src/{auth,locks,transport.ts,idempotency.ts,index.ts}`
- [x] 1.2 WorkerStorageEmail — `worker/src/{storage,durable-objects,attachments,email,observability,server-factory.ts,rate-limiter.ts,hq-instrumentation.ts}`
- [x] 1.3 CoreCryptoBusinessLogic — `core/src/*` (server.ts, crypto/srp/container/otp, account-lock, share, session, item, encoding, api.ts)
- [x] 1.4 WebClient — `app/src`, `pwa`, `admin/src` (trace admin RPCs to `core` role checks, Req.5), `locale`
- [x] 1.5 ExtensionClient — `extension/src`, incl. passkey broker RP-ID binding
- [x] 1.6 ServerSelfHosted — `server/src` (scim, provisioning, storage adapters, attachments, auth, transport, repl)
- [x] 1.7 PriorClaimsVerification — confirm `AccountLockDO`/`GENERAL_RATE_LIMIT` live status (best-effort); spot-check sample "FIXED" claims (`docs/security-audit-2026-08.md`); reassess 3 disclosed-unfixed items; caveat unconfirmed (Req.3)

## Phase 2: Consolidation

- [x] 2.1 Merge 7 reports into one severity-ranked register; re-check every `core` finding against worker/server reachability (`padloc-worker-dead-security-code-audit`); discard findings with no exploit scenario
- [x] 2.2 Verify register meets Surface Coverage Completeness (7/7) and Finding Evidence Quality before Stage 2

## Phase 3: Remediation — Critical Round

- [x] 3.1 Per CRITICAL finding: read real call graph, fix; if infeasible, `SECURITY:` comment + disclosed compensating-control entry — 3/3 fixed
- [x] 3.2 Verify: owning package's real `tsc --skipLibCheck` + tests + live smoke test + concurrency test where applicable — all 3 verified with exploit-reproduction-on-baseline evidence
- [x] 3.3 Checkpoint: report Critical-round status before Phase 4 — reported

## Phase 4: Remediation — High Round

- [x] 4.1 Same as 3.1, HIGH findings — 5/5 fixed
- [x] 4.2 Same verification as 3.2 — all 5 verified
- [x] 4.3 Checkpoint: report High-round status before Phase 5 — reported

## Phase 5: Remediation — Medium/Low Round

- [x] 5.1 Fix each MEDIUM finding; verify per 3.2 — 7/8 fixed, 1 (M2) documented deferral with detailed rationale
- [x] 5.2 Each LOW finding: document deferral rationale inline (`SECURITY:` comment) — 6/17 fixed, 11 documented deferrals
- [x] 5.3 Checkpoint: report Medium/Low status — reported

## Phase 6: Final Report + Verification

- [x] 6.1 Assemble report at `docs/sec-expert-review-2026-08-06.md`: per-surface pass/no-findings, finding statuses, `AccountLockDO`/`GENERAL_RATE_LIMIT` live status, out-of-reach workstreams (crypto proof, pentest, Cloudflare MFA, SBOM/CVE, compliance)
- [x] 6.2 Verify all 7 `security-baseline` requirements' acceptance scenarios are satisfiable from the report
- [x] 6.3 Confirm zero unaddressed CRITICAL/HIGH undisclosed; MEDIUM fixed-where-scoped; LOW documented if deferred
- [x] 6.4 Hand off report + branch state to `sdd-verify`
