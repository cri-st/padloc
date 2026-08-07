# Supply-Chain & Compliance Baseline Specification

## Purpose

Acceptance bar for padloc's supply-chain (SBOM, license, pipeline) and
compliance (retention, deletion, audit-trail) findings + remediation;
follow-up to `sec-expert`'s `security-baseline`. New capability, no
prior spec to delta.

## Requirements

### Requirement: Real Tool Output Required

SBOM generation (`npm sbom`) and license inventory (`license-checker`)
MUST run per package; findings MUST cite real output, not estimates.

#### Scenario: SBOM cited from real output

- GIVEN `npm sbom` runs on `packages/worker`
- WHEN a finding references its dependency tree
- THEN it MUST cite the actual output, not an assumed list

#### Scenario: Tool output unavailable

- GIVEN `npm sbom` fails for a package
- WHEN the register is compiled
- THEN that package MUST be reported blocked with the exact error

### Requirement: Evidence-Backed Findings

Every finding MUST cite file:line or a reproducible command plus
output, severity-first where a severity applies.

#### Scenario: Well-formed finding

- GIVEN a retention gap confirmed in `storage/schema.ts`
- WHEN added to the register
- THEN it MUST cite file:line or the command/output confirming it

#### Scenario: Finding lacking evidence

- GIVEN a candidate lacking file:line or a reproducible command
- WHEN prepared for the register
- THEN it MUST NOT be listed until evidence exists

### Requirement: Scope Disclosure Honesty

The register MUST distinguish code-verifiable evidence from
legal/business judgment calls (license interpretation, GDPR sign-off)
and MUST NOT imply formal compliance certification.

#### Scenario: Legal judgment call flagged

- GIVEN an AGPL-vs-GPL-3.0 license mismatch is discovered
- WHEN recorded
- THEN it MUST be labeled a legal determination, not silently resolved

#### Scenario: Overclaim attempt

- GIVEN a draft implies "GDPR compliance verified"
- WHEN reviewed
- THEN it MUST be corrected to name only what was code-verified

### Requirement: Attachment Cascade-Delete Completeness

`deleteAccount()`/`deleteOrg()` MUST delete every attachment
referenced by items in the deleted vault(s), leaving none orphaned.

#### Scenario: Account deletion removes attachments

- GIVEN a vault with an item holding an attachment
- WHEN `deleteAccount()` is called
- THEN the attachment MUST be removed with the vault

#### Scenario: Org deletion with multiple vaults

- GIVEN an org with several vaults holding attachments across items
- WHEN `deleteOrg()` is called
- THEN every attachment across every deleted vault MUST be removed

### Requirement: Log Retention Enforcement

Request/change logs MUST be truncated past a configurable retention
window via a scheduled mechanism, not a comment.

#### Scenario: Scheduled truncation runs

- GIVEN log rows older than the retention window exist
- WHEN the scheduled mechanism fires
- THEN those rows MUST be deleted; in-window rows MUST remain

#### Scenario: Mechanism not wired to a scheduler

- GIVEN truncation logic exists only as a code comment
- WHEN retention is verified
- THEN it MUST be reported not implemented

### Requirement: SBOM Completeness Across All In-Scope Packages

SBOM generation MUST succeed for every in-scope package (`worker`,
`server`, `core`, `app`, `pwa`, `extension`, `admin`). A failing
package MUST have its blocker fixed, not excluded.

#### Scenario: Blocked package fixed

- GIVEN `npm sbom` fails for `packages/app` on a dependency conflict
- WHEN remediation completes
- THEN the conflict MUST be resolved and `npm sbom` MUST succeed

#### Scenario: Package silently dropped

- GIVEN a package's SBOM generation fails and stays unaddressed
- WHEN the register is finalized
- THEN this MUST be treated as incomplete

### Requirement: Fix Verification Rigor

Every code fix (cascade-delete, retention cron, SBOM unblock, CI
pinning) MUST pass the package's `tsc` gate, tests, and a live/local
exercise. "Should work" MUST NOT count as verified.

#### Scenario: Fix verified end-to-end

- GIVEN the cascade-delete fix is applied to `packages/core`
- WHEN marked done
- THEN it MUST pass `tsc`, tests, and confirm attachment deletion with the account

#### Scenario: Fix verified by inspection only

- GIVEN a fix compiles but was never exercised
- WHEN status is reported
- THEN it MUST stay "pending verification"
