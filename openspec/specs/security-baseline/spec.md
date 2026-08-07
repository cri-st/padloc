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