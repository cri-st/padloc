# @padloc/extension <!-- oc:id=sec_aa -->

The Padloc browser extension — a Chrome MV3 unpacked extension with full auth
parity, multi-field autofill, save/update credential prompts, and biometric
re-unlock.

## Parity Feature Set <!-- oc:id=sec_ab -->

| Feature                                                       | Status                                                                                                                           |
| ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Email + TOTP auth                                             | Complete                                                                                                                         |
| WebAuthn for CH5 Auth account authentication                  | Client implemented; Worker verifier not yet wired                                                                                |
| OAuth (Google, GitHub, etc.)                                  | Extension client implemented; Worker auth server not wired                                                                       |
| Biometric re-unlock (MV3 session key)                         | Complete                                                                                                                         |
| Multi-field login form autofill                               | Complete                                                                                                                         |
| Padloc-held passkeys for third-party relying parties          | Browser canary implemented; controlled CH5 RP five-credential create/get E2E passing; Google canary awaiting user-presence steps |
| Save / update credential prompts                              | Complete                                                                                                                         |
| Content script login/identity/address/payment field detection | Complete                                                                                                                         |
| Popup cold-start state restoration                            | Complete                                                                                                                         |
| Playwright runtime test harness                               | Complete                                                                                                                         |

## Setup <!-- oc:id=sec_ac -->

The `@padloc/extension` package is meant to be used from within the
[Padloc monorepo](../../README.md).

```sh
git clone git@github.com:padloc/padloc.git
cd padloc
npm ci
cd packages/extension
```

## Building <!-- oc:id=sec_ad -->

To build an unpacked version of the web extension, run from the monorepo root:

```sh
npm run web-extension:build
```

Or from the extension package directory:

```sh
cd packages/extension
npm run build
```

The resulting build is in `packages/extension/dist/`.

### Build Options <!-- oc:id=sec_ae -->

All build options are provided as environment variables:

| Variable Name            | Description                                                  | Default                                      |
| ------------------------ | ------------------------------------------------------------ | -------------------------------------------- |
| `PL_SERVER_URL`          | URL to the Worker backend                                    | `http://127.0.0.1:8787`                      |
| `PL_BUILD_ENV`           | Baked build label (e.g. `staging`)                           | `development`                                |
| `PL_PASSKEY_DIAGNOSTICS` | Expose redacted passkey stage diagnostics and console events | `true` outside production; otherwise `false` |

`PL_SERVER_URL` is baked into the extension at build time via webpack
`DefinePlugin`. The extension does not read this value at runtime.

Passkey diagnostics contain ceremony IDs, operation/RP metadata, stage, result,
and error category only. They are disabled by default for production builds; set
`PL_PASSKEY_DIAGNOSTICS=true` only for a bounded canary build.

### Installing an Unpacked Extension <!-- oc:id=sec_af -->

Google Chrome:

1. Open `chrome://extensions` <!-- oc:id=item_aa -->
1. Enable **Developer mode** (top right) <!-- oc:id=item_ab -->
1. Click **Load unpacked** <!-- oc:id=item_ac -->
1. Select `packages/extension/dist` <!-- oc:id=item_ad -->

Firefox is not yet in CI — see [packages/extension/NOTES.md](NOTES.md) for known
gaps.

## Testing <!-- oc:id=sec_ag -->

### Unit Tests (mocha) <!-- oc:id=sec_ah -->

```sh
cd packages/extension
npm test
```

Tests live in `test/*.ts` and cover field classification, cold-start state
machines, OAuth stubs, biometric gating, save/update message types, autofill
orchestration, passkey cryptography, RP/origin enforcement, and nonce-bound
approval and multi-credential selection.

### Runtime Smoke Tests (Playwright) <!-- oc:id=sec_ai -->

These tests load the actual built extension in a headless Chromium, verify popup
load, background message routing, content script attachment, and worker
liveness.

```sh
npm run test:extension
```

Run changed-only proof first when iterating:

```sh
npm run test:changed -- --since hq/main
```

This runs `web-extension:build` followed by the Playwright harness. Equivalent
to:

```sh
npm run web-extension:build
cd packages/extension && npx playwright test
```

The harness is headless by default so it does not steal focus. Use
`PADLOC_EXTENSION_HEADFUL=1 npm run test:extension` only for visual debugging.

### Agentic Google Passkey Proof <!-- oc:id=sec_agentic_google_passkey -->

Use the existing owned Chrome for Testing lane on CDP port `9812`; do not launch
another visible browser:

```sh
npm --prefix packages/extension run agentic:google-passkey -- --mode state --port 9812
```

After the disposable Google account has passed password reauth, run enrollment
and login proof from the same Chrome:

```sh
npm --prefix packages/extension run agentic:google-passkey -- --mode enroll --port 9812 --screenshots=1
npm --prefix packages/extension run agentic:google-passkey -- --mode clear-google-session --port 9812
npm --prefix packages/extension run agentic:google-passkey -- --mode login --port 9812 --screenshots=1
```

The helper refuses non-disposable Google accounts unless
`--allow-non-disposable` is explicitly set after disposable proof succeeds. Its
routine output redacts account identifiers and URL challenge tokens.

For Crown or other real accounts, use a dedicated Chrome for Testing profile and
a separate CDP port. Chris must complete the first Google ownership checkpoint
in the browser. Do not request or store Crown passwords by default.

For a non-Google public relying-party proof through the actual extension hook,
use the deterministic local RP first, then WebAuthn.io from an owned Chrome for
Testing lane with Padloc unlocked:

```sh
npm --prefix packages/extension run agentic:extension-cdp -- --mode local-rp-webauthn-proof --port 9831
npm --prefix packages/extension run agentic:extension-cdp -- --mode webauthn-io-proof --port 9831
npm --prefix packages/extension run agentic:extension-cdp -- --mode webauthn-me-proof --port 9831
```

If `--extension-id` is omitted, the helper discovers the loaded unpacked
extension ID from the CDP extension service-worker target. Pass
`--extension-id <id>` only when you are intentionally attaching to a known
historical lane.

Local RP pass means server-side registration and authentication checks pass,
including challenge, origin, RP ID hash, AAGUID, flags, transports, and
assertion signature. WebAuthn.io pass means `status=webauthn-io-proof`,
`ok=true`, fresh register/login succeeds, and WebAuthn.io shows
`You're logged in!`. WebAuthn.me is a secondary public-RP attempt; record the
JSON blocker if its tutorial controls fail to attach. The WebAuthn.io helper
deletes only `webauthn.io` test passkey items from the current Padloc test vault
before a fresh proof so a reused discoverable-credential lane cannot assert with
an older WebAuthn.io credential. Pass `--preserve-rp-passkeys=true` only when
intentionally testing the existing-profile path.

**First run**: Install the Chromium browser for Playwright:

```sh
cd packages/extension && npx playwright install chromium
```

The harness requires the extension to be built first (`dist/manifest.json` must
exist). The `globalSetup` in `playwright.config.ts` validates this before
running tests.

### CI Coverage <!-- oc:id=sec_aj -->

Both test lanes run in CI:

-   `run-tests.yml` — runs unit tests on every PR and main push
-   `build-web-extension.yml` — runs the Playwright harness after building on
    feature/fix branches and main push; archive the built extension as a `.crx`
    artifact

## Development <!-- oc:id=sec_ak -->

The extension dev workflow assumes the Padloc worker is running locally:

```sh
# From monorepo root
npm run worker:dev
```

Then build with your local API URL:

```sh
PL_SERVER_URL=http://127.0.0.1:8787 npm run web-extension:build
```

Load the `dist/` folder as an unpacked extension in Chrome. Reload the extension
in `chrome://extensions` after each build.

For hot-reload development, rebuild manually or use a file watcher.

## Architecture Notes <!-- oc:id=sec_al -->

-   **Three distinct credential paths**: CH5 Auth WebAuthn authenticates the
    user to Padloc through the browser or operating-system authenticator.
    Biometric re-unlock uses that CH5 Auth token to release the remembered vault
    key. Username/password/TOTP autofill writes approved vault values into web
    forms. The separate browser-provider path described below is what makes
    Padloc a passkey provider for explicitly enabled relying parties.
-   **Third-party passkey provider gate**: A Padloc-held passkey must retain an
    RP-scoped private key inside the encrypted vault and answer WebAuthn
    create/get requests after local user verification. A desktop extension can
    do this by replacing the page's WebAuthn methods in the main world while
    preserving a native fallback; mobile apps require the operating system's
    credential-provider surface. The extension now has the ES256 vault
    record/authenticator and the HTTPS-only main/isolated-world bridge with
    bounded native fallback, nonce-bound approval, recent password/biometric
    verification, RP option validation, and encrypted-vault persistence. The
    controlled `example.com` RP E2E creates five discoverable ES256 credentials,
    signs a fresh assertion with an exact redacted user choice, verifies the
    signature and RP hash in Chromium, preserves the multi-device zero counter,
    and reloads the credentials from encrypted vault storage. Ambiguous requests
    require a second, nonce-bound choice tied to the original RP, origin, tab,
    frame, and ceremony; stale or mismatched state fails closed. The current
    rollout remains an explicit CH5/Google canary; a complete public-suffix
    policy is still required before general enablement. See
    [the provider test plan](../../docs/passkey-provider-test-plan.md).
-   **Synchronized passkey semantics**: Vault-held passkeys are backup-eligible
    multi-device credentials. They use the WebAuthn zero-counter policy, and a
    registration is returned only after encrypted vault synchronization. Page
    abort/timeout disconnects the ceremony port; background lifetime and
    tab/origin checks are re-run around signing and persistence, with rollback
    if cancellation is observed after a local mutation.

-   **MV3 session key**: Raw master key is stored in `browser.storage.session`
    (volatile, survives worker restarts). The worker and popup both restore from
    session storage after cold start.
-   **No master-key relay**: The popup does not send the raw master key to the
    background worker. Both independently restore from session storage.
-   **Content script field detection**: Field roles are determined by the
    content script scanning the live DOM, not from item data. Handles shadow
    DOM, aria labels, login, identity, address, payment, and transient CVV
    roles.
-   **Agentic autofill bridge**: Padloc owns encrypted items and approval; Magic
    Browser owns browser execution and redacted proof. See
    [docs/agentic-autofill-bridge.md](../../docs/agentic-autofill-bridge.md).
-   **`PL_SERVER_URL` is build-time only**: The extension connects to the API
    URL that was active when it was built. Change the env var and rebuild to
    point to a different environment.

## Contributing <!-- oc:id=sec_am -->

For info on contributing to Padloc, please refer to the
[monorepo readme](../../README.md#contributing).
