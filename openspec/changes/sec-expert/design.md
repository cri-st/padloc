# Design: Independent Security Review of padloc (sec-expert)

## Technical Approach

Two-stage methodology from the proposal's Approach table and
`padloc-fresh-security-audit-workflow`.

**Stage 1 — parallel anti-bias review.** Seven concurrent assignments, each
reading only its own surface (never a prior audit report): `WorkerAuthCore`,
`WorkerStorageEmail`, `CoreCryptoBusinessLogic`, `WebClient`
(app/pwa/admin/locale), `ExtensionClient`, `ServerSelfHosted`,
`PriorClaimsVerification`. Each reports exhaustively, severity-first, with
file:line + exploit scenario per finding (`security-baseline` Req. 1–2).
Consolidation follows: shared `packages/core` findings are re-checked against
BOTH `worker` and `server` reachability, per
`padloc-worker-dead-security-code-audit`'s caller-check discipline.

**Stage 2 — progressive-severity remediation.** Fix confirmed findings in
rounds: critical → high → medium → low, pausing each round to report status.
Per fix: read the real call graph first, re-verify via the owning package's
real `tsc` gate + tests + live smoke test where feasible; infeasible items
get a `SECURITY:` comment and an explicit disclosed-risk entry, never
silent closure.

## Architecture Decisions

### Decision: Parallel per-surface review vs. single sequential reviewer

**Choice**: 7 parallel anti-bias assignments + 1 consolidation pass.
**Alternatives**: One reviewer covering all surfaces sequentially.
**Rationale**: Sequential review risks priming bias (missing a
worker-specific variant of a bug just fixed in server). Parallel isolation
forces independent re-derivation per surface, per the proposal's anti-bias
rule and exploration's Approach 3; consolidation absorbs the shared-`core`
overlap cost.

### Decision: In-scope remediation vs. defer-all-fixes to a later change

**Choice**: Remediate confirmed findings in this same change (progressive
severity rounds), on the topic branch, with commits.
**Alternatives**: Report-only deliverable; fixes filed as separate changes.
**Rationale**: The amended proposal requires "enterprise-grade... in-scope,"
not just a report — Success Criteria include a zero-unaddressed-CRITICAL/HIGH
bar. Deferring would miss the amended intent and duplicate Stage-1 work.

### Decision: Operationalizing "enterprise-grade" as an exit bar

**Choice**: Zero unaddressed CRITICAL/HIGH in-scope findings at close — each
fixed-and-verified (real `tsc` gate + tests + smoke test) or disclosed as
accepted/deferred risk with compensating-control rationale; MEDIUM fixed
where scoped, LOW documented if deferred. Mirrors `security-baseline`'s
Remediation Completion Bar and the proposal's Success Criteria verbatim.
**Alternatives**: "All findings fixed" (rejected — some need infra/account
access or a redesign, forcing a fake fix); "report severity only" (rejected —
proposal requires remediation).
**Rationale**: Balances real closure against honest disclosure.

## Data Flow

Not a data-flow feature. Workflow flow instead:

```
Explore ─▶ Propose(amended) ─▶ [Design(this) | Spec(parallel)] ─▶ Tasks ─▶ Apply ─▶ Verify ─▶ Archive
                                                                             │
                                                     Apply expands to:
                                                     Stage 1: 7 parallel audit sub-agents
                                                              │
                                                     Consolidation (core × worker/server)
                                                              │
                                                     Stage 2: remediation rounds
                                                     (critical→high→medium→low),
                                                     status pause after each
```

## File Changes

Stage 1 findings determine the exact remediation file list — unknowable
before the review runs. Known file touched by THIS phase:

| File | Action | Description |
|------|--------|-------------|
| `openspec/changes/sec-expert/design.md` | Create | This document |

Blast-radius envelope for `sdd-tasks`/Stage 1 (proposal's Affected Areas):
`packages/{worker,server,core,app,extension,admin}/src`, `packages/pwa`,
`packages/locale` (cursory), `config/`, `assets/email/*`. Concrete file:line
targets are deferred to Stage 1 output.

## Interfaces / Contracts

N/A — patches implementation defects, no new API surface, RPC method, or
public interface. Verified against these entry points:
`packages/worker/src/index.ts`'s `default` RPC-dispatch object,
`packages/core/src/server.ts`'s `Controller`/`Server` classes,
`packages/server/src`'s storage/scim/provisioning modules,
`packages/admin/src`'s `app.ts` shell — none gains a new contract.

## Testing Strategy

| Layer | What to Test | Approach |
|-------|-------------|----------|
| Typecheck | Package compiles clean | Package's pinned `tsc --noEmit --skipLibCheck` (worker: `npm run deploy:dry-run` esbuild bundle), per `padloc-verify-without-ch5-multi-package` |
| Existing suite | No regression | `worker`: `npm run test:ci`; `server`: `mocha` in `test/`; others: existing package suites |
| Live smoke | Behavior fixes work for real | `wrangler dev` + `curl` for worker (pre/post, safe+unsafe configs); package run commands for self-hosted server; manual check for client fixes |
| Concurrency (if applicable) | Lock/DO fixes hold under races | Real `Promise.all()` multi-way test against the actual class, per `padloc-worker-dead-security-code-audit` |

No CI gate exists in this repo (per `sdd-init`); this is the only
enforcement layer, run manually per fix before it's marked done.

## Threat Matrix

N/A — this design's own mechanism does not add or change routing, shell
commands, subprocess/VCS/PR automation, executable-file classification, or
process integration. Stage 1 findings MAY later surface remediation targets
that touch such boundaries; that applicability call and its RED tests belong
to the individual remediation task in `sdd-tasks`/apply, not this design.

## Migration / Rollout

No migration required. This is a review-and-in-place-fix change on a topic
branch (`AGENTS.md`: no PR flow, commits fast-forward to `main`). Rollback =
`git reset`/revert pre-fast-forward, or `git revert` on `main` after.

## Open Questions

- [ ] Is live Cloudflare deploy-state access available to confirm
      `AccountLockDO`/`GENERAL_RATE_LIMIT` production status, or must this be
      reported as an explicitly caveated "inherited risk, unconfirmed"?
- [ ] How deep can `packages/admin`'s RPC-level authorization first-pass go
      without live server access to trace the full request path end-to-end —
      static call-graph tracing only, or is a local `wrangler dev`/server
      instance available for live verification?
