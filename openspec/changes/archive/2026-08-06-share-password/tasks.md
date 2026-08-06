# Tasks: One-Time, Expiring Password Share Links

## Review Workload Forecast

Estimated changed lines: 900-1300 (13 files, core+worker+app).

Decision needed before apply: No
Chained PRs recommended: Yes
Chain strategy: size-exception
400-line budget risk: High

### Suggested Work Units

| Unit | Goal | Likely PR | Focused test command | Runtime harness | Rollback boundary |
|------|------|-----------|----------------------|-----------------|-------------------|
| 1 | Core types + ShareLinkDO | N/A | `npm test -w packages/worker` | `wrangler dev` | revert new files |
| 2 | RPC handlers + rate limit | N/A | `npm test -w packages/core` | `wrangler dev` | revert `api.ts`/`server.ts` |
| 3 | Client UI | N/A | `npm test -w packages/app` | manual dev build | revert new files |

## Phase 1: Foundation - Core Types & Config

- [x] 1.1 Create `core/share.ts`: `ShareID`, `CreateShareParams`, `ShareLinkInfo`, `ShareData`, `ShareStatus`, `ShareStorage`. (Contracts)
- [x] 1.2 `server.ts` `ServerConfig`: add `shareLinkMaxTtlSeconds`. (Req: TTL max)
- [x] 1.3 `worker/env.ts`: add `SHARE_LINKS?: DurableObjectNamespace`.
- [x] 1.4 `worker/wrangler.toml`: `new_sqlite_classes=["ShareLinkDO"]` migration + `SHARE_LINKS` binding.

## Phase 2: ShareLinkDO & Storage (TDD)

- [x] 2.1 RED: `ShareLinkDO` test — concurrent reveal (2 simultaneous -> 1 success) + alarm-driven expiry (post-TTL -> "expired"). (Req: Concurrent reveal race, Reveal after expiry)
- [x] 2.2 GREEN: `worker/durable-objects/share-link.ts` (SQLite, `create/peek/reveal/getStatus/revoke`, atomic flip, `alarm()` expiry) passes 2.1.
- [x] 2.3 REFACTOR: extract SQL helpers/schema in `share-link.ts`.
- [x] 2.4 Create `worker/storage/share-do-storage.ts`: `DurableObjectShareStorage implements ShareStorage`.

## Phase 3: RPC Handlers (TDD)

- [x] 3.1 RED: extend `server.spec.ts`-style test: create/status/revoke reject unauthed; peek/reveal work anon. (Req: Auth, Revocation)
- [x] 3.2 GREEN: `@Handler` methods in `core/api.ts`: `createShare`, `peekShare`, `revealShare`, `getShareStatus`, `revokeShare`.
- [x] 3.3 GREEN: `Controller` bodies in `server.ts`; `_requireAuth` for create/status/revoke; `Server` ctor gains `shareStorage`. (Req: Revocation, View Receipt)
- [x] 3.4 REFACTOR: dedupe TTL-cap validation and expired/viewed/not-found error mapping.

## Phase 4: Worker Wiring & Rate Limit

- [x] 4.1 `worker/index.ts`: export `ShareLinkDO`; add 2nd `RateLimiter` keyed `share-view:${ip}`.
- [x] 4.2 RED: rate-limit test, rapid `revealShare` guesses, per-share/per-IP caps. (Req: Rate Limiting)
- [x] 4.3 GREEN: wire rate-limit check into `revealShare`/`peekShare`.
- [x] 4.4 `worker/server-factory.ts`: instantiate `DurableObjectShareStorage`, inject into `createServer`.

## Phase 5: Client UI

- [x] 5.1 `app/item-view.ts`: add "Share Link ..." action, enabled only for `FieldType.Password` items. (Req: Item-Type Scope)
- [x] 5.2 RED: fragment-key encode/decode test (`#k=base64url(key)`) + Login-item heuristic.
- [x] 5.3 GREEN: `app/share-dialog.ts` (`Dialog<VaultItem, void>`, TTL `pl-select`, `SimpleContainer` encrypt, `pl-clipboard` copy) passes 5.2.
- [x] 5.4 GREEN: `app/share-view.ts`: anon pre-auth page, `peekShare` on connect (no burn), Reveal calls `revealShare`.
- [x] 5.5 REFACTOR: shared fragment-key parsing util; confirm `routing.ts` ignores hash.
- [x] 5.6 `app/app.ts`: register `"share"` page, pre-auth allow-list, exclude from `unlocked` gate.

## Phase 6: Testing - Integration & E2E

- [x] 6.1 Integration test: create->peek->reveal->already-viewed vs `wrangler dev --local`; verify GET load never burns view. (Req: Reveal, Lifecycle, Page load)
- [x] 6.2 Manual/Playwright E2E: create->copy->anon->reveal once->2nd fails. (Success Criteria)

## Phase 7: Cleanup

- [x] 7.1 Update docs/comments for new `ServerConfig`/`SHARE_LINKS` config; remove temporary debug logging added while developing `ShareLinkDO`.
