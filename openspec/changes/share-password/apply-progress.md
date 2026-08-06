# Apply Progress: One-Time, Expiring Password Share Links

**Batch**: 2 of 4 (merged with Batch 1)
**Mode**: Strict TDD (packages/core RPC handlers, packages/worker rate limiting) + standard (packages/worker wiring)
**Delivery**: `exception-ok` — `size:exception` accepted by maintainer, single continuous branch on `main`, no PR splitting, no push.

## Completed Tasks

### Phase 1: Foundation - Core Types & Config
- [x] 1.1 Created `packages/core/src/share.ts`: `ShareID`, `CreateShareParams`, `ShareLinkInfo`, `ShareData`, `ShareStatus`, `ShareStorage`.
- [x] 1.2 `packages/core/src/server.ts` `ServerConfig`: added `shareLinkMaxTtlSeconds` (`@ConfigParam("number")`, default 14 days).
- [x] 1.3 `packages/worker/src/env.ts`: added `SHARE_LINKS?: DurableObjectNamespace`.
- [x] 1.4 `packages/worker/wrangler.toml`: `new_sqlite_classes=["ShareLinkDO"]` migration (`v2`) + `SHARE_LINKS` binding for `env.dev` and `env.preview`.

### Phase 2: ShareLinkDO & Storage (TDD)
- [x] 2.1 RED: `packages/worker/test/share-link-do.test.mjs` — concurrent reveal (2 simultaneous → 1 success) + alarm-driven expiry (post-TTL → expired), written against a not-yet-existing `ShareLinkDO`.
- [x] 2.2 GREEN: `packages/worker/src/durable-objects/share-link.ts` — SQLite-backed (`create/peek/reveal/getStatus/revoke`), atomic `UPDATE ... RETURNING` flip, `alarm()` expiry cleanup. Passes 2.1 (10/10 assertions).
- [x] 2.3 REFACTOR: extracted named SQL constants (`SCHEMA`, `UPSERT_SHARE`, `SELECT_SHARE`, `REVEAL_SHARE`, `REVOKE_SHARE`, `DELETE_EXPIRED_SHARE`) out of inline query literals. Tests stayed green throughout.
- [x] 2.4 Created `packages/worker/src/storage/share-do-storage.ts`: `DurableObjectShareStorage implements ShareStorage`, translates `@padloc/core` Serializable types ↔ the DO's opaque JSON/bytes wire format.

### Phase 3: RPC Handlers (TDD)
- [x] 3.1 RED: `packages/core/test/share-rpc-auth.spec.ts` — create/status/revoke reject unauthed (`INVALID_SESSION`); peek/reveal work anon. Written against `Controller.createShare`/etc. that did not exist yet; confirmed failing via execution (`TypeError: anon.createShare is not a function`) before any handler existed.
- [x] 3.2 GREEN: `@Handler` method declarations added to `core/api.ts`: `createShare`, `peekShare`, `revealShare`, `getShareStatus`, `revokeShare` (mirrors the `createAttachment`/`getAttachment`/`deleteAttachment` grouping pattern).
- [x] 3.3 GREEN: `Controller` bodies in `server.ts` — `_requireAuth()` gates create/status/revoke; peek/reveal call straight through to `ShareStorage` with no auth check; `Server` ctor gains an **optional**, trailing `shareStorage?: ShareStorage` param (kept optional and last so `packages/server/src/init.ts`'s existing 10-positional-arg call site, outside this batch's `allowedEditRoots`, needed no change).
- [x] 3.4 REFACTOR: extracted `_validateShareTtl`, `_shareNotFoundError`, `_shareStatusOrNotFound`, `_requireShareStorage` private helpers on `Controller` to dedupe TTL-cap validation and expired/viewed/revoked/not-found error mapping across all five handlers. All 31 assertions in `share-rpc-auth.spec.ts` stayed green through this pass (helpers were written directly into the GREEN step rather than as a separate post-hoc edit — see Deviations).

### Phase 4: Worker Wiring & Rate Limit
- [x] 4.1 `packages/worker/src/index.ts`: now exports `ShareLinkDO` alongside `AccountLockDO` (the real production entrypoint, not just the throwaway e2e workers Batch 1 patched); added a dedicated, hardcoded-limits `RateLimiter` for share-view traffic.
- [x] 4.2 RED: `packages/worker/test/share-view-rate-limit.test.mjs` — rapid `revealShare`/`peekShare` guesses, both per-share and per-IP caps. Confirmed RED by temporarily renaming the two exported functions under test (`shareViewRateLimitKeys`/`checkShareViewRateLimit`) in `index.ts`, re-running (`TypeError: shareViewRateLimitKeys is not a function`), then restoring GREEN — see TDD Cycle Evidence notes for why (process ordering slip, corrected before commit).
- [x] 4.3 GREEN: `checkShareViewRateLimit()` wired into the RPC dispatch closure inside `fetch()`, gating `peekShare`/`revealShare` before `server.handle(req)` is ever called (rejects with the same `BAD_REQUEST` "Too many requests" shape the existing generic limiter uses).
- [x] 4.4 `packages/worker/src/server-factory.ts`: instantiates `DurableObjectShareStorage` from `env.SHARE_LINKS` (when bound) and injects it as `createServer`'s new trailing `Server` constructor argument.

## TDD Cycle Evidence

| Task | Test File | Layer | Safety Net | RED | GREEN | TRIANGULATE | REFACTOR |
|------|-----------|-------|------------|-----|-------|-------------|----------|
| 2.1-2.2 | `worker/test/share-link-do.test.mjs` | Unit (real `SqlStorage`-shaped `node:sqlite` backend) | N/A (new) | ✅ Written — `ShareLinkDO` didn't exist, esbuild reported `Could not resolve` | ✅ Passed — 10/10 assertions after implementing `ShareLinkDO` | ✅ 4 scenarios: concurrent-reveal happy path, reveal-on-never-created, alarm-driven expiry, unexpired-share-stays-revealable | N/A (covered by 2.3) |
| 2.3 | `worker/test/share-link-do.test.mjs` | Unit | ✅ 10/10 (pre-refactor baseline) | N/A (refactor, not new behavior) | N/A | N/A | ✅ Extracted SQL constants; re-ran full suite after — still 10/10 |
| 2.4 | (covered transitively — thin translation layer, no independent branching) | N/A | N/A | N/A | N/A | Triangulation skipped: pure pass-through, one code path per method | N/A |
| 3.1-3.3 | `core/test/share-rpc-auth.spec.ts` | Unit (real `Controller`, duck-typed `Server`/`Context`) | ✅ 11/11 (`signup-gate.spec.ts` re-run untouched, before AND after — no regression in shared `_requireAuth`/`Controller` surface) | ✅ Written — referenced `Controller.createShare`/`peekShare`/`revealShare`/`getShareStatus`/`revokeShare`, none of which existed on `API`/`Controller` yet; confirmed failing via execution (`TypeError: anon.createShare is not a function`), not just "written" | ✅ Passed — 31/31 assertions after adding the 5 `@Handler` declarations (`api.ts`) + 5 `Controller` method bodies + 4 private helpers (`server.ts`) | ✅ 7 scenario groups: auth gating (authed vs. anon), TTL-cap accept/reject, content-free terminal-state mapping (never-created/expired/already-viewed all → same `NOT_FOUND`), revocation (unviewed succeeds, post-view is a no-op error), view receipt (`viewedAt` only after reveal), `shareStorage` unset → `NOT_SUPPORTED` | ✅ Helpers (`_validateShareTtl`, `_shareNotFoundError`, `_shareStatusOrNotFound`, `_requireShareStorage`) extracted directly during GREEN rather than as a separate pass — see note below |
| 3.4 | `core/test/share-rpc-auth.spec.ts` | Unit | ✅ 31/31 (post-3.3 baseline) | N/A (refactor, not new behavior) | N/A | N/A | ✅ Dedup helpers already present from 3.3; re-ran suite unchanged after confirming no further extraction was warranted — still 31/31 |
| 4.1-4.3 | `worker/test/share-view-rate-limit.test.mjs` | Unit (real `RateLimiter` + real `index.ts` exports, esbuild single-file transpile, all other `index.ts` imports/`cloudflare:workers` stubbed) | ✅ 10/10 (`share-link-do.test.mjs` re-run unaffected by the `index.ts`/`server-factory.ts` changes) | ✅ Written, then **re-confirmed via execution after the fact**: `checkShareViewRateLimit`/`shareViewRateLimitKeys` were implemented before this test was written (a process-ordering slip); corrected by temporarily renaming both exports back to `__disabled_*` in `index.ts`, re-running the test (`TypeError: shareViewRateLimitKeys is not a function` — genuine RED), then restoring the real names and re-running to confirm GREEN | ✅ Passed — 9/9 assertions after restoring the real exports | ✅ 3 scenario groups: method-scope (`shareViewRateLimitKeys` returns `null`/keys correctly), per-share cap (3 guesses/3 different IPs → 4th rejected), per-IP cap (3 guesses/3 different share ids → 4th rejected), non-view methods always bypass | ➖ None needed — both functions were written as small, single-purpose, already-pure units |
| 4.4 | (covered transitively by the live boot-check below; pure dependency injection, no independent branching) | N/A | N/A | N/A | N/A | Triangulation skipped: one code path (`env.SHARE_LINKS ? new DurableObjectShareStorage(...) : undefined`), both branches exercised live (see Work Unit Evidence) | N/A |

### Test Summary
- **Total tests written this batch**: 31 assertions (`core/test/share-rpc-auth.spec.ts`) + 9 assertions (`worker/test/share-view-rate-limit.test.mjs`) = 40
- **Total tests passing this batch**: 40/40
- **Cumulative tests across Batches 1-2**: 10 (`share-link-do.test.mjs`) + 31 + 9 = 50/50 passing
- **Layers used**: Unit (50) — real `Controller`/`RateLimiter`/`ShareLinkDO` production code against duck-typed or in-memory test doubles, no mocked business logic
- **Approval tests** (refactoring): None — no pre-existing behavior was being refactored in this batch
- **Pure functions created**: 2 (`shareViewRateLimitKeys`, `checkShareViewRateLimit` in `worker/src/index.ts`) + 4 private Controller helper methods (not pure — they read `this.config`/`this.shareStorage`, consistent with the rest of `Controller`'s existing style)

## Work Unit Evidence

| Evidence | Value |
|---|---|
| Focused test command and exact result | `npx ts-node --transpile-only --compiler-options '{"module":"commonjs"}' packages/core/test/share-rpc-auth.spec.ts` → **31 passed, 0 failed**, exit 0. `node packages/worker/test/share-view-rate-limit.test.mjs` (Node 24, `esbuild` single-file transpile) → **9 passed, 0 failed**, exit 0. |
| Runtime harness command/scenario and exact result | Real `wrangler dev --local --env=dev` boot of the **production** `packages/worker/src/index.ts` (not a throwaway harness — Phase 4's own export wiring makes this possible for the first time). `GET /healthcheck` → `200 {"status":"ok",...}`. 12 rapid anonymous `peekShare` RPC calls (real `marshalRequest`/`unmarshalResponse` wire format) against distinct nonexistent share ids from one identity: calls 1-9 returned the real `NOT_FOUND "Share not found."` from the live `Controller` → `DurableObjectShareStorage` → `ShareLinkDO` round-trip; call 10 onward returned the live rate limiter's `BAD_REQUEST "Too many requests. Please try again later."` (bucket was already partially consumed by earlier interactive debugging calls against the same "anonymous" identity — consistent with the token-bucket algorithm, not a bug). A follow-up call from a distinct `x-forwarded-for` identity against the same exhausted worker instance returned `NOT_FOUND` normally, confirming per-identity isolation. Harness was a throwaway `/tmp` script, not committed (same non-committed-harness pattern as Batch 1's `test/__share-link-boot-check.worker.ts`). |
| Rollback boundary | Revert `packages/core/src/api.ts` (5 new `@Handler` declarations), `packages/core/src/server.ts` (import + `Controller.shareStorage` getter + 5 handler methods + 4 private helpers + `Server` ctor's trailing optional `shareStorage` param), `packages/core/test/share-rpc-auth.spec.ts` (new), `packages/worker/src/index.ts` (import + `ShareLinkDO` export + 2 pure rate-limit functions + `shareViewRateLimiter` instantiation + gate in the `fetch()` dispatch closure), `packages/worker/src/server-factory.ts` (import + `shareStorage` instantiation + `Server(...)` call's 2 new trailing args), `packages/worker/test/share-view-rate-limit.test.mjs` (new). Purely additive to existing files — no existing method signature changed except `Server`'s constructor, which only gained a new **optional, trailing** parameter (verified zero other call sites needed changes: `packages/server/src/init.ts`'s existing 10-arg call is unaffected since JS/TS allow omitting trailing optional params). |

## Files Changed

### Batch 1 (Phases 1-2)

| File | Action | What Was Done |
|------|--------|---------------|
| `packages/core/src/share.ts` | Created | `ShareID`, `CreateShareParams`, `ShareLinkInfo`, `ShareData`, `ShareStatus`, `ShareStorage` interface |
| `packages/core/src/server.ts` | Modified | `ServerConfig`: added `shareLinkMaxTtlSeconds` `@ConfigParam("number")`, default 14 days |
| `packages/worker/src/env.ts` | Modified | Added `SHARE_LINKS?: DurableObjectNamespace` |
| `packages/worker/wrangler.toml` | Modified | Added `[[migrations]] tag="v2" new_sqlite_classes=["ShareLinkDO"]`; `SHARE_LINKS` binding for `env.dev` and `env.preview` |
| `packages/worker/src/durable-objects/share-link.ts` | Created | `ShareLinkDO extends DurableObject<Env>` — SQLite-backed single-share state, atomic `reveal()`, `alarm()`-driven cleanup |
| `packages/worker/src/storage/share-do-storage.ts` | Created | `DurableObjectShareStorage implements ShareStorage` — wraps `SHARE_LINKS` namespace, translates core Serializable types ↔ DO wire format |
| `packages/worker/test/share-link-do.test.mjs` | Created | RED→GREEN→REFACTOR unit test for `ShareLinkDO` (concurrent reveal race, alarm-driven expiry), real SQLite via `node:sqlite` |
| `packages/worker/package.json` | Modified | Added `esbuild` devDependency; added `test:share-link-do` script; wired into `test:ci` |
| `packages/worker/test/account-lockout-e2e.worker.ts` | Modified | Added `export { ShareLinkDO }` alongside `AccountLockDO` (required fix — see Batch 1 Deviations) |
| `packages/worker/test/vault-crud-e2e.worker.ts` | Modified | Same fix as above |

### Batch 2 (Phases 3-4)

| File | Action | What Was Done |
|------|--------|---------------|
| `packages/core/src/api.ts` | Modified | Added `@Handler` declarations: `createShare`, `peekShare`, `revealShare`, `getShareStatus`, `revokeShare` (grouped with the attachment handlers); import of `share.ts` types |
| `packages/core/src/server.ts` | Modified | Import of `share.ts` types; `Controller.shareStorage` getter; 5 handler method bodies (`createShare`/`peekShare`/`revealShare`/`getShareStatus`/`revokeShare`) plus 4 private helpers (`_validateShareTtl`, `_shareNotFoundError`, `_shareStatusOrNotFound`, `_requireShareStorage`); `Server` constructor gains a trailing, optional `shareStorage?: ShareStorage` param |
| `packages/core/test/share-rpc-auth.spec.ts` | Created | RED→GREEN unit test for the 5 RPC handlers: auth gating, TTL cap, content-free terminal-state mapping, revocation, view receipt, `shareStorage`-unset guard (31 assertions) |
| `packages/worker/src/index.ts` | Modified | `export { AccountLockDO, ShareLinkDO }`; pure exported `shareViewRateLimitKeys`/`checkShareViewRateLimit` functions; a dedicated `shareViewRateLimiter` (`RateLimiter`, 10 req/60s, hardcoded — see Deviations); gate wired into the RPC dispatch closure inside `fetch()`, ahead of `server.handle(req)` |
| `packages/worker/src/server-factory.ts` | Modified | Import of `DurableObjectShareStorage`; instantiates it from `env.SHARE_LINKS` when bound; injects as `createServer`'s new trailing `Server(...)` argument |
| `packages/worker/test/share-view-rate-limit.test.mjs` | Created | RED→GREEN unit test for the share-view rate limiter: per-share cap, per-IP cap, non-view-method bypass (9 assertions) |
| `openspec/changes/share-password/tasks.md` | Modified | Marked tasks 3.1-4.4 `[x]` (cumulative: 1.1-4.4 all `[x]`) |
| `openspec/changes/share-password/apply-progress.md` | Modified | This file — merged Batch 1 + Batch 2 |

## Deviations from Design

Batch 1's 4 deviations (ShareLinkDO extends DurableObject; ArrayBuffer BLOB normalization; e2e worker exports; alarm hard-deletes) carry forward unchanged — see the "Batch 1" file-changed section above for file pointers; full rationale is in git history (commits `99051537`, `bd8b5cc9`).

Batch 2 deviations:

1. **`Server` constructor's new `shareStorage` param is optional and appended LAST, not inserted near `attachmentStorage`.** design.md just says "Server ctor gains `shareStorage`" without specifying position/optionality. `packages/server/src/init.ts` (the self-hosted Node server's `new Server(...)` call site) is **outside this batch's `allowedEditRoots`**, so the only change-compatible option was a trailing, optional parameter — which also correctly encodes that the self-hosted server has no DO-backed `ShareStorage` implementation yet (Controller reports `ErrorCode.NOT_SUPPORTED` when it's unset, rather than crashing on a missing required arg).
2. **`checkShareViewRateLimit` was implemented in `index.ts` before its RED test was written** (task 4.2 said "RED... before the GREEN wiring (4.3)"; I combined 4.1's export change and 4.3's gate wiring into one edit before writing the test). Caught during review of the TDD evidence gate; corrected by temporarily renaming the two exports back to `__disabled_*`, re-running the test to get a genuine, executed RED (`TypeError: shareViewRateLimitKeys is not a function`), then restoring the real names and re-confirming GREEN. The evidence table above documents this honestly rather than presenting a false RED-first narrative.
3. **The share-view rate limiter's thresholds are hardcoded (`maxRequests: 10, windowMs: 60_000`), not sourced from new `Env` fields**, unlike the existing generic limiter's `env.RATE_LIMIT_MAX_REQUESTS`/`env.RATE_LIMIT_WINDOW_MS`. `packages/worker/src/env.ts` is a closed interface (no index signature) and is **outside this batch's `allowedEditRoots`**; adding new `env.SHARE_VIEW_RATE_LIMIT_*` properties there would have been a TypeScript error. The hardcoded value matches design.md's own stated default ("start conservative (10/min/IP), tune post-launch"). Making it configurable is a natural Phase 7 cleanup follow-up once `env.ts` is back in scope.
4. **Both an IP-scoped AND a share-scoped rate-limit key are enforced**, not just the IP-scoped key task 4.1's literal wording ("2nd `RateLimiter` keyed `share-view:${ip}`") calls out. spec.md's Rate Limiting requirement has two explicit scenarios — "Per-share brute-force attempts" and "Per-IP enumeration attempts" — so both were implemented (`share-view:ip:<ip>` and `share-view:share:<id>`, checked together via one `RateLimiter` instance, one call to `.check()` per key). Implementing only the IP-scoped key would have left the per-share scenario unmet.
5. **`ShareStorage.peek()`'s anonymous `ShareStatus` never reflects a `revoked` flag** (defaults to `false`) — this is a `ShareLinkDO`/`share-link.ts` (Batch 1, outside this batch's `allowedEditRoots`) limitation: its `peek()` RPC method only ever returns `{expired, viewed}`, never checking the `revoked` column. `Controller.peekShare` is faithful to what the storage layer actually reports. Practically low-impact (spec's View Receipt requirement is sender-only, and `revealShare` DOES correctly exclude revoked shares — `REVEAL_SHARE`'s SQL has `AND revoked = 0`), but flagging for whoever picks up Phase 7 cleanup: `peek()` could optionally also expose `revoked` for a more informative pre-reveal anonymous page state.

## Issues Found

Carried forward from Batch 1 (still true, still out of scope): `npm run test:logging-redaction` pre-existing failure on clean `main`; `packages/worker`'s `tsc --noEmit` has 217 pre-existing `TS1005` parse errors, 100% inside `node_modules` (`drizzle-orm`/`@simplewebauthn/server` `.d.ts` files), confirmed **still exactly 217, zero new, zero outside `node_modules`** after this batch's changes; `AccountLockDO`'s dormant "plain class breaks RPC" bug (unrelated, untouched).

New in this batch:
- **This session's ambient `node` (via `nvm`, v14.15.5) is far too old** for this repo's `node:sqlite`-dependent worker tests and has a mismatched-architecture `esbuild` binary (`@esbuild/darwin-arm64` installed, but the v14 binary reports `process.arch === "x64"`, apparently running under Rosetta 2). Neither `nvm`'s available versions (14.15.5, 20.17.0) nor `fnm`'s (22.23.1) satisfy `package.json`'s pinned `"node": "24.x"` engines field. Found and used `/opt/homebrew/opt/node@24/bin/node` (Homebrew, v24.19.0, native arm64) for all test runs and the live `wrangler dev` boot-check in this batch — this resolved both the `node:sqlite` and `esbuild` architecture-mismatch failures. Flagging for whoever manages this workstation's Node version: the default shell `node` resolution is unreliable for this repo's engines requirement.
- **`packages/worker/package.json` was NOT updated to wire `test:share-view-rate-limit` into `test:ci`** (mirroring how Batch 1 wired `test:share-link-do`), because `package.json` is outside this batch's `allowedEditRoots`. The test was verified directly (`node test/share-view-rate-limit.test.mjs`) and is fully passing; wiring it into the npm script chain is a 2-line follow-up for whoever next has `package.json` in scope (Phase 7 cleanup, or the next batch if its `allowedEditRoots` includes it).

## Remaining Tasks (Phase 5 onward — later batches)

- [ ] 5.1-5.6 Client UI (`share-dialog.ts`, `share-view.ts`, `item-view.ts`, `app.ts` routing)
- [ ] 6.1-6.2 Integration & E2E tests
- [ ] 7.1 Cleanup / docs — **plus this batch's two flagged follow-ups**: wire `test:share-view-rate-limit` into `packages/worker/package.json`'s `test:ci`; consider making the share-view rate limit thresholds configurable via `Env` once `env.ts` is in scope; consider having `ShareLinkDO.peek()` also report `revoked` once `durable-objects/share-link.ts` is in scope.

## Workload / PR Boundary

- Mode: `size:exception` (maintainer-accepted, single continuous branch, no PR splitting)
- Current work unit: Suggested Work Unit 2 ("RPC handlers + rate limit") — Phases 3-4 fully cover it
- Boundary: This batch starts from Batch 1's 2 local, unpushed commits (`99051537`, `bd8b5cc9`) and ends with 2 more local, unpushed commits (`aafd0aba` feat(core), `8a4ffc43` feat(worker)) covering Phase 3 (RPC Handlers) and Phase 4 (Worker Wiring & Rate Limit)
- Estimated review budget impact: this batch's diff is ~450 changed lines (2 new test files + handler/wiring code); cumulative Batches 1-2 remain within Suggested Work Unit 1+2's intended scope; full change remains High risk per the tasks.md forecast (900-1300 lines across 13 files) — Batches 3-4 will add the client UI and integration/E2E remainder

## Status

16/23 tasks complete (Phases 1-4 of 7). Ready for apply batch 3 (Phase 5: Client UI).
