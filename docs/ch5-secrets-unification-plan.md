# CH5 Secrets Unification — Padloc as the single interactive-credential store

**Status:** PLAN (Phase 0 deliverable). Written 2026-07-08. Gate: this plan must pass
`consult-oracle --fuse` review before any account login / mutation (handoff rule:
"write the plan first — don't willy-nilly log in"). Reversible code slices may proceed
in parallel; account logins and Crown mutation are hard-gated on this plan + human.

**Owner:** Chris (CH5). All assets are CH5-owned. Repos: `padloc`, `magic-browser`,
`agent-hub`.

---

## 1. Goal

Make the self-hosted CH5 Padloc fork (`app.example.com`) the company's single store for
**interactive-login credentials, passkeys, and autofill identity/address/payment**,
unlocked and synced across:

- the Agent Hub box (`ch5-authority`),
- this laptop,
- every browser in the system (dell-chromium hub lanes, Magic Browser's Chrome-for-Testing, local Chrome).

A passkey enrolled once must be usable from any linked browser. Hush stays the runtime/
vendor/operator secret store with a clean, non-overlapping boundary. Browser automation
always has credentials available — no native OS chooser, no getting stuck at a passkey
popup.

---

## 2. Current state — what already exists (do NOT rebuild)

Verified against live code + docs this session:

- **Padloc fork is feature-complete and live.** `packages/core` is untouched from
  upstream (standard zero-knowledge crypto); the Cloudflare Worker implements all 39 API
  handlers incl. KeyStore, MFA authenticators, trusted-device.
- **Passkey vault model already exists in core.** `VaultItemKind.PasskeyCredential`
  (`packages/core/src/item.ts:48`), class `PasskeyCredential` (`:118-141`:
  `algorithm`, `credentialId`, `rpId`, `privateKeyFieldIndex`, `publicKeySpki`,
  `publicKeyJwk`, `signCount`, `userHandle`, `policy`, `auditTrail`),
  `PasskeyCredentialPolicy` (`:65` — allowedRpIds, allowedTopOrigins, approval mode,
  rateLimit, timeWindows, requireFlowBinding, emergencyLockout).
- **The passkey bridge ops are ALREADY BUILT** — not pending. `enroll-passkey` and
  `request-assertion` exist in the protocol enum
  (`packages/extension/src/autofill-broker-protocol.ts:13-14`), a full signer/policy
  engine (`packages/extension/src/passkey-broker.ts`), wired into **both** transports:
  native-messaging broker (`background.ts:1238/1259`) and the MAIN-world
  `navigator.credentials` hook (`webauthn-page.ts` → `background.ts:680/785`). Bound
  `flowId+ttl+topOrigin+rpId` enforcement, internal signing (ES256 + Ed25519), rate
  limits, time windows, nonce anti-replay, emergency lockout, append-only audit, and a
  redaction guard refusing any `value`/`secret`/`privateKey` leak. Unit + Playwright
  tests green.
- **Autofill P0 is landed.** Broker `classify → plan-fill → approve → mint-fill-bundle
  → apply-fill-bundle → revoke`; native host `me.ch5.padloc`; redacted invariant
  enforced; local fake-checkout fixture green; one real Meijer purchase completed with
  transaction-only CVV + guarded submit.
- **Two passkey control planes exist:**
  - **Plane A — Padloc Chrome extension** (page-world WebAuthn hook, key in the
    extension's own store). Documented preference. Has the only proven Google *registration*.
  - **Plane B — CDP virtual authenticator** (`agent-hub/deploy/dell/{webauthn-authenticator,lane-passkey}.mjs`),
    operates below `navigator.credentials`, credentials persisted to Hush
    (`CH5LANE_PASSKEY_*`). BE=1 proven on-wire on the box. Wired into the lane viewer.

**Two hard truths from the evidence:**

1. **Passkeys do NOT currently roam.** Private keys live in device-local,
   non-exportable IndexedDB (`padloc-agentic-passkey-signers`), *by deliberate design* —
   `readStoredSignerHandle` rejects legacy inline key fields and a test enforces it. The
   synced vault item carries only the public key + policy + audit + an opaque
   signer-handle string. On a second synced device, assertion throws
   `"signer key missing; re-enroll passkey"`. This directly contradicts the vision.
2. **Passwordless Google *login* is unproven by ANY path.** Registration works (Padloc,
   BE=1). Login has never completed passwordless. The blocker is either Google's
   per-new-passkey **security delay** (days, account-side) or a residual credential-shape
   issue — undiscriminated as of 2026-06-30. The delay has almost certainly lapsed now.

---

## 3. The reconciliation — one store, one destination plane

**Padloc's synced vault is the single credential store.** All planes write into it.

- **Plane A (Padloc extension) is the destination for every browser that can load an
  extension** — local Chrome, Magic Browser CFT, and (newly) the dell-chromium hub
  lanes. The extension's already-built `enroll-passkey`/`request-assertion` broker ops
  are the mechanism.
- **Plane B (CDP virtual authenticator) is retained as a FALLBACK ONLY**, for a
  browser/RP where the extension can't be loaded or is rejected for a
  non-flag reason. When used, it must **write through** to the Padloc vault (export the
  key → store as a roaming `PasskeyCredential` item via the native host), never fork to
  Hush. The `CH5LANE_PASSKEY_*` Hush blobs are migrated into the vault and deleted.

This makes "credentials always land in Padloc" true regardless of which plane enrolled them.

---

## 4. Architecture decisions

Each decision states a recommendation + rationale. Decisions marked **[ORACLE]** are the
high-stakes, hard-to-reverse ones gated on `consult-oracle --fuse`.

### D1 — Account topology **[ORACLE]**

**Options:** (a) one Padloc account reused on every device (Chris's literal "one account
logged in everywhere"); (b) a CH5 org with per-device member accounts and scoped shared
vaults.

**Recommendation: two-tier hybrid.**
- Chris's **human account** holds his personal vault + personal passkeys, used on his own
  browsers. Its master key never touches a server.
- A **CH5 org** owns a dedicated **"Browser Automation" shared vault** holding ONLY the
  specific passkeys/logins the headless lanes need. Each headless service instance (hub
  box; optionally each lane class) is its own **low-privilege member account** that can
  unlock only that shared vault.

**Rationale:** keeps the crown master key off the servers; gives per-device revocation
(drop a compromised box's accessor without rotating Chris's account — directly matches the
"each exported key is a P0 bearer secret" risk model); still one logical store (Padloc)
synced everywhere. Cost: org invite + accessor re-key per member; more moving parts than
Chris's "one account." Oracle to weigh simplicity vs blast-radius.

### D2 — Passkey key-storage model (roaming) **[ORACLE]**

**The vision requires roaming, which requires the encrypted private key to travel in the
synced vault** — the reverse of today's non-exportable device-local design.

**Recommendation: per-credential `roaming` policy flag.**
- **Roaming credential:** private key stored as an encrypted vault field
  (`privateKeyFieldIndex` → a real key field, protected by the vault's AES-GCM
  `encryptedData` exactly like a password), unwrapped in extension SW memory at sign
  time, zeroized after. This is the 1Password/Apple-synced-passkey model. Enables
  "enroll once, use from any linked browser."
- **Device-bound credential:** keeps the current non-exportable IndexedDB path
  (unchanged, still the secure default for anything that need not roam).
- Default **roaming** for CH5 automation passkeys; user-chosen for personal.

**Rationale + risk:** roaming turns the passkey private key into an
exportable-at-rest secret inside the vault. Protected by vault crypto (same as every
stored password) but no longer hardware-nonexportable. This is an intentional, guarded
reversal — the existing `readStoredSignerHandle` guard + test must be updated to permit
the roaming field kind while still rejecting *unencrypted* inline keys. Oracle to vet:
(i) is vault-AES-GCM protection sufficient, or add an extra wrap under a per-credential
key; (ii) keep the non-exportable path as the hard default.

### D3 — Headless unlock secret **[ORACLE]**

A process holding the account **master password OR the 32-byte masterKey** unlocks all
its vaults non-interactively via `App.unlockWithMasterKey(masterKey)` — no MFA in unlock
itself (`account.ts:185-188`, `app.ts:1058-1061`).

**Recommendation:** store the **service member account's** masterKey (NOT Chris's) in
Hush, stage-split (`runtime` / `runtime-staging` / `runtime-production`-style targets per
box class). This is a device/bootstrap key — Hush's proper domain — not a personal record.
First-login-per-new-device trust bootstrap: register a scriptable **TOTP or PublicKey
authenticator** (`Login` purpose) so `startCreateSession` passes without an email code, OR
provision each device once by hand and rely on `addTrustedDevice` + the persisted session
thereafter (`server.ts:548-558`).

**Browser tradeoff:** in a browser the masterKey is memory-only and re-locks on reload.
Silent browser re-unlock requires persisting the masterKey to browser storage — moving the
crown jewel into browser storage. Recommendation: for headless lanes, keep the masterKey
in the **native host / launch env (from Hush)**, and have the native host feed unlock to
the extension on demand, rather than persisting it in extension `storage.local`. Oracle to
confirm the least-bad unlock-persistence surface.

### D4 — Passkey approval policy for headless (no human gesture)

The `PasskeyCredentialPolicy` engine already supports this. For CH5 automation
credentials: `requireFlowBinding=true`, auto-approve within a bound
`flowId+ttl+topOrigin+rpId`, per-day/week rate limits, time windows, emergency lockout,
full audit. Payment fill / final-submit stays **human-gesture** (autofill approval path,
unchanged). No oracle gate — reuses shipped, tested policy.

**Rationale:** a passkey assertion for a bound flow is a scoped signing op, not a payment.
Binding + rate-limit + audit + lockout is the compensating control set. This is the
designed use of the existing policy engine.

### D5 — Plane A everywhere, Plane B write-through fallback

Load the Padloc extension + native host into dell-chromium hub lanes (bootstrap-only
per-lane relaunch, never edit the shared autostart — per `passkey-autonomy.md §8.4`),
Magic Browser CFT, and local Chrome. Plane B stays armed as fallback and, when used,
write-through-exports into the vault. Migrate `CH5LANE_PASSKEY_*` → vault items, then
`hush delete-key`.

### D6 — Google passwordless is a HUMAN-GATED experiment, non-Crown first

Unproven by any path. The retest (BE=1 credential, delay now lapsed) is the discriminator:
clean passwordless login → it was the delay (solved); still fails → residual shape bug.
Run on disposable/non-Crown (`zackattacktucker@gmail.com` = go-b, or
`hassongoblue@gmail.com`) FIRST; Crown only after the non-Crown matrix passes. Enrollment
needs ONE human sign-in (password + 2FA) to reach the add-passkey page = the
"don't willy-nilly log in" / ultraboom human-only-vendor-checkpoint gate.

---

## 5. Sync topology

Standard Padloc zero-knowledge sync — server (`api.example.com`) sees only ciphertext;
`getVault`/`updateVault` exchange `encryptedData` + RSA-wrapped `accessors` only.

**Unlock chain (per device/instance):**
```
masterKey (from Hush for service instances; typed once for Chris on his browsers)
  → App.unlockWithMasterKey → account RSA privateKey + HMAC signingKey
  → RSA-unwrap shared-vault accessor key
  → AES-GCM decrypt vault items (incl. roaming passkey private-key fields)
```

**Per-surface plan:**

| Surface | Account | Unlock | Extension | Notes |
|---|---|---|---|---|
| Chris's laptop Chrome | human account | human types master pw | Padloc ext + native host | personal vault + automation vault (if member) |
| Magic Browser CFT | automation member acct | masterKey via native host (Hush) | Padloc ext + native host | dogfood + agentic flows |
| dell-chromium hub lanes | automation member acct | masterKey via native host (Hush, on box) | Padloc ext (per-lane bootstrap) | Plane A; Plane B fallback |
| ch5-authority box (server) | automation member acct | masterKey from Hush | headless Padloc app | sync + serve; no browser needed for unlock |

**Availability doctor** (`Phase 3`): one idempotent, self-healing script per box-class
that verifies extension present + native host installed + account logged-in/trusted +
vault unlocked + sync fresh; heals drift; alarms on zero-throughput (a green signal that
can coexist with a locked/unsynced vault is a defect — CH5 metrics doctrine).

---

## 6. Hush ↔ Padloc ownership boundary (final)

- **Padloc (encrypted synced vault):** personal + interactive-login credentials,
  passkeys (roaming private keys), autofill identity/address/payment-policy items. The
  approval + audit authority.
- **Hush (stage-split targets):** runtime/vendor/operator secrets AND the per-device
  **bootstrap secret** for service instances — the automation member account's masterKey
  and any device-authenticator TOTP/PublicKey secret. Nothing else about personal records.
- **Never:** personal autofill values, passkey private keys, or PAN/CVV in Hush. Never
  personal values in Magic Browser learned state (structure only). CVV transaction-only.

This resolves the autofill-doc open question ("should Hush store only bootstrap/device
keys?") as **yes — bootstrap/device keys only.**

---

## 7. Security risks + mitigations

- **Exported/roaming passkey key = P0 root-equivalent bearer secret.** A leaked roaming
  vault (or a leaked service masterKey) is a portable, offline-usable auth factor until
  RP-side revoke. Mitigations: vault crypto at rest; per-device member accounts (blast
  radius = one box's vault, not Chris's account); armed RP-side revocation kill-switch
  (rotation ≠ revocation); assertion monitoring/audit; emergency lockout policy. Keep the
  non-exportable device-bound path as the default for anything that need not roam.
- **Service masterKey in Hush = crown jewel for that account's vault.** Stage-split, least
  privilege, smallest-scope automation vault. Never Chris's account key on a server.
- **Google risk engine** (datacenter IP + headless UA) can step up past the passkey to a
  phone tap — a re-bootstrap gate distinct from key capture. Expect it; keep the human
  bootstrap path.
- **Profile-wide virtual authenticator (Plane B)** self-drops on socket death; never
  attach during a human's own password+2FA. Invariant already enforced in `lane-passkey`.
- **Reversal of the non-exportable guard (D2)** must stay narrow: permit only an
  *encrypted/wrapped* roaming key field; keep rejecting raw inline keys; update the guard
  test to assert both.

---

## 8. Phased execution (reversible vs gated)

**Reversible / autonomous (proceed after oracle sign-off on D1–D3):**
- **P2a** Implement roaming key-storage (D2): add `roaming` policy flag; store wrapped
  private key in an encrypted vault field; unwrap-at-sign in SW memory + zeroize; update
  `readStoredSignerHandle` guard + test to permit encrypted roaming field, reject raw
  inline. Round-trip test: enroll on device A → sync → assert on device B (simulated).
- **P2b** Native-host masterKey-feed unlock path (D3) for headless instances.
- **P3a** Availability doctor + per-lane Padloc-extension bootstrap loader (D5); Magic
  Browser + local Chrome extension/native-host install via `setup-agentic-chromium`.
- **P3b** Migration tool: `CH5LANE_PASSKEY_*` Hush blobs → roaming `PasskeyCredential`
  vault items → `hush delete-key`.
- **P2c** Passkey `push_required` approval popup wiring (minor gap noted in inventory), if
  D4 needs an interactive path for Chris's personal browsers.

**Human-gated (surface as consolidated checkpoints; do NOT auto-run):**
- **P1** Google security-delay retest on non-Crown (needs one human sign-in). go-b Google
  enroll doubles as the retest.
- **P4** Remaining hub-lane sign-in bootstraps (go-a github, go-b google), routed through
  the unified Padloc path so credentials sync everywhere.
- **Crown** only after non-Crown passwordless login is proven.

**Org/account provisioning** (D1) — creating the CH5 org + automation member accounts +
the automation shared vault: reversible infra, but touches the live Padloc account, so do
it after oracle sign-off, before P1/P4.

---

## 9. Open decisions for oracle / Chris

1. D1 topology: two-tier hybrid (recommended) vs single-account simplicity. Chris's
   literal ask leans single-account; blast-radius leans hybrid.
2. D2 roaming key protection: vault-AES-GCM sufficient, or extra per-credential wrap?
   Keep non-exportable as hard default?
3. D3 browser unlock-persistence: native-host-feed (recommended) vs extension
   `storage.session` vs a scriptable Padloc authenticator.
4. Whether to keep Plane B (CDP) at all once Plane A is loaded on hub lanes, or retire it.

---

## 10. Proof gates

- **P2:** unit round-trip (enroll A → sync → assert B) green; redaction tests still green;
  guard test updated + green; Playwright webauthn-intercept green.
- **P3:** doctor reports unlocked+synced on ≥2 surfaces; extension live on a hub lane; one
  migrated credential asserts from the vault.
- **P1:** exact Google login result recorded (`logged_in` vs exact block text) with
  retry/verify times, redacted evidence.
- **Land:** commit coherent slices to `main` (worktree → ff → push, no PR); box is
  scp-deploy, not git.

---

## 11. Oracle review verdict (2026-07-08, `consult-oracle --fuse`, fable-5 + gpt-5.5)

**High confidence — both panels agreed on every core decision.** The verdict RESEQUENCES
this plan. Summary + the changes it forces:

### The decisive reorder (D4) — decouple the unproven login from the blast-radius change

**No live Google passwordless login has ever completed by any path.** Building roaming +
fanning keys across N devices before the assertion path works = maximal blast radius on an
unproven pipeline. **One proven Google passwordless login is now a HARD P0 GATE before ANY
roaming / vault-residency / key-expansion work.**

- **The one thing most likely to bite:** ship exportable roaming, fan the key across lanes,
  THEN discover the Google failure was assertion-*shape* not *timing* → debugging
  correctness with every credential already exported+synced, blast radius maximal, and
  unable to cleanly revoke because re-key-on-revoke was never verified.
- **Cheapest, highest-value datum:** capture ONE real `navigator.credentials.get`
  assertion and diff its structure — `authenticatorData` flags (UP/UV bits),
  `clientDataJSON.type`, signature encoding — against a known-good browser-native passkey.
  That single diff discriminates security-delay vs shape-bug. Do this BEFORE any roaming.

### D1 topology — hybrid CONFIRMED, with two added constraints

- Reject one-account-everywhere (makes the human masterKey the headless unlock secret;
  equates device-revoke with full account re-key).
- **NEW constraint — revocation reality:** the hybrid's per-device revocation is real ONLY
  IF Padloc **re-keys the shared vault symmetric key on member removal**. If a removed
  member's cached vault key still decrypts future ciphertext, revocation is
  forward-delivery-only and every passkey in that vault is burned. **Must verify Padloc's
  re-key-on-revoke behavior before relying on the hybrid** (verification worker dispatched).
- **NEW — split the automation vault by RP / stage / device.** A single shared automation
  vault means any one service-member compromise = vault-wide compromise. Split so blast
  radius is one RP/lane, not all.

### D2 roaming — reverse YES, but with a mandatory broker-held envelope wrap

- Plain vault AES-GCM is **insufficient**. A leaked passkey key is silently usable,
  un-rotatable without re-enroll at every RP, and converts an unphishable factor into a
  bearer secret with zero user-visible theft signal.
- **Mandatory:** vault stores `wrap(brokerKey, pkcs8)`. `brokerKey` is held ONLY by the
  broker, sealed to a **different trust boundary than the Hush masterKey** (TPM /
  Secure-Enclave, or at minimum a separate host/user). Unwrap only inside the broker at
  sign time, after allowedRpIds/topOrigins/flow-binding checks. **Top risk = key-separation
  theater:** if brokerKey sits beside the Hush masterKey / CDP signer on the same
  compromised host+user, the two layers collapse to one.
- **Scope (safe default preserved):** exportable creation allowed ONLY when ALL true — CH5
  org policy enabled, `Browser Automation` vault, service member, RP allowlisted (checked
  at BOTH enrollment AND broker sign time), flow-bound, audited. Human extension keeps
  non-exportable IndexedDB WebCrypto as the compiled-in default; **no human-vault
  migration**; **add a negative test that the human-account vault rejects exportable passkey
  items.**

### D3 headless unlock — native host must be a BROKER, not a key courier

- Native host beats `storage.local` (plaintext-on-disk, survives reboot, in profile
  backups) — but **never hand the masterKey to the browser.** One hardened daemon fetches
  the service masterKey from Hush by machine identity at boot (memory-only, `mlock`,
  non-dumpable, never persisted), does vault decrypt + policy + CDP injection ITSELF, and
  returns only per-request outputs (assertions, or a short-lived per-sign PKCS#8 injected
  via CDP and destroyed with `removeVirtualAuthenticator` immediately after). The extension
  requests "assert for flow X / RP Y" and never receives the masterKey.
- **Split-secret unlock:** Hush share ⊕ broker-local sealed share, combined only at daemon
  start, so a stolen Hush masterKey alone can't sign through the sanctioned path.
- **Top risk (precise):** native-messaging authenticates by **manifest extension ID, NOT
  the peer process** — any same-user local process that can spawn/replace the host or spoof
  the pipe gets everything. **Run the daemon as a separate user; harden the manifest path;
  treat same-user local compromise as explicitly game-over** (documented) or fix it with a
  hardware boundary.

### The aggregate-exposure hole (co-equal mechanism)

All guardrails today sit in front of *signing*; nothing sits in front of *decryption*. One
Hush secret reads raw PKCS#8 for every credential straight from the vault — no
allowedRpIds/rateLimit/flow-binding/lockout/audit. The D2 broker-held wrap is the fix that
also closes this: it makes vault ciphertext undecryptable without the broker, forcing every
key use through the rate-limited/flow-bound/audited/lockout-capable policy engine.

---

## 12. REVISED execution order (supersedes §8 sequencing)

**Gate 0 — verify revocation reality. DONE (2026-07-08, code-verified).** Padloc re-keying
is REAL, not theater: `SharedContainer.updateAccessors` (`packages/core/src/container.ts:210`)
*always* generates a fresh AES vault key and re-wraps it only for still-active members;
removal drops the accessor and the server denies the removed member further reads
(`server.ts:1444`, `org.ts:429`). **Two load-bearing caveats the automation design must
handle:**
1. **Re-key is LAZY** — deferred until a remaining write-capable member next syncs that
   vault (`app.ts:1441-1448`); `removeMember` itself does not re-key. Window is unbounded if
   no one edits the vault. → **Revocation ops must FORCE an immediate re-key**: after removing
   a member, edit/touch the automation vault and sync so `accessorsChanged` fires now.
2. **Already-read/exported secrets are NEVER clawed back** — there is no per-item key or
   retraction; a device that already synced holds those passkeys permanently. → **The real
   kill-switch for an already-synced passkey is RP-side credential DELETION**, not vault
   re-key. Vault re-key only protects *future* credentials. Keep an armed RP-side revocation
   path per credential (matches the oracle's "rotation ≠ revocation"). This is why the
   automation vaults must be RP/device-split (blast radius = the creds one device already
   read, nothing more).

**Gate 1 — PROVE Google passwordless login (P0, human-gated). Nothing roaming proceeds
until this is green.** Minimal canary on a NON-Crown/disposable account (go-b
`zackattacktucker` or `hassongoblue`): one registered automation passkey → full CDP (or
extension) assertion transcript → broker audit row → proven `logged_in`. Capture the raw
`navigator.credentials.get` assertion and diff vs browser-native to classify
delay-vs-shape. Needs ONE human sign-in (password + 2FA) to reach the add-passkey page =
the "don't willy-nilly log in" checkpoint. **This is the single highest-value next action.**

**Only after Gates 0+1 pass — build the blast-radius work:**
- Provision CH5 org + per-device service member accounts + RP/stage-split automation
  vaults (D1, re-key-on-revoke confirmed).
- Roaming key storage with the broker-held envelope wrap + scoping + human-vault negative
  test (D2).
- Broker-not-courier daemon as a separate user, split-secret unlock (D3).
- Load Plane A into all browsers; Plane B write-through fallback; migrate
  `CH5LANE_PASSKEY_*` → vault (D5).
- Availability doctor + zero-throughput alarm (§5).

**Autonomous NOW (safe, no login, no key expansion):** Gate 0 verification; this plan;
prepare the Gate-1 canary harness to one-human-step-away; commit the plan.
```

