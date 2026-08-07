# Proposal: Independent Security Review of padloc (sec-expert)

## Intent

Deliver an independent, external-expert-style security review of padloc's in-scope surfaces —
severity-classified findings, then remediation of confirmed findings, not just reporting.
Informed by, but independent of, this week's internal audit and the scope brief's workstream
list (§6: coverage reference, not a checklist). Goal: enterprise-grade security posture
in-scope.

## Scope

### In Scope
- `packages/{worker,server,core}/src` — API, self-host, and shared crypto/business logic
- `packages/app/src`, `packages/pwa` — shared web UI + static build
- `packages/extension/src` — extension + native passkey broker
- `packages/admin/src` — admin console (net-new, no prior coverage)
- `packages/locale` — cursory, rendering-sink injection risk only
- `config/`, `assets/email/*` — deploy config, email templates
- Cloudflare deploy/runtime state per `AGENTS.md` (best-effort, read-only)
- Live status of the 2 pending DO-bound fixes (`AccountLockDO`, `GENERAL_RATE_LIMIT`)
- Progressive-severity remediation (critical→high→medium→low) of confirmed findings, per
  `padloc-fresh-security-audit-workflow`: fix, re-verify (`tsc` gate, tests, smoke test),
  pause each round to report status

### Out of Scope
- `packages/electron`, `packages/tauri`, `packages/macos`, `packages/cordova` (user-confirmed)
- Formal crypto proof, black-box pentesting, Cloudflare account/MFA audit, SBOM/CVE scanning,
  compliance assessment — unreachable by a code-reviewing agent; disclosed explicitly
- Remediation beyond agent reach (infra/account access, compliance sign-off, larger redesign) —
  `SECURITY:`-commented and disclosed as a gap, never silently closed or overclaimed

## Capabilities

### New Capabilities
- `security-baseline`: acceptance bar for this review+remediation engagement (surface
  coverage, finding evidence quality, pending-fix live-verification, scope-disclosure
  honesty, admin first-pass coverage, remediation completion bar, fix verification rigor)

### Modified Capabilities
None — remediation fixes implementation defects, not existing spec-level requirements.

## Approach

Hybrid structure (exploration's Approach 3): parallel per-surface anti-bias reviewers (no
prior-audit reading) plus one verification pass, then consolidation checking `core` findings
against worker/server reachability.

| Surface | Coverage |
|---|---|
| WorkerAuthCore | `worker/src/{auth,locks,transport.ts,idempotency.ts,index.ts}` |
| WorkerStorageEmail | `worker/src/{storage,durable-objects,attachments,email,observability,server-factory.ts,rate-limiter.ts,hq-instrumentation.ts}` |
| CoreCryptoBusinessLogic | `core/src/*` (server.ts, crypto/srp/container/otp, account-lock, share, session, item, encoding, api.ts) |
| WebClient | `app/src`, `pwa`, `admin/src` (RPC-level authz first-pass), `locale` (cursory) |
| ExtensionClient | `extension/src` (incl. passkey broker RP-ID binding) |
| ServerSelfHosted | `server/src` (scim, provisioning, storage adapters, attachments, auth, transport, repl) |
| PriorClaimsVerification | Confirm live status of the 2 pending DO fixes; spot-check a sample of "FIXED" claims; reassess the 3 disclosed-unfixed items |

**Stage 2 — remediation.** Fix findings in severity rounds (critical→high→medium→low), pausing
each round to report status. Enterprise-grade = zero unaddressed CRITICAL/HIGH at close
(fixed+verified, or disclosed infeasible with compensating-control rationale); MEDIUM fixed
where scoped; LOW documented if deferred.

## Affected Areas

| Area | Impact | Description |
|---|---|---|
| `packages/worker/src` | Review + Fix | Auth, DO locks, storage, transport, email, idempotency |
| `packages/server/src` | Review + Fix | Self-host injection/authz history — highest prior CRITICAL yield |
| `packages/core/src` | Review + Fix | Shared crypto/session/business logic — max blast radius |
| `packages/app/src`, `packages/pwa` | Review + Fix | Shared UI, untrusted-file parsing, DOMPurify sinks |
| `packages/extension/src` | Review + Fix | Passkey broker RP-ID binding, session-token storage |
| `packages/admin/src` | Review + Fix | Net-new privileged surface, unverified RPC-level authz |
| `packages/locale` | Review | Cursory injection check on translated strings |
| `config/`, `assets/email/*` | Review + Fix | Secret/hostname hygiene, template injection regression |
| Cloudflare deploy state | Review | Live status of 2 pending DO-bound fixes |

## Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| Scope ambiguity (from-scratch vs. verify-prior) | Resolved | §6 of scope brief settles this: independent re-derivation, prior docs as context only |
| `packages/admin` authz model unverified at depth | Med | First-class reviewer assignment tracing every admin RPC's server-side role check |
| 2 pending DO fixes' live status unconfirmed | Med | Dedicated verification sub-task; if Cloudflare account access unavailable, report explicitly caveats as "inherited risk, unconfirmed" rather than claiming closure |
| Cross-surface duplication/omission (shared `core`) | Med | Consolidation pass explicitly checks shared-file findings against both worker and server entry points |
| Overclaiming coverage vs. real external-audit scope | Low | Report explicitly lists unreachable workstreams (crypto proof, pentest, infra access, compliance) rather than implying full coverage |
| Remediation introduces a regression | Med | Per-package real `tsc` gate + existing tests + live smoke test before any fix is considered done (`padloc-fix-verification-gotchas`) |
| No CI test/lint gate in this repo (per sdd-init) | Med | Verification stays manual/agent-driven per package, not CI-enforced; each fix explicitly re-verified before commit |

## Rollback Plan

Now includes source commits, not just a report. Per `AGENTS.md`: topic branch, no PRs; commits
fast-forward to `main`. Rollback = revert/reset pre-fast-forward, or `git revert` on `main`
after (no PR flow here). Report discardable (Engram + `openspec/changes/sec-expert/`).

## Dependencies

- `docs/security-audit-2026-08.md`, `docs/external-security-audit-scope-2026-08-06.md` — context only
- Best-effort Cloudflare deploy-state access; absence disclosed, not a blocker

## Success Criteria

- [ ] Every surface (7-way split) gets an explicit pass: findings or "no findings", no silent
      omission
- [ ] Every finding has file:line, exploit scenario, severity + justification, severity-first
- [ ] `AccountLockDO`/`GENERAL_RATE_LIMIT` live status confirmed or caveated as unconfirmed
- [ ] Report states out-of-reach external-scope workstreams (no overclaim)
- [ ] `packages/admin`'s RPC-level authorization gets first-pass coverage (previously unaudited)
- [ ] Zero unaddressed CRITICAL/HIGH findings in-scope at close (fixed+verified or disclosed as
      accepted/deferred risk); each fix verified via the package's real `tsc` gate + tests +
      smoke test
