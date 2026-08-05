# Chrome Extension MV3 Unlock Notes

## Findings

-   The old MV3 flow treated the background service worker as the session
    keystore: the popup sent the raw master key to `background.ts`, and the
    popup asked the worker for that same key again on later opens.
-   That breaks on every cold start because MV3 service workers are ephemeral;
    worker restart is normal, not exceptional.
-   `rememberedMasterKey` already exists in core as the right cross-restart
    biometric pattern: keep an encrypted `StoredMasterKey` in persistent app
    state, then fetch the unwrap key through authenticated biometric access.

## Design

-   `browser.storage.session` is now the only place raw master key material is
    stored outside live memory.
-   The session record is scoped by `accountId` and `sessionId` so a stale
    session unlock blob is ignored after logout or session churn.
-   `browser.storage.local` still stores extension app state, including
    encrypted `rememberedMasterKey`, but never stores raw master key
    bytes/base64.
-   Popup and worker both restore unlock state from `browser.storage.session`;
    the worker no longer acts as a master-key relay.
-   WebAuthn auth types are exposed on `ExtensionPlatform` so the existing
    remembered-master-key UX can light up in the extension.

## Implementation Notes

-   `packages/extension/src/storage.ts` now owns the MV3 session-key helpers:
    configure access level, write/read session unlock state, and clear it on
    lock/logout.
-   `packages/extension/src/app.ts` restores from `browser.storage.session` on
    popup load, writes the session key after unlock, and clears it on
    lock/logout.
-   `packages/extension/src/background.ts` restores from
    `browser.storage.session` after worker startup and after popup unlock
    messages, so service-worker wake is a supported path.
-   `packages/extension/src/message.ts` no longer ships raw master key payloads
    over runtime messages.
-   `packages/extension/src/platform.ts` now exposes Email, TOTP, and supported
    WebAuthn types.

## Verification Notes

-   `npm run build` passed in `packages/extension` after the refactor.
-   LSP diagnostics could not be collected because the workspace TypeScript
    server timed out during initialize in this session.

## Task 2: WebAuthn/Passkey Auth Support

### Findings

- `WebPlatform._getAuthClient` originally returned `webAuthnClient` for `AuthType.WebAuthnPlatform` and `AuthType.WebAuthnPortable`, but it was private and could not select extension-native clients. It is now protected and `ExtensionPlatform` explicitly selects its OAuth and WebAuthn clients.
- The extension popup context exposes `navigator.credentials`, so it can invoke the browser/OS authenticator for CH5 Auth account authentication. This does not make the extension an arbitrary relying-party passkey provider.
- `@simplewebauthn/browser` 5.4.0 and `@simplewebauthn/typescript-types` 5.4.0 resolved correctly from `@padloc/app/node_modules/` via the existing tsconfig path aliases and webpack alias resolution.
- `packages/core/src/auth.ts` defines `AuthType.WebAuthnPlatform` ("webauthn_platform") and `AuthType.WebAuthnPortable` ("webauthn_portable") — both match the server-side WebAuthn flow.
- The legacy Node server has WebAuthn verification code, but the shipped Cloudflare Worker currently registers only Email and TOTP auth servers. WebAuthn cannot complete against the production Worker until a Worker-compatible verifier and configuration are wired.

### Implementation

- `packages/extension/src/auth/webauthn.ts` — extension-scoped `WebAuthnClient` mirroring `@padloc/app/src/lib/auth/webauthn.ts`. Uses `@simplewebauthn/browser` directly via `browserSupportsWebauthn()`, `platformAuthenticatorIsAvailable()`, `startRegistration()`, `startAuthentication()`.
- `packages/extension/package.json` — added `@simplewebauthn/browser` 5.4.0 and `@simplewebauthn/typescript-types` 5.4.0 as dependencies; added `mocha` 9.2.2, `chai` 4.3.4, `@types/chai`, `@types/mocha` for test coverage.
- `packages/extension/test/webauthn.ts` — smoke tests for `ExtensionPlatform.supportedAuthTypes` and `WebAuthnClient.supportsType` behavior.
- `packages/extension/src/platform.ts` — explicitly selects the extension WebAuthn client for CH5 Auth account authentication.

### Verification

- The current verified extension build bundles the client successfully. End-to-end WebAuthn remains gated on Worker verifier wiring and is not evidence of third-party passkey-provider support.

## Task 3: Extension-Native OAuth Flow

### Findings

-   `packages/app/src/lib/auth/oauth.ts` uses `window.open` + `postMessage` to
    handle OAuth — this does NOT work in extension popup context because the
    popup is a separate browsing context that doesn't receive `postMessage` from
    the auth window.
-   `chrome.identity.launchWebAuthFlow` is the Chrome extension-native OAuth
    API: opens provider auth URL in a browser-managed window, intercepts the
    redirect to `https://<extension-id>.chromiumapp.org/provider_callback_path`,
    and returns the final URL with code/state params.
-   `ExtensionPlatform` now overrides `_getAuthClient` to return the extension's
    `oauthClient` for `AuthType.Oauth` instead of the web `OauthClient`.
-   The `identity` permission was added to `manifest.json` to enable
    `chrome.identity.launchWebAuthFlow`.

### Implementation

-   `packages/extension/src/auth/oauth.ts` — extension `OauthClient` using
    `browser.identity.launchWebAuthFlow`. Mirrors the `AuthClient` interface:
    `prepareRegistration` and `prepareAuthentication` both call
    `_getAuthorizationCode` which launches the web auth flow and returns
    `{ code, state }`.
-   `packages/extension/src/platform.ts` — added `AuthType.Oauth` to
    `supportedAuthTypes` and overridden `_getAuthClient` to return `oauthClient`
    for OAuth type.
-   `packages/extension/src/manifest.json` — added `"identity"` permission.
-   `packages/extension/test/oauth.ts` — tests covering success (code+state
    returned), cancel (rejects with AUTHENTICATION_FAILED), error callback
    (rejects with error param), no redirect URL, and missing code param.

### Key Difference from Web OAuth

| Aspect          | Web OAuth                            | Extension OAuth                                      |
| --------------- | ------------------------------------ | ---------------------------------------------------- |
| Auth window     | `window.open` popup                  | `chrome.identity.launchWebAuthFlow`                  |
| Callback        | `postMessage` from popup             | `launchWebAuthFlow` returns redirect URL             |
| Cancel handling | Window closed detection              | Promise rejection from `launchWebAuthFlow`           |
| Redirect URL    | Must match registered OAuth callback | Uses `chrome-extension://id.chromiumapp.org/` domain |

### Verification

-   `tsc --noEmit` passed (0 errors).
-   `npm run build` passed.

## Task 5: Popup Cold-Start State Restoration

### Findings

-   **Race condition in `ExtensionApp.load()`**: `super.load()` was called
    before tab capture. Since `super.load()` fires `stateChanged()`, and
    `stateChanged()` sends `state-changed` to background which triggers
    `application.reload()` (async), the popup was making routing decisions
    before the background had finished reloading.
-   **Critical ordering bug**: `stateChanged()` fires during `super.load()` and
    reads `state.context.browser?.url` to compute matching items. The tab was
    captured AFTER `super.load()`, meaning `_matchingItems` returned empty on
    cold start even when there were items for the current tab.
-   **Worker liveness**: MV3 service workers can be killed after ~30s
    inactivity. The popup had no way to know if the worker was alive and had
    finished initializing before making routing decisions.
-   **`update()` fire-and-forget**: In `background.ts`, `update()` (which calls
    `updateBadgeAndContextMenu()`) was called without `await` in the message
    handler, creating race conditions on cold start where the badge/menu update
    happened after the popup had already made routing decisions.

### Implementation

-   `packages/extension/src/app.ts`:
    -   Moved `browser.tabs.query()` and `state.context.browser` assignment
        BEFORE `super.load()` to fix the race condition
    -   Added `_waitForWorkerReady()` which pings the worker with a 100-500ms
        wait window to ensure cold start settlement
    -   Added fallback to "vaults" when `routerState.path` is empty
-   `packages/extension/src/background.ts`:
    -   Added `case "ping": return { type: "pong" }` handler for worker liveness
        check
    -   Changed all `update()` calls in message handler to `await update()`
-   `packages/extension/src/message.ts`:
    -   Added `| { type: "ping" }` and `| { type: "pong" }` to Message union
-   `packages/extension/test/cold-start.ts`:
    -   New test file covering: ping/pong worker liveness, router state
        restoration, matching items comparison, tab capture ordering, session
        key availability, background message handling, routing decision logic

### Verification

-   `tsc --noEmit` passed (0 errors).
-   `npm test` passed (all suites).
-   `npm run build` passed.

## Task 6: Multi-Field Login Form Autofill

### Findings

-   Current fill path (`content.ts:175`) fills a single value into the active
    input via `fillActive` message.
-   `handleContextMenuClick` in `background.ts:119` parsed
    `item/{id}/{fieldIndex}` but had a bug: `parseInt(undefined)` returns `NaN`,
    so `isNaN(NaN)` is `true`, causing early return for the top-level
    `item/{id}` menu item — meaning the item-level menu click did nothing.
-   Field classification is not on the item level but on the content-script
    level: `content.ts` detects field types by traversing the page DOM and
    classifying inputs by `type`, `name`, `id`, `autocomplete`, and
    `placeholder` attributes.
-   `FieldType` enum from `core/src/item.ts` distinguishes `Username`,
    `Password`, and `Totp` — each with their own `transform()` method for
    getting the fill value.

### Implementation

-   `packages/extension/src/message.ts`:
    -   Added `FieldMappings` type
        (`{ username?: string; password?: string; totp?: string }`)
    -   Added `fillFields` message type for multi-field orchestration
-   `packages/extension/src/content.ts`:
    -   Added `FieldRole` enum (`Username`, `Password`, `Totp`)
    -   Added `_detectFieldTypes()` — traverses document and shadow roots,
        classifies each fillable input
    -   Added `_classifyField()` — heuristic classification by
        type/name/id/autocomplete/placeholder
    -   Added `_fillFields()` — fills multiple fields based on detected types,
        falls back to single-field on active input
    -   Added `fillFields` case in `_handleMessage`
-   `packages/extension/src/background.ts`:
    -   Added import of `FieldType` from `@padloc/core/src/item`
    -   Added `fillItemMultiField()` — extracts username/password/totp from item
        and sends `fillFields` message
    -   Rewrote `handleContextMenuClick()` with two regex patterns:
        `item/{id}/{fieldIndex}` (single-field) and `item/{id}` (multi-field)
    -   Menu item title appends `▸ Fill Login` when item has both
        username+password fields
-   `packages/extension/src/app.ts`:
    -   Enabled `field-clicked` event listener (was commented out)
    -   Implemented `_fieldClicked()` — transforms field value and sends
        `fillActive` to content script
-   `packages/extension/test/autofill.ts`:
    -   New test suite covering: field classification, context menu ID parsing,
        multi-field orchestration, mappings, fallback

### Key Design Decisions

-   **Content script field detection**: Field roles are determined by the
    content script scanning the live DOM, not by the item data. This handles any
    site's specific field naming/structuring.
-   **Shadow DOM traversal**: `_detectFieldTypes()` walks shadow roots to handle
    Web Components.
-   **Cascading fallback**: `_fillFields()` prioritizes dedicated TOTP fields,
    then password fields, then username fields for OTP fill.
-   **Menu title UX**: Items with both username+password show `▸ Fill Login` to
    signal the multi-field action.
-   **TOTP transform**: `Field.transform()` for `Totp` type calls
    `totp(base32ToBytes(value))` — returns the current OTP code.

### Verification

-   `tsc --noEmit` passed (0 errors).
-   `npm test` passed (all suites).
-   `npm run build` passed.

## Task 7: Content Script Field Detection Reliability

### Findings

-   **Label text is a strong signal**: `aria-labelledby`, `aria-label`,
    `<label for>`, and ancestor `<label>` text all reliably identify field
    purpose on modern SaaS login pages (Google, GitHub, Salesforce, Okta, Azure
    AD, Slack).
-   **TOTP detection via pattern+maxLength**: Fields with `pattern="\d+"` and
    `maxLength` in [4,8] are almost always OTP inputs — catches sites that don't
    use `autocomplete="one-time-code"`.
-   **inputmode as OTP signal**: `inputmode="numeric"` combined with `maxLength`
    in [4,8] catches numeric OTP inputs even without name/id/placeholder hints.
-   **autocomplete=new-password/current-password**: Even on non-password-type
    inputs, these indicate password fields.
-   **React/Vue/Angular fill**: Requires `beforeinput` (React 18+), `InputEvent`
    for `input` (not `Event`), and Enter-key `KeyboardEvent` dispatch for
    Angular.
-   **Selection range preservation**: React/Vue controlled inputs gate on
    `selectionStart`/`selectionEnd` — restoring these after value assignment is
    required.
-   **form attribute association**: Inputs with `form="id"` but rendered outside
    the `<form>` element are associated with that form — queried via
    `CSS.escape()`.
-   **Shadow DOM traversal**: Recursive `element.shadowRoot` +
    `querySelectorAll("*")` pattern correctly finds all nested inputs.
-   **MV3 CSP compliance**: No eval, no Function constructor, no dynamic code —
    all event dispatch uses native `InputEvent`/`KeyboardEvent`/`Event`
    constructors.

### Implementation

-   `packages/extension/src/content.ts`:
    -   Added `_getLabelText()` — resolves `aria-labelledby`, `aria-label`,
        `form.labels`, and ancestor `<label>` text
    -   Expanded `_classifyField()` — adds `autocomplete` values
        (`current-password`, `new-password`, `username`, `one-time-code`),
        `data-field-type`/`data-field` dataset attrs, `labelText`, `pattern`
        (digit-only), `maxLength` (4-8 for OTP), `inputmode`, `aria-label`, and
        label text as classification signals
    -   Added `verification_code`/`verification`/`identifier`/`screen_name` name
        patterns for common SaaS forms
    -   Expanded TOTP signals: `labelText.includes("code")` catches generic
        "Enter code" labels
    -   Strengthened `_fill()` — uses `InputEvent` for `beforeinput` and `input`
        (not plain `Event`), preserves selection range, adds Enter-key
        `keydown`/`keyup`/`keypress` sequence for Angular compatibility
    -   Updated `_collectFields()` — collects `form` attribute IDs and queries
        external forms via `CSS.escape()`
-   `packages/extension/test/content.ts`:
    -   New test suite covering: plain DOM classification, modern SaaS patterns,
        TOTP pattern/maxLength/inputmode detection, aria-label/aria-labelledby
        resolution, label text resolution, shadow DOM traversal, form attribute
        association, fill event sequence, selection range preservation,
        multi-field orchestration ordering

### Key Design Decisions

-   **Multi-signal TOTP detection**: TOTP classification requires either a
    name/id/autocomplete signal OR (digit-only pattern AND valid length) OR
    (numeric inputmode AND valid length). Handles sites that use only
    `maxLength` or only `inputmode`.
-   **`beforeinput` as first event**: React 18+ reads `input.value` inside the
    `beforeinput` event handler before the value is set. Firing `beforeinput`
    first with `data=value` causes React to see the new value immediately.
-   **CSS.escape for form IDs**: Form IDs may contain dots, colons, spaces —
    using `CSS.escape()` prevents selector injection.
-   **Label resolution order**: `aria-labelledby` > `aria-label` >
    `form.labels[0]` > ancestor `<label>` — matches the HTML spec precedence.

### Verification

-   `tsc --noEmit` passed (0 errors).
-   `npm test` passed (all suites with tap reporter).
-   `npm run build` passed.

## Task 3: Biometric/Passkey Re-Unlock

### Findings

-   Task 1 already made `browser.storage.session` the volatile raw-master-key
    store, so Task 3 only needs to bridge popup WebAuthn auth into the existing
    `rememberedMasterKey` container path.
-   The shared unlock UI already knows how to call
    `unlockWithRememberedMasterKey(authToken)`; the extension gap was the
    cold-start/common-path handoff, not a missing core crypto primitive.
-   MV3 worker restarts also drop the auto-lock alarm, so background rehydration
    needs to restart the timer after restoring an unlocked session from
    `browser.storage.session`.

### Implementation

-   `packages/extension/src/auth/biometric.ts` — new extension helper that wraps
    `authenticate({ purpose: AccessKeyStore, type: WebAuthnPlatform, authenticatorId })`
    and then calls `unlockWithRememberedMasterKey(token)`.
-   `packages/extension/src/app.ts` — cold-start load now tries session-key
    restore first, then attempts biometric re-unlock when the session key is
    gone but `rememberedMasterKey` still exists.
-   `packages/extension/src/background.ts` — worker-side session rehydrate now
    restarts the auto-lock timer when unlock state is restored after worker
    reload.
-   `packages/extension/test/biometric.ts` — added coverage for the biometric
    gating logic, remembered-master-key unlock wrapper, expired authenticator
    fallback, and extension-reload auto-lock restart path.

## Task: Save/Update Credential Flow

### Findings

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

### Implementation

-   `packages/extension/src/content.ts` — `_listenForFormSubmit()` with form
    attachment, credential capture via `findPasswordInputs` /
    `findUsernameInput`, deduplication by URL
-   `packages/extension/src/background.ts` — `handleFormSubmitDetected()`,
    `handleGetSavePrompt()`, `handleSaveCredential()`,
    `handleUpdateCredential()`, `handleDismissPrompt()`
-   `packages/extension/src/app.ts` — `_checkForSavePrompt()`,
    `_renderSavePromptOverlay()`, `_handleSavePromptAction()`,
    `_handleDismissPrompt()`
-   `packages/extension/src/message.ts` — `CredentialData`, `SavePrompt`, and
    all save/update message types
-   `packages/extension/test/save.ts` — comprehensive test suite for form
    detection, suppression logic, credential data, message types

### Verification

-   `tsc --noEmit` passed (0 errors).
-   `npm test` passed (all suites).
-   `npm run build` passed.

### Scope Limitations

-   Login credentials only — no address, card, or profile saving.
-   No inline prompt bar in popup — uses centered card overlay.
-   Existing autofill and auth paths are untouched.

## Task 9: Extension Runtime Test Harness

### Findings

-   **MV3 extension loading in Playwright**: Chromium must be launched with
    `--disable-extensions-except=${EXT_DIR}` and `--load-extension=${EXT_DIR}`
    to replace the built-in extension loader with a custom one. Without these
    flags, the unpacked extension is silently ignored.
-   **MV3 service worker dormancy**: Workers are killed ~30s after last
    activity. The flags
    `--disable-backgrounding-occluded-windows --disable-renderer-backgrounding`
    prevent Chrome from suspending the worker process during tests, keeping it
    alive for the full test session.
-   **Extension ID discovery**: For unpacked extensions, the extension ID is
    assigned by Chrome based on the extension path/key. Use
    `ChromeExtension.getExtensions` CDP command to retrieve the assigned ID
    rather than hardcoding it.
-   **Content script attachment**: Content scripts attach to `file://` pages
    when `<all_urls>` is in `host_permissions`. Attachment timing is after
    `networkidle`, but a 500ms wait is added in the test as a safety margin.
-   **Background ping**: The `ping`/`pong` message pair (added in Task 5) is the
    primary reliable signal for worker liveness — it works regardless of auth
    state.
-   **`PL_SERVER_URL` is baked at build time**: `webpack.config.js` uses
    `DefinePlugin` to replace `process.env.PL_SERVER_URL` at build time. The
    extension does NOT read `PL_SERVER_URL` at runtime. In CI, the workflow
    passes `PL_SERVER_URL=https://api-staging.example.com` when building so the
    extension connects to staging.
-   **Test scope vs existing unit tests**: `test/*.ts` (mocha + sinon) tests
    unit-level logic (field classification, cold-start state machines, OAuth
    stubs, biometric gating). The Playwright harness tests the actual runtime
    contract: popup load, background message routing, content script attachment.
    Both lanes run in CI.

### Implementation

-   `packages/extension/test-harness/playwright.config.ts` — Playwright config
    targeting Chromium with extension loading flags, `chromium` device profile,
    `networkidle` timeout, and JSON/HTML reporters.
-   `packages/extension/test-harness/smoke.spec.ts` — 8 smoke tests covering:
    popup console errors, popup body non-empty, ping/pong worker liveness, badge
    updates on plain page, content script field detection on fixture, content
    script `isContentReady` response, manifest existence, and logged-out popup
    state.
-   `packages/extension/test-harness/fixtures/login-form.html` — Static login
    fixture with username (text), password, TOTP (numeric, maxLength=6,
    inputmode=numeric), and submit button. Serves as the autofill content-script
    test target.
-   `packages/extension/package.json` — Added `@playwright/test` ^1.40.0 and
    `playwright` ^1.40.0 as devDependencies. Added `test:harness` and
    `test:harness:install` scripts.
-   Root `package.json` — Added `test:extension` script:
    `npm run web-extension:build && npm run --prefix packages/extension test:harness`.
-   `.github/workflows/build-web-extension.yml` — After extension build,
    installs Playwright Chromium with deps and runs the harness. `PL_SERVER_URL`
    falls back to staging when not set.
-   `.gitignore` — Added `packages/extension/.playwright-html/`,
    `packages/extension/.playwright-results.json`, and
    `packages/extension/test-results/`.

### Verification

-   `npm run test:extension` locally builds the extension and runs the
    Playwright smoke suite.
-   CI runs the same suite after every extension-relevant push via the updated
    workflow.
-   Smoke test output includes JSON results (`.playwright-results.json`) for
    downstream tooling.

### Reference Paths

-   `packages/extension/test-harness/playwright.config.ts:17` — Extension
    loading Chromium flags
-   `packages/extension/test-harness/smoke.spec.ts:8` — `getExtensionId` via
    `ChromeExtension.getExtensions` CDP
-   `packages/extension/test-harness/smoke.spec.ts:48` — Background ping test
    via `chrome.runtime.sendMessage`
-   `packages/extension/test-harness/smoke.spec.ts:99` — Content script
    `isContentReady` test via CDP tab target lookup
-   `packages/extension/test-harness/fixtures/login-form.html` — TOTP field uses
    `inputmode="numeric"` + `maxLength=6` + `pattern="\d{6}"` matching
    content-script detection signals

## Task 10: CI, Proof Lanes, and Operator Docs

### Implementation

-   `README.md` — Added extension section covering
    `npm run web-extension:build`, `npm run test:extension`, and Chromium
    Playwright install.
-   `packages/extension/README.md` — Rewritten to document the full parity
    feature set, build options, testing lanes (unit + Playwright harness), CI
    coverage, and architecture notes.
-   `.github/workflows/run-tests.yml` — Added `extension-runtime` job that runs
    when extension/core/app/locale/asset files change. Job builds extension and
    runs `npm run test:extension` (Playwright harness). Also added extension
    paths to the push/PR triggers.
-   `scripts/proof-lanes/proof-extension.sh` — New proof lane: builds extension,
    verifies manifest exists, runs Playwright harness. Exit codes: 0 (pass), 1
    (build/test fail), 2 (Playwright missing).
-   `scripts/proof-lanes/help.sh` — Added `proof:extension` lane entry.
    `proof:all` now chains `proof:extension`.
-   `package.json` — Added `proof:extension` script and updated `proof:all` to
    include it.

### CI Coverage Summary

| Workflow                                | Trigger                                    | What it does                                |
| --------------------------------------- | ------------------------------------------ | ------------------------------------------- |
| `build-web-extension.yml`               | Push to main/feature/fix (extension paths) | Builds extension + signs .crx               |
| `run-tests.yml` (test job)              | PR + push to main (extension paths)        | Runs unit tests + prettier + runtime-config |
| `run-tests.yml` (extension-runtime job) | PR + push to main (extension paths)        | Builds + runs Playwright smoke harness      |

### Reference Paths

-   `README.md:140` — Extension commands in monorepo README
-   `packages/extension/README.md` — Full extension operator documentation
-   `.github/workflows/run-tests.yml:59` — `extension-runtime` job
-   `scripts/proof-lanes/proof-extension.sh` — Extension proof lane script
-   `scripts/proof-lanes/help.sh:22` — Updated help output with extension lane
