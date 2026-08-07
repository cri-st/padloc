# Tasks: Supply-Chain & Compliance Audit + Remediation

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Estimated changed lines | ~180-260 (code ~90-140; register excluded) |
| 400-line budget risk | Low |
| Chained PRs recommended | No |
| Suggested split | Single branch |
| Delivery strategy | single-pr |
| Chain strategy | size-exception |

Decision needed before apply: Yes
Chained PRs recommended: No
Chain strategy: size-exception
400-line budget risk: Low

### Suggested Work Units

| Unit | Goal | Focused test | Runtime harness | Rollback boundary |
|------|------|---------------|-----------------|-------------------|
| 1 | Findings register | N/A (docs) | `npm sbom`/`license-checker` | Delete `findings-register.md` |
| 2 | 4 code fixes | `tsc --noEmit` + exercises | See Ph.2-5 | Each fix own commit |

## Phase 1: Audit Tooling + Findings Register

- [x] 1.1 Confirm/re-run `npm sbom` for worker/server/core/app/pwa/extension/admin (reuse if unchanged).
- [x] 1.2 Confirm/re-run `license-checker` per package; flag licenses outside MIT/Apache-2.0/BSD/ISC.
- [x] 1.3 Write `findings-register.md` supply-chain section: SBOM/license inventory, CI/Dockerfile pinning gap, dependency-update tooling gap — file:line/output citations.
- [x] 1.4 Add compliance section: personal-data inventory, DSR/deletion gap, retention gap, encryption posture, audit-trail coverage, legal-artifact absence — file:line citations.
- [x] 1.5 Label AGPL-vs-GPL-3.0 mismatch and `nginx/Dockerfile` modernization as legal/business judgment calls, not silently resolved.
- [x] 1.6 Mark any failing `npm sbom` package blocked with exact error.

## Phase 2: Attachment Cascade-Delete Fix (ADR 1)

- [x] 2.1 `core/src/server.ts` `deleteAccount()`: add `attachmentStorage.deleteAll(account.mainVault.id)` before `storage.delete(Vault…)` (line 1315), mirroring `deleteVault()`.
- [x] 2.2 `deleteOrg()`: add `attachmentStorage.deleteAll(...)` per `org.vaults` entry before `Promise.all` delete (line 1681); no try/catch.
- [x] 2.3 Add `core` test: attachment via `MemoryAttachmentStorage` → `deleteAccount()` → `attachmentStorage.get()` throws `NOT_FOUND`; repeat `deleteOrg()` multi-vault.
- [x] 2.4 Run `core` `tsc --noEmit` + tests.

## Phase 3: Retention Cron Fix (ADR 2)

- [x] 3.1 Add `LOG_RETENTION_DAYS?: string` to `worker/src/env.ts` `Env`, beside `RATE_LIMIT_MAX_REQUESTS`.
- [x] 3.2 Add `scheduled(event, env, ctx)` in `worker/src/index.ts:157`; cutoff via `safeParsePositiveNumber` (default 90); `DELETE FROM request_log/change_log WHERE timestamp < ?` on `env.DB`.
- [x] 3.3 Add `[triggers]\ncrons = [...]` to `worker/wrangler.toml`.
- [x] 3.4 Run `worker` `tsc --noEmit`.
- [x] 3.5 `wrangler dev --test-scheduled`: seed aged+fresh rows, invoke `scheduled()`, assert aged gone/fresh retained, `fetch()` still 200s.

## Phase 4: SBOM Unblock Fix (ADR 3)

- [x] 4.1 Pin `@types/trusted-types` to `2.0.7` (devDependency) in `app/package.json`.
- [x] 4.2 Apply same pin to `pwa/package.json` if independently stale.
- [x] 4.3 Re-run `npm sbom` for `app`/`pwa`; confirm exit 0.
- [x] 4.4 Run `app`/`pwa` `tsc --noEmit`/build; confirm no sanitizer regression.

## Phase 5: CI SHA-Pinning Fix (ADR 4)

- [x] 5.1 Resolve release-tag SHAs for `actions/checkout@v4`, `docker/setup-buildx-action@v3`, `docker/login-action@v3`, `docker/metadata-action@v5`, `docker/build-push-action@v6`.
- [x] 5.2 Edit `.github/workflows/docker-publish.yml`: each `uses: <tag>` → `uses: owner/repo@<sha> # vX.Y.Z`.
- [x] 5.3 Parse-validate YAML post-edit — only CI pipeline.

## Phase 6: Final Report + Handoff

- [x] 6.1 Update register fix-status rows to FIXED with commit SHA.
- [x] 6.2 Verify all `supply-chain-compliance-baseline` requirement scenarios are satisfiable.
- [x] 6.3 Confirm proposal Success Criteria checked; hand off to `sdd-verify`.
