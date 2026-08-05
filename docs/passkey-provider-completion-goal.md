# Padloc Passkey Provider Completion Goal

> Historical planning artifact, superseded for current proof work. It does not
> authorize Google, Crown, Hush-secret, quarantined-credential, or production
> account access. Public and Google canaries are manual-only and require fresh,
> separate authorization. The current local/CI proof contract is
> `docs/passkey-provider-verification-matrix.md`.

Copy everything from `/goal` through the end into a new Codex task.

```text
/goal Continue and finish the CH5 Auth Padloc-held passkey-provider work in `/Users/hassoncs/src/ch5/padloc`. Work autonomously in a persistent diagnose-edit-test-verify loop until every completion gate below is proved, or until a genuine user-presence or missing-authority blocker remains after safe alternatives have been exhausted. Do not stop merely to report partial progress, a failed test, an uncertain hypothesis, a browser-automation problem, or a recoverable environment issue. Keep the goal active across compactions and continuations. Re-read repository state and durable artifacts rather than restarting completed work.

## Verified baseline; do not redo without evidence of regression

- Padloc now has a browser-extension passkey-provider path separate from password autofill and from using WebAuthn merely to authenticate to Padloc.
- The provider creates discoverable ES256/P-256 WebAuthn credentials. The relying party receives the public key; the credential private key stays in the encrypted Padloc vault. Authentication signs `authenticatorData || clientDataHash` only after Padloc user verification.
- The controlled `https://passkey-test.example.com` registration and authentication ceremony passed through the real extension, including popup approval, RP-ID/origin validation, signature verification in the RP page, strictly acknowledged encrypted-vault persistence, synchronized-passkey backup flags, the required zero-counter policy, and reload.
- The latest recorded verification is 212 extension unit tests passing, extension TypeScript passing with the repository's required `--skipLibCheck` workaround, a clean production extension build with no source maps, 13 default Playwright tests passing with the opt-in canary skipped, and the controlled five-credential real-extension canary passing independently.
- Final independent code review is APPROVED with no findings. Final architecture review is CLEAR, with only a non-blocking WATCH for the unavoidable MV3 port-disconnect race between durable credential persistence and delivery of the response to the page.
- Start by inspecting the current worktree, `.omx/ultragoal/`, `docs/passkey-provider-test-plan.md`, and the latest tests. Preserve unrelated user changes and never discard a dirty worktree.

## Current continuation point

- Local implementation, automated verification, production build validation, controlled five-credential E2E, cleanup, and independent review are complete.
- The exact authorized non-Crown Google profile has been confirmed in Chrome. The Crown/CH5 profile remains out of scope and untouched.
- Repo-local Hush contains no password secret for the authorized Google account, so do not claim or search for a nonexistent credential by printing secret material.
- Google ended the prior reauthentication attempt after inactivity. Resume from the authorized Google profile's passkey settings by selecting **Try again**.
- Chrome intentionally blocks automation of `chrome://extensions`. The user must manually load or reload the unpacked extension from `/Users/hassoncs/src/ch5/padloc/packages/extension/dist` in the authorized Google profile, then approve Google's normal Touch ID, Apple Watch, device-passcode, or other user-presence prompt. Do not bypass either control or work around the Chrome restriction through CDP, CLI flags, or a different browser.
- Once the user reports that the extension is loaded, automatically resume the live registration, fresh signed-out sign-in, restart/reload persistence proof, unlock proof, final redacted documentation, and cleanup gates.

## Primary outcome

Complete a real Google Account passkey registration and subsequent passwordless sign-in using a Padloc-held credential for the specifically designated non-Crown account whose display identity is “Zach Attack Tucker.” Padloc must be the component holding the RP private key and producing the assertion after local approval/unlock. A password-filled Google form, native Chrome/Apple/Google Password Manager credential, OAuth login, or an already-authenticated session is not proof of this outcome.

## Explicit authorization and safety boundary

- You are authorized to inspect the repo-local Hush configuration and metadata, use secret values through approved Hush commands without printing them, open a fresh Chrome window/profile, load or reload the unpacked local extension, use existing signed-in browser state, navigate Google Account security/passkey pages, register exactly one canary Padloc passkey on the confirmed Zach Attack Tucker non-Crown account, sign that account out, and sign it back in to prove the Padloc assertion.
- Before the Google security mutation, independently confirm the exact account identifier and displayed account. Do not infer it from a similar name and do not select a random profile.
- Do not print, log, screenshot, persist, or paste passwords, Hush values, cookies, tokens, raw challenges/assertions, recovery codes, vault keys, private keys, or biometric data. Redact account identifiers in durable diagnostics unless the user has already made them public in the task.
- Do not add, delete, rename, or revoke passkeys on any other Google account. Do not change passwords, recovery methods, MFA/2-Step Verification, trusted devices, OAuth grants, Chrome sync settings, or organization policies. Do not enroll Crown or production-sensitive accounts without fresh explicit authorization.
- Never bypass Touch ID, Apple Watch approval, a device password, Google reauthentication, CAPTCHA, or other user-presence controls. If one appears, state the exact safe action required in one concise request, wait for the user, and automatically resume the same goal after it is satisfied.

## Required execution loop

1. Reconcile current code and test state. Run the smallest current verification that proves the controlled provider path still passes. Diagnose and repair regressions before proceeding.
2. Restore an operable browser lane. Prefer the Chrome-control integration because it can use existing profiles and sessions. If attachment fails, diagnose the native host/extension/profile state and use a fresh authorized Chrome window. Do not silently fall back to a browser context that cannot load the real extension or prove the selected profile/account.
3. Restore an operable secret/account lane. Diagnose repo-local Hush identity/target configuration without exposing values. Determine the exact Zach account identifier from authorized Hush or browser evidence. If the secret exists but the local identity is stale or missing, repair only the local/repo-approved Hush configuration needed to read it. Do not create plaintext `.env`, `.dev.vars`, temporary password files, shell-history entries, or diagnostic output containing secrets.
4. Build the extension for the backend environment that owns the Zach vault/account. Verify the baked `PL_SERVER_URL` and environment label before loading it. Do not use a local Worker for a live account unless the account actually exists there. Authenticate the extension and verify that the expected encrypted vault is loaded.
5. Instrument redacted stage diagnostics if necessary. Each provider ceremony should expose only a random ceremony ID, phase, RP ID, caller-origin category, requested algorithms/resident-key/user-verification policy, hashed credential/user-handle identifiers, selected algorithm, flags, counter policy/value, result category, and timing. Remove or gate temporary noisy instrumentation after diagnosis.
6. Perform the Google registration canary on the confirmed Zach account. Prove that the request reaches Padloc, that the user explicitly approves/unlocks Padloc, that Google accepts the registration, and that the encrypted vault contains the matching private credential record while Google receives only public credential data.
7. Prove a fresh Google authentication. Sign the Zach account out or use a clean authorized profile, enter/select the exact account, choose passkey sign-in, select Padloc, approve/unlock locally, and complete the session. Capture redacted evidence that the Padloc-held credential signed the Google challenge. Repeat once after extension/provider restart to prove persistence.
8. Finish the multi-profile behavior needed for five Google Chrome profiles/accounts. Implement a safe credential/account selector for usernameless or multiple-eligible discoverable-credential requests if the current background UI lacks one. Bind selection to RP ID, user handle/account metadata, tab, frame, ceremony, nonce, and expiration; never auto-select an ambiguous credential. Prove with deterministic tests covering five eligible fixtures, exact selection, cancellation, stale approval, wrong tab/frame, wrong RP, and no-match behavior. Live passkey enrollment on accounts other than the designated Zach canary remains outside this authorization.
9. Verify local-unlock behavior. Prove password unlock and the supported platform biometric re-unlock path. Where macOS offers Touch ID or Apple Watch through the platform authenticator, use the normal system prompt and record only success/cancel/error category. Do not claim Apple Watch support unless it is actually offered and observed; clearly distinguish browser WebAuthn user verification from a native macOS credential-provider integration.
10. Run negative and recovery cases: cancel approval, locked vault, stale challenge/nonce, wrong Google account, provider unavailable/native fallback, extension restart, revoked/deleted local credential handling, and registration/authentication timeout. Every unsafe mismatch must fail closed without leaking a credential or password.
11. Keep password autofill, OAuth, Padloc account WebAuthn, and Padloc-held third-party passkeys conceptually and technically separate. Never report one as evidence for another.
12. After each failure, form an evidence-backed hypothesis, add or tighten a regression test when practical, implement the smallest safe fix, and rerun the nearest proving test. Continue automatically while a safe recovery path exists.

## Completion gates

Do not mark the goal complete until all of these are true:

- The controlled non-Google real-extension create/get E2E passes from a clean build.
- The exact Zach Attack Tucker Google account is confirmed before mutation.
- Google accepts a newly registered Padloc-held passkey for that account.
- A fresh signed-out Google session is authenticated by a Padloc-generated assertion, and the flow passes again after extension/provider restart.
- Evidence distinguishes Padloc signing from password autofill, OAuth, native Chrome/Apple credential use, and an existing session.
- Multi-credential selection is implemented and deterministically tested with five eligible account fixtures, including ambiguity and cancellation cases.
- Password unlock and the actually available platform biometric re-unlock path are verified; unsupported Apple Watch/native-provider claims are not made.
- Security-negative cases fail closed, and durable logs contain no secrets or raw WebAuthn material.
- Targeted unit/integration/E2E tests, extension build, typecheck/lint where configured, and `git diff --check` pass.
- Temporary test accounts, local Worker data/processes, browser test state, and diagnostic hooks are cleaned up without deleting the real Google canary credential or unrelated user data.
- Documentation accurately records the architecture, build target, live canary result, exact limitations, reproduction commands, and redacted evidence locations.
- Changed files receive a cleanup pass, post-cleanup verification, independent code review, and architecture-invariant review. Resolve all blocking findings before completion.

## Architecture invariants

- RP private keys remain only inside encrypted Padloc vault records and are never placed in item history, logs, page context, extension local storage, or messages beyond the minimum signing boundary.
- The extension independently validates browser-reported origin, RP-ID suffix policy, top frame, tab/frame identity, request lifetime, approval nonce, and credential eligibility.
- The page/main-world bridge never receives vault secrets or private key material and retains bounded native fallback when Padloc cannot safely answer.
- A WebAuthn assertion signs the standards-defined payload and never injects a password. Password autofill is a separate explicit feature.
- Ambiguous account/credential selection always requires user choice and fails closed on stale or mismatched state.
- General rollout beyond the explicit CH5/Google canary allowlist requires a complete public-suffix policy; do not quietly broaden the allowlist as a shortcut.

## Final handoff

Lead with the actual outcome. List the Google and controlled-RP ceremonies that were personally observed, the verification commands and results, changed files, redacted evidence, and any narrowly scoped limitation. Do not declare success based only on mocks or unit tests. Mark the goal complete only after the final quality gates pass and no required work remains.
```
