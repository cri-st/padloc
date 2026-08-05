# Padloc Passkey Provider Test Plan

## Scope and terminology

This plan treats three independent contracts as separate features:

1. **Vault unlock** authenticates the user to CH5 Auth and releases the
   encrypted vault key. The current web/extension implementation delegates
   WebAuthn signing to a browser or operating-system authenticator.
2. **Password autofill** releases an approved username, password, or TOTP from
   an unlocked Padloc item and fills fields on a third-party page.
3. **Passkey provider** makes Padloc the credential manager for a third-party
   WebAuthn relying party. Padloc must retain the RP-scoped private key and sign
   the RP challenge only after local user verification.

OAuth authorizes access to an identity provider or API. It does not create or
use a Google Account passkey, and an OAuth success is not passkey evidence.

## Architecture gate

Desktop Chrome now has two intentionally separate provider lanes:

-   the CH5 Auth **browser-extension provider**, which intercepts an enabled RP
    at document start and returns a WebAuthn credential through the page bridge;
-   the CH5 Auth **macOS credential-provider extension**, which is discovered
    by AuthenticationServices and is selected from the operating-system passkey
    sheet after the browser delegates to the platform.

An Apple Passwords/iCloud Keychain result, a 1Password browser-extension result,
and a Chrome-profile passkey result are controls, not evidence for either CH5
lane. Every live result must record the provider surface that actually handled
the ceremony.

Do not start a live Google passkey canary until all of these are true:

-   A document-start main-world shim preserves the browser's native
    `navigator.credentials.create/get` functions, replaces them with Padloc's
    provider entry points, and can fall back without recursion.
-   An isolated-world bridge validates request shape, binds the request to the
    browser-reported tab/frame origin, and never accepts an RP ID that is not a
    registrable suffix of that origin.
-   The provider can request Padloc vault unlock through the platform's local
    authentication policy and returns cancellation without releasing key
    material.
-   The encrypted vault has a dedicated discoverable passkey record containing
    RP ID, opaque user handle, credential ID, algorithm/public metadata,
    encrypted private key, backup eligibility/state, and an explicit
    signature-counter policy.
-   The provider accepts only bridged create/get requests and validates caller
    RP/origin independently in the extension background. Native implementations
    validate the equivalent caller contract supplied by the operating system.
-   No password, vault key, private key, raw challenge, raw assertion, OAuth
    token, cookie, or biometric data is written to logs.

The current browser extension satisfies this gate for the explicit CH5/Google
canary policy. It has a vault-serializable ES256 passkey record, registration
and assertion construction, independent RP/origin checks, an HTTPS-only
document-start main-world shim, an isolated-world bridge, top-frame enforcement,
bounded native fallback, nonce-bound approval, recent password/biometric
verification with a master-password fallback when biometrics are unavailable or
stale, WebAuthn option validation, and encrypted vault save/update
orchestration. Chrome does not expose a general password-manager
passkey-provider API, so this page-bridge architecture preserves the native
browser authenticator when Padloc cannot safely answer. A complete public-suffix
policy remains required before general enablement.

The canary implementation now includes a two-phase ambiguous-credential flow:
the user first approves the ceremony and then chooses from redacted account
labels. Each choice is bound to the ceremony request ID, RP ID, origin, tab,
frame, extension UI sender, one-time nonce, and expiration. Candidate tokens are
invocation-local indexes; credential IDs and private material never cross the
selection UI boundary. A changed tab/origin, stale nonce, cancellation, or
unknown selection fails closed.

### Native development-boundary decision

The macOS provider's current Keychain-backed `NativePasskeyBroker` is a
development signing boundary, not a completed integration with Padloc's real
unlocked vault or local service. `adr-passkey-native-vault-boundary.md` makes
this a release-blocking constraint. Its synthetic test verifier is compiled
only with `DEBUG` and `CH5_PASSKEY_TEST_VERIFICATION_INJECTION`; it supplies no
biometric/system approval and retains the registration/assertion
`clientDataHash` binding. It is test evidence only, never user-verification
evidence.

The page shim emits an explicit cancellation on abort or timeout. The isolated
bridge replaces the page correlation value with a random extension ceremony ID
and disconnects that ceremony's runtime port on cancellation. The background
propagates port liveness, deadline, and tab/origin checks through cryptographic
execution and persistence. A cancellation or strict-sync failure observed after
a local mutation rolls back the newly created credential or restores the
original assertion metadata before returning.

Vault-held passkeys are modeled as synchronized multi-device credentials:
registration advertises backup eligibility/state, uses the WebAuthn zero
signature-counter policy, and does not return success until the server has
acknowledged the exact encrypted-vault item mutation. A failed request, errored
vault, or mutation that remains pending after sync is rejected and compensated
where possible. This avoids both false registration success and divergent
incrementing counters across profiles or clients that share the synchronized
vault.

### Current verified evidence (2026-07-10)

-   The latest clean extension unit run passes 223 tests. TypeScript passes with
    `--skipLibCheck`, which is required by the repository's existing
    webpack/tapable declaration mismatch. The production extension build targets
    `https://api.example.com`, emits no source maps, and compiles passkey
    diagnostics off unless `PL_PASSKEY_DIAGNOSTICS=true` is explicitly supplied.
-   Pure ES256 registration and assertion tests verify RP binding, authenticator
    flags, COSE encoding, DER signatures, counter behavior, and public-key
    verification.
-   Vault serialization tests prove passkey private keys remain on live
    encrypted items and are excluded from item-history snapshots.
-   Real Chromium smoke coverage proves the main-world request reaches the
    isolated bridge and returns to native handling within a bounded timeout.
-   The controlled `https://passkey-test.example.com` E2E passes through the real
    extension background and approval UI. The latest clean local run creates
    five discoverable vault-held credentials, authenticates one through
    `allowCredentials`, presents all five redacted identities for a usernameless
    request, signs with the exact fourth choice, verifies the assertion in the
    relying-party page, and reloads all five encrypted records with the expected
    zero-counter policy and last-used updates.
-   Deterministic tests cover five eligible credentials, exact fourth-account
    selection, cancellation/invalid selection without counter mutation, stale or
    wrong nonces, wrong extension UI sender, expiry, duplicate candidates, wrong
    tab/frame/origin, wrong RP, and `allowCredentials` no-match behavior.
-   Abort/timeout coverage proves the isolated bridge disconnects the exact
    ceremony port and that expiry detected during create/get persistence rolls
    back the credential or assertion metadata. The controlled E2E verifies the
    backup-eligible/backed-up flags and zero counter after encrypted reload.
-   User-verification regressions prove that a recently entered master password
    satisfies the freshness window, an expired password-only session returns to
    the normal locked-vault password UI without dropping the pending ceremony,
    and biometric cancellation leaves the approval pending rather than silently
    falling through.
-   The controlled popup E2E now forces the stale-verification/password-fallback
    branch. It proves the vault locks without approving, the background retains
    the exact ceremony, master-password unlock refreshes verification, the popup
    re-fetches the same approval, and registration then succeeds.
-   The same controlled ceremony sends hostile RP/account display strings that
    resemble executable image and script markup. The popup renders them as
    literal text, creates no injected nodes, leaves the execution sentinel
    untouched, and still requires the normal approval and verification flow.
-   A deterministic Google-origin provider regression creates and asserts a
    credential for `https://accounts.google.com` with RP ID `google.com` using
    the production canary suffix policy. It verifies discoverability,
    platform/internal presentation, BE/BS/UP/UV flags, zero AAGUID, zero counter,
    exact client-data origin binding, and stable credential selection. This is a
    strong compatibility substitute but does not replace the pending live Google
    registration and sign-in proof.
-   Current official references were rechecked on 2026-07-10. WebAuthn Level 3
    defines a passkey platform authenticator as platform attachment with
    `internal` transport and defines BE/BS as the multi-device backup signals,
    matching the emitted credential. Google documents passkey support in Chrome
    on macOS. Chrome's public `webAuthenticationProxy` extension API is explicitly
    scoped to remote-desktop software, so it is not a general third-party
    password-manager provider surface; the main-world bridge remains an explicit
    bounded canary until the live Google proof succeeds.
-   Assertion persistence now compensates even when a repository mutates the
    local record before rejecting strict synchronization; a dedicated regression
    proves the original counter and last-used metadata are restored.
-   The designated non-Crown Google profile and displayed account have been
    independently confirmed. Google passkey settings currently require normal
    user-presence reauthentication, and Chrome requires a person to load the
    unpacked extension from its internal extensions page. No Google account
    security setting has yet been changed by this work.
-   The live canary build targets `https://api.example.com` with
    `PL_BUILD_ENV=production`; the backend URL was verified in the generated
    background bundle before browser loading.
-   Worker diagnostics no longer serialize provisioning/auth objects. Provisioning
    logs contain only boolean/count metadata, and failed Resend delivery logs
    contain only HTTP status and template name. The combined sentinel regression
    (`npm --prefix packages/worker run test:logging-redaction`), the normal
    Worker package/root test lane, Wrangler dry-run,
    controlled E2E log inspection, and changed-source secret-transcript scan pass.
-   The live Zack account flow is currently at two required user-presence gates:
    the final CH5 Auth account-creation confirmation and Google's existing-passkey
    reauthentication. No Google passkey mutation has occurred yet.
-   A fresh independent review initially found three issues: missing
    master-password fallback after the verification freshness window, incomplete
    rollback when strict sync rejects after a local mutation, and the Worker
    logging regression not being part of its normal test lane. All three have
    been fixed and regression-tested; final independent code re-review is
    approved with no remaining finding. Final architecture status is `WATCH`,
    non-blocking: the main-world monkeypatch remains a browser canary rather than
    a native Chrome credential-provider API, rollback is best-effort if both
    strict and compensating sync fail, and Google must still validate the emitted
    WebAuthn presentation live. The earlier popup-integration coverage note is now
    closed by the controlled stale-verification/password-unlock E2E. These are
    documented limits, not blockers for the bounded Google canary.
-   The signed macOS development host and credential-provider extension install
    successfully, have the AuthenticationServices credential-provider
    entitlement, expose `ProvidesPasskeys`, and appear exactly once in the
    macOS provider registry. The host reports the provider enabled.
-   On webauthn.io, Chrome's 1Password browser-extension prompt can be bypassed
    and the macOS system sheet independently offers **Save in CH5 Auth
    Passkeys** alongside **Save in Passwords**. Selecting CH5 invokes the native
    provider, creates an ES256 key, and publishes a CH5 credential identity.
-   Native codec tests validate the WebAuthn authenticator-data layout,
    `fmt=none` attestation envelope, RP-ID hash position, counter, credential ID,
    COSE-map boundary, synchronized credential flags, and UV gating. Native
    registration/assertion APIs require an opaque grant issued only after macOS
    device-owner authentication succeeds.
-   The final signed native provider passed the controlled localhost RP system
    lane: registration accepted, assertion signature verified, Safari/provider
    terminated and relaunched, and the persisted assertion verified again.
    Apple Watch was the observed device-owner verification method. The same
    shared verifier rejects native wrong-origin/RP/credential, malformed
    CBOR/DER, unsupported-algorithm, and missing-UV vectors.
-   Native private keys and metadata are CH5-owned Keychain-synchronizable
    items behind `NativePasskeyBroker`. The exportable key payload is confined
    to that module and encrypted at rest by Keychain; it is not a non-exportable
    `SecKey`. A device-owner verification produces a short-lived, single-use,
    ceremony-bound capability that the broker consumes before retrieving or
    signing with private bytes. Same-Mac persistence is live-proven; cross-device
    identity-store reconciliation remains a documented release follow-up.
-   The existing Google credential is quarantined from this work: it is an
    Apple/iCloud credential under Google's security review, not a CH5-held
    credential. It must not be deleted or recreated as part of native-provider
    debugging.

## Provider-by-provider verification matrix

| Contract | Browser extension | macOS CH5 provider | Non-CH5 control |
| --- | --- | --- | --- |
| Provider is discoverable | Verified in the enabled canary page | Verified in the macOS system sheet | 1Password and Apple Passwords are visibly distinct |
| Registration request reaches provider | Verified | Verified (`registration-entered`) | Not counted as CH5 evidence |
| ES256 credential is constructed | Verified and unit tested | Verified and native-unit tested | Not counted |
| Private key persistence | Verified in encrypted Padloc vault reload | Verified in CH5 Keychain-synchronizable items behind a bounded authenticated broker; cross-device discovery not yet claimed | Apple/Chrome storage is out of scope |
| RP accepts registration | Verified by controlled CH5 RP | Verified by the same controlled RP | Apple/Chrome success is only a control |
| Assertion signature verifies | Verified by controlled CH5 RP | Verified live by the shared verifier | Not counted |
| Browser/provider restart persistence | Verified for encrypted-vault reload | Verified after Safari/provider restart | Not counted |
| Real local user verification | Password fallback/biometric coordinator covered in extension tests | Verified with macOS device-owner authentication; Apple Watch observed | Apple Passwords verification is not CH5 verification |
| Five-account selection | Verified with exact fourth selection | Five-record exact-fourth deterministic broker test; live enrollment on other accounts intentionally avoided | Other accounts/providers remain untouched |

## Automated relying-party harness plan

The executable feature-to-test mapping is maintained in
`docs/passkey-provider-verification-matrix.md`. `npm run proof:passkeys` is the
single deterministic entry point; add the signed system extension with
`PADLOC_NATIVE_SYSTEM_E2E=1 npm run proof:passkeys:system`.

The durable test harness is a small RP server plus one shared conformance suite,
not a dependency on webauthn.io or Google. It must run registration and
authentication as real server ceremonies and retain only public credential
state.

### RP server responsibilities

1. Issue random, single-use registration and assertion challenges with a short
   expiry and an opaque ceremony identifier.
2. Serve a same-origin WebAuthn page over localhost HTTPS (or Playwright's
   trusted test-origin routing) with configurable RP ID, resident-key,
   attachment, attestation, and user-verification policies.
3. Verify `clientDataJSON` type, challenge, origin, RP-ID hash, UP/UV/BE/BS
   flags, credential ID, COSE ES256 public key, and assertion signature.
4. Persist only the public key, credential ID hash, opaque user handle,
   signature-counter policy, and redacted result metadata.
5. Reject replay, expired challenge, wrong origin/RP, wrong credential,
   unsupported algorithm, malformed CBOR/DER, missing required UV, and
   non-zero counters for the synchronized zero-counter policy.

### Execution lanes

-   `extension-rp-e2e`: fully headless Playwright. Load the unpacked extension,
    create the temporary CH5 account/vault, register through the extension
    provider, verify at the RP server, authenticate, restart the persistent
    Chromium context, authenticate again, and run five-profile selection.
-   `native-codec-rp-contract`: CI-safe macOS job. Feed native registration and
    assertion outputs into the exact same RP verifier, verify signatures, reload
    the native store, and exercise negative vectors without browser UI.
-   `native-system-e2e`: signed macOS runner. Launch Safari against the local RP,
    select **CH5 Auth Passkeys** in
    the AuthenticationServices sheet, then register/authenticate/restart. This
    lane is supervised because Playwright cannot select protected macOS system
    sheets; the page and server assertions remain scripted and deterministic.
-   `public-canary`: optional manual release check against webauthn.io. It is a
    compatibility signal only and never replaces the controlled RP suite.
-   `google-canary`: delayed final compatibility check after every preceding
    lane is green. Never create a replacement credential merely because Google
    is still reviewing an earlier one.

### Required artifacts and commands

The implementation should converge on these stable entry points:

```sh
npm --prefix packages/extension run test:passkey-rp
npm --prefix packages/extension run test:passkey-rp:extension
xcodebuild test -project packages/macos/CH5AuthPasskeyProvider.xcodeproj \
  -scheme CH5AuthHost -destination 'platform=macOS' CODE_SIGNING_ALLOWED=NO
PADLOC_NATIVE_SYSTEM_E2E=1 npm --prefix packages/extension run test:passkey-rp:native
npm run proof:passkeys
PADLOC_NATIVE_SYSTEM_E2E=1 npm run proof:passkeys:system
```

The RP verifier and vectors must be shared between the extension and native
lanes. A provider-specific test may construct a response differently, but it
must not use a weaker verifier.

## Stage 1: deterministic conformance tests

Use fixed inputs and an isolated test key store. Verify:

-   registration selects a supported COSE algorithm and produces a discoverable
    credential scoped to the requested RP ID;
-   credential ID, user handle, RP ID, and encrypted private key round-trip
    without exposing private material in serialized diagnostics;
-   authenticator data contains the correct RP-ID hash and UP/UV flags;
-   assertions sign `authenticatorData || clientDataHash` and verify with the
    registered public key;
-   `allowCredentials`, resident-key requirements, and user-verification
    requirements are honored;
-   wrong RP ID, wrong origin context, wrong challenge, unsupported algorithm,
    replay, locked vault, canceled verification, revoked credential, and timeout
    all fail closed;
-   the chosen multi-device or device-bound counter policy remains internally
    consistent across sync/restart scenarios.

## Stage 2: controlled non-Google relying party

Use a controlled HTTPS or localhost WebAuthn RP with redacted ceremony IDs.

1. Enable the Padloc browser provider for the controlled RP. For a native-app
   target, enable Padloc in the operating system's credential-provider settings.
2. Start registration with resident-key and user-verification requirements
   recorded in redacted diagnostics.
3. Approve Padloc's provider prompt, unlock Padloc, and complete registration.
4. Verify the RP stored only the public credential and Padloc stored the
   encrypted private credential record.
5. Lock Padloc, start a fresh authentication ceremony, unlock through the
   configured extension unlock method (or Touch ID, Apple Watch, device
   password, or the supported native-platform equivalent), and verify the RP
   session.
6. Repeat authentication after provider/app restart.
7. Run negative cases for another RP, a subdomain mismatch, cancellation, stale
   challenge, revoked credential, and a locked vault.

Reproduction commands used for the latest controlled proof:

```sh
npm --prefix packages/worker run migrate:local
PADLOC_PASSKEY_E2E=1 PL_SERVER_URL=http://127.0.0.1:8787 \
  npm run --prefix packages/extension test:harness -- \
  --grep 'controlled CH5 RP'
```

The opt-in test owns its temporary local account and encrypted vault fixtures.
It must remain separate from the live Google profile and production vault.

Passing a browser virtual-authenticator test is useful cryptographic evidence
but does not prove Padloc was selected as the real system credential provider or
that Touch ID/Apple Watch UX works.

## Stage 3: password-autofill canary

Keep this lane separate from passkeys. With an encrypted non-production login
item, verify exact-item selection, explicit unlock/approval, username fill,
password fill on the staged password page, submit, and successful session.
Assert that audit output contains only origin, item ID, roles, counts, and
result status.

## Stage 4: consumer Google Account canary

Use the designated non-Crown account only after Stage 2 passes.

1. Confirm the exact Google account identity before changing account security.
2. While signed in through an existing recovery method, open Google Account
   passkey settings and create a passkey through the system chooser with Padloc.
3. Record only redacted provider, credential-ID hash, RP ID, algorithm, and
   result.
4. Sign out or use a clean profile, enter the exact account identifier, choose
   passkey sign-in, select Padloc, unlock locally, and require successful login.
5. Repeat once with multiple Google profiles present and verify exact-account
   selection.
6. Test cancellation, provider unavailable, wrong account, locked vault, and a
   deleted/revoked Google passkey.

If the flow enters a password and fills a form, report it as password autofill.
Do not label it a passkey handshake.

## Redacted evidence contract

Persist only a random ceremony ID, phase, RP ID, caller origin category,
requested algorithms, resident/UV requirements, hashed credential and
user-handle IDs, selected algorithm, UP/UV flags, counter policy/value, provider
callback result, error category, and timings. Screenshots may show provider
selection and the final account display name but must not include passwords,
private keys, raw assertions, cookies, recovery codes, or Hush values.

## Standards and platform references

-   [W3C Web Authentication Level 3](https://www.w3.org/TR/webauthn-3/)
-   [FIDO Alliance specifications](https://fidoalliance.org/specifications/)
-   [Apple Authentication Services credential provider](https://developer.apple.com/documentation/authenticationservices/ascredentialproviderviewcontroller)
-   [Apple device-owner authentication policy](https://developer.apple.com/documentation/localauthentication/lapolicy/deviceownerauthentication)
-   [Android credential provider service](https://developer.android.com/identity/sign-in/credential-provider)
-   [Chrome Web Authentication Proxy API](https://developer.chrome.com/docs/extensions/reference/api/webAuthenticationProxy)
-   [Google passkey supported environments](https://developers.google.com/identity/passkeys/supported-environments)
-   [Google Account passkey help](https://support.google.com/accounts/answer/13548313)
-   [Bitwarden browser-extension passkey-provider architecture](https://contributing.bitwarden.com/architecture/deep-dives/passkeys/implementations/provider/browser-extension/)
