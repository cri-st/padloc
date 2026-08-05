# Padloc Google Passkey Gate 1 Handoff

Date: 2026-07-08
Repo: `/Users/hassoncs/src/ch5/padloc`
Account lane: Zack non-Crown Google account only

## Current State

-   Gate 1 is not green.
-   Zack signed into Google in the owned Chrome-for-Testing lane on CDP port
    `9841`.
-   Padloc extension WebAuthn hooks were active.
-   Padloc vault was unlocked through the email-code flow.
-   Google accepted a new Padloc-created credential and displayed it as a
    `Passkey`.
-   Fresh login after clearing only Google session did not offer passkey login.
    It stopped at Google's chooser: `Enter your password` / `Try another way`.
-   Chris also saw Google's live message:
    `Your key requires a password to sign in. The key you're using is a 2-Step
    Verification only security key.`

## Code Change Landed Locally

Commit:

```text
45238b5f5 fix(extension): mark agentic passkeys device-bound
```

What changed:

-   `packages/extension/src/passkey-broker.ts`
    -   Removed always-on BE/BS flags from generated registration authData and
        assertion authData.
    -   Current extension-local signer store is durable, but not proven synced
        or backed up. Device-bound flags are the truthful default.
-   `packages/extension/test/passkey-broker.ts`
    -   Updated expectations so generated credentials assert BE=0 and BS=0.
-   `.llm/wiki/passkey-google-gate1.md`
    -   Durable summary of current Google Gate 1 result, evidence, and next
        experiment.

Verification:

```bash
npm --prefix packages/extension run test:passkey-broker
```

Result: 18 passing.

`npm run test:changed -- --files ...` was attempted but refused because the
planner produced a fallback task. That refusal is not a code test failure.

## Evidence

Committed evidence:

```text
.sisyphus/evidence/gate1-noncrown/zack/google-passkey-state.json
.sisyphus/evidence/gate1-noncrown/zack/google-passkey-login.json
.sisyphus/evidence/gate1-noncrown/zack/google-passkey-login-after.png
.sisyphus/evidence/gate1-noncrown/zack/google-passkey-clear-google-session.json
.sisyphus/evidence/gate1-noncrown/zack/watch-20260708T091208.log
.sisyphus/evidence/gate1-noncrown/zack/watch-20260708T095148.log
```

Key evidence facts:

-   `google-passkey-state.json`
    -   Google page status ready.
    -   `createHooked=true`
    -   `getHooked=true`
    -   Existing credentials visible:
        -   older generic `Passkey`
        -   `1Password`
        -   `iCloud Keychain`
    -   New credential visible:
        -   `Passkey (Jul 8, 2026, 10:39:58 AM)`
        -   `Created: Just now`
        -   `Last used: Not yet used`
        -   `Approve this passkey?`
        -   Google security-delay copy present.
-   `google-passkey-clear-google-session.json`
    -   Google session was cleared without clearing Padloc extension storage.
-   `google-passkey-login.json`
    -   Fresh login result:
        `blocked_google_password_required_no_passkey_offer`
    -   Google chooser text showed:
        `Enter your password`
        `Try another way`

## Root Cause Read

Likely not pure WebAuthn malformed credential.

Current stronger read:

-   Padloc can generate/sign valid WebAuthn credential material.
-   Google accepts registration and labels it `Passkey`.
-   Google does not grant first-factor sign-in status.
-   Plausible causes:
    -   Google security delay / approval state.
    -   Google treating current credential as 2SV-only due to enrollment path.
    -   Provider classification/trust issue: unknown Padloc AAGUID plus `fmt:
        none`.
    -   Prior implementation bug: Padloc claimed BE=1/BS=1 even though signer
        storage is currently extension-local. This has now been patched locally.

## Critical Caveat

The failed Google credential was created before commit `45238b5f5`, when Padloc
still set BE=1 and BS=1.

Do not treat the current Google failure as proof that BE=0/BS=0 still fails.
The next experiment must rebuild the extension and create a fresh credential.

## Next Experiment

Use Zack only. Do not touch Crown.

1. Rebuild extension with the device-bound patch:

```bash
PL_SERVER_URL=https://api-staging.example.com npm --prefix packages/extension run build
npm run web-extension:preflight
```

2. Relaunch Chrome for Testing on port `9841` with the rebuilt extension.

3. Sign into Zack if Google requires reauth.

4. Recreate a fresh Padloc Google passkey.

5. Confirm new decoded registration shape:

```text
UP=1
UV=1 when requested/preferred
AT=1 on registration
BE=0
BS=0
fmt=none
AAGUID=7a46cc38-26d9-47fe-9f3b-b52837c6020d
transports=["internal"]
authenticatorAttachment="platform"
credProps.rk=true
```

6. Clear only Google session.

7. Attempt fresh passwordless login.

Pass criteria:

-   `status=logged_in`
-   landing host `myaccount.google.com`
-   `createHooked=true`
-   `getHooked=true`
-   no password prompt
-   no `2-Step Verification only security key` message

Fail criteria:

-   password-only chooser
-   `2-Step Verification only security key`
-   security-delay block
-   `/challenge/pk/error`

## If Fresh BE=0/BS=0 Still Fails

Next highest-signal path:

1. Create a 1Password Google passkey on the same Zack account.
2. Capture and decode 1Password registration and assertion.
3. Capture and decode Padloc registration and assertion.
4. Diff semantic fields:
    -   AAGUID
    -   attestation fmt/path
    -   UP/UV/BE/BS/AT flags
    -   authenticatorAttachment
    -   transports
    -   credProps
    -   credProtect
    -   userHandle behavior
    -   signCount
    -   discoverable assertion without allowCredentials
5. Patch only fields that are truthful for Padloc.

Do not spoof 1Password, Apple, Google, or YubiKey AAGUIDs.

## Current Repo State At Handoff

```text
main ahead of hq/main by 1 local commit
untracked: .ch5/shadow/
```

`.ch5/shadow/` was pre-existing/generated state and was left untouched.

## Browser State

Chrome-for-Testing CDP port `9841` may still be running, but after the last
fresh-login attempt it had only Google reauth/challenge state and GLIC targets
exposed. If continuing, prefer relaunching a fresh CFT lane after rebuilding the
extension.

## Do Not

-   Do not use Crown for this matrix.
-   Do not keep retrying the stale pre-patch credential.
-   Do not claim Gate 1 green until fresh Google-only session clear plus login
    passes.
-   Do not print raw Google URLs, cookies, auth tokens, OTPs, private keys,
    signer handles, or full credential IDs.
