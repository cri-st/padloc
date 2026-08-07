# Archive Report: Supply-Chain & Compliance Audit + Remediation

**Change**: `supply-chain-compliance-audit`
**Status**: Archived (closed, complete)
**Archived**: 2026-08-07
**Archived to**: `openspec/changes/archive/2026-08-07-supply-chain-compliance-audit/`

## Summary

Follow-up to the `sec-expert` security review, this change audited padloc's
supply-chain posture (SBOM, license compliance, CI/CD pipeline integrity)
and compliance posture (GDPR-style data retention, deletion, audit trail)
across all 7 in-scope packages (`worker`, `server`, `core`, `app`, `pwa`,
`extension`, `admin`), producing an evidence-based findings register and
remediating every code-fixable finding. The change is fully planned,
implemented, verified, and now closed.

## Final State (authoritative — supersedes intermediate snapshots)

`sdd-verify` (observation `#1371`) returned **PASS WITH WARNINGS** —
0 CRITICAL, 2 WARNING, 1 SUGGESTION, verdict `pass`, 7/7 requirements,
14/14 scenarios, 25/25 tasks complete, 0 blockers. Both WARNING-level
findings were **citation-accuracy nits in the findings register's prose**,
not code defects, and are text-only corrections — nothing to re-verify
beyond the corrected text itself:

1. **L1's per-package license attribution** (`findings-register.md`,
   Legal/Business Judgment section, "AGPL vs. GPL-3.0/GPLv3
   license-declaration mismatch") had `packages/server` and
   `packages/extension` swapped in the prose. Verified directly against
   the real `package.json` `license` fields:
   - `"license": "GPL-3.0"` → `extension`, `core`, `app`, `pwa`, `admin`,
     root
   - `"license": "GPLv3"` → `worker`, `server`

   Corrected in the register. **The underlying finding is unaffected**:
   the repository root `LICENSE` file is genuinely AGPLv3 while every
   `package.json` declares GPL-3.0/GPLv3 — a real, code-verified
   mismatch, still `OUT OF SCOPE — legal/business judgment` per the
   proposal's explicit scope boundary. Only the specific per-package
   attribution in the prose was wrong; only the swap was corrected.
2. **C2's fix note** (`findings-register.md`, "Log retention — aspirational
   comment, never implemented (T26)") claimed `packages/worker`'s
   `npm run test:ci` has "13 sub-suites". The independently re-verified
   count is **14 sub-suites** — consistent with `verify-report`
   (`#1371`), which already recorded `test_command: "... npm run test:ci
   (14 sub-suites) ..."` and `"full worker test:ci suite (14 sub-suites,
   all passed, exit 0)"`. Corrected the register's prose to match.

Both corrections are the sole remediation required to close from PASS WITH
WARNINGS to a clean archive; the archived `findings-register.md` at its new
path (see below) reflects the corrected text.

## Spec Sync

**No delta-spec merge was needed.** `supply-chain-compliance-baseline` is a
**new capability** — no prior spec existed to delta against. The
`sdd-spec` phase wrote the spec directly to its final location:

- `openspec/specs/supply-chain-compliance-baseline/spec.md` ✅ (confirmed
  present at close; no `openspec/changes/supply-chain-compliance-audit/specs/`
  delta folder ever existed for this change — the change folder contained
  only `proposal.md`, `exploration.md`, `design.md`, `tasks.md`,
  `findings-register.md`, `verify-report.md`)

This spec is the durable source of truth for future supply-chain/compliance
review baselines and is unaffected by this archive move.

## Report Location

This change's real deliverable — the evidence-based findings register — is
`findings-register.md` itself; per this change's own sizing decision during
`sdd-apply`, no separate `docs/`-level report was produced (unlike
`sec-expert`, which wrote a standalone `docs/sec-expert-review-*.md`). The
register now lives at its permanent archived path:

**`openspec/changes/archive/2026-08-07-supply-chain-compliance-audit/findings-register.md`**

A future reader should look for the audit findings there, not at a
`docs/` path — none exists for this change.

## Artifacts Archived

All present at `openspec/changes/archive/2026-08-07-supply-chain-compliance-audit/`:

- `proposal.md` ✅
- `exploration.md` ✅
- `design.md` ✅
- `tasks.md` ✅ (25/25 tasks complete, 0 unchecked)
- `findings-register.md` ✅ (2 citation nits corrected at archive time)
- `verify-report.md` ✅
- `archive-report.md` ✅ (this file)

## Engram Observation IDs (traceability)

| Artifact | Observation ID |
|---|---|
| proposal | `#1364` |
| spec | `#1365` |
| design | `#1366` |
| tasks | `#1367` |
| verify-report | `#1371` |
| archive-report | (this save, `sdd/supply-chain-compliance-audit/archive-report`) |

## Remediation Summary (from findings-register.md)

- **C1, C2, S1, S5** — `FIXED` with commit refs (cascade-delete
  attachments, log retention cron T26, SBOM dependency-tree blocker
  resolved, GitHub Actions SHA-pinned).
- **L1, L2** — `OUT OF SCOPE — legal/business judgment`, surfaced not
  silently resolved (AGPL/GPL-3.0 mismatch; `nginx/Dockerfile`
  modernization).
- **S2, S4, S7, S8, S9, C3–C7** — `OPEN`/informational by design, no fix
  planned this change.
- **C8** — `DISCLOSED — OUT OF SCOPE for this change` (`D1Storage`
  generic save fallback omits `change_log`/`request_log` `NOT NULL`
  columns; found during Phase 3 verification, recommend a dedicated
  future change).

## Branch State

Branch `supply-chain-compliance-audit`, 8 commits ahead of `main`
(`59b33d81` … `130df058`), plus this archive commit. **Not merged, not
pushed** — merge/push is the user's decision, outside this archive phase's
scope.

## Risks

None. No CRITICAL issues at close. Both WARNING-level citation nits were
corrected as part of this archive. No unranked contradictions were found
between the launch prompt's final-state facts and repository evidence —
both corrections were independently verified against live `package.json`
files and the `verify-report` observation before being applied.

## SDD Cycle Complete

The change has been fully planned, implemented, verified, and archived.
Ready for the next change.
