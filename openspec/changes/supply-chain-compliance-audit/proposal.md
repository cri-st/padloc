# Proposal: Supply-Chain & Compliance Audit + Remediation

## Intent

Follow-up to `sec-expert`, which excluded supply-chain (SBOM, license,
pipeline integrity) and compliance (GDPR-style data/retention/DSR
posture) coverage. Produces an evidence-based findings register — real
`npm sbom`/`license-checker` output plus file:line citations — for a real
compliance/legal review, not a substitute. Also fixes the three concrete,
low-risk code gaps found, since they're real defects independent of any
legal judgment.

## Scope

### In Scope
- Findings register: supply-chain (SBOM/package, license inventory,
  CI/Dockerfile pinning, dependency-update tooling gap) and compliance
  (personal-data inventory, DSR/deletion gap, retention gap, encryption
  posture, audit-trail coverage, legal-artifact absence) for `worker`,
  `server`, `core`, `app`, `pwa`, `extension`, `admin`.
- Fix: `deleteAccount()`/`deleteOrg()` (`server.ts`) never delete
  attachments referenced by deleted vaults — add cascade deletion
  mirroring the client path (`app.ts:1663-1664`).
- Fix: implement the T26 retention cron — `scheduled()` handler +
  `wrangler.toml` `[triggers]` truncating `request_log`/`change_log` past
  a configurable window (`storage/schema.ts`).
- Fix: resolve the `app`/`pwa` `npm sbom` blocker
  (`@types/trusted-types@2.0.2` vs. `dompurify@3.4.13`'s `^2.0.7`
  requirement).
- Fix (mechanical, low-risk): SHA-pin the 5 GitHub Actions in
  `docker-publish.yml` (tag-pinned today) — same-behavior diff; safe
  since it's the only CI pipeline.

### Out of Scope (documented, not resolved)
- AGPL-vs-`GPL-3.0` license mismatch — a legal determination, not a code
  fix; surfaced prominently, never silently changed.
- `nginx/Dockerfile` modernization (stale `nginx:1.21`/Debian `stretch`,
  deprecated `apt-key`) — self-hosted-only, zero CI/test coverage; a bump
  risks breaking that path blind. Documented as a recommendation only.
- Image signing/attestation, CI provenance, data residency, vendor risk
  (Cloudflare, Resend), and drafting a privacy policy/ToS/DPA — out of
  AI-agent reach (no live account access, no legal authority).

## Capabilities

### New Capabilities
- `supply-chain-compliance-baseline`: acceptance bar — real tool output
  required, file:line evidence, fix-verification rigor, and Scope
  Disclosure Honesty mirroring `security-baseline` Req. 4 (never imply a
  GDPR/SOC2/ISO27001 sign-off).

### Modified Capabilities
None.

## Approach

Single combined findings register (exploration's Approach 2), then
remediation for the 3 fixes plus CI SHA-pinning. Cascade-delete and
retention-cron get real `tsc`/test verification per
`padloc-fix-verification-gotchas`; the SBOM fix is a dependency-tree
correction verified by a clean `npm sbom` re-run.

## Affected Areas

| Area | Impact | Description |
|---|---|---|
| `packages/core/src/server.ts` | Modified | Attachment cascade-delete in `deleteAccount`/`deleteOrg` |
| `packages/worker/src/storage/schema.ts`, `wrangler.toml`, new `scheduled()` handler | New | T26 retention cron |
| `packages/app/package.json`, `packages/pwa/package.json` | Modified | `trusted-types`/`dompurify` dependency fix |
| `.github/workflows/docker-publish.yml` | Modified | SHA-pin 5 actions |
| `openspec/specs/supply-chain-compliance-baseline/spec.md` | New | Audit acceptance bar |

## Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| Cascade-delete touches destructive, hard-to-reverse account/org deletion | Med | Real tests covering attachment presence pre/post delete; no live prod data touched |
| New `scheduled()` handler is untested Worker surface | Med | Local wrangler test + verify handler is inert until cron fires |
| `trusted-types`/`dompurify` version fix regresses sanitization | Low | Re-run `tsc`/build, confirm sanitizer behavior unchanged |
| SHA-pinning breaks CI if the wrong SHA is captured | Low | Verify each SHA against the action's published release tag before commit |

## Rollback Plan

New topic branch off current `main` (not the archived
`security/sec-expert-remediation` branch); no direct-`main` commits. Each
fix is an isolated, revertable commit; findings are additive docs with no
rollback risk.

## Dependencies

None external; builds on `sec-expert`'s `security-baseline` spec pattern.

## Success Criteria

- [x] Findings register complete for both domains, every finding evidence-backed (file:line or reproducible command output) — 19 findings (`S1`-`S9`, `C1`-`C8`, `L1`-`L2`) in `findings-register.md`, each with file:line or command+output citations; verified requirement-by-requirement against `supply-chain-compliance-baseline` spec in Phase 6.
- [x] All 3 code fixes applied, tested, and verified — not "should work" (register actually delivered 4: `C1` cascade-delete, `C2` retention cron, `S1` SBOM unblock, `S5` CI SHA-pinning — see the Scope section's 4th "Fix" bullet above; this line's "3" undercounts the Scope section by one, a pre-existing wording slip in this proposal, not a shortfall — all 4 have commit SHAs plus `tsc`/test/live-exercise evidence in the register, none inspection-only)
- [x] License mismatch and nginx modernization explicitly documented, never silently resolved — `L1`/`L2` in `findings-register.md`, labeled `OUT OF SCOPE — legal/business judgment`, not code-changed
