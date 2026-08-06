# Apply Progress: One-Time, Expiring Password Share Links

**Batch**: 1 of 4
**Mode**: Strict TDD (packages/worker unit tests) + standard (packages/core types/config)
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

## TDD Cycle Evidence

| Task | Test File | Layer | Safety Net | RED | GREEN | TRIANGULATE | REFACTOR |
|------|-----------|-------|------------|-----|-------|-------------|----------|
| 2.1-2.2 | `test/share-link-do.test.mjs` | Unit (real `SqlStorage`-shaped `node:sqlite` backend) | N/A (new) | ✅ Written — `ShareLinkDO` didn't exist, esbuild reported `Could not resolve` | ✅ Passed — 10/10 assertions after implementing `ShareLinkDO` | ✅ 4 scenarios: concurrent-reveal happy path, reveal-on-never-created (all-null triangulation), alarm-driven expiry, unexpired-share-stays-revealable (expired=false triangulation) | N/A (covered by 2.3) |
| 2.3 | `test/share-link-do.test.mjs` | Unit | ✅ 10/10 (pre-refactor baseline) | N/A (refactor, not new behavior) | N/A | N/A | ✅ Extracted SQL constants; re-ran full suite after — still 10/10 |
| 2.4 | (covered transitively by live boot-check below; no new RED/GREEN cycle — `DurableObjectShareStorage` is a thin translation layer with no independent branching logic beyond what `ShareLinkDO`'s tests already cover) | N/A | N/A | N/A | N/A | Triangulation skipped: pure pass-through/translation code, one code path per method, no branching logic of its own | N/A |

### Test Summary
- **Total tests written**: 10 assertions across 4 test functions (`test/share-link-do.test.mjs`)
- **Total tests passing**: 10/10
- **Layers used**: Unit (10) — real SQLite semantics via `node:sqlite`, no mocked SQL logic
- **Approval tests** (refactoring): None — no existing behavior to preserve, 2.3 refactored newly-written code
- **Pure functions created**: 0 (DO class methods are inherently stateful/async by design; SQL query strings extracted as constants instead, per REFACTOR step)

## Work Unit Evidence

| Evidence | Value |
|---|---|
| Focused test command and exact result | `npm run test:share-link-do` (packages/worker) → `node test/share-link-do.test.mjs` → **10 passed, 0 failed**, exit 0 |
| Runtime harness command/scenario and exact result | Real `wrangler dev --local --env=dev` boot via a throwaway, non-committed alternate entrypoint (`test/__share-link-boot-check.worker.ts`, deleted after use — same pattern as the pre-existing `dev:crypto-parity` script). `GET /healthcheck` → `200 {"status":"ok"}` (no `_paramDefinitions` decorator crash). `GET /boot-check/concurrent-reveal` → `{"successCount":1,...}` against REAL local SQLite DO storage. `GET /boot-check/expiry` → `{"peek":{"expired":true,"viewed":false},"reveal":null}`. Full production wiring (Phase 4's `worker/index.ts` export) is out of scope for this batch; verified via the equivalent throwaway harness instead. |
| Rollback boundary | Revert `packages/core/src/share.ts` (new), `packages/worker/src/durable-objects/share-link.ts` (new), `packages/worker/src/storage/share-do-storage.ts` (new), `packages/worker/test/share-link-do.test.mjs` (new); revert the `shareLinkMaxTtlSeconds` hunk in `packages/core/src/server.ts`; revert the `SHARE_LINKS` hunk in `packages/worker/src/env.ts`; revert the migration/binding hunks in `packages/worker/wrangler.toml`; revert the `ShareLinkDO` export line in `packages/worker/test/account-lockout-e2e.worker.ts` and `packages/worker/test/vault-crud-e2e.worker.ts`; revert the `esbuild` devDependency + `test:share-link-do` script lines in `packages/worker/package.json`. Purely additive — no existing behavior removed, `wrangler.toml` migration is append-only (`v2` after `v1`). |

## Files Changed

| File | Action | What Was Done |
|------|--------|---------------|
| `packages/core/src/share.ts` | Created | `ShareID`, `CreateShareParams`, `ShareLinkInfo`, `ShareData`, `ShareStatus`, `ShareStorage` interface — platform-agnostic contracts per design.md |
| `packages/core/src/server.ts` | Modified | `ServerConfig`: added `shareLinkMaxTtlSeconds` `@ConfigParam("number")`, default 14 days |
| `packages/worker/src/env.ts` | Modified | Added `SHARE_LINKS?: DurableObjectNamespace` |
| `packages/worker/wrangler.toml` | Modified | Added `[[migrations]] tag="v2" new_sqlite_classes=["ShareLinkDO"]`; `SHARE_LINKS` binding for `env.dev` and `env.preview` |
| `packages/worker/src/durable-objects/share-link.ts` | Created | `ShareLinkDO extends DurableObject<Env>` — SQLite-backed single-share state, atomic `reveal()`, `alarm()`-driven cleanup |
| `packages/worker/src/storage/share-do-storage.ts` | Created | `DurableObjectShareStorage implements ShareStorage` — wraps `SHARE_LINKS` namespace, translates core Serializable types ↔ DO wire format |
| `packages/worker/test/share-link-do.test.mjs` | Created | RED→GREEN→REFACTOR unit test for `ShareLinkDO` (concurrent reveal race, alarm-driven expiry), real SQLite via `node:sqlite` |
| `packages/worker/package.json` | Modified | Added `esbuild` devDependency (already a transitive/override dep, now explicit since the new test imports it directly); added `test:share-link-do` script; wired into `test:ci` |
| `packages/worker/test/account-lockout-e2e.worker.ts` | Modified | Added `export { ShareLinkDO }` alongside the pre-existing `AccountLockDO` export — required fix, see Deviations |
| `packages/worker/test/vault-crud-e2e.worker.ts` | Modified | Same fix as above |
| `openspec/changes/share-password/tasks.md` | Modified | Marked tasks 1.1-2.4 `[x]` |
| `openspec/changes/share-password/apply-progress.md` | Created | This file |

## Deviations from Design

1. **`ShareLinkDO extends DurableObject<Env>`, not a plain class.** design.md's Architecture Decisions table says ShareLinkDO is "modeled on `AccountLockDO`" (a plain class, no base-class extension). A live `wrangler dev` boot-check proved that a plain DO class only gets a startup **warning** for missing RPC support, but the moment a real caller invokes an RPC method (`stub.reveal()` etc.), wrangler/workerd throws `TypeError: The receiving Durable Object does not support RPC, because its class was not declared with 'extends DurableObject'`. `ShareLinkDO` therefore extends the `DurableObject` base class from `cloudflare:workers` (industry-standard requirement for real RPC dispatch); it still does NOT extend `@padloc/core`'s `Config`/`Serializable` and uses none of its decorators, so the `_paramDefinitions` crash this design decision was actually guarding against does not apply. This is a correction to a factual assumption in design.md, not a functional deviation from its intent (per-DO RPC-stub access) — **flagging for design.md/Phase 3-4 authors**: `AccountLockDO` itself (unmodified, out of my scope) has this same latent bug, currently undetected because `withAccountLocks` — its only caller — is dead code (confirmed via grep; matches an existing repo gotcha note).
2. **`ShareRow.encrypted_data` typed `ArrayBuffer`, not `Uint8Array`; `reveal()` normalizes with `new Uint8Array(...)`.** The same live boot-check found that real Cloudflare `SqlStorage.exec().toArray()` returns BLOB columns as `ArrayBuffer`, not `Uint8Array` (confirmed: `node:sqlite`, used by the fast unit test, returns `Uint8Array` for the same query — a real, fast-test-invisible discrepancy). Fixed at the DO boundary (`reveal()` always returns a real `Uint8Array`) so `DurableObjectShareStorage` and all downstream `@padloc/core` consumers never see the ambiguity. The unit test's `FakeSqlStorage` was also updated to coerce BLOB columns to `ArrayBuffer`, matching production, and a revert-and-rerun (`sed` revert → 9/10 failing → restore → 10/10) confirmed the test now genuinely guards this regression.
3. **`export { ShareLinkDO }` added to `test/account-lockout-e2e.worker.ts` and `test/vault-crud-e2e.worker.ts`** (files outside this batch's `allowedEditRoots`). Adding the `SHARE_LINKS`/`ShareLinkDO` binding to `wrangler.toml` (in-scope task 1.4) broke these two pre-existing e2e tests: once a worker script exports ANY Durable Object class, wrangler hard-fails startup (`wrangler exited before serving requests`) for every OTHER configured DO binding whose class isn't also exported (both files already export `AccountLockDO` but not `ShareLinkDO`). Confirmed via `git stash` that both tests passed on the clean baseline and failed after the in-scope `wrangler.toml` change alone. Flagged to and approved by the orchestrator (`Main`) before applying the 1-line, additive, mechanical export fix. `test/auth-flow-e2e.worker.ts` has the same latent exposure but is not wired into any `npm run test:*` script (pre-existing, confirmed dead runner) — left untouched, noted here for awareness.
4. **`alarm()` deletes the row rather than only marking it expired.** design.md doesn't specify alarm-fired behavior in detail. Chose hard delete (proposal.md success criterion: "Links expire per TTL, no manual cleanup") since `peek()`/`getStatus()`/`reveal()` already independently re-check `expiresAt` against wall-clock time on every call, so correctness never depends on whether the alarm has fired yet — only storage hygiene does. After deletion, `getStatus()`/`peek()` return `null` (indistinguishable from "never existed"); Phase 3's Controller will need to map that null the same way it maps "expired" per the spec's content-free-error requirement — noted for the Phase 3 batch.

## Issues Found

- **Pre-existing, unrelated test failure**: `npm run test:logging-redaction` fails on `packages/worker` both before and after this batch's changes (`AssertionError` — actual Resend-failure log payload includes an extra `body: ''` field the test doesn't expect). Confirmed via `git stash` — identical failure on the clean `main` baseline. Not touched; out of scope for this batch.
- **`tsc --noEmit` is structurally broken for `packages/worker`** on this machine's pinned TypeScript 4.4.3: `drizzle-orm`'s and `@simplewebauthn/server@13.3.2`'s shipped `.d.ts` files use syntax TS 4.4.3 cannot parse (217 pre-existing `TS1005` parse errors, all inside `node_modules`, zero in project source). Confirmed pre-existing (same 217 errors before touching any file in this batch) and confirmed unrelated (identical count after adding all Phase 1-2 files — verified via `diff` of the two full error dumps). Worked around by: (a) typechecking `packages/core`'s changes via `packages/server`'s cleaner `tsc --noEmit` path (only 1 pre-existing, unrelated `dompurify`/`trusted-types` error, unchanged before/after), and (b) validating `packages/worker`'s new files via a real `wrangler dev` boot + the esbuild-based test-transpile path, since esbuild is what actually builds this package for deployment.
- **`AccountLockDO` (`packages/worker/src/locks/account-lock.ts`, untouched, out of scope) has the same "plain class breaks RPC" bug** described in Deviation #1 above — currently dormant because its only caller (`withAccountLocks`) is dead code. Not fixed here (outside `allowedEditRoots`); flagging for whoever eventually wires `withAccountLocks` into a live request path.

## Remaining Tasks (Phase 3 onward — later batches)

- [ ] 3.1-3.4 RPC Handlers (`core/api.ts` `@Handler` methods, `Controller` bodies in `server.ts`, TTL-cap/error-mapping refactor)
- [ ] 4.1-4.4 Worker wiring (`worker/index.ts` export `ShareLinkDO`, rate limiter, `server-factory.ts` wiring)
- [ ] 5.1-5.6 Client UI (`share-dialog.ts`, `share-view.ts`, `item-view.ts`, `app.ts` routing)
- [ ] 6.1-6.2 Integration & E2E tests
- [ ] 7.1 Cleanup / docs

## Workload / PR Boundary

- Mode: `size:exception` (maintainer-accepted, single continuous branch, no PR splitting)
- Current work unit: Suggested Work Unit 1 ("Core types + ShareLinkDO") — Phases 1-2 fully cover it
- Boundary: This batch starts from a clean `main` (0 ahead/0 behind `origin/main`) and ends with 2 local, unpushed commits covering Phase 1 (Foundation) and Phase 2 (ShareLinkDO & Storage)
- Estimated review budget impact: ~450 changed lines (Phase 1+2 code + tests + progress notes), well within Suggested Work Unit 1's intended scope; full change remains High risk per the tasks.md forecast (900-1300 lines across 13 files) — batches 2-4 will add the remainder

## Status

8/23 tasks complete (Phases 1-2 of 7). Ready for apply batch 2 (Phase 3: RPC Handlers).
