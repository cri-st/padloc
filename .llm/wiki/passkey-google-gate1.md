# Google Passkey Gate 1

Gate 1 goal: prove one Google passwordless (first-factor) login using a
Padloc-created passkey, on the Zack non-Crown account only. Not green yet.

## Corrected Verdict (2026-07-08)

The prior read ("Padloc's BE/BS flags block first-factor login") was a confound.
Primary evidence — Google's own UI copy captured at credential creation — shows
the real blocker for the failed login test was **Google's new-passkey security
delay**, not the credential's flags.

Captured verbatim from `google-passkey-state.json` right after Padloc created the
credential:

> Approve this passkey?
> To keep your account safe, there's a security delay before you can use a new
> passkey. To speed up this process, you can approve your new passkey using an
> existing passkey or security key.

The new credential showed `Created: Just now` / `Last used: Not yet used`. The
login attempt ran immediately afterward, while the passkey was still inside that
delay window, so Google could not offer it and fell back to the password chooser
(`blocked_google_password_required_no_passkey_offer`). This alone explains the
failure. The `2-Step Verification only security key` message Chris saw live is a
separate signal and may be tied to the credential's UV flag (below), but it was
not isolated from the security-delay confound.

Consequence: the earlier "Next Experiment" (rebuild → create fresh → test login
immediately) would fail again for the same reason. **The login test must run
after the passkey is out of the security delay** — either approved via an
existing authenticator, or after the delay elapses.

## What Landed

Commit `45238b5f5` (device-bound) plus this change:

- `packages/extension/src/passkey-broker.ts`
  - `shouldSetUserVerification` now treats an omitted `userVerification` as UV=1.
    WebAuthn defaults the member to `"preferred"`; Padloc verifies the user via
    vault unlock before every ceremony, so UV=1 is truthful. Only an explicit
    `"discouraged"` suppresses the flag. Previously an omitted value produced
    UV=0, which invites relying parties (Google included) to classify the
    credential as a 2SV-only security key.
  - BE (0x08) and BS (0x10) remain unset — the signer store is device-local, not
    synced/backed up, so credentials are truthfully device-bound.
- `packages/extension/test/passkey-broker.ts`
  - Locks UV=1 for omitted userVerification and UV=0 for explicit `"discouraged"`,
    alongside the existing UV/BE/BS and identity-metadata assertions.

Truthful credential shape now enforced by tests (no Google needed to verify):
UP=1, UV=1 unless discouraged, AT=1 on registration, BE=0, BS=0, `fmt=none`,
AAGUID `7a46cc38-26d9-47fe-9f3b-b52837c6020d`, `transports:["internal"]`,
`authenticatorAttachment:"platform"`, `credProps.rk=true`.

Verification (local, autonomous):

```bash
npm --prefix packages/extension run check:source   # preflight + tsc + readiness + 20 passing
PL_SERVER_URL=https://api-staging.example.com npm --prefix packages/extension run build
```

## Corrected Gate 1 Runbook (needs a human)

Zack only. Never Crown. The live proof is human-gated: it needs Google reauth,
and clearing the security delay needs an existing authenticator gesture.

1. Load the freshly built `packages/extension/dist` into Chrome for Testing
   (relaunch a clean CFT lane on the owned CDP port).
2. Sign into Zack Google if reauth is required (human).
3. Create a fresh Padloc Google passkey.
4. **Clear the security delay before testing login** — do ONE of:
   - Click `Approve` on the new passkey and confirm with an existing passkey /
     security key on the account (fastest), or
   - Wait out Google's delay, then reload the passkeys page and confirm the new
     credential no longer shows `Approve this passkey?`.
5. Only then: clear the Google session (leave Padloc extension storage intact)
   and attempt a fresh passwordless login.

Pass: `status=logged_in`, landing `myaccount.google.com`, no password prompt, no
`2-Step Verification only security key` message.

Fail states to record: password-only chooser, `2-Step Verification only security
key`, still-in-security-delay, `/challenge/pk/error`.

## If It Still Fails After The Delay Is Cleared

Highest-signal next step — semantic diff against a known-good provider:

1. Create a 1Password Google passkey on the same Zack account and approve it.
2. Decode both 1Password and Padloc registration + assertion.
3. Diff: AAGUID, attestation fmt/path, UP/UV/BE/BS/AT flags, attachment,
   transports, credProps, credProtect, userHandle, signCount, discoverable
   assertion without allowCredentials.
4. Patch only fields that are truthful for Padloc. Do not spoof any other
   provider's AAGUID (1Password, Apple, Google, YubiKey).

## Evidence

- `.sisyphus/evidence/gate1-noncrown/zack/google-passkey-state.json` — security-delay copy
- `.sisyphus/evidence/gate1-noncrown/zack/google-passkey-login.json` — password-only fallback
- `.sisyphus/evidence/gate1-noncrown/zack/google-passkey-login-after.png`
