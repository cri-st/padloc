# Supply-Chain & Compliance Audit — Findings Register (Phase 1)

Follow-up to the `sec-expert` engagement (archived at
`openspec/changes/archive/2026-08-06-sec-expert/`), which explicitly disclosed
supply-chain (SBOM, license, pipeline integrity) and compliance (GDPR-style
data/retention/DSR posture) as **never covered**. This register closes that
gap for `worker`, `server`, `core`, `app`, `pwa`, `extension`, `admin`
(matching `sec-expert`'s in-scope surface; `electron`/`tauri`/`macos`/`cordova`
remain excluded as deprecated).

Every finding below cites either a reproducible command + real output, or a
`file:line` reference read directly from this repository at commit `7b18725d`
on branch `supply-chain-compliance-audit`. Tool output was re-run fresh during
this phase (not copy-pasted from exploration) — see **Tool Re-Run
Confirmation** below for the one discrepancy found.

Status legend: `OPEN` = not yet remediated (this phase is audit-only);
`OPEN — fix scheduled in Phase 2-5 of this change` = a concrete code gap this
same SDD change will fix later in this branch; `OUT OF SCOPE — legal/business
judgment` = intentionally not resolved by code, per
`supply-chain-compliance-baseline` Req. 3.

## Tool Re-Run Confirmation

Re-ran with `PATH=/usr/local/bin:$PATH` (Node v24.13.0, npm 11.6.2 — the
`node:24-bookworm`-equivalent toolchain; the shell's default `node` on PATH is
a stale v14.15.5 that cannot run modern npm at all, a local environment quirk,
not a repo issue).

- **`npm sbom --sbom-format cyclonedx`** (component counts): `worker` 82,
  `server` 323, `core` 2, `extension` 382, `admin` 913 — all exit 0, **identical
  to exploration's counts, confirmed unchanged**. `app`/`pwa` still fail with
  the exact same error (see Finding S1).
- **`license-checker@25.0.1 --summary`**: license-family counts per package
  reproduced and matched exploration for every package (MIT/Apache-2.0/ISC/BSD
  majority, `UNLICENSED` = internal `@padloc/*` workspace packages, one
  `LGPL-3.0-or-later` entry, dual-license `GPL-3.0`/`GPL-2.0` options present
  but not forced).
- **Discrepancy found and corrected**: exploration attributed the single
  `LGPL-3.0-or-later` dependency, `@img/sharp-libvips-darwin-arm64@1.2.4`, to
  `pwa`/`admin` (as a `sharp` devDependency transitively pulling it). A fresh
  per-package `license-checker --json` scan grepped for `LGPL` found it
  **only in `packages/worker`'s installed tree**, not in `pwa`, `admin`, or
  `extension` (all three of which *do* declare `sharp` directly in their own
  `package.json`, but license-checker found no LGPL entry in their trees — the
  installed `sharp-libvips` binary matching their pinned `sharp` version must
  differ or resolve elsewhere). Tracing `packages/worker/package-lock.json`
  confirms the real path: `worker`'s `devDependency` on `wrangler` pulls in
  `miniflare`, which depends on `sharp@^0.34.5` for its local dev-server image
  tooling — that resolves to `@img/sharp-libvips-darwin-arm64@1.2.4`
  (LGPL-3.0-or-later), a **devDependency-only, local-dev-toolchain path**,
  never bundled into the deployed Worker script (esbuild-bundled, no `sharp`
  import in `packages/worker/src`). Finding S2 below uses this corrected
  attribution; exploration's `pwa`/`admin` framing was inaccurate on the
  specific package, though its underlying risk conclusion (build-time-only,
  not shipped) still holds for the corrected package.

---

## Supply-Chain Findings

### Inventory Summary Table

| Package | `npm sbom` (cyclonedx) | Components | License families (top 3) | Non-exact-pin deps |
|---|---|---|---|---|
| `worker` | ✅ exit 0 | 82 | MIT 59, Apache-2.0 9, MIT OR Apache-2.0 3 | `drizzle-orm@^0.38.0`, `drizzle-kit@^0.30.0` |
| `server` | ✅ exit 0 | 323 | MIT 233, Apache-2.0 32, ISC 31 | none |
| `core` | ✅ exit 0 | 2 | UNLICENSED 2 (internal), MIT 1 | none |
| `app` | ❌ **blocked** (S1) | n/a | MIT 193, ISC 24, BSD-3-Clause 9 | none |
| `pwa` | ❌ **blocked** (S1) | n/a | MIT 891, ISC 70, BSD-2-Clause 25 | none |
| `extension` | ✅ exit 0 | 382 | MIT 288, ISC 33, BSD-3-Clause 25 | `@playwright/test@^1.40.0`, `playwright@^1.40.0`, `tsconfig-paths@^4.2.0` |
| `admin` | ✅ exit 0 | 913 | MIT 773, ISC 57, BSD-2-Clause 24 | none |

Lockfile discipline: every in-scope package plus root has a committed
`package-lock.json` (`packages/{worker,server,admin,app,pwa,extension,core}/package-lock.json`,
root `package-lock.json`) — confirmed present via directory listing.

### S1. `app`/`pwa` SBOM generation blocked — `@types/trusted-types`/`dompurify` peer conflict — `FIXED (commit d293f18f)`

- **Evidence**: `cd packages/app && npm sbom --sbom-format cyclonedx` and the
  identical command in `packages/pwa` both exit 1:
  ```
  npm error code ESBOMPROBLEMS
  npm error invalid: @types/trusted-types@2.0.2, ^2.0.7 required by dompurify@3.4.13
  ```
- **Per `supply-chain-compliance-baseline` Req. 5 ("SBOM Completeness Across
  All In-Scope Packages")**: this is a blocked package, not a package to
  silently exclude. `app`/`pwa` have real, complete license inventories
  (via `license-checker`, which tolerates the resolution conflict) but **no
  valid SBOM** until the dependency-tree conflict is resolved.
- **Fix**: Pinned `@types/trusted-types` to `2.0.7` (devDependency) in
  `packages/app/package.json` and `packages/pwa/package.json` (both were
  independently stale at `2.0.2`); regenerated both lockfiles'
  `@types/trusted-types` entries to `2.0.7` (`npm install --package-lock-only`
  fails outright on this repo's unpublished `@padloc/core`/`@padloc/locale`
  local packages — patched the 4 lockfile locations per package directly
  against the real npm registry's `2.0.7` resolved URL/integrity, confirmed
  via an isolated `npm install --package-lock-only` run in a throwaway
  directory).
- **Verified**: `npm sbom --sbom-format cyclonedx` now exits 0 for both `app`
  (240 components) and `pwa` (1058 components); `tsc --noEmit --skipLibCheck`
  clean for both; the real `pwa` webpack build
  (`lerna run build --scope @padloc/pwa`) compiles successfully; `DOMPurify.sanitize()`
  smoke-tested in a real headless browser against the app's exact
  `MARKDOWN_ALLOWED_TAGS`/`MARKDOWN_ALLOWED_ATTR` allowlist (`<script>` tags
  stripped, `onerror`/`javascript:` URIs stripped, allowed tags/attrs
  preserved) — confirmed `@types/trusted-types` ships zero runtime `.js`
  files (type-only package), so the version pin cannot affect sanitizer
  behavior at all.

### S2. One LGPL-3.0-or-later dependency — `worker`'s dev-only `wrangler`/`miniflare`/`sharp` chain — informational, no fix needed

- **Evidence**: `license-checker --summary` on `packages/worker`:
  `LGPL-3.0-or-later: 1`; `--json` scan identifies
  `@img/sharp-libvips-darwin-arm64@1.2.4`. Package-lock trace:
  `packages/worker/package-lock.json` shows `sharp@^0.34.5` required by
  `miniflare` (a transitive dependency of `wrangler`, a devDependency of
  `worker`; see `packages/worker/package.json`).
- **Risk assessment (code-verifiable, not a legal conclusion)**: `sharp` is
  used only by Miniflare's local dev-server tooling, never imported by
  `packages/worker/src` and never present in the esbuild-bundled Worker script
  that actually deploys. LGPL-3.0's copyleft-propagation trigger (static
  linking into a distributed binary) does not apply to a devDependency that
  never ships. Low risk, but flagged for completeness per Req. 2 (every
  license finding must be evidence-backed, not omitted for being "probably
  fine").
- **Note**: this corrects exploration.md's attribution of this same finding
  to `pwa`/`admin` — see Tool Re-Run Confirmation above.

### S3. `AGPL`-vs-`GPL-3.0`/`GPLv3` license-declaration mismatch — `OUT OF SCOPE — legal/business judgment`

See the dedicated **Legal/Business Judgment** section below — not folded into
this table per `supply-chain-compliance-baseline` Req. 3.

### S4. Version-pinning discipline — strong overall, 5 named exceptions — `OPEN` (informational, no fix planned this change)

- **Evidence** (`node -e` walk of each package's `dependencies`/`devDependencies`
  for `^`/`~` ranges):
  - `packages/worker/package.json`: `drizzle-orm@^0.38.0`, `drizzle-kit@^0.30.0`
  - `packages/extension/package.json`: `@playwright/test@^1.40.0`,
    `playwright@^1.40.0`, `tsconfig-paths@^4.2.0`
  - `server`, `core`, `app`, `pwa`, `admin`: zero non-exact pins found.
- **Risk**: both Dockerfiles (`Dockerfile-server`, `Dockerfile-pwa`) run
  `npm ci`, which honors the committed lockfile's exact resolved versions —
  **CI/production builds are reproducible despite these ranges**. Residual
  risk is confined to a local `npm install` (not `ci`) silently drifting to a
  newer minor/patch before the lockfile is regenerated and committed.
- **Not fixed this change**: cosmetic/process discipline, no security or
  compliance blast radius; out of the 4 ADRs this change's Phase 2-5 covers.

### S5. CI pins GitHub Actions by tag, not commit SHA — `FIXED (commit bc2bcbf3)`

- **Evidence**: `.github/workflows/docker-publish.yml:58,61,68,76,85` —
  `uses: actions/checkout@v4`, `docker/setup-buildx-action@v3`,
  `docker/login-action@v3`, `docker/metadata-action@v5`,
  `docker/build-push-action@v6` — all tag-pinned, none SHA-pinned.
- **Risk**: tag pinning is a known supply-chain weakness — a compromised or
  republished tag silently changes behavior on the next CI run. This is the
  **only CI pipeline** in the repo (confirmed: no other `.github/workflows/*`
  file exists).
- **Related, confirmed unresolved by this scan**: no image signing/attestation
  step (no `cosign` invocation, no explicit `provenance:`/`sbom:` input on
  `build-push-action`) is configured. Whatever provenance
  `docker/build-push-action@v6` attaches by default is **unconfirmed** — GHCR
  packages are private and this review has no registry credentials to inspect
  the pushed manifest. Disclosed as unconfirmed, not claimed either way. No
  ad-hoc `curl`/`wget` steps exist in `docker-publish.yml` itself, so no
  in-workflow checksum-verification gap beyond the action-pinning issue.
- **Fix**: `.github/workflows/docker-publish.yml`'s 5 `uses:` refs
  (`actions/checkout@v4`, `docker/setup-buildx-action@v3`,
  `docker/login-action@v3`, `docker/metadata-action@v5`,
  `docker/build-push-action@v6`) re-pinned to the exact commit SHA each
  major-version tag currently resolves to, tag preserved as a trailing
  comment (e.g. `actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4.4.0`).
- **Verified**: each SHA cross-checked two independent ways — `git ls-remote
  --tags` against the real GitHub repo AND the unauthenticated GitHub REST
  API (`/repos/<owner>/<repo>/git/refs/tags/<tag>`) — both agreed exactly for
  all 5 actions, and all 5 are lightweight tags (`type: commit`, no
  annotated-tag peeling ambiguity). Post-edit YAML re-parsed successfully
  (Node `js-yaml`) confirming no syntax break to this repo's only CI
  pipeline.

### S6. `nginx/Dockerfile` staleness and `apt-key`-based trust — `OUT OF SCOPE — legal/business judgment` (self-hosted-only)

See the dedicated **Legal/Business Judgment** section below.

### S7. No automated dependency-update/advisory tooling — `OPEN` (informational, no fix planned this change)

- **Evidence**: `.github/dependabot.yml` and `renovate.json` — both confirmed
  absent (`ls` returns "No such file or directory" for both, checked at repo
  root).
- **Risk**: vulnerability awareness depends entirely on someone manually
  re-running `npm audit` (as `sec-expert` Round 2 did once, per its archived
  register) — no standing mechanism catches a new CVE landing in an
  already-pinned dependency between manual audits.
- **Not fixed this change**: standing up Dependabot/Renovate is new recurring
  infrastructure, explicitly out of this change's mechanical-fix scope per
  `proposal.md`'s rejected-alternative note in design.md ADR 4.

### S8. Base-image pinning — Dockerfiles reasonably current, `nginx/Dockerfile` is the exception

- **Evidence**: `Dockerfile-server:1` and `Dockerfile-pwa:1` both
  `FROM node:24-bookworm` — a moving minor-version tag, not a digest pin, but
  reasonably current and covered by CI on every push. `nginx/Dockerfile:1`
  `FROM nginx:1.21` — materially worse; detailed under Legal/Business
  Judgment (S6) since remediating it is a self-hosted-path risk call, not a
  mechanical fix.

### S9. Infrastructure-level vendor dependencies — noted, not deep-audited (matches `sec-expert` scope boundary)

Cloudflare (Worker runtime, D1, R2, KV, Durable Objects) and Resend
(transactional email, `packages/worker/src/email/resend.ts`). A real vendor
supply-chain risk assessment (SOC2 report review, subprocessor list, incident
history) is out of an AI code-reviewing agent's reach — matches the exact
limitation `sec-expert` already disclosed for the Cloudflare account/MFA
review.

---

## Compliance Findings

### Personal Data Inventory

| Data | Location | Protection | Evidence |
|---|---|---|---|
| Account `email`, `name`, `created`/`updated`, `publicKey` | `packages/core/src/account.ts:69-85` | Plaintext/server-readable | file:line |
| Account `privateKey`/`signingKey` | `packages/core/src/account.ts` | `@Exclude()`d from serialization; only ever decrypted in memory client-side; at rest inside the account's own PBES2-encrypted container | class definition |
| `OrgMember.name`/`.email` | `packages/core/src/org.ts:56-60` | Plaintext — necessary for org-admin UI; server must read org membership to enforce authorization, so not E2E-encryptable | file:line |
| `DeviceInfo` (device fingerprint: `platform`, `osVersion`, `id`, `appVersion`, `userAgent`, `locale`, `manufacturer`, `model`, `browser`, `browserVersion`) | `packages/core/src/platform.ts:15-48` | Plaintext, stored per trusted device/session | file:line |
| IP address (transient) | `packages/worker/src/transport.ts:221-223` | Captured on incoming requests for rate-limiting/geolocation; only `{city, country}` persisted into `LogEvent.context.location` (`packages/core/src/logging.ts:34-37`), not the raw IP | file:line |
| Vault contents (credentials, notes, attachments) | `packages/core/src/attachment.ts:112-158` | **Client-side E2E encrypted** — `Attachment extends SimpleContainer` with a client-generated AES key; ciphertext-only at rest in R2/S3. Reconfirms (not re-derives) `sec-expert`'s zero-knowledge claim | file:line |

Whether the raw IP is independently persisted anywhere outside this codebase
(e.g. Cloudflare's own edge logs) is out of this review's reach.

### C1. Attachment cascade-delete gap on account/org deletion — `FIXED (commit 0854cd65)`

- **Evidence**: `packages/core/src/server.ts:1289-1327` (`deleteAccount`) deletes
  the account's main `Vault` storage record (line 1315:
  `await this.storage.delete(Object.assign(new Vault(), { id: account.mainVault.id }))`),
  revokes sessions, and deletes `Auth`/`Account` objects — **no call to
  `attachmentStorage.deleteAll(...)` anywhere in the method**.
  `packages/core/src/server.ts:1671-1699` (`deleteOrg`) has the identical gap:
  line 1681 deletes every org vault (`Promise.all(org.vaults.map(v =>
  this.storage.delete(...)))`) with no attachment cleanup first.
- **Established precedent this violates**: `deleteVault()`
  (`packages/core/src/server.ts:1873-1874`) **already calls this exact
  method** — `await this.attachmentStorage.deleteAll(vault.id);` — before
  removing the vault. `deleteAccount`/`deleteOrg` skip a step their sibling
  method already implements correctly.
- **Client-side confirms the intended lifecycle**:
  `packages/core/src/app.ts:1663-1664` explicitly loops "Delete all
  attachments for this item" before deleting items on the client path.
- **Compliance impact**: attachment blobs (R2/S3/self-hosted filesystem) are
  **orphaned, not erased**, on account or org deletion — a concrete
  right-to-erasure/data-minimization gap, not hypothetical. No account-data-
  export capability exists in `packages/core/src/server.ts` either (the sync
  protocol lets a client pull its own data down incrementally, but there is no
  dedicated "export everything" API) — noted, not treated as a defect since no
  requirement in `supply-chain-compliance-baseline` covers data export.
- **Maps to** `supply-chain-compliance-baseline` Req. "Attachment
  Cascade-Delete Completeness".
- **Fix**: `deleteAccount()` (`server.ts:1314-1315`) now calls
  `attachmentStorage.deleteAll(account.mainVault.id)` before the main-vault
  storage delete; `deleteOrg()` (`server.ts:1683-1686`) now loops
  `org.vaults` calling `attachmentStorage.deleteAll(v.id)` before the
  `Promise.all` vault delete — both mirror `deleteVault()`'s existing
  pattern exactly, no `try`/`catch` swallowing.
- **Verified**: new `packages/core/test/attachment-cascade-delete.spec.ts`
  (real `Server`/`Controller`/`MemoryStorage`/`MemoryAttachmentStorage`, not
  a reimplementation) proves `attachmentStorage.get()` throws `NOT_FOUND`
  after `deleteAccount()` and after `deleteOrg()` (multi-vault) — 6/6
  assertions pass. A negative-control run (temporarily reverting the two new
  calls) reproduced 3/6 failures, confirming the test genuinely catches the
  regression. `packages/server`'s pinned `tsc --noEmit --skipLibCheck` clean.

### C2. Log retention — aspirational comment, never implemented (T26) — `FIXED (commit 27786b9c)`

- **Evidence**: `packages/worker/src/storage/schema.ts:274-275`:
  ```
  // request_log — Append-only audit trail for HTTP requests.
  // Configurable retention (truncated by cron in T26).
  ```
  A repo-wide grep for `scheduled(`, `[triggers]`, and `crons` under
  `packages/worker` returns **zero matches** — no `scheduled()` export exists
  anywhere in `packages/worker/src`, and `wrangler.toml` has no `[triggers]`
  block. "T26" reads as an internal task reference that was never completed.
  `change_log` (also append-only per the same schema file's header comment)
  has no retention mechanism either. `LogEvent`/`LogEntry` in
  `packages/core/src/logging.ts` have no TTL/expiry field in their class
  definitions.
- **Compliance impact**: audit logs, request logs, and change logs accumulate
  indefinitely by default — a real data-minimization/retention-policy gap for
  any GDPR-style assessment (Art. 5(1)(e) storage limitation, cited for
  context, not as a formal legal determination).
- **Maps to** `supply-chain-compliance-baseline` Req. "Log Retention
  Enforcement".
- **Fix**: added `scheduled(event, env, ctx)` export to
  `packages/worker/src/index.ts` (deletes `request_log`/`change_log` rows
  older than `LOG_RETENTION_DAYS`, default 90, via the existing
  `safeParsePositiveNumber` helper); added `LOG_RETENTION_DAYS?: string` to
  `Env` (`env.ts`); added a daily `[triggers]` cron block
  (`crons = ["0 3 * * *"]`) to `wrangler.toml`.
- **Verified**: real local exercise via `wrangler dev --local --test-scheduled`
  — seeded one 120-day-old row and one 1-day-old row into both `request_log`
  and `change_log` via `wrangler d1 execute --local`, hit
  `GET /__scheduled?cron=0+3+*+*+*`, confirmed the aged rows were deleted and
  the fresh rows retained in both tables (`wrangler d1 execute` SELECT
  cross-check), and confirmed `/healthcheck` still returns `200` afterward.
  Full `npm run test:ci` (13 sub-suites) passes, exit 0, zero regressions.

### C3. Encryption posture for compliance purposes — confirmed, not re-derived

- Vault contents and attachments are genuinely E2E/zero-knowledge encrypted
  client-side (re-cited from `sec-expert` + `SECURITY.md`, structurally
  reconfirmed via `packages/core/src/attachment.ts:112-158` above — not
  re-proven from scratch).
- Metadata at rest (accounts, orgs, logs) relies on **Cloudflare's own
  platform-level at-rest encryption** for D1/R2/KV — there is no additional
  app-level encryption layer over that metadata. This is expected/normal
  architecture but is stated explicitly here rather than implying an
  app-level encryption layer exists where it doesn't.

### C4. Audit logging — broad coverage, contingent on fixing C2

- **Evidence**: `this.log(...)` is called at 25+ distinct points across
  `packages/core/src/server.ts`, covering login success/failure
  (`account.createSession`), password/MFA changes, session revocation,
  account/org creation/deletion (including the `this.log("account.delete")`
  at line 1326 and `this.log("org.delete", ...)` at line 1698 cited above),
  vault/attachment CRUD, invite lifecycle, and share-link
  create/reveal/revoke.
- **Assessment**: a genuinely broad audit trail suitable as a compliance
  audit-trail foundation — but **an audit trail that never expires is a
  data-hoarding liability, not a feature**, under most compliance frameworks.
  This finding is explicitly contingent on C2's fix landing; it is not a
  standalone gap.

### C5. Legal/policy artifacts — confirmed absent, not fabricated — `OPEN` (business responsibility, not code-fixable)

- **Evidence**: a repository-wide search for "privacy policy", "terms of
  service", "cookie policy", "DPA", and "breach notification" found no such
  document anywhere in this repository. `assets/manifest.json`'s
  `terms_of_service` field points at the generic upstream
  `https://padloc.app/` homepage, not a real ToS.
- **Not a code defect**: this is expected for an engineering repository and
  is reported as a gap for the business/legal side to fill — no fix is
  planned in this SDD change; it is not a code-remediable finding.

### C6. Data residency — cannot be resolved from source alone — `OPEN` (needs live account access)

- **Evidence**: no region/jurisdiction pinning found anywhere in
  `packages/worker/wrangler.toml` for D1/R2/KV bindings — data location
  follows Cloudflare's default global distribution.
- **Limitation**: confirming exactly which Cloudflare account-level settings
  (jurisdiction restrictions, available on some D1/R2 tiers) are or aren't
  configured requires live Cloudflare account access this review doesn't
  have — the same access limitation `sec-expert` already disclosed for its
  account/MFA review. No fix attempted; disclosed as a gap requiring
  operator-side confirmation.

### C7. Consent/cookie mechanisms — reconfirmed, moot

- Reconfirms (does not re-derive) `sec-expert`'s finding of zero cookie usage
  anywhere in `worker`/`server`/`app` — moot for cookie-consent banners. The
  one telemetry pipeline in scope,
  `packages/worker/src/hq-instrumentation.ts` (Sentry/OTLP-style
  error/exception telemetry), is server-to-server (Worker → operator-
  controlled logging endpoint), not a client-side browser tracker — it goes
  through the same field-level redaction as everything else
  (`packages/worker/src/observability/log-redaction.ts`) and is not a
  cookie/consent concern in the ePrivacy sense. No other tracking/analytics
  beacon was found in `packages/app`/`packages/pwa`.

---

## Legal/Business Judgment — Not Resolved Here

Per `supply-chain-compliance-baseline` Req. 3 (Scope Disclosure Honesty),
these two findings are code-verified **facts**, but their remediation is a
legal or business decision this review explicitly does not make.

### L1. `AGPL` vs. `GPL-3.0`/`GPLv3` license-declaration mismatch

- **Code-verified fact**: the repository root `LICENSE` file's actual text
  begins:
  ```
                      GNU AFFERO GENERAL PUBLIC LICENSE
                         Version 3, 19 November 2007
  ```
  (confirmed by reading the file header directly). But **every single
  `package.json`** — root and all 7 in-scope packages — declares
  `"license": "GPL-3.0"` (`server`, `core`, `app`, `pwa`, `admin`, root) or
  `"license": "GPLv3"` (`worker`, `extension`), confirmed via a direct grep of
  each `package.json`'s `license` field. Neither declared value is AGPL, and
  `"GPLv3"` is not even a valid SPDX identifier.
- **Why this is a legal call, not a code fix**: this mismatch is upstream
  padloc's own inconsistency, inherited by this fork — but it materially
  matters here. **AGPL §13's network-use clause** requires anyone who runs a
  *modified* AGPL program as a network service to offer the modified source
  to users of that service; GPL-3.0 has no such clause. If this fork (running
  as a commercial hosted SaaS for CrackIt) is knowingly or unknowingly relying
  on the `package.json` `"GPL-3.0"`/`"GPLv3"` label instead of the real
  `LICENSE` file's AGPL terms, that is a legal-exposure question a lawyer
  needs to resolve.
- **This review does not**: correct the `package.json` license fields, offer
  a legal opinion on current compliance status, or recommend AGPL vs. GPL-3.0
  as the "correct" choice. The *fact* of the mismatch is fully code-verified
  and is surfaced here prominently, not silently resolved or buried in a
  table row.

### L2. `nginx/Dockerfile` modernization

- **Code-verified facts**: `nginx/Dockerfile:1` is `FROM nginx:1.21` — stale;
  current stable is 1.27+. The base OS is Debian `stretch` (confirmed via the
  APT repo line at `nginx/Dockerfile:6`:
  `echo 'deb https://packages.amplify.nginx.com/debian/ stretch amplify-agent' > ...`),
  and `stretch` has been EOL since 2022. `nginx/Dockerfile:7` installs the
  NGINX Amplify monitoring agent via
  `curl -fs https://nginx.org/keys/nginx_signing.key | apt-key add -` —
  the deprecated `apt-key` trust mechanism, piped directly from `curl`, then
  adds that third-party APT repo pointed at the EOL `stretch` codename. This
  is the closest thing in the repo to a real curl-pipe-to-trust
  supply-chain anti-pattern, and — critically — it sits **outside the CI
  pipeline's visibility entirely**: `docker-publish.yml`'s `paths:` trigger
  list does not include `nginx/**`, and this image is only ever built locally
  at `docker compose build` time for the self-hosted reverse-proxy path, per
  `docker-compose.yml`.
- **Why this is a business call, not a mechanical fix**: `nginx/Dockerfile`
  is self-hosted-only with **zero CI/test coverage** — a version bump risks
  breaking that path blind, with no automated way to catch a regression
  before a self-hosting operator hits it in production. Modernizing base
  image + drop `apt-key` for a signed-by keyring approach is a well-understood
  pattern, but doing it safely needs either new CI coverage for this image
  (infrastructure investment) or an operator willing to accept the risk of an
  unverified change — a deliberate scope/risk decision, not a 2-line patch.
- **This review does not**: modify `nginx/Dockerfile`. It is documented as a
  recommendation only, per `proposal.md`'s explicit Out of Scope list.

---

## Fix-Status Summary

| Finding | Status now |
|---|---|
| C1 — Attachment cascade-delete | `FIXED (commit 0854cd65)` |
| C2 — Retention cron (T26) | `FIXED (commit 27786b9c)` |
| S1 — `app`/`pwa` SBOM blocker | `FIXED (commit d293f18f)` |
| S5 — CI SHA-pinning | `FIXED (commit bc2bcbf3)` |
| L1 — AGPL/GPL-3.0 mismatch | `OUT OF SCOPE — legal/business judgment` — never silently resolved |
| L2 — `nginx/Dockerfile` modernization | `OUT OF SCOPE — legal/business judgment` — documented recommendation only |
| S2, S4, S7, S8, S9, C3, C4, C5, C6, C7 | `OPEN` (informational) — unchanged, no fix planned this change |

## Scope Disclosure

This register is code-verified evidence for a real compliance/legal review —
**not a substitute for one, and not a GDPR/SOC2/ISO27001 certification**. It
does not and cannot: draft a privacy policy or ToS, confirm Cloudflare-level
data-residency settings, assess vendor (Cloudflare, Resend) SOC2 posture, or
render a legal opinion on the AGPL/GPL-3.0 mismatch. Everything above is
either a direct `file:line` citation, a reproduced command's real output, or
explicitly labeled as outside code-verifiable reach.
