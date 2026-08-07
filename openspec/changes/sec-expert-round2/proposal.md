# Proposal: Sec-Expert Round 2 — Dependency, Crash-Resilience, and Session-Lifecycle Hardening

## Intent

Round 1 (`archive/2026-08-06-sec-expert`) closed 3 CRITICAL + 5 HIGH + most MEDIUM/LOW findings but never ran `npm audit`, never scanned for secrets, and left `unhandledRejection` deferred. This round executed those gaps end-to-end and found three real, evidence-backed problems worth fixing now: 4 CRITICAL `npm audit` findings in the WebAuthn MFA verification chain, a reachable unhandled-rejection crash source in the HTTP transport, and a missing OWASP control (no session revocation on password change). Four other areas came back clean and only need write-up.

## Scope

### In Scope
- `packages/server/src/transport/http.ts`: wrap the entire `createServer` callback body in `try/catch` (currently only the `POST` branch is guarded).
- `packages/server/src/init.ts`: add `process.on("unhandledRejection", ...)` — log + best-effort admin email, no `process.exit()` (avoid turning a missed `.catch()` into a remote single-request DoS).
- `packages/core/src/server.ts`'s `updateAuth()`: revoke all other sessions on verifier change (password change). MFA enrollment/removal is accepted-risk (additive, not compromise-recovery).
- Dependency bumps, priority order: `@simplewebauthn/server` 5.4.3→13.x (server, closes 4 CRITICALs via elliptic/jsrsasign, needs `webauthn.ts` re-verification against new API), `nodemailer` 6.6.1→6.10.x (server), `@aws-sdk/client-s3` family (server, non-major), `diff` 5.1.0→5.2.x (admin, non-major).
- Round 2 report documentation: dependency scan (full table), secret scan (clean), `packages/admin` re-review (no new findings), `packages/pwa` re-review (no new findings), CSRF posture (resistant by construction).

### Out of Scope
- Re-opening any Round 1 finding.
- Session revocation on MFA enrollment/removal (documented accepted-risk).
- Forcing `drizzle-orm` (worker) or `http-server`'s transitive chain (app) to major versions — confirmed not exploitable here; documented as accepted-risk instead.

## Capabilities

### New Capabilities
None.

### Modified Capabilities
- `security-baseline`: extends the acceptance bar with dependency-vulnerability closure and session-lifecycle requirements not previously specified.

## Approach

Fix-what's-actionable, disclose-what-isn't: 3 code changes plus prioritized dependency bumps go through `sdd-apply`; the 4 clean-scan areas are written up in the Round 2 report with no code change. Same topic-branch/no-PR delivery as Round 1.

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `packages/server/src/transport/http.ts` | Modified | Whole-callback try/catch |
| `packages/server/src/init.ts` | Modified | `unhandledRejection` handler |
| `packages/core/src/server.ts` | Modified | Revoke other sessions on password change |
| `packages/server/package.json` | Modified | 4 dependency bumps |
| `packages/admin/package.json` | Modified | `diff` bump |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| `@simplewebauthn/server` 5→13 major bump breaks WebAuthn MFA API surface | Medium | Re-verify `webauthn.ts` integration against new API; tsc + tests before merge |
| Password-change session revocation logs out the requesting user's own session | Low | Design decision: current session survives (matches common product UX); confirm in `sdd-design` |
| `unhandledRejection` handler pattern-matched back into `process.exit()` later | Low | Inline rationale comment documenting the deliberate divergence |

## Rollback Plan

Same as Round 1: work stays on the dedicated topic branch with no PR opened until explicitly approved; revert via `git revert` or discard the branch pre-merge.

## Dependencies

- None external; all fixes are within-repo.

## Success Criteria

- [ ] All 4 CRITICAL `npm audit` findings (server) closed or explicitly risk-accepted with rationale
- [ ] `http.ts`'s unhandled-rejection gap closed (whole-callback try/catch)
- [ ] `unhandledRejection` process handler added with documented no-exit rationale
- [ ] Password-change flow revokes all other sessions
- [ ] Every fix verified via real `tsc` + tests, not "should work"
- [ ] Round 2 report documents the 4 clean-scan areas (secrets, admin, pwa, CSRF)
