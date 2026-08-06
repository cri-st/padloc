# Archive Report: One-Time, Expiring Password Share Links (`share-password`)

**Archived**: 2026-08-06
**Status**: Archived — COMPLETE and VERIFIED (pass with warnings, 0 CRITICAL)

## Traceability (Engram observation IDs, confirmed via `mem_search` — not trusted from prior claims)

| Artifact | Topic Key | Observation ID | Saved |
|---|---|---|---|
| Exploration | `sdd/share-password/explore` | #1316 | 2026-08-05 22:35:16 |
| Proposal | `sdd/share-password/proposal` | #1317 | 2026-08-05 22:42:06 |
| Spec | `sdd/share-password/spec` | #1318 | 2026-08-05 23:29:31 |
| Design | `sdd/share-password/design` | #1319 | 2026-08-05 23:34:17 |
| Tasks | `sdd/share-password/tasks` | #1320 | 2026-08-05 23:42:51 |
| Apply Progress | `sdd/share-password/apply-progress` | #1321 | 2026-08-06 00:13:45 |
| Verify Report | `sdd/share-password/verify-report` | #1322 | 2026-08-06 01:57:46 |
| Archive Report (this document) | `sdd/share-password/archive-report` | (assigned on save, below) | 2026-08-06 |

All seven upstream IDs were independently re-confirmed by `mem_search` during this archive pass (not trusted from the launch-prompt's provisional numbers) — the search results matched the numbers supplied in context exactly, except the archive phase additionally discovered #1316 for `explore` (not pre-supplied) and confirmed #1318 for `spec` (also not pre-supplied).

## Native Review Receipt Gate

This delegated sub-agent environment has no native `gentle-ai` CLI binary access (confirmed across every prior phase this session, per orchestrator context). No receipt-driven-development review authority is active here. Per the archive skill's stated relaxation — "`disabled/unmanaged` is the only relaxation, and the native gate is what decides it... it removes only the implicit demand" — this gate is treated as `reviewGate.delivery: disabled/unmanaged` and does not block archive. No terminal review receipt exists or is required for this cycle.

## Task Completion Gate

Independently re-read `openspec/changes/share-password/tasks.md` (pre-move) in full: **all 25/25 tasks across 7 phases are literally `[x]`** (Phase 1: 4/4, Phase 2: 4/4, Phase 3: 4/4, Phase 4: 4/4, Phase 5: 6/6, Phase 6: 2/2, Phase 7: 1/1). This corroborates the prior independent spot-check already performed by `sdd-verify` (verify-report #1322), which cross-checked 6 of the 25 against real code (wrangler.toml migration/binding, `core/api.ts` handler declarations, `ServerConfig.shareLinkMaxTtlSeconds`, `worker/index.ts` exports/rate-limiter wiring, absence of debug logging, and the DO concurrency test) and found no discrepancies. No reconciliation was needed — this is a clean pass, not an exceptional stale-checkbox repair.

## Final-State Summary (per the Final-State Authority hierarchy — this section outranks the intermediate verify-report/apply-progress snapshots below for anything it covers)

- **Verdict**: PASS WITH WARNINGS (verify-report #1322, evidence_revision `sha256:3ff8ad62...`). 0 CRITICAL / 0 blockers, 3 WARNING, 3 SUGGESTION — none block archive per the skill's rule ("NEVER archive a change that has CRITICAL issues"; there are none here).
- **Requirements/scenarios**: 7/7 requirements, 16/16 scenarios have runtime-passing covering tests (15 fully compliant, 1 partial on a UX-text technicality — see below). 84/84 real test assertions independently re-run and passing by `sdd-verify` from scratch (not trusted from the self-report): `share-link-do.test.mjs` 10, `share-view-rate-limit.test.mjs` 9, `share-link-e2e.worker.ts` 20, `share-rpc-auth.spec.ts` 31, `share.spec.ts` 14.
- **The 3 WARNINGs, at close, per verify-report #1322**:
  1. **Idempotency-store replay bug** (`packages/worker/src/transport.ts`/`idempotency.ts`) — real, confirmed by independent code read, structurally incapable of causing a second real reveal or a double ciphertext leak (the idempotency cache never stores the actual success payload and short-circuits before `handler(req)` on a cache hit). Cosmetic-only: a byte-identical duplicate anonymous `peekShare`/`revealShare` request within a 1-hour KV TTL window can render a generic error on replay instead of the real (already-delivered) result. Left unfixed, out of this change's `allowedEditRoots` — recommended as a maintainer follow-up on the general transport idempotency mechanism, not specific to sharing.
  2. **Spec scenario "Non-Login item rejected" is UX-text-partial.** The underlying security property — a non-Login item's ciphertext is never uploaded (`isShareableItem()` gates every path to `ShareDialog`/`createShare`) — is correctly implemented and tested. What's missing is the literal "naming the type" rejection message the spec's THEN clause calls for; the real implementation instead hides the menu entry and silently no-ops a bypass. Recommended: either update the spec's THEN clause to match the actual (reasonable) "silently hidden" UX, or add an explicit rejection message.
  3. **`cypress/e2e/05 - share-link.cy.ts` cannot auto-execute** in this or any environment with the current `env.dev` config: `EMAIL_BACKEND=mock`'s `MockMessenger` never delivers to `maildev`, so `cy.signup()`'s email-code step can never complete — a pre-existing, unrelated gap (also affects `01/02/03 - *.cy.ts`, confirmed not introduced by this change). All 16 spec scenarios already have independent, automatically-executed, passing coverage at the RPC/DO layer, so no scenario is left untested; only the full click-through UI path relies on a manually-verified (not machine-verified) walkthrough recorded in apply-progress #1321.
- **The 3 SUGGESTIONs, at close, per verify-report #1322**: (1) `ShareLinkDO.peek()` doesn't surface `revoked`, so a revoked-but-unattempted share's landing page shows the maskable "Reveal" button instead of an immediate "Link Not Available" state — `reveal()` still correctly rejects it server-side; UX polish only. (2) "Share Link ..." menu icon (`icon="unlock"`) is a less precise semantic match than the already-used `icon="show"` eye glyph — deliberately deferred, outside the batch's `allowedEditRoots`. (3) `packages/core/package.json` has no `scripts`/`tsconfig.json`, forcing `ts-node --transpile-only` (skips real type-checking) for all `packages/core` tests — pre-existing repo-wide gap, not introduced by this change.
- **Git state, at close**: 9 local commits on `main` (`99051537`, `bd8b5cc9`, `aafd0aba`, `8a4ffc43`, `5c409a55`, `72bf3758`, `9f6f52ac`, `4a0046e5`, `45240dcd`), all unpushed — `main` is 9 ahead / 0 behind `origin/main`. This is the correct, intentional terminal state for this session's scope: the user's explicit delivery constraint was no PR and no push without a separate future confirmation (also reflected in apply-progress #1321's `Delivery: exception-ok — size:exception accepted by maintainer, single continuous branch on main, no PR splitting, no push`). This is a factual note, not an open task or risk.

No CRITICAL issues exist anywhere across the cycle. Archive is not blocked by any gate.

## Specs Synced

| Domain | Action | Details |
|---|---|---|
| `password-share-links` | **Created** (straight copy, no prior main spec existed — confirmed: `openspec/specs/` contained only `.gitkeep` before this archive) | 7 requirements / 16 scenarios copied verbatim from `openspec/changes/share-password/specs/password-share-links/spec.md` → `openspec/specs/password-share-links/spec.md`. No delta-merge logic applied (not needed — this is the domain's first-ever spec). |

## Archive Contents

Moved `openspec/changes/share-password/` → `openspec/changes/archive/2026-08-06-share-password/` (via `git mv`, preserving history):
- `proposal.md` ✅
- `specs/password-share-links/spec.md` ✅
- `design.md` ✅
- `tasks.md` ✅ (25/25 tasks complete)
- `apply-progress.md` ✅
- `verify-report.md` ✅
- `exploration.md` ✅
- `archive-report.md` ✅ (this document)

## Source of Truth Updated

- `openspec/specs/password-share-links/spec.md` now reflects the new `password-share-links` capability and is the authoritative spec for future changes touching this domain.

## Contradictions

None found. No source disagreed with any other on a fact this report covers; the launch prompt's final-state facts and the highest-ranked available evidence (verify-report #1322, apply-progress #1321, direct re-read of `tasks.md`) were all mutually consistent.
