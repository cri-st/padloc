# Chrome Extension Parity - Learnings <!-- oc:id=sec_aa -->

## Key Architecture Findings <!-- oc:id=sec_ab -->

### Current Extension Architecture Issues (MV3) <!-- oc:id=sec_ac -->

1. **Worker dormancy kills in-memory state**: `background.ts` holds `app: App`
   as module-level singleton. When MV3 service worker is killed (after ~30s
   inactivity), `app` and all its in-memory state (including
   `account.masterKey`) is lost. <!-- oc:id=item_aa -->

1. **`ExtensionStorage` uses `browser.storage.local` for ALL storage**:
   `storage.ts` line 8 writes everything to `browser.storage.local`, including
   `AppState` which holds `rememberedMasterKey`. This is a security concern per
   the plan's "Must NOT have" rules. <!-- oc:id=item_ab -->

1. **Popup unlock flow broken after worker restart**: `app.ts` line 38-44
   requests master key from background via `requestMasterKey` message. If worker
   restarted, `application.account.masterKey` is null (lines 58-62 in
   background.ts) → user forced to re-enter master password.
    <!-- oc:id=item_ac -->

1. **`ExtensionPlatform.supportedAuthTypes` only exposes Email+Totp**
   (platform.ts line 8-10), excluding OAuth and WebAuthn — which are needed per
   the plan. <!-- oc:id=item_ad -->

### Core Unlock Pattern (`rememberedMasterKey`) <!-- oc:id=sec_ad -->

-   Located: `packages/core/src/app.ts:188`
    (`StoredMasterKey extends SimpleContainer`), line 243-244 (state field),
    lines 1015-1054 (methods)
-   Pattern: Encrypted container holding master key, unlocked via
    `unlockWithRememberedMasterKey(authToken)` which requires a server API call
    (`getKeyStoreEntry`)
-   Account/session persistence needed to survive worker restart — core app uses
    `LocalStorage` which is `window.localStorage` in the browser (not available
    in extension worker)

### Storage Strategy for MV3 Extension <!-- oc:id=sec_ae -->

-   `chrome.storage.session`: Session-scoped, survives worker restarts, cleared
    when browser session ends
-   `chrome.storage.local`: Persistent, survives restarts but is NOT a secure
    keystore per plan rules
-   **Decision**: Store `AppState` (with `rememberedMasterKey`) and `Account` in
    `chrome.storage.session`; keep other storage in `browser.storage.local`
-   **Key insight**: `StoredMasterKey` (line 188) is an encrypted blob that can
    safely be stored in `chrome.storage.session` — the actual master key bytes
    never leave the encrypted container

### Critical Reference Paths <!-- oc:id=sec_af -->

-   `packages/extension/src/background.ts:56-62` — `requestMasterKey` message
    handler returning `application.account.masterKey` from memory (BROKEN after
    worker restart)
-   `packages/extension/src/app.ts:38-44` — Popup unlock flow that requests
    master key from background (fails if worker dead)
-   `packages/extension/src/storage.ts:5-36` — `ExtensionStorage` using
    `browser.storage.local` only
-   `packages/extension/src/platform.ts:5-17` — `ExtensionPlatform` with limited
    `supportedAuthTypes`
-   `packages/core/src/app.ts:1015-1054` — `StoredMasterKey` setup and
    `unlockWithRememberedMasterKey` method

## Plan-Wide Decisions <!-- oc:id=sec_ag -->

-   Wave 1 critical path: Task 1 → Tasks 2, 3, 4, 5, 6, 9
-   Tasks 4 and 5 can run in parallel with Task 1 (Wave 1, but independent
    paths)
-   Task 2 (WebAuthn) depends on Task 1 completing first
-   `chrome.storage.session` is the key MV3 persistence primitive for extension
    session state

## Task 1 Implementation Notes <!-- oc:id=sec_ah -->

-   Corrected the unlock contract to use `browser.storage.session` only for raw
    master key material; `browser.storage.local` remains the persistent store
    for serialized app state and encrypted `rememberedMasterKey`.
    <!-- oc:id=item_ae -->
-   Removed the popup ↔ background raw master-key relay (`requestMasterKey` /
    payloaded `unlocked` message). The worker now rehydrates by reading session
    storage directly, same as the popup. <!-- oc:id=item_af -->
-   Scoped the session unlock blob by `accountId` and `sessionId` so stale
    session data does not unlock a different account/session after logout or
    session rotation. <!-- oc:id=item_ag -->
-   Kept `rememberedMasterKey` as the cross-restart biometric path instead of
    inventing a new extension-only key wrapping scheme. <!-- oc:id=item_ah -->
-   Exposed WebAuthn auth types from `ExtensionPlatform`, which unblocks the
    existing unlock/settings biometric UI for the extension once the dedicated
    WebAuthn task lands. <!-- oc:id=item_ai -->

-   Verification so far: `npm run build` for `packages/extension` passed; direct
    LSP diagnostics were attempted twice but the TypeScript server timed out
    during initialize. <!-- oc:id=item_aj -->

## Task 3: OAuth Flow <!-- oc:id=sec_ai -->

### Key Findings

-   Web OAuth at `packages/app/src/lib/auth/oauth.ts` uses `window.open` +
    `postMessage` — incompatible with extension popup context because the
    popup's `window` cannot receive `postMessage` from the auth popup.
-   Chrome provides `chrome.identity.launchWebAuthFlow` for extension-native
    OAuth: opens auth URL, intercepts redirect to
    `chrome-extension://[ext-id].chromiumapp.org/callback`, returns the full
    redirect URL with code/state params.
-   The `identity` permission is required in manifest.json for
    `launchWebAuthFlow` to work.
-   Extension's `OauthClient` follows same `AuthClient` interface as web:
    `prepareRegistration` and `prepareAuthentication` both return
    `{ code, state }`.

### Implementation Notes

-   `packages/extension/src/auth/oauth.ts` — new file, `OauthClient` using
    `browser.identity.launchWebAuthFlow`. Uses `webextension-polyfill-ts` for
    the `browser.identity` API.
-   `packages/extension/src/platform.ts` — override `_getAuthClient` to return
    `oauthClient` for `AuthType.Oauth`; added `AuthType.Oauth` to
    `supportedAuthTypes`.
-   `packages/extension/src/manifest.json` — added `"identity"` to permissions
    array.
-   `packages/extension/test/oauth.ts` — tests for success (resolves
    code+state), cancel (rejects), error param in callback (rejects), undefined
    redirect URL (rejects), and missing code param (rejects).

### Reference Paths

-   `packages/extension/src/auth/oauth.ts` — new OAuth client
-   `packages/extension/src/platform.ts:8-20` — updated `supportedAuthTypes` and
    `_getAuthClient`
-   `packages/extension/src/manifest.json:14` — added `identity` permission
-   `packages/extension/test/oauth.ts` — OAuth test suite

## Task 5: Popup Cold-Start State Restoration

### Key Findings

-   **Race condition**: `super.load()` fires `stateChanged()` which reads
    `state.context.browser?.url`. Tab capture happened AFTER `super.load()`, so
    `_matchingItems` returned empty even when there were matching items for the
    current tab.
-   **Worker dormancy**: MV3 workers restart after ~30s inactivity. Popup had no
    liveness check — it made routing decisions before the worker had finished
    booting.
-   **Fire-and-forget update()**: In `background.ts`, `update()` was called
    without `await` in message handlers, causing badge/menu race conditions on
    cold start.

### Implementation

-   `packages/extension/src/app.ts`:
    -   Tab capture moved before `super.load()` to fix stateChanged race
    -   Added `_waitForWorkerReady()` with ping/pong handshake (100-500ms
        window)
    -   Added fallback to "vaults" when `routerState.path` is empty
-   `packages/extension/src/background.ts`:
    -   Added ping/pong case in message handler
    -   All `update()` calls now awaited
-   `packages/extension/src/message.ts`:
    -   Added `ping` and `pong` to Message union
-   `packages/extension/test/cold-start.ts`:
    -   New test suite covering cold-start scenarios

### Reference Paths

-   `packages/extension/src/app.ts:46` — tab capture moved before `super.load()`
-   `packages/extension/src/app.ts:53-70` — `_waitForWorkerReady()` and routing
    logic
-   `packages/extension/src/background.ts:114` — `await update()` call
-   `packages/extension/src/message.ts:13-14` — ping/pong message types

## Task 6: Multi-Field Login Form Autofill

### Key Findings

-   **Context menu bug**: `handleContextMenuClick` used a single regex
    `^item\/([^\/]+)(?:\/(\d+))?$` but then called `parseInt(ind)` where `ind`
    is `undefined` for `item/{id}`. `parseInt(undefined)` → `NaN`, `isNaN(NaN)`
    → `true`, causing early return. The top-level item click did nothing.
-   **Field classification lives in content script**: Page field roles
    (username/password/TOTP) are determined by the content script scanning the
    DOM, not from item data. This decouples item data from page structure.
-   **Shadow DOM traversal required**: Many modern sites use Web Components with
    shadow DOM — field detection must walk shadow roots.
-   **TOTP fill value**: `Field.transform()` for `Totp` type runs
    `totp(base32ToBytes(value))` which returns the live OTP code, not the
    secret.
-   **Menu title UX signal**: Appending `▸ Fill Login` to the item name when it
    has username+password fields gives users a clear affordance.

### Implementation

-   `message.ts`: New `FieldMappings` type and `fillFields` message for
    orchestrated multi-field fill
-   `content.ts`: `_detectFieldTypes()` traverses DOM + shadow roots,
    `_classifyField()` classifies by heuristics, `_fillFields()` orchestrates
-   `background.ts`: Two distinct regex patterns in `handleContextMenuClick` —
    `item/{id}/{fieldIndex}` (single) and `item/{id}` (multi).
    `fillItemMultiField()` extracts fields by `FieldType` and sends `fillFields`
-   `app.ts`: `_fieldClicked()` wired to `field-clicked` event — transforms and
    sends `fillActive` for single-field popup fill

### Reference Paths

-   `packages/extension/src/content.ts:175` — original single-field fill
    (unchanged, remains fallback)
-   `packages/extension/src/message.ts:5` — `FieldMappings` type and
    `fillFields` message
-   `packages/extension/src/background.ts:119` — rewritten
    `handleContextMenuClick` with two-pattern dispatch
-   `packages/extension/src/app.ts:214` — `_fieldClicked()` implementation
-   `packages/extension/test/autofill.ts` — test suite for classification,
    parsing, and orchestration logic

## Task 7: Content Script Field Detection Reliability

### Key Findings

-   **Label text resolves field purpose**: `aria-labelledby`, `aria-label`,
    `<label for>`, and ancestor `<label>` text collectively identify field
    purpose on virtually all modern login pages — Google, GitHub, Salesforce,
    Okta, Azure AD, Slack all use these attributes.
-   **TOTP via pattern+maxLength**: `pattern="\d+"` + `maxLength` in [4,8]
    reliably detects OTP fields even without name/id signals. Combined with
    `inputmode="numeric"`, this covers numeric-only OTP inputs.
-   **React/Vue/Angular need `beforeinput`**: React 18+ reads `input.value` in
    `beforeinput` before the DOM value is set. Using `InputEvent` (not plain
    `Event`) for both `beforeinput` and `input` is required.
-   **Selection range gating**: React and Vue controlled inputs check
    `selectionStart`/`selectionEnd` before accepting input. Restoring selection
    after value assignment prevents framework-side rejection.
-   **form="" attribute**: Inputs rendered outside a `<form>` but associated via
    `form="id"` must be found by querying the external form element via
    `CSS.escape(id)`.
-   **Shadow DOM is recursive**: `querySelectorAll("*")` on a shadow root finds
    elements whose shadow roots must then be recursively queried — a two-level
    walk is insufficient for deeply nested web components.

### Reference Paths

-   `packages/extension/src/content.ts:180` — `_getLabelText()` helper
    (aria-labelledby, aria-label, form.labels, ancestor label)
-   `packages/extension/src/content.ts:214` — `_fill()` with `beforeinput` +
    `InputEvent` + selection preservation + Angular key events
-   `packages/extension/src/content.ts:293` — `_collectFields()` with form=""
    attribute support and recursive shadow DOM traversal
-   `packages/extension/src/content.ts:336` — `_classifyField()` with
    multi-signal TOTP/OTP detection (pattern, maxLength, inputmode)
-   `packages/extension/test/content.ts` — full test suite for classification,
    SaaS patterns, shadow DOM, fill events

## Task 3: Biometric/Passkey Re-Unlock

### Key Findings

-   The extension already had all needed primitives after Tasks 1 and 2:
    persistent encrypted `rememberedMasterKey` state in local storage, volatile
    raw master key in `browser.storage.session`, and popup-context WebAuthn
    support.
-   The missing glue was a popup-side helper that explicitly reuses
    `unlockWithRememberedMasterKey(token)` and a cold-start decision that
    prefers biometric re-unlock when the volatile session key is gone.
-   MV3 worker reload also drops scheduled alarms, so restoring unlocked state
    from `browser.storage.session` must restart auto-lock or the worker quietly
    stops enforcing the configured lock delay.

### Reference Paths

-   `packages/extension/src/auth/biometric.ts` — popup-context biometric
    re-unlock helper and cold-start gating helper
-   `packages/extension/src/app.ts` — session-key restore first, biometric
    fallback second
-   `packages/extension/src/background.ts` — auto-lock timer restart after
    worker-side session restore
-   `packages/extension/test/biometric.ts` — coverage for biometric unlock and
    extension-reload timer restoration

## Task: Save/Update Credential Flow

### Key Findings

-   Submit detection lives entirely in the content script:
    `_listenForFormSubmit()` attaches submit listeners to all forms on pages
    containing password fields, captures username + password on submit, and
    sends `formSubmitDetected` to the background service worker.
-   Background handles the orchestration: checks for existing vault items
    matching the URL, creates a save prompt (new) or update prompt (existing),
    and stores it in a `pendingPrompts` map keyed by UUID.
-   Popup renders a centered overlay on `_unlocked()` → `_checkForSavePrompt()`
    path: fetches the pending prompt via `getSavePrompt`, shows a card with
    hostname/username/password, and presents Save/Update + Not Now buttons.
-   Suppression is URL-based: dismissed URLs are suppressed for 1 hour
    (`DISMISSAL_DURATION_MS`), preventing duplicate prompts after a user
    dismisses the overlay.
-   Content script also suppresses within-page-session: `submittedUrls` Set
    prevents double-sends for the same URL after navigation.
-   The popup overlay uses DOM insertion (`insertAdjacentHTML`) with click
    handlers wired inline — no complex state management needed.
-   Edge case: `handleFormSubmitDetected` in background collects password fields
    from anywhere on the page (not just the submitted form), which can pair
    credentials from different forms on complex pages.

### Reference Paths

-   `packages/extension/src/content.ts:494` — `_listenForFormSubmit()` with form
    attachment, credential capture, deduplication
-   `packages/extension/src/content.ts:514` — `findUsernameInput()` heuristic
    for username field detection
-   `packages/extension/src/background.ts:21` — `pendingPrompts` map and
    `dismissedUrls` suppression map
-   `packages/extension/src/background.ts:311` — `handleFormSubmitDetected()` —
    checks lock/login state, existing items, creates prompt
-   `packages/extension/src/background.ts:357` — `handleSaveCredential()` —
    creates new vault item via `application.createItem()`
-   `packages/extension/src/background.ts:392` — `handleUpdateCredential()` —
    updates username + password fields on existing vault item
-   `packages/extension/src/background.ts:420` — `handleDismissPrompt()` —
    clears prompt, sets 1-hour suppression for URL
-   `packages/extension/src/app.ts:37` — `_pendingSavePrompt` and
    `_savePromptOverlay` state
-   `packages/extension/src/app.ts:279` — `_checkForSavePrompt()` fetches
    pending prompt from worker
-   `packages/extension/src/app.ts:293` — `_renderSavePromptOverlay()` — injects
    card DOM with save/update + dismiss buttons
-   `packages/extension/src/app.ts:358` — `_handleSavePromptAction()` — sends
    `saveCredential` or `updateCredential` to worker
-   `packages/extension/src/app.ts:373` — `_handleDismissPrompt()` — sends
    `dismissPrompt`, suppresses future prompts
-   `packages/extension/src/message.ts:17` — `CredentialData` interface
    (username, password, url)
-   `packages/extension/src/message.ts:26` — `SavePrompt` interface (id, url,
    username, password, existingItem, dismissedUntil)
-   `packages/extension/test/save.ts` — comprehensive test suite for form
    detection, suppression, credential data, message types

## Task 9: Extension Runtime Test Harness

### Key Findings

-   **MV3 extension loading in Playwright**: Requires
    `--disable-extensions-except=${EXT_DIR}` and `--load-extension=${EXT_DIR}`
    Chromium launch flags. Without these, Chrome silently ignores the unpacked
    extension.
-   **Keeping MV3 workers alive in tests**: Service workers are killed ~30s
    after last activity. Use
    `--disable-backgrounding-occluded-windows --disable-renderer-backgrounding`
    flags to prevent worker dormancy during the test run.
-   **Extension ID discovery**: Chrome assigns IDs to unpacked extensions. The
    `ChromeExtension.getExtensions` CDP command returns `{ id, name, url }` for
    each loaded extension — use this instead of hardcoding or reading manifest
    keys.
-   **`PL_SERVER_URL` is baked at build time**: `webpack.DefinePlugin` replaces
    `process.env.PL_SERVER_URL` during webpack. The CI workflow passes
    `PL_SERVER_URL=https://api-staging.example.com` to the build step so the
    running extension uses staging, not localhost.
-   **Content script on `file://`**: The `<all_urls>` host permission covers
    `file://` URLs. The content script attaches after `networkidle`; an
    additional 500ms wait ensures the script's `ExtensionContent.init()` has
    completed before test messages are sent.
-   **Ping/pong as liveness signal**: The `ping`/`pong` message pair (from Task
    5 cold-start work) is the most reliable worker-liveness test — works
    regardless of auth state.
-   **Two-test-lane separation**: Existing `test/*.ts` (mocha + sinon) tests
    unit-level logic (classification, cold-start state, OAuth stubs, biometric
    gating). The new Playwright harness tests the runtime contract: popup load,
    background message routing, content script attachment. Both run in CI.

### Reference Paths

-   `packages/extension/test-harness/playwright.config.ts` — Chromium launch
    flags for MV3 extension loading
-   `packages/extension/test-harness/smoke.spec.ts:8` — `getExtensionId` via
    `ChromeExtension.getExtensions` CDP
-   `packages/extension/test-harness/smoke.spec.ts:48` — `ping`/`pong` worker
    liveness test
-   `packages/extension/test-harness/smoke.spec.ts:99` — Content script
    `isContentReady` via CDP tab target lookup
-   `packages/extension/test-harness/fixtures/login-form.html` — TOTP field:
    `inputmode="numeric"` + `maxLength=6` + `pattern="\d{6}"` matching
    content-script detection signals
-   `.github/workflows/build-web-extension.yml:46` — Playwright install + test
    step after extension build
-   Root `package.json:65` — `test:extension` lane: build + harness

## Task 10: CI, Proof Lanes, and Operator Docs

### Key Findings

-   **`run-tests.yml` had zero extension runtime coverage**: The workflow built
    the extension but never ran the Playwright harness. The `test` job's
    `npm test` runs `lerna run test` which only executes `test/*.ts` mocha
    suites, not `test-harness/*.spec.ts` Playwright tests.
-   **`build-web-extension.yml` already had the test step**: Lines 46-51 of
    `build-web-extension.yml` were already correct. The gap was `run-tests.yml`
    not running extension tests on PRs.
-   **`PL_SERVER_URL` is build-time only**: The CI workflows pass
    `PL_SERVER_URL=https://api-staging.example.com` to the build step so the
    running extension uses staging. This is already documented in the harness
    config.
-   **Two CI workflows cover extension changes**: `build-web-extension.yml`
    (build + sign + archive) on push to main/feature/fix, and `run-tests.yml`
    (unit + extension-runtime) on PR and push. Together they cover build
    verification and runtime test coverage.

### Implementation Summary

| File                                     | Change                                                                            |
| ---------------------------------------- | --------------------------------------------------------------------------------- |
| `README.md`                              | Added extension dev/test section                                                  |
| `packages/extension/README.md`           | Full rewrite: feature table, build options, testing lanes, CI summary, arch notes |
| `.github/workflows/run-tests.yml`        | Added `extension-runtime` job; added extension paths to push/PR triggers          |
| `scripts/proof-lanes/proof-extension.sh` | New lane: build + manifest check + Playwright harness                             |
| `scripts/proof-lanes/help.sh`            | Added `proof:extension` entry                                                     |
| `package.json`                           | Added `proof:extension` script; updated `proof:all` chain                         |

### Reference Paths

-   `README.md:140` — Extension commands in monorepo README
-   `packages/extension/README.md` — Full extension operator documentation
-   `.github/workflows/run-tests.yml:59` — `extension-runtime` CI job
-   `scripts/proof-lanes/proof-extension.sh` — Extension proof lane script
-   `scripts/proof-lanes/help.sh:22` — Extension lane in help output

## Final Wave Fixes (Post F2 and F4 Rejections)

### F2 Rejections Fixed

**Issue 1 — `process.env.PL_APP_NAME` in MV3 service worker
(background.ts:263):**

-   Already fixed before F2 re-run (was `process.env.PL_APP_NAME || ""`, changed
    to hardcoded `"CH5 Auth"`)

**Issue 2 — `vaultId as any` in background.ts:**

-   `packages/extension/src/background.ts:369-371`
-   Changed `application.getVault(vaultId as any)` →
    `application.getVault(vaultId!)`
-   Non-null assertion is valid here: ternary already guarantees `vaultId` is
    truthy when this branch executes

**Issue 3 — Empty `catch (e) {}` in message.ts:**

-   `packages/extension/src/message.ts:59-61`
-   Replaced with `.catch(() => false)` — returns false on content script
    not-yet-injected, which is the correct semantic
-   Pattern: `await browser.tabs.sendMessage(...).catch(() => false)` — no
    comment needed, code is self-documenting

### F4 Rejections Fixed

**Issue 1 — `process.env.PL_SERVER_URL` in MV3 SW (background.ts):**

-   `packages/extension/src/background.ts:13` — Added
    `const API_BASE_URL = "https://api.example.com";`
-   `packages/extension/src/background.ts:30` — Changed
    `new AjaxSender(process.env.PL_SERVER_URL!)` →
    `new AjaxSender(API_BASE_URL)`
-   Root cause: AGENTS.md rule says MV3 service workers do not provide `process`
    — even webpack DefinePlugin substitution is insufficient since the SOURCE
    would contain `process.env`, misleading future developers

**Issue 2 — Extension `WebAuthnClient` not wired:**

-   `packages/extension/src/platform.ts:5` — Added
    `import { webAuthnClient } from "./auth/webauthn";`
-   `packages/extension/src/platform.ts:20-21` — Added explicit return of
    `webAuthnClient` for `AuthType.WebAuthnPlatform` and
    `AuthType.WebAuthnPortable` in `_getAuthClient`
-   Previously, WebAuthn auth fell through to `super._getAuthClient()` which
    returned the web app's `webAuthnClient` — the extension's dedicated client
    was never used

**Issue 3 — Playwright smoke harness under-delivered Task 9:**

-   `packages/extension/test-harness/smoke.spec.ts` — Added 4 new smoke tests:
    -   Manifest `identity` permission check
    -   Content script `<all_urls>` registration check
    -   Autofill routing test: sends `fillFields` with username/password/totp,
        verifies correct DOM fields receive values (proves content script
        classification + routing)
    -   `fillFields` background→content routing test
-   Removed fixture attribute inspection test (didn't actually test content
    script behavior)

### Final Wave Results

-   F1 Plan Compliance Audit: **APPROVED** (1st run)
-   F2 Code Quality Review: **APPROVED** (2nd run — after vaultId fix and catch
    fix)
-   F3 Real Manual QA: **APPROVED** (1st run)
-   F4 Scope Fidelity Check: **APPROVED** (3rd run — after API_BASE_URL
    hardcode, WebAuthn wiring, and smoke test expansion)

## Popup Reopen + Biometric Follow-up

### Root Cause: unlock persistence raced popup teardown

-   The extension already had a session-restoration design
    (`browser.storage.session`) and a biometric re-unlock path, but successful
    unlock still depended on the popup's throttled `stateChanged()` subscriber
    to eventually call `_syncUnlockedState()`. When the user unlocked and closed
    the popup quickly, the popup context could die before that async save
    completed.
-   Concrete cause: `packages/core/src/app.ts:611-615` uses a throttled,
    non-awaited `publish()`. The unlock UI calls `app.unlock(...)` directly from
    `packages/app/src/elements/unlock.ts:214`, so extension-specific session
    persistence was not on the direct unlock path.
-   Before fix, `packages/extension/src/app.ts:_unlocked()` did
    `void this._syncUnlockedState()`, which made session-key persistence
    best-effort instead of required.

### Fix Shape

-   Added `packages/extension/src/unlock-persistence.ts` with
    `installUnlockPersistenceHooks()` that wraps `app.unlock()` and
    `app.unlockWithMasterKey()` so successful unlock cannot resolve before
    `persistUnlockedState()` completes.
-   Updated `packages/extension/src/app.ts` to install those hooks during popup
    load, dedupe concurrent persistence with `_sessionSyncPromise`, and await
    lock/unlock transition handlers before emitting the debounced
    `state-changed` message to background.
-   This preserves the extension's existing biometric path while removing the
    popup-close race that was making it feel like the extension "forgot" the
    unlock instantly.

### Biometric Availability Status

-   The shared unlock screen already has a biometric button at
    `packages/app/src/elements/unlock.ts:190` and auto-attempts biometric
    re-unlock when `app.remembersMasterKey` is true and the platform supports a
    platform authenticator.
-   The settings UI already exposes enable/disable biometric unlock in
    `packages/app/src/elements/settings-security.ts:617-739`.
-   The extension platform now advertises WebAuthn platform + portable auth in
    `packages/extension/src/platform.ts`, and extension-specific biometric
    re-unlock uses `packages/extension/src/auth/biometric.ts`.
-   Repo status for the broader watch-approval idea: existing iOS/Android
    surface is Cordova (`packages/cordova`), not React Native; there is no
    watchOS app yet, so watch approval would extend the existing iOS shell plus
    add a new watch target rather than reuse an existing watch client.

### Verification Notes

-   Added targeted unit test `packages/extension/test/unlock-session.ts` for the
    new hook contract: successful unlock must await session persistence before
    resolving.
-   Direct compile check of `src/unlock-persistence.ts` +
    `test/unlock-session.ts` succeeded under the available local Node runtime.
-   Full extension package build/test lanes are currently blocked by older,
    broader extension compile issues already present in `content.ts` and other
    files, so this popup fix was verified narrowly rather than via a full clean
    bundle rebuild in this session.

## Popup White-Screen Investigation

### Root Cause

-   The popup startup path in `packages/extension/src/popup.ts` used
    `await import("./app")` before registering `window.onload`. If that import
    failed for any reason, the popup stayed on the static spinner forever with
    no visible error.
-   The currently loaded dist bundle also shows a broken `content.js` artifact
    containing a webpack parse failure stub, which is strong evidence the
    extension build output can be partially stale/bad even while `popup.html`
    still renders.
-   `packages/extension/dist/popup.js` sets `__webpack_require__.p = "/"`, so
    extension chunk loading is sensitive to how the bundle was built and loaded.
    Making popup startup failure explicit is important even before the broader
    build debt is repaired.

### Mitigation Added

-   `packages/extension/src/popup.ts` now:
    -   starts from `DOMContentLoaded`/immediate-ready instead of assigning
        `window.onload` after the dynamic import,
    -   wraps startup in `try/catch`,
    -   logs the startup failure to console, and
    -   replaces the spinner with a visible error message instead of hanging
        forever.

### Operator Meaning

-   If popup startup still fails after this, the extension should now show an
    explicit load error instead of an endless spinner, which makes the next
    debugging pass much faster.
-   The deeper rebuild issue remains: extension source cannot currently be
    cleanly rebuilt until pre-existing compile failures in
    `packages/extension/src/content.ts` and related files are corrected.
