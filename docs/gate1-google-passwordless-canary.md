# Gate 1 — prove ONE live Google passwordless login (the P0 gate)

**Why this is the gate:** the oracle review (`docs/ch5-secrets-unification-plan.md` §11–12)
made one proven Google passwordless login a hard prerequisite for ALL roaming / key-expansion
work. Passwordless Google *login* has never completed by any path (registration works;
login stops at `/challenge/pk/error` or a password-only chooser). Until this is green, do
NOT provision the org, reverse to roaming keys, or fan credentials across lanes — that would
maximize blast radius on an unproven pipeline.

**Non-negotiables:** non-Crown/disposable account FIRST (never Crown until non-Crown passes).
One human sign-in (password + 2FA) is required to reach the add-passkey page — this is the
"don't willy-nilly log in" checkpoint. Record exact retry/verify times.

## The single human action

Chris signs into a **non-Crown** Google account once in the owned Chrome-for-Testing lane,
reaching the passkeys settings page. Candidates (existing profiles from the 2026-06-30 run):

- `zackattacktucker@gmail.com` — profile `~/.browser-profiles/magic-browser-noncrown-zack-20260630`
- `hassongoblue@gmail.com` — profile `~/.browser-profiles/magic-browser-noncrown-blue-20260630`

Everything before and after the sign-in is scripted below.

## Procedure (existing runner `agentic:google-passkey`)

```bash
cd /Users/hassoncs/src/ch5/padloc
# 0. fresh extension against staging server (operating rule)
PL_SERVER_URL=https://api-staging.example.com npm --prefix packages/extension run build
npm run web-extension:preflight

# 1. read current Google passkey state (needs the human already signed in)
npm --prefix packages/extension run agentic:google-passkey -- --mode state \
  --port <owned-cft-port> --account zackattacktucker@gmail.com --screenshots=1 \
  --evidence-dir .sisyphus/evidence/gate1-noncrown/zack

# 2. enroll a fresh Padloc automation passkey (BE=0/BS=0 device-bound, UV=1, patched AAGUID)
npm --prefix packages/extension run agentic:google-passkey -- --mode enroll \
  --port <owned-cft-port> --account zackattacktucker@gmail.com --screenshots=1 \
  --evidence-dir .sisyphus/evidence/gate1-noncrown/zack

# 2b. CLEAR THE SECURITY DELAY BEFORE LOGIN. A just-created Google passkey shows
#     "Approve this passkey? … there's a security delay before you can use a new passkey"
#     and cannot sign in yet (confounded the 2026-07-08 run). Click Approve with an existing
#     authenticator on the account, or wait out the delay, until the credential no longer
#     shows "Approve this passkey?". See .llm/wiki/passkey-google-gate1.md.

# 3. clear ONLY Google cookies/origin storage, preserve Padloc extension/signer state,
#    then attempt passwordless login
npm --prefix packages/extension run agentic:google-passkey -- --mode login \
  --port <owned-cft-port> --account zackattacktucker@gmail.com --screenshots=1 \
  --evidence-dir .sisyphus/evidence/gate1-noncrown/zack
```

## The discriminator — delay vs shape

The runner reports `status: logged_in` (PASS) or an exact block (`/challenge/pk/error`,
password-only chooser). If it FAILS, distinguish the two failure classes cheaply:

1. **Browser-native control on the SAME account.** Enroll a real platform passkey (native
   Touch ID / CDP virtual authenticator that Google already accepts) and attempt the same
   passwordless login.
   - Native works, Padloc doesn't → **shape/classification bug** → freeze roaming; fix the
     assertion shape first (the pipeline is not sound).
   - Neither works → **security-delay / account-risk tier** → wait out Google's few-day
     cooldown (or use Google's "Approve this passkey?" existing-factor shortcut), then rerun.
2. **Assertion structure diff (if `get()` fires but is rejected).** Capture the raw
   `navigator.credentials.get` response and compare `authenticatorData` flag byte (UP/UV/BE/BS),
   `clientDataJSON.type` (`webauthn.get`), and signature encoding (ES256 DER) against the
   browser-native control. The runner does not capture this today — add lightweight capture
   ONLY if step 1 lands on "shape bug" and we need the exact field delta.

## Pass criteria

- `status: logged_in`, landing host `myaccount.google.com`, `createHooked=true`,
  `getHooked=true`, no native chooser / Touch ID / password on the assertion path.
- Redacted JSON + screenshots under `.sisyphus/evidence/gate1-noncrown/<account>/`.
- Exact times recorded if a security delay is observed.

## On PASS → unblocks

Provision CH5 org + service members + RP/stage-split automation vaults (D1, after Gate 0
re-key-on-revoke confirmation), then roaming key storage with broker-held wrap (D2), the
broker daemon (D3), browser loading + migration (D5). See plan §12.

## On the go-b lane specifically

go-b (`zackattacktucker`) is the hub-lane bootstrap candidate; its Google enroll doubles as
this Gate-1 retest. Serving is unaffected (go-b serves off `OPENCODE_GO_API_KEY_B`, not the
browser session). Route the credential through the Padloc path so, on PASS, it is already in
the vault to sync.
