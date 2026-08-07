# Security Baseline Specification

## Purpose

Acceptance bar for padloc's independent security review + remediation
engagement (`sec-expert`); new capability synthesized from the proposal's
Success Criteria, no prior spec to delta against.

## Requirements

### Requirement: Surface Coverage Completeness

The review MUST produce a reviewed-or-no-findings statement for each
in-scope surface (WorkerAuthCore, WorkerStorageEmail,
CoreCryptoBusinessLogic, WebClient, ExtensionClient, ServerSelfHosted,
PriorClaimsVerification); none MUST be silently omitted.

#### Scenario: Surface has no findings

- GIVEN WebClient was reviewed with no vulnerabilities
- WHEN the report is compiled
- THEN it MUST state "no findings" for WebClient

#### Scenario: Surface missing from report

- GIVEN a surface lacks both findings and a "no findings" statement
- WHEN the report is assembled
- THEN it MUST be treated as incomplete, not final

### Requirement: Finding Evidence Quality

Every finding MUST include file:line, an exploit scenario, and a severity
rating with justification, listed severity-first (CRITICAL→HIGH→MEDIUM→LOW).

#### Scenario: Well-formed finding

- GIVEN a vulnerability confirmed in `packages/worker/src/auth`
- WHEN added to the report
- THEN it MUST cite file:line, exploit path, and severity + justification

#### Scenario: Finding lacking exploit scenario

- GIVEN a candidate with no articulable exploit path
- WHEN prepared for the report
- THEN it MUST NOT be listed until an exploit path exists, else discarded

### Requirement: Pending Fix Live-Verification

Live status of the two pending DO-bound fixes (`AccountLockDO`,
`GENERAL_RATE_LIMIT`) MUST be confirmed, or caveated unconfirmed with
reason.

#### Scenario: Access available

- GIVEN Cloudflare deploy-state access is available
- WHEN the two fixes are checked
- THEN the report MUST state their confirmed live status

#### Scenario: Access unavailable

- GIVEN deploy-state access is unavailable
- WHEN the report is finalized
- THEN it MUST caveat both unconfirmed with the blocker, not claim closure

### Requirement: Scope Disclosure Honesty

The report MUST enumerate external-audit workstreams out of reach (crypto
formal proof, black-box pentest, Cloudflare account/MFA review, SBOM/CVE
scan, compliance). MUST NOT imply coverage not performed.

#### Scenario: Out-of-scope workstream listed

- GIVEN the report is complete
- WHEN checked for crypto formal-proof coverage
- THEN it MUST list it as out-of-reach, not omit it silently

#### Scenario: Overclaim attempt

- GIVEN a draft implies "full security audit"
- WHEN reviewed for accuracy
- THEN it MUST name only what was reviewed

### Requirement: Admin Surface First-Pass Coverage

`packages/admin`'s RPC-level authorization MUST get first-pass tracing
against `packages/core`'s server-side role checks (previously unaudited).

#### Scenario: Admin RPC traced

- GIVEN an admin RPC method in `packages/admin/src`
- WHEN the review executes
- THEN it MUST trace to the matching role check in `packages/core`

#### Scenario: RPC with no server-side check found

- GIVEN an admin RPC has no matching authorization check
- WHEN discovered during tracing
- THEN it MUST be reported as a finding

### Requirement: Remediation Completion Bar

At close, in-scope surfaces MUST have zero unaddressed CRITICAL/HIGH
findings: each fixed-and-verified, or disclosed as accepted/deferred risk
with a compensating-control rationale.

#### Scenario: Critical finding fixed

- GIVEN a CRITICAL finding is confirmed
- WHEN remediation completes
- THEN it MUST be marked fixed-and-verified before close

#### Scenario: Critical finding infeasible to fix

- GIVEN a CRITICAL finding needs out-of-reach infra access
- WHEN it cannot be fixed in-scope
- THEN it MUST be disclosed with a compensating-control rationale

### Requirement: Fix Verification Rigor

Every fix MUST be verified via the package's real `tsc` gate, existing
tests, and a smoke test where feasible, before being marked done; "should
work" MUST NOT count as done.

#### Scenario: Fix verified end-to-end

- GIVEN a fix applied to `packages/worker`
- WHEN marked done
- THEN it MUST pass the package's `tsc --skipLibCheck`, tests, and a smoke test if feasible

#### Scenario: Fix verified by inspection only

- GIVEN a fix compiles but was never tested or smoke-tested
- WHEN status is reported
- THEN it MUST stay "pending verification", not "done"

### Requirement: Dependency Vulnerability Disclosure

Every in-scope package (`packages/server`, `packages/admin`, `packages/worker`,
`packages/app`) MUST have its dependency vulnerability scan run and its
results disclosed with severity counts (CRITICAL/HIGH/MEDIUM/LOW). Every
CRITICAL or HIGH finding MUST be either remediated — version bump plus
re-verification via the package's `tsc` gate and tests — or explicitly
risk-accepted with an exploitability analysis citing the actual codebase
usage pattern of the vulnerable dependency, not a bare "not exploitable"
assertion.

#### Scenario: CRITICAL finding remediated

- GIVEN `npm audit` reports a CRITICAL finding in `@simplewebauthn/server`
- WHEN the fix is applied
- THEN the dependency MUST be bumped past the vulnerable range
- AND the package MUST pass its `tsc` gate and existing tests afterward

#### Scenario: CRITICAL finding risk-accepted instead of fixed

- GIVEN a CRITICAL/HIGH finding exists in a transitive dependency
  (e.g. `drizzle-orm`, `http-server`) that cannot be bumped in-scope
- WHEN the finding is disclosed instead of fixed
- THEN the report MUST include an exploitability analysis tracing the
  actual call path or usage pattern in this codebase
- AND it MUST NOT be closed with an unsupported "not exploitable" claim

#### Scenario: Scan not run for an in-scope package

- GIVEN a package is listed as in-scope
- WHEN the Round 2 report is compiled
- THEN a missing or skipped vulnerability scan MUST be treated as
  incomplete, not silently omitted

### Requirement: Session Lifecycle Integrity

The system MUST server-side-invalidate the affected session(s) on logout
and on full-account-recovery. A credential change (password or verifier
update via `updateAuth()`) MUST additionally revoke all OTHER active
sessions for that account, preserving the session that performed the
change so the requesting user is not logged out by their own action.

#### Scenario: Logout invalidates the session

- GIVEN an authenticated session
- WHEN the user logs out
- THEN that session MUST be invalidated server-side and rejected on reuse

#### Scenario: Account recovery invalidates prior sessions

- GIVEN an account completes full recovery
- WHEN recovery finishes
- THEN all sessions predating recovery MUST be invalidated server-side

#### Scenario: Password change revokes other sessions, keeps current

- GIVEN an account has two active sessions, A (current) and B
- WHEN the user changes their password via session A
- THEN session B MUST be revoked and rejected on its next request
- AND session A MUST remain valid

#### Scenario: Password change with only one active session

- GIVEN an account has a single active session
- WHEN the user changes their password
- THEN that session MUST remain valid
- AND no unrelated session MUST be revoked