# Archive Report: sec-expert-round2

**Change**: sec-expert Round 2 — Dependency, Crash-Resilience, and Session-Lifecycle Hardening
**Status**: Archived (closed, done)
**Archived**: 2026-08-07
**Branch**: `security/sec-expert-remediation`, 32 commits ahead of `main` — NOT merged, NOT pushed (deployment/merge decision belongs to the user)

## Traceability (Engram observation IDs)

| Artifact | Engram ID | Topic key |
|---|---|---|
| Proposal | #1353 | `sdd/sec-expert-round2/proposal` |
| Spec (delta) | #1354 | `sdd/sec-expert-round2/spec` |
| Design | #1355 | `sdd/sec-expert-round2/design` |
| Tasks | #1356 | `sdd/sec-expert-round2/tasks` |
| Verify report | #1358 | `sdd/sec-expert-round2/verify-report` |

Filesystem copies (openspec/hybrid mode) moved to this archive folder:
`proposal.md`, `exploration.md`, `specs/security-baseline/spec.md`, `design.md`,
`tasks.md`, `verify-report.md`, `findings-register.md`.

## Summary

Round 2 of the independent `sec-expert` security engagement closed the gaps
Round 1 (`archive/2026-08-06-sec-expert`) left open: it ran `npm audit` for
the first time across all 7 in-scope-adjacent packages, closed a reachable
unhandled-rejection crash source in the HTTP transport, added a missing
OWASP session-revocation-on-password-change control, and remediated 4
CRITICAL dependency findings in the WebAuthn MFA verification chain. Three
code fixes shipped (commits `503e9ac9`, `a9b6a67a`) plus four dependency
bumps (`db8bdcd4`, `868064b7`, `58da1c3d`), all independently re-verified by
`sdd-verify`, not self-reported.

## Specs Synced

| Domain | Action | Details |
|---|---|---|
| `security-baseline` | Updated (merge) | 2 requirements ADDED (`Dependency Vulnerability Disclosure`, `Session Lifecycle Integrity`), 0 MODIFIED, 0 REMOVED, 0 RENAMED — 7 pre-existing Round 1 requirements preserved unchanged. Main spec now has 9 total requirements. |

Source of truth updated: `openspec/specs/security-baseline/spec.md` (verified: `grep -c "^### Requirement:"` → 9).

## Task Completion Gate

All 18 implementation tasks in the archived `tasks.md` are checked `[x]` (Phase 1: 3, Phase 2: 2, Phase 3: 5, Phase 4: 4, plus sub-items). No stale-checkbox reconciliation was needed — `sdd-apply` marked completion directly.

## Final State (per Final-State Authority hierarchy)

`verify-report.md` (rank 4, intermediate snapshot, written at verification time) recorded:
**PASS WITH WARNINGS** — 0 CRITICAL, 3 WARNING, 2 SUGGESTION. The three WARNINGs concerned missing persisted/re-runnable test coverage for the `Session Lifecycle Integrity` requirement's scenarios; the two SUGGESTIONs concerned an unwired e2e test script and an imprecise summary count in the register.

A higher-ranked, later fact (explicit final-state input to this archive phase, corroborated by direct repository evidence — commit `0cf5fa0a`, dated 2026-08-07 00:58:22, and the current `findings-register.md` content on disk) supersedes that snapshot for the items it resolved:

- **CLOSED** — WARNING 1 *("Password change revokes other sessions, keeps current" has no persisted regression test)*: `0cf5fa0a` added two persisted scenarios to `packages/worker/test/auth-flow-e2e.worker.ts` (two-session revocation case + single-session no-op case), run via `run-auth-flow-e2e.mjs` against a real `wrangler dev` instance.
- **CLOSED** — WARNING 3 *("Password change with only one active session" has zero test coverage)*: covered by the same commit's second new scenario above.
- **CLOSED** — SUGGESTION 1 *(`run-auth-flow-e2e.mjs` not wired into `test:ci`)*: `0cf5fa0a` wires it in as `test:auth-flow-e2e` in `packages/worker/package.json`, and fixes a real pre-existing test-isolation bug in the runner (missing `mkdtemp --persist-to` + explicit D1 migration apply — the fixture's tables previously only existed by accident from leftover local dev-server state, so it would have failed on a clean checkout/CI runner). Commit message states `npm run test:ci` in `packages/worker` re-run afterward: all suites pass, `test:auth-flow-e2e` now 11/11 (was 9/9 before the two new scenarios).
- **Independently re-confirmed**: full `test:ci` re-run after `0cf5fa0a`, 13 chained suites, 0 failures (per this archive phase's launch-context final-state facts).

**Remaining open item (NOT closed, correctly still open):**

- **WARNING 2** — *"Account recovery invalidates prior sessions" has zero test coverage.* No test exists anywhere in `packages/worker/test`, `packages/server/test`, or `packages/core/test` exercising `recoverAccount()`'s session-revocation behavior (`packages/core/src/server.ts:1254`). This is **pre-existing Round 1 code, unmodified by Round 2**. `findings-register.md`'s Session Lifecycle Integrity section explicitly documents this as "a documented gap for a future round (out of scope for this session, pre-existing Round 1 code, unmodified in Round 2)." This is intentionally not scope-creeped into Round 2 — logic is verified sound by direct code trace only (same delete-then-splice pattern as the now-tested `revokeSession`/`updateAuth` paths), but has no runtime regression proof. **Recommended as the first item for any future Round 3.**
- **SUGGESTION 2** — the register's "Coverage Check" summary count ("9 dependency findings documented as accepted-risk") doesn't cleanly reconcile against the ~11 individual `npm audit` JSON nodes or 8 bullet points those findings map to (due to `npm audit`'s convention of listing both a direct dependency and its vulnerable transitive package as separate nodes for one advisory). Not a disclosure gap — every distinct advisory's exploitability is covered in prose — just an imprecise summary count. Left open; cosmetic only, non-blocking.

No CRITICAL issues were ever present at any point in this round, so the Native Review Receipt Gate / CRITICAL-blocks-archive rule was never in tension with closing this change.

## Archive Contents

- `proposal.md` ✅
- `exploration.md` ✅ (optional artifact, present)
- `specs/security-baseline/spec.md` ✅ (delta spec, now merged into main)
- `design.md` ✅
- `tasks.md` ✅ (18/18 tasks complete)
- `verify-report.md` ✅ (PASS WITH WARNINGS at verification time; see Final State above for what has since closed)
- `findings-register.md` ✅ (Round 2's own register; Round 1's archived register at `archive/2026-08-06-sec-expert/findings-register.md` stays frozen)

## Source of Truth Updated

The following specs now reflect the new behavior:
- `openspec/specs/security-baseline/spec.md` (9 total requirements: 7 from Round 1 + 2 from Round 2)

Real deliverables that remain at their live paths (not archived, intentionally — these are the durable engagement outputs, not per-cycle artifacts):
- `docs/sec-expert-review-2026-08-06.md` — now contains both the original Round 1 report and a "Round 2 Addendum — Enterprise-Grade Gap Closure" section (confirmed present at line 70).
- `openspec/specs/security-baseline/spec.md` — the merged main spec (source of truth going forward).

## Branch / Deployment State

`security/sec-expert-remediation` is 32 commits ahead of `main`. It has NOT been merged and NOT been pushed. That decision remains with the user — this phase does not merge, push, or open a PR.

## SDD Cycle Complete

The `sec-expert-round2` change has been fully planned, implemented, verified, and archived. The one open follow-up (account-recovery session-revocation test coverage) is a pre-existing, out-of-scope gap, explicitly documented rather than silently dropped, and is the natural entry point for a possible Round 3 — not a blocker to this closure.
