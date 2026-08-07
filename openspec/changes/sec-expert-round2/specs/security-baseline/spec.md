# Delta for Security Baseline

## ADDED Requirements

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
