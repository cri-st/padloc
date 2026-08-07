## Exploration: Supply-Chain & Compliance Audit (follow-up to `sec-expert` engagement)

### Current State

The `sec-expert` engagement (2 rounds, archived) explicitly disclosed two workstreams as
**never covered**: dependency/supply-chain risk (SBOM, license review, build-pipeline
integrity) and compliance (GDPR/SOC2/ISO27001 gap assessment). `npm audit` (CVE scanning)
*was* run in Round 2 and is **out of scope here** — this exploration covers only what
Round 2 didn't: SBOM generation, license compliance, pipeline/lockfile integrity, and the
full compliance workstream (data inventory, DSR support, retention, encryption posture,
audit logging, legal artifacts, residency, consent).

In-scope packages (matches `sec-expert` scope): `worker`, `server`, `core`, `app`, `pwa`,
`extension`, `admin`. Excluded: `electron`, `tauri`, `macos`, `cordova` (deprecated).

Every in-scope package plus root has a committed `package-lock.json`
(`packages/{worker,server,admin,app,pwa,extension,core}/package-lock.json`, root
`package-lock.json`) — lockfile discipline is intact everywhere.

### Affected Areas

**Supply-chain:**
- `package.json` (root) + `packages/{worker,server,core,app,pwa,extension,admin}/package.json` — dependency inventory, license field, version-pinning discipline.
- `LICENSE` (repo root) — actual license text vs. declared `license` fields.
- `.github/workflows/docker-publish.yml` — the only CI; action-pinning, no signing/attestation/checksum verification.
- `Dockerfile-server`, `Dockerfile-pwa` — base-image pinning, `npm ci` usage.
- `nginx/Dockerfile` + `docker-compose.yml` — self-hosted reverse-proxy image, built locally (not in CI), stale base + third-party APT repo trust pattern.
- No `.github/dependabot.yml` / `renovate.json` — no automated dependency-update/advisory tooling.

**Compliance:**
- `packages/core/src/account.ts` (`Account`, `AccountSecrets`) — personal data fields.
- `packages/core/src/org.ts` (`OrgMember`) — plaintext org membership name/email.
- `packages/core/src/platform.ts` (`DeviceInfo`) — device/browser fingerprint fields.
- `packages/core/src/server.ts` — `deleteAccount` (:1289), `deleteOrg` (:1671), `this.log(...)` audit-event call sites (25+), attachment lifecycle (`createAttachment`/`deleteAttachment`).
- `packages/core/src/attachment.ts` — client-side AES encryption before upload (zero-knowledge extends to attachments).
- `packages/core/src/logging.ts` — `LogEvent`/`LogEntry`/`ChangeLogEntry`/`RequestLogEntry` — no retention/TTL fields anywhere in the class hierarchy.
- `packages/worker/src/storage/schema.ts` (:274) — `request_log` comment says "Configurable retention (truncated by cron in T26)" — **aspirational, unimplemented**.
- `packages/worker/wrangler.toml` — no cron `[triggers]`, no `scheduled()` export anywhere in `packages/worker/src`, no region/jurisdiction pinning for D1/R2/KV.
- `packages/worker/src/hq-instrumentation.ts`, `packages/worker/src/observability/log-redaction.ts` — server-side telemetry pipeline, field-level redaction.
- `assets/manifest.json` (`terms_of_service`) — points at the generic `https://padloc.app/` homepage, not a real ToS/privacy-policy document.
- `SECURITY.md` — upstream's own encryption-architecture whitepaper (citable evidence for the E2E/zero-knowledge claim).

### Findings — Supply-Chain (locally verified, not deferred)

1. **SBOM generation IS locally feasible, no new tooling needed.** `npm sbom
   --sbom-format cyclonedx` (native to npm ≥9, confirmed on the installed npm 11.6.2) ran
   successfully for `worker` (82 components), `server` (323), `core` (2), `extension`
   (382), `admin` (913). SPDX format (`--sbom-format spdx`) is also natively supported.
   **`app` and `pwa` fail** with `npm error code ESBOMPROBLEMS: invalid:
   @types/trusted-types@2.0.2, ^2.0.7 required by dompurify@3.4.13` — a real,
   reproducible dependency-tree integrity gap in the installed `node_modules` for those
   two packages (same `dompurify`/`trusted-types` root cause the
   `padloc-fix-verification-gotchas` skill already flagged for `tsc`, now confirmed to
   also break SBOM generation). This needs a real fix (lockfile/install correction)
   before an accurate SBOM for `app`/`pwa` can be generated — not just a `sdd-apply`
   footnote.

2. **License compliance — real risk data gathered, not guessed.** `license-checker`
   v25.0.1 (network-installed via a scratch npm cache since the shared `~/.npm` cache had
   a corrupted/permission-locked entry unrelated to this repo) ran against every
   in-scope package's actual installed tree:
   - No forced-copyleft (GPL/AGPL-only) *third-party* transitive dependency found in any
     package. A few dependencies offer a copyleft option inside a dual license (e.g. `(MIT
     OR GPL-3.0-or-later)`, `(BSD-3-Clause OR GPL-2.0)`) — consumers may pick the
     permissive branch, so this is low risk, not zero-risk-worth-ignoring.
   - One **LGPL-3.0-or-later** dependency: `@img/sharp-libvips-darwin-arm64` (native
     `libvips` binary pulled transitively by `sharp`, a **devDependency** used only for
     build-time image processing in `pwa`/`admin`, never shipped in the runtime bundle) —
     low risk since LGPL's dynamic-linking-at-build-time-only usage here doesn't trigger
     copyleft propagation into the shipped app, but this should be confirmed, not assumed,
     by whoever signs off on the license posture.
   - **`UNLICENSED` entries are just the internal `@padloc/*` workspace packages**
     (`license-checker` doesn't parse their declared `GPL-3.0`/`GPLv3` field correctly
     given `"private": true`) — not a real third-party risk, but worth fixing the
     `license-checker` config (`--excludePackages`) if this becomes a recurring compliance
     check.
   - **A genuine, significant finding**: the repo's actual `LICENSE` file (root) is the
     full **GNU AFFERO GPL v3** text (confirmed by reading the file header: "GNU AFFERO
     GENERAL PUBLIC LICENSE"), but **every single `package.json`** (root and all 7
     in-scope packages) declares `"license": "GPL-3.0"` or `"license": "GPLv3"` —
     neither of which is AGPL, and `"GPLv3"` isn't even a valid SPDX identifier. This
     mismatch is upstream padloc's own inconsistency (inherited by the fork), but it
     matters materially here: **AGPL §13's network-use clause** requires anyone who runs
     a *modified* AGPL program as a network service to offer the modified source to
     users of that service — GPL-3.0 has no such clause. If this fork (running as a
     commercial hosted SaaS for CrackIt) is knowingly or unknowingly relying on the
     `package.json` `"GPL-3.0"` label instead of the real `LICENSE` file's AGPL terms,
     that is a legal-exposure question a lawyer needs to resolve, not an AI reviewer —
     but the *fact* of the mismatch is fully code-verified and should be surfaced
     prominently, not buried.

3. **Version-pinning discipline is strong overall, with named exceptions.** Across every
   in-scope `package.json`, only 5 dependencies use a `^`/`~` range instead of an exact
   pin: `packages/worker` → `drizzle-orm@^0.38.0`, `drizzle-kit@^0.30.0`;
   `packages/extension` → `@playwright/test@^1.40.0`, `playwright@^1.40.0`,
   `tsconfig-paths@^4.2.0`. Because both Dockerfiles use `npm ci` (which honors the
   committed lockfile's exact resolved versions), the *build* is reproducible even with
   these ranges present — the residual risk is a **local** `npm install` (not `ci`)
   silently drifting to a newer minor/patch before the lockfile is regenerated and
   committed.

4. **CI (`docker-publish.yml`) pins GitHub Actions by tag, not SHA** —
   `actions/checkout@v4`, `docker/setup-buildx-action@v3`, `docker/login-action@v3`,
   `docker/metadata-action@v5`, `docker/build-push-action@v6`. Tag pinning is a known
   supply-chain weakness (a compromised/republished tag silently changes behavior on the
   next run) vs. pinning the action's commit SHA. **No image signing/attestation step**
   (no `cosign`, no explicit `provenance:`/`sbom:` input on `build-push-action`) is
   configured; whatever provenance `docker/build-push-action@v6` attaches by default is
   unverified here since GHCR packages are private and I have no registry credentials to
   inspect the pushed manifest — this is disclosed as **unconfirmed**, not claimed either
   way. No checksum verification of any downloaded artifact in the workflow (there are no
   ad-hoc `curl`/`wget` steps in `docker-publish.yml` itself).

5. **Base-image pinning**: `Dockerfile-server`/`Dockerfile-pwa` use `FROM
   node:24-bookworm` — a moving minor-version tag (not a digest pin), reasonably current.
   **`nginx/Dockerfile`** (used by `docker-compose.yml`'s self-hosted `nginx` service,
   built locally at `docker compose build` time — never built or scanned by CI) is
   materially worse: `FROM nginx:1.21` (stale — current stable is 1.27+, unpatched CVEs
   likely accumulated) on a **Debian `stretch`** base (EOL since 2022), and installs the
   NGINX Amplify monitoring agent via `curl -fs https://nginx.org/keys/nginx_signing.key |
   apt-key add -` piped into the deprecated `apt-key` trust mechanism, then adds a
   third-party APT repo pointed at the EOL `stretch` codename. This is the closest thing
   in the repo to a real curl-pipe-to-trust supply-chain anti-pattern, and it sits outside
   the CI pipeline's visibility entirely.

6. **No automated dependency-update/advisory tooling** — no `.github/dependabot.yml`, no
   `renovate.json`. Vulnerability awareness depends entirely on someone manually re-running
   `npm audit` (as `sec-expert` Round 2 did once) — there's no standing mechanism that
   would catch a new CVE landing in an already-pinned dependency between audits.

7. **Infrastructure-level vendor dependencies** (noted, not deep-audited — matches scope
   note in the assignment): Cloudflare (Worker runtime, D1, R2, KV, Durable Objects),
   Resend (transactional email, per `packages/worker/src/email/resend.ts`). A real vendor
   supply-chain risk assessment (SOC2 report review, subprocessor list, incident history)
   for these is out of an AI code-reviewing agent's reach — same conclusion `sec-expert`
   already reached for Cloudflare account/MFA access review.

### Findings — Compliance (code-reviewable, evidence-cited)

1. **Personal data inventory** (traced from `packages/core/src/account.ts:65-207`,
   `org.ts`, `platform.ts:15-48`):
   - `Account`: `email`, `name`, `created`/`updated` timestamps, `publicKey` — all
     plaintext/server-readable. `privateKey`/`signingKey` are `@Exclude()`d from
     serialization and only ever exist decrypted in memory client-side; at rest they live
     inside the account's own PBES2-encrypted container (password-derived key).
   - `OrgMember` (`org.ts:56-60`): plaintext `name` + `email` per member — necessary for
     org-admin UI, not E2E encrypted (server must be able to read org membership to
     enforce authorization).
   - `DeviceInfo` (`platform.ts:15-48`): `platform`, `osVersion`, device `id`,
     `appVersion`, `userAgent`, `locale`, `manufacturer`, `model`, `browser`,
     `browserVersion` — a genuine device fingerprint, stored per trusted device/session.
   - IP addresses: captured transiently on incoming requests
     (`packages/worker/src/transport.ts:221-223`, `req.ipAddress = cf-connecting-ip ||
     x-forwarded-for`) for rate-limiting and geolocation (city/country only — the raw IP
     itself is not persisted into `LogEvent.context.location`, which stores only
     `{city, country}` per `packages/core/src/logging.ts:34-37`). Whether the raw IP is
     independently persisted anywhere else (e.g. Cloudflare's own edge logs, which are
     outside this codebase) is out of this review's reach.
   - Vault contents (credentials, notes, attachments): **client-side E2E encrypted**
     (Shared-Key scheme per `SECURITY.md`, confirmed structurally — `Attachment` extends
     `SimpleContainer` with a client-generated AES key at `packages/core/src/attachment.ts:112-158`,
     so attachment blobs in R2/S3 are ciphertext-only, same zero-knowledge guarantee as
     vault items). This reconfirms, rather than re-derives, `sec-expert`'s zero-knowledge
     claim.

2. **Data subject rights (deletion) — a real, previously-undisclosed gap found**:
   `Server.deleteAccount()` (`packages/core/src/server.ts:1289-1327`) deletes the
   account's main `Vault` storage record, revokes all sessions, and deletes the `Auth`
   and `Account` objects — but **never calls `deleteAttachment` for any attachment
   referenced by items in that vault**, unlike the client-side item-deletion path
   (`packages/core/src/app.ts:1663-1664`, which explicitly loops "Delete all attachments
   for this item" before deleting items). `Server.deleteOrg()`
   (`packages/core/src/server.ts:1671-1699`) has the identical gap for org vaults. This
   means **attachment blobs (R2/S3/self-hosted filesystem) are orphaned, not erased,
   on account or org deletion** — a concrete right-to-erasure/data-minimization gap, not
   a hypothetical one. No account-data-export capability was found anywhere in
   `packages/core/src/server.ts` (the sync protocol lets a client pull its own data down
   incrementally, but there's no dedicated "export everything" API).

3. **Data retention — aspirational, not implemented**: `packages/worker/src/storage/schema.ts:274-275`
   comments the `request_log` table as "Append-only audit trail for HTTP requests.
   Configurable retention (truncated by cron in T26)" — but grepping the entire
   `packages/worker` tree found **no `scheduled()` export, no `[triggers]` block in
   `wrangler.toml`, and no cron configuration anywhere**. "T26" reads as an internal
   task reference that was never completed. `change_log` (also append-only per the same
   schema file's header comment) has no retention mechanism either. `LogEvent`/`LogEntry`
   in `packages/core/src/logging.ts` have no TTL/expiry field in their class definitions.
   **Net effect: audit logs, request logs, and change logs accumulate indefinitely by
   default** — a real data-minimization/retention-policy gap for any GDPR-style
   assessment (Art. 5(1)(e) storage limitation).

4. **Encryption posture for compliance purposes**: vault contents and attachments are
   genuinely E2E/zero-knowledge encrypted client-side (re-cited from `sec-expert`+
   `SECURITY.md`, structurally reconfirmed above — not re-proven from scratch). Metadata
   at rest (accounts, orgs, logs) relies on **Cloudflare's own platform-level at-rest
   encryption** for D1/R2/KV — there is no additional app-level encryption layer over
   that metadata, which is expected/normal but worth stating explicitly rather than
   implying app-level encryption exists where it doesn't.

5. **Audit logging**: `this.log(...)` is called at 25+ distinct points across
   `packages/core/src/server.ts` covering login success/failure
   (`account.createSession`), password/MFA changes, session revocation, account/org
   creation/deletion, vault/attachment CRUD, invite lifecycle, and share-link
   create/reveal/revoke — a genuinely broad audit trail suitable as a compliance
   audit-trail foundation, **contingent on fixing the retention gap in finding 3 above**
   (an audit trail that never expires is a data-hoarding liability, not a feature, under
   most compliance frameworks).

6. **Legal/policy artifacts — confirmed absent**, not fabricated: no privacy policy,
   terms-of-service document, cookie policy, DPA template, or breach-notification
   procedure exists in this repository (searched the whole tree for these terms; the only
   hits were `sec-expert`'s own prior scope docs discussing the *absence* of a compliance
   review, and `assets/manifest.json`'s `terms_of_service` field, which points at the
   generic upstream `https://padloc.app/` homepage rather than a real ToS — a pre-existing
   observation already on record in `.sisyphus/notepads/ch5-auth-launch/learnings.md`,
   not a new discovery). This is expected for an engineering repo and is reported as a
   gap for the business/legal side to fill, not something this review can generate.

7. **Data residency**: no region/jurisdiction pinning found in `packages/worker/wrangler.toml`
   for D1/R2/KV — data location follows Cloudflare's default global distribution.
   Confirming exactly which Cloudflare account-level settings (jurisdiction restrictions,
   available on some D1/R2 tiers) are or aren't configured requires live Cloudflare
   account access this review doesn't have — same access limitation `sec-expert` already
   disclosed for the account/MFA review.

8. **Consent/cookie mechanisms**: reconfirms (does not re-derive) `sec-expert`'s finding
   of zero cookie usage anywhere in worker/server/app — moot for cookie-consent banners.
   The one telemetry pipeline in scope, `packages/worker/src/hq-instrumentation.ts`
   (Sentry/OTLP-style error/exception telemetry), is **server-to-server** (Worker →
   operator-controlled logging endpoint), not a client-side browser tracker — it goes
   through the same field-level redaction as everything else
   (`packages/worker/src/observability/log-redaction.ts`) and is not a cookie/consent
   concern in the ePrivacy sense. No other tracking/analytics beacon was found in
   `packages/app`/`packages/pwa`.

### Approaches (how to structure the `sdd-apply` audit work)

1. **One agent per domain (supply-chain vs. compliance), each producing its own findings
   register** — mirrors the `sec-expert` engagement's per-surface split.
   - Pros: clean separation of concerns; supply-chain work is code/tooling-driven while
     compliance work is more document/policy-driven — different skill emphasis benefits
     from separate focused passes. Easy to parallelize since the two domains barely
     overlap in files touched (supply-chain touches `package.json`/CI/Dockerfiles;
     compliance touches `core/src/server.ts`, `logging.ts`, `worker/src/storage/schema.ts`).
   - Cons: the retention-gap finding (compliance) and the audit-logging finding
     (compliance) both live in the same files an eventual *fix* for finding 2/3
     (attachment cascade delete, retention cron) would touch — if remediation is in
     scope later, coordination between the two agents' fix proposals still matters even
     if the audit itself splits cleanly.
   - Effort: Low coordination overhead, straightforward fan-out.

2. **One combined agent doing both domains sequentially in a single findings register** —
   matches this exploration's own approach (one pass, two labeled sections).
   - Pros: a single coherent narrative; avoids the risk of the two domains producing
     inconsistent severity/format conventions; this exploration phase already proved a
     single agent can cover both without running out of depth.
   - Cons: slower wall-clock time than parallel agents for a bigger `sdd-apply` scope
     (e.g. if remediation — not just audit — is later requested, like the retention cron
     fix (T26) and the attachment-cascade-delete fix, splitting into supply-chain-fix vs.
     compliance-fix agents would parallelize real code changes).
   - Effort: Low for a report-only deliverable; would need re-splitting if remediation
     is added to scope.

3. **Split by "audit tooling to run" vs. "code/architecture tracing"** (e.g. one agent
   runs SBOM/license-checker/npm-audit-style tooling across all packages and produces raw
   data, a second agent does the code-tracing narrative for both supply-chain-pipeline
   and compliance-data-flow questions) — a cross-cutting split rather than a
   domain split.
   - Pros: the tooling-running agent's output (SBOM JSON, license summary) is exactly the
     kind of artifact a real compliance/legal reviewer would want attached verbatim;
     keeping it separate from narrative prose avoids diluting raw evidence with
     interpretation.
   - Cons: more artifact-stitching required to produce one coherent proposal/spec later;
     less natural fit for `sdd-propose`'s single-document expectation.
   - Effort: Medium — extra synthesis step.

### Recommendation

**Approach 2 (combined single-pass report)** for the `sdd-propose`/`sdd-spec` stage that
follows this exploration, because the deliverable here (like `sec-expert`'s
`security-baseline` spec) is fundamentally a **report/audit artifact**, not new
application capability — there's no meaningful "domain boundary" to protect reviewers
from the way there is for code changes, and a single coherent findings register (matching
`openspec/specs/security-baseline/spec.md`'s severity-first, file:line, honest-disclosure
conventions already established by this project) is easier for a human to act on than two
separately-formatted reports. **If the follow-on scope later expands to remediation**
(fixing the retention cron / T26, the attachment-cascade-delete gap, the `app`/`pwa`
`dompurify`/`trusted-types` SBOM blocker, correcting the `GPL-3.0`→AGPL license-field
mismatch, SHA-pinning the CI actions, modernizing `nginx/Dockerfile`), **switch to
Approach 1** (domain-split agents) for that phase specifically, since those fixes touch
disjoint files and genuinely parallelize.

Persist the eventual audit output using the same `security-baseline`-style spec pattern:
a `supply-chain-compliance-baseline` spec under `openspec/specs/`, synthesized fresh (no
prior spec to delta against, same as `security-baseline` was).

### Risks

- **Overclaiming compliance coverage is the single biggest risk for the next phase.**
  This exploration deliberately does NOT produce a GDPR/SOC2/ISO27001 "gap assessment"
  with formal legal sign-off — it produces code-verified *evidence* (data inventory,
  deletion-cascade gap, retention gap, encryption posture, audit-trail coverage) that a
  real compliance consultant or lawyer would need as an input, not a substitute for their
  judgment. `sdd-propose`/`sdd-spec` MUST preserve this framing explicitly, the same way
  `security-baseline`'s "Scope Disclosure Honesty" requirement already does for the
  security engagement.
- **The `app`/`pwa` `npm sbom` failure (`@types/trusted-types` peer-dep gap) blocks a
  complete SBOM for two of seven in-scope packages** until that dependency-tree issue is
  actually fixed — this should be either fixed first or explicitly carried as a known
  limitation in the audit report, not silently worked around by omitting those two
  packages' SBOMs.
- **The AGPL vs. GPL-3.0 license-declaration mismatch is a real legal-exposure question**
  for a commercially-operated SaaS fork — this exploration surfaces the *fact* (verified
  by reading the actual `LICENSE` file) but explicitly cannot and should not attempt to
  answer whether current operation is compliant; that determination needs a lawyer.
- **Data residency and CI image-signing/provenance both terminate at "needs live
  Cloudflare/GHCR account access this review doesn't have"** — same category of
  limitation `sec-expert` already hit for the Cloudflare account/MFA review; don't
  re-attempt to answer these from source alone in `sdd-apply`.
- **The retention-cron gap (T26) and the attachment-cascade-delete gap are both real,
  fixable code issues discovered during what was scoped as an audit-only exploration** —
  if the user wants these actually fixed (not just reported), that needs to be an
  explicit scope decision at `sdd-propose`, not assumed.

### Ready for Proposal

**Yes.** Findings are grounded in real, reproduced tool output (`npm sbom`,
`license-checker`) and direct code citations (file:line) across both domains. The
orchestrator should tell the user: this exploration ran real local tooling (no external
paid services needed) and found two genuinely new, previously-undisclosed gaps beyond
what `sec-expert` covered — the attachment-cascade-delete-on-account/org-deletion gap and
the unimplemented `T26` log-retention cron — plus the AGPL/GPL-3.0 license-declaration
mismatch, which is a real legal question for the business side. `sdd-propose` should
decide explicitly whether this is audit-only (report deliverable, like `security-baseline`
Round 1) or should also fix the concrete code gaps found here.
