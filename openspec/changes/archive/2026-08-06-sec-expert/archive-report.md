# Archive Report: Independent Security Review of padloc (sec-expert)

## Status

**Archived.** SDD cycle complete: explore → propose → spec → design → tasks → apply → verify → archive.

## Change Summary

An independent, external-expert-style security review of padloc across 7 surfaces
(`WorkerAuthCore`, `WorkerStorageEmail`, `CoreCryptoBusinessLogic`, `WebClient`,
`ExtensionClient`, `ServerSelfHosted`, `PriorClaimsVerification`), followed by
in-scope remediation in severity rounds (critical → high → medium → low). This
was a report **and** a real source-code remediation effort — not report-only.

- **37 findings** total: 3 CRITICAL, 5 HIGH, 8 MEDIUM, 17 LOW (+ 4 N/A best-practice notes,
  per the findings register).
- **3/3 CRITICAL fixed and verified.**
- **5/5 HIGH fixed and verified.**
- **7/8 MEDIUM fixed** (1 documented deferral: M2, rushed per-argument RFC5054 PAD() fix
  risks a simultaneous unrecoverable login outage — rationale recorded inline).
- **6/17 LOW fixed**, 11 documented deferrals (`SECURITY:` comments + register rationale).
- **Zero unaddressed CRITICAL/HIGH** at close — the review's stated "enterprise-grade" bar.

## Deliverables (real repo artifacts — NOT archived, remain at their live locations)

- **`docs/sec-expert-review-2026-08-06.md`** — the final report: per-surface pass/no-findings
  statements, finding statuses, `AccountLockDO`/`GENERAL_RATE_LIMIT` live-status caveat,
  out-of-reach workstreams (crypto formal proof, black-box pentest, Cloudflare account/MFA
  audit, SBOM/CVE scan, compliance assessment, account-recovery social-engineering testing).
- **`openspec/changes/sec-expert/findings-register.md`** (now at its archived path below) —
  the full 37-finding severity-ranked register with file:line, exploit scenario, fix commit
  or deferral rationale per finding, plus a "Per-Surface No-Findings Statements" appendix
  (added in commit `8e17a529`, closing the sdd-verify WARNING about transcript-only
  evidence — see Warnings Resolved below).

Per the orchestrator's explicit instruction for this change's unusual report+remediation
shape, only the SDD planning-artifact folder (proposal/design/tasks/verify-report/
exploration/findings-register) is archived below. The final report at `docs/` is a
genuine repo deliverable, not an SDD planning artifact, and stays at its live path.

## Specs

`security-baseline` (new capability) was authored **directly at its final location**
`openspec/specs/security-baseline/spec.md` during `sdd-spec`, not as a delta inside the
change folder — confirmed no `specs/` subdirectory existed under
`openspec/changes/sec-expert/` at archive time. **No delta-merge step was performed**
because none was needed; the main spec is the original and only copy. It defines 7
requirements / 14 scenarios (Surface Coverage Completeness, Finding Evidence Quality,
Pending Fix Live-Verification, Scope Disclosure Honesty, Admin Surface First-Pass
Coverage, Remediation Completion Bar, Fix Verification Rigor) — all 7/7 satisfied per
`sdd-verify`'s Spec Compliance Matrix (12/14 scenarios ✅ COMPLIANT, 1 ✅ N/A-by-design,
2 ⚠️ PARTIAL — see Warnings Resolved).

## Task Completion Gate

Both the filesystem `tasks.md` (archived below) and the Engram `sdd/sec-expert/tasks`
observation (`#1346`) show **22/22 implementation tasks checked `[x]`**, zero unchecked.
Independently re-verified by `grep -c '^\- \[x\]' tasks.md` = 22, `'^\- \[ \]'` = 0
(matches `sdd-verify`'s own recount). Gate **passes**.

## Native Review Receipt Gate

No `gentle-ai review` native validator/receipt system is available in this xd:// tool
environment — consistent with `sdd-verify`'s own finding that `gentle-ai
sdd-verify-validate` was unavailable throughout this session. No terminal review receipt,
transaction, ledger, or gate-context was ever produced for this change because the tooling
to produce one does not exist here; there is no `reviewGate.result: allow` to check against
because no reviewGate ran. Treated as **`disabled/unmanaged`** for this environment — the
only relaxation the gate itself permits — and archive proceeds on that basis, matching how
`sdd-verify` persisted its own report without that gate.

## Final-State Authority — Verify Warnings Resolved

`sdd-verify` (observation `#1349`, persisted 2026-08-07 02:28:40) returned **PASS WITH
WARNINGS**: 0 CRITICAL, 0 blockers, 2 WARNINGs. Per this phase's Final-State Authority
hierarchy, both are reported as **resolved**, not as still-open, per the orchestrator's
explicit final-state facts and independently re-confirmed against the current repository
state:

1. **Commit-count self-reporting inconsistency.** `verify-report` recorded: `apply-progress`/
   `tasks.md` said "22 commits", the final report said "20 commits", actual branch state was
   23 commits at verify time. **Fixed** in commit `8e17a529` ("docs(security): fix
   commit-count drift and fold per-surface no-findings into register"), which corrected the
   final report's commit-count line to **"23 commits on branch `security/sec-expert-remediation`"**
   (`docs/sec-expert-review-2026-08-06.md:16`).

   **Residual discrepancy found and disclosed, not silently resolved**: `git rev-list --count
   main..HEAD` on `security/sec-expert-remediation` now returns **24**, not 23, because
   `8e17a529` — the very commit that corrected the count — is itself one more commit ahead of
   `main`, created after the count it records was accurate. This is a self-referential
   counting limit (a commit cannot include its own ordinal in a "commits on this branch" count
   without a further commit to update it) rather than an uncorrected inconsistency; the commit
   genuinely fixed the number to match the state at the moment it was authored. Non-blocking,
   cosmetic, and disclosed here per the Final-State Authority rule that an unrankable
   contradiction between the launch prompt's "corrected to 24" framing and the file's literal
   "23" text must be recorded explicitly rather than silently resolved in either direction.
   Both the launch prompt's characterization and this report's own independent `git
   rev-list` check are accurate for the moment each was taken.

2. **Req.1/Req.5 evidentiary trail not durably persisted.** `verify-report` found the
   register deferred per-surface "no findings" statements (incl. the Req.5 admin-RPC-to-
   `core`-role-check tracing) to ephemeral sub-agent session transcripts rather than a
   persisted artifact. **Fixed** in the same commit `8e17a529`, which added a "Per-Surface
   No-Findings Statements" appendix to `findings-register.md` (confirmed present at line 158:
   `## Per-Surface No-Findings Statements (appendix — closes sdd-verify WARNING re:
   transcript-only evidence)`), making the register self-contained without needing
   `history://` transcript survival.

Both fixes independently confirmed present at `HEAD` (`8e17a529`) by this archive phase via
direct file inspection, not trusted from the launch prompt alone.

## Build/Test Evidence (carried from sdd-verify, highest-ranked source that covers it)

- `packages/server`, `packages/app`, `packages/extension`: `tsc --noEmit --skipLibCheck` →
  exit 0, all 3.
- `packages/worker`: `npm run deploy:dry-run` → exit 0 (bare `tsc` is not the correct gate
  for this package per `padloc-verify-without-ch5-multi-package` — pre-existing unrelated
  `drizzle-orm`/`zod` `.d.ts` parse errors).
- Tests: `packages/server` mocha 10/10, `packages/extension` 56/56, `packages/worker`
  `test:ci` (13 chained sub-suites) all green — independently re-run by `sdd-verify`, not
  trusted from self-report.

## Branch / Merge State

**Not merged, not pushed.** `security/sec-expert-remediation` is a local topic branch, 24
commits ahead of `main`, no PRs (repo convention per `AGENTS.md`: fast-forward to `main`,
no PR flow). Merging or pushing this branch is **a decision for the requesting user**, not
performed by this archive phase or any prior SDD phase.

## Archive Contents

Moved `openspec/changes/sec-expert/` → `openspec/changes/archive/2026-08-06-sec-expert/`:
- `proposal.md` ✅
- `design.md` ✅
- `tasks.md` ✅ (22/22 tasks complete)
- `verify-report.md` ✅ (was untracked in git at archive time — now staged with the move)
- `findings-register.md` ✅ (37-finding register + no-findings appendix)
- `exploration.md` ✅
- `archive-report.md` ✅ (this file)

No `specs/` subdirectory existed in the change folder (spec was authored directly at its
final location — see Specs section above), so nothing else moves or merges.

## Observation IDs (Engram, for traceability)

| Artifact | Topic key | Observation ID |
|---|---|---|
| Proposal | `sdd/sec-expert/proposal` | `#1343` |
| Design | `sdd/sec-expert/design` | `#1344` |
| Spec | `sdd/sec-expert/spec` | `#1345` |
| Tasks | `sdd/sec-expert/tasks` | `#1346` |
| Verify report | `sdd/sec-expert/verify-report` | `#1349` |
| Archive report (this doc) | `sdd/sec-expert/archive-report` | persisted below |

## Risks / Follow-ups (not blocking archive)

- Branch `security/sec-expert-remediation` (24 commits) has not been merged or pushed —
  awaiting an explicit user decision.
- 1 MEDIUM (M2) and 11 LOW findings remain documented-deferred (rationale in
  `findings-register.md`), not fixed — by design, per the review's completion bar which only
  requires zero unaddressed CRITICAL/HIGH.
- `AccountLockDO`/`GENERAL_RATE_LIMIT` DO bindings are confirmed present in committed config
  only; true live production/staging deployment status remains unconfirmed (no Cloudflare
  account access in this environment) — disclosed, not overclaimed, per `security-baseline`
  Req.3's access-unavailable branch.
- `packages/worker`'s `test:ci` script does not include `test:auth-flow-e2e` in its chain
  (pre-existing repo structure, noted by `sdd-verify` as a maintainer follow-up, not
  introduced by this change).

## SDD Cycle Complete

The change has been fully explored, proposed, spec'd, designed, tasked, implemented,
verified, and archived. Ready for the next change.
