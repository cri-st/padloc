# Design: Supply-Chain & Compliance Audit + Remediation

## Technical Approach

Two-part, mirroring `security-baseline`'s Round 1 pattern.

**Part 1 — Audit**: run real tooling (`npm sbom`, `license-checker`) across
all 7 packages (`worker`, `server`, `core`, `app`, `pwa`, `extension`,
`admin`); trace compliance code paths; produce one combined
`findings-register.md` with file:line/command-output citations per
`supply-chain-compliance-baseline` Req. 1–3.

**Part 2 — Remediation**: 4 grounded fixes below, each verified per
`padloc-fix-verification-gotchas` (real `tsc`, real tests, no "should work").

## Architecture Decisions

| # | Decision | Choice | Rejected alternative | Rationale |
|---|---|---|---|---|
| 1 | Attachment cascade-delete | `deleteAccount()` (`server.ts:1289`) calls `attachmentStorage.deleteAll(account.mainVault.id)` before `storage.delete(Vault…)` at line 1315; `deleteOrg()` (`server.ts:1671`) calls it per `org.vaults` entry before the `Promise.all` delete at line 1681. No try/catch — errors propagate and abort deletion. | Swallow attachment-delete errors and continue; or a separate cleanup job. | `deleteVault()` (`server.ts:1873-1874`) **already calls this exact method** before removing the vault — established pattern, not new. Propagating errors matches that precedent: a failed blob delete must not silently orphan attachments while the account/org record disappears. `AttachmentStorage.deleteAll` (`attachment.ts:196`) is already safely implemented by R2/S3/FS backends. |
| 2 | Retention cron | New `scheduled(event, env, ctx)` export beside `fetch` in `worker/src/index.ts:157`'s `export default {}`. New `env.LOG_RETENTION_DAYS?: string`, parsed via the existing `safeParsePositiveNumber` helper (`index.ts:22`), default `90`. Runs `DELETE FROM request_log/change_log WHERE timestamp < ?`, cutoff = `now - days*86400000`, directly against `env.DB`. Registered via `[triggers]\ncrons = [...]` in `wrangler.toml`. | `@padloc/core` `@ConfigParam`-decorated config class; or routing retention through `createServer()`/`Server`. | Worker never uses the `ConfigParam` pattern (only `packages/server`'s `ServerConfig` does — no `config.ts` exists in worker). Plain `Env` vars match existing convention (`RATE_LIMIT_MAX_REQUESTS`, `SIGNUP_RESTRICT`). `scheduled()` has no per-request auth context `Server` needs; a direct `env.DB` delete shares no mutable state with `fetch()`'s bindings. |
| 3 | `trusted-types`/`dompurify` | Pin `@types/trusted-types` to `2.0.7` as devDependency in `packages/app/package.json` (and `pwa/package.json` if independently stale). | Downgrade `dompurify` to a pre-3.x release. | Verified live: `dompurify@3.4.13` requires `@types/trusted-types@^2.0.7`; both `app` and `pwa` `node_modules` copies are stuck at `2.0.2` (fails `npm sbom`'s strict resolution). `2.0.7` is the latest published 2.x release — satisfies the range, and it's type-only (no runtime code), zero regression surface. Downgrading `dompurify` was rejected: no in-repo test proves 2.x/3.x sanitization parity and it discards later fixes — strictly higher risk. |
| 4 | CI SHA-pinning | Resolve each of the 5 actions' current tag to its release-tag commit SHA via the action repo's public GitHub Releases (no auth), pin as `uses: owner/repo@<sha> # vX.Y.Z`. | Dependabot/Renovate auto-pinning bot. | Bot setup is new recurring infra, out of this change's mechanical scope. Same-major-version SHA keeps behavior identical; trailing comment preserves readability. Post-edit, parse-validate the YAML (only CI pipeline — a syntax break kills all future builds). |

## Data Flow

    Cascade-delete:
    deleteAccount()/deleteOrg() ──▶ attachmentStorage.deleteAll(vaultId) [R2/S3/FS] ──▶ storage.delete(Vault) ──▶ storage.delete(Account/Org)

    Retention cron:
    Cron Trigger ──▶ scheduled(event, env, ctx) ──▶ env.DB DELETE WHERE timestamp < cutoff ──▶ request_log / change_log truncated
    (fetch() handler: separate export, untouched, same read-only Env bindings)

## File Changes

| File | Action | Description |
|---|---|---|
| `packages/core/src/server.ts` | Modify | Cascade-delete attachments in `deleteAccount()`/`deleteOrg()` |
| `packages/worker/src/index.ts` | Modify | Add `scheduled()` export |
| `packages/worker/src/env.ts` | Modify | Add `LOG_RETENTION_DAYS?: string` |
| `packages/worker/wrangler.toml` | Modify | Add `[triggers]` cron schedule |
| `packages/app/package.json` | Modify | Pin `@types/trusted-types` to `2.0.7` |
| `packages/pwa/package.json` | Modify (conditional) | Same pin if independently stale |
| `.github/workflows/docker-publish.yml` | Modify | SHA-pin 5 actions |
| `openspec/changes/supply-chain-compliance-audit/findings-register.md` | Create | Combined findings |

## Testing Strategy

| Layer | What | Approach |
|---|---|---|
| Type-check | `core`, `worker` | Per-package `tsc --noEmit` |
| Integration | Cascade-delete | Create account+vault+item+attachment via `MemoryAttachmentStorage`, call `deleteAccount()`, assert `attachmentStorage.get()` now throws `NOT_FOUND` |
| Integration | Retention cron | `wrangler dev --test-scheduled` (or Miniflare trigger): seed aged + fresh rows, invoke `scheduled()`, assert aged gone/fresh retained, `fetch()` still 200s after |
| SBOM | `app`, `pwa` | Re-run `npm sbom`, confirm exit 0, no peer-resolution failure |
| CI | `docker-publish.yml` | YAML parse-validate post-edit |

## Threat Matrix

N/A for all 5 rows. `scheduled()` is a Cron Trigger invoking Worker code directly — no shell, subprocess, or VCS/PR automation added. `docker-publish.yml` only changes `uses:` refs — no new commands. Documentation-path/Git-selection/commit-state/push-state/PR-command rows: all N/A, no such boundary touched.

## Migration / Rollout

First cron run truncates immediately past the 90-day window — no grace period. `request_log`/`change_log` are audit-trail-only, no legal minimum-retention found in this codebase; `schema.ts` already flags this as overdue ("T26"). The delete is idempotent and low-risk (append-only, non-user-facing), so no dry-run/backfill flag is needed.

## Open Questions

None — all 4 ADRs are grounded in actual code. Remaining unknowns (license-mismatch legal determination) belong to the findings register and are already flagged out-of-scope in the proposal.
