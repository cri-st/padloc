## 2026-05-19 launch topology freeze

-   Live runtime source of truth checked first: `packages/worker/src/env.ts`,
    `packages/worker/wrangler.toml`, and `packages/pwa/webpack.config.js`.
-   Freeze production split-host topology as `app.example.com` for the PWA and
    `api.example.com` for the Worker API. This fits the current runtime contract
    because the PWA already consumes a full backend origin via `PL_SERVER_URL`,
    and the Worker only exposes a direct CORS allowlist via `ALLOW_ORIGIN`; no
    same-origin proxy is required.
-   No `/server` proxy path exists in `packages/worker` or `packages/pwa`. Any
    `/server` references found by repo grep live in deferred legacy
    docs/examples outside today's implementation lane and must not be
    reintroduced into runtime config.
-   Do not use `padloc.app` hosted infrastructure for runtime. Current
    `padloc.app` hits in assets, emails, legacy docs, support links, and mobile
    identity remain deferred unless they block the shipped PWA+Worker path.
-   Fresh-account bootstrap path is the launch proof path. Do not spend scope on
    continuity or migration work for existing accounts in this lane.
-   Deep-link scheme is frozen to `ch5`. Current read-only identity sources
    still show legacy values (`assets/manifest.json` has `appId: app.padloc` and
    `scheme: padloc`; `packages/cordova/config.xml` has widget id `app.padloc`).
    Those rename surfaces are package-scope follow-up work, not part of this
    freeze unless a downstream runtime task proves blocking.
-   TOTP proof stays in scope with one real base32 seed and two consecutive
    windows. Worker test coverage already exercises TOTP flows; this freeze
    keeps TOTP as the proof lane and does not expand auth surface.
-   No passkey continuity work for launch. Worker/package references to WebAuthn
    remain non-blocking unless a runtime task explicitly needs them for a
    shipped path.
-   Note: inherited planning text mentioned `api-pad.ch3.me`; treat that as
    stale/typo. Repo freeze for today is `api.example.com`.

## 2026-05-19 bundle identity rename (T1 follow-through)

### Changes made

**`assets/manifest.json`** — identity source:

-   `name`: "Padloc" → "CH5 Auth"
-   `appId`: "app.padloc" → "me.ch5"
-   `scheme`: "padloc" → "ch5"

**`packages/cordova/update-config-xml.js`** — Cordova updater:

-   Added `scheme` to destructured import from manifest.json
-   Added idempotent `<allow-intent scheme="ch5" launchExternal="true"/>`
    insertion
-   Handles re-run deduplication (array/scalar normalization, filter before
    push)
-   Regenerated `packages/cordova/config.xml` with `id="me.ch5"`,
    `<name>CH5 Auth</name>`

**Electron (`packages/electron/prepare-build.js`)** and **Tauri
(`packages/tauri/build-tauri-conf.js`)** already read `name`, `appId`, `scheme`
from manifest.json at build time — no changes needed; they will pick up the new
values automatically.

### QA verification

```
rg -n "app\.padloc|me\.ch5|CH5 Auth|scheme" assets/ packages/cordova/
```

→ `me.ch5` and `CH5 Auth` present in manifest.json, config.xml, and updater
script; `scheme: "ch5"` confirmed.

```
rg -n "me\.ch5:|scheme.*me\.ch5" packages/ assets/
```

→ Zero matches (no dotted scheme anywhere).

```
rg -n "app\.padloc" assets/manifest.json packages/cordova/config.xml
```

→ Zero matches (old identity gone from bundle surfaces).

## 2026-05-19 shipped identity surface rename (support/email/branding)

### Changes made

-   `packages/pwa/webpack.config.js`: `PL_SUPPORT_EMAIL` → `support@padloc.app`
-   `packages/cordova/webpack.config.js`: `PL_SUPPORT_EMAIL` → `support@padloc.app`
-   `assets/support.md`: All `padloc.app` URLs replaced with `example.com`
    equivalents:
    -   Website → `https://example.com/`
    -   Blog → `https://example.com/blog/`
    -   TOS → `https://example.com/tos/`
    -   Privacy → `https://example.com/privacy/`
    -   Contact Support → `mailto:support@padloc.app`
    -   User Manual → `https://docs.example.com/manual/`
    -   FAQ → `https://docs.example.com/faq/`
-   `assets/email/*.html` and `*.txt` source templates: Email footers updated
    from `Padloc (https://padloc.app) support@padloc.app` →
    `CH5 (https://example.com) support@padloc.app`
-   `assets/email/*.html` and `*.txt`: Body text references to "Padloc
    organization" and "in Padloc" changed to "CH5 organization" / "in CH5"
-   `packages/worker/src/email/templates.ts`: Regenerated from updated source
    templates

### Deferred (not user-visible today)

-   `assets/manifest.json`: `terms_of_service: "https://padloc.app/tos"` —
    webpack-injected at build time via `PL_TERMS_OF_SERVICE` env var; env var
    not hardcoded in shipped webpack configs, so deferred
-   `packages/worker/src/email/resend.ts:121`: Fallback sender
    `"Padloc <noreply@padloc.app>"` — email FROM address set via
    `EMAIL_FROM_ADDRESS` env var at runtime
-   `packages/app/src/elements/login-signup.ts`: Migration help URLs to
    `padloc.app/help/*`
-   `packages/app/src/elements/report-errors-dialog.ts`: Error report
    subject/body "Padloc"
-   `packages/app/src/elements/settings-security.ts:473`: "Padloc app" in
    session help text
-   SVG logo IDs (`id="Padloc"`) — not user-visible text, deferred
-   Cordova config.xml author URL — not shown to users in shipped app

## 2026-05-19 T2: Cloudflare resource bootstrap

### Actions taken

-   Verified bootstrap token via `cf-project.sh whoami` — account
    `25bb5f8d9ec4a36106f0ff6b519133b1` (Hassoncs@gmail.com)
-   Minted project-scoped deploy token (`padloc-deploy`) via
    `cf-project.sh mint-deploy-token padloc`
-   Stored `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` in repo-local Hush
    (`.hush/` v3, bootstrapped today)
-   Pinned `account_id = "25bb5f8d9ec4a36106f0ff6b519133b1"` at top level of
    `packages/worker/wrangler.toml`
-   Created missing R2 bucket `padloc-attachments-dev` (was absent from account)

### Resource verification (deploy token + wrangler confirmed)

| Resource                                | Binding        | ID                                     | Status                           |
| --------------------------------------- | -------------- | -------------------------------------- | -------------------------------- |
| D1 `padloc-prod`                        | `DB`           | `f443b7e5-861e-4a4f-9c67-1a33acf5677d` | EXISTS (created 2026-05-05)      |
| D1 `padloc-preview`                     | `DB`           | `426f172f-8117-48c6-849b-1b26901b89e6` | EXISTS (created 2026-05-05)      |
| D1 `padloc-dev`                         | `DB`           | `e2bf5126-0913-48a1-831d-531606f398c9` | EXISTS (created 2026-05-04)      |
| R2 `padloc-attachments-prod`            | `ATTACHMENTS`  | —                                      | EXISTS (bootstrap API confirmed) |
| R2 `padloc-attachments-preview`         | `ATTACHMENTS`  | —                                      | EXISTS (bootstrap API confirmed) |
| R2 `padloc-attachments-dev`             | `ATTACHMENTS`  | —                                      | CREATED today (was missing)      |
| KV `production-PADLOC_EMAIL_PRODUCTION` | `EMAIL_KV`     | `0231a8c22d1b4a54a3c4b9e72a68165d`     | EXISTS                           |
| KV `production-PADLOC_HINTS_PRODUCTION` | `HINTS`        | `0abcb21cdf5541b9a7f8c2c35e922a7b`     | EXISTS                           |
| KV `preview-PADLOC_EMAIL_PREVIEW`       | `EMAIL_KV`     | `9dbdc747eeb4472681e9f081eb9e8269`     | EXISTS                           |
| KV `preview-PADLOC_HINTS_PREVIEW`       | `HINTS`        | `f868962679c74a33886cff584f37d18d`     | EXISTS                           |
| DO `AccountLockDO`                      | `ACCOUNT_LOCK` | —                                      | DECLARED in wrangler.toml        |

### Key observations

-   `wrangler d1 list` requires `memberships:read` scope — not included in
    project deploy token. Use `wrangler d1 info <name> --env=<env>` for targeted
    verification instead.
-   `wrangler r2 bucket list` paginates (20/page); padloc buckets appear on
    page 2. Creation attempt returns "already exists" confirming presence.
-   Deploy token stored in repo Hush;
    `hush run -- bash -c 'CLOUDFLARE_API_TOKEN="$CLOUDFLARE_API_TOKEN" wrangler ...'`
    resolves correctly.
-   wrangler.toml env sections use `[env.production]` (hyphen); deploy token
    verification warns "No environment found with name 'production'" but still
    returns correct DB info.
-   Repo was not Hush-enabled; bootstrapped fresh v3 repo. Old `hush.yaml`
    references in status were stale — no actual legacy files existed.
-   `cf-project.sh whoami` with repo-local Hush token succeeds — confirms token
    is usable for deploy operations.

## 2026-05-19 auth-sensitive origin and issuer rotation

### Changes made

-   `packages/worker/wrangler.toml`: added production
    `ALLOW_ORIGIN = "https://app.example.com"` under `[env.production.vars]`.
-   `packages/core/src/otp.ts`: changed the default TOTP issuer from `Padloc` to
    `CH5` so shipped otpauth URLs no longer brand as Padloc.
-   `packages/core/src/server.ts`: changed `ServerConfig.clientUrl` default to
    `https://app.example.com`; org invite/open-app links now inherit the CH5 app
    hostname.
-   `packages/server/src/auth/webauthn.ts`: set WebAuthn defaults to
    `rpName = "CH5 Auth"`, `rpID = "app.example.com"`,
    `origin = "https://app.example.com"`.
-   `packages/server/src/init.ts`: when WebAuthn config is synthesized from
    `clientUrl`, keep `rpName` CH5-branded while deriving `rpID` and `origin`
    from the active client host.

### Findings

-   `clientUrl` is the user-facing app base, not the API origin. For split-host
    launch it must stay `https://app.example.com`; setting it to
    `https://api.example.com` would break email links and WebAuthn origin
    defaults.
-   `packages/worker/src/email/templates.ts` contains only runtime placeholders
    like `acceptInviteUrl`, `confirmMemberUrl`, and `openAppUrl`; no hardcoded
    `padloc.app` callback origins remain there.
-   No hardcoded OAuth redirect defaults were found in code. OAuth redirect URIs
    are still runtime-config-driven through `packages/server/src/auth/oauth.ts`.
-   Passkey continuity is intentionally not preserved. WebAuthn defaults now
    point at CH5 domains, so existing passkeys bound to old Padloc RP surfaces
    should be treated as non-continuing.

## 2026-05-19 T6: Worker production deployment

### Actions taken

-   Applied production D1 migrations remotely (`0000_init.sql`,
    `0001_orphan_log.sql`) on `padloc-prod` (D1 ID
    `f443b7e5-861e-4a4f-9c67-1a33acf5677d`) via Wrangler.
-   Set `RESEND_API_KEY` and `EMAIL_FROM_ADDRESS` as production secrets via
    `wrangler secret put`. Both secrets now exist on the `padloc-worker`
    production Worker.
-   Deployed Worker to production using bootstrap Account API Token (stored in
    1Password `CLOUD_FLARE_MASTER_API_TOKEN`; redacted here for security — never
    commit raw Cloudflare tokens).
-   Created DNS CNAME for `api.example.com` →
    `padloc-worker.hassoncs.workers.dev` via `cf-surface.sh dns-upsert-cname`.

### Verified

-   **Healthcheck**: `https://padloc-worker.hassoncs.workers.dev/healthcheck`
    returns
    `{"status":"ok","version":"0.0.0","d1":"ok","r2":"ok","resend":"ok"}` ✅
-   **CORS**: Origin `https://app.example.com` is allowed
    (`access-control-allow-origin: https://app.example.com`) ✅
-   **ALLOW_ORIGIN**: Correctly set to `https://app.example.com` in `wrangler.toml`
    `[env.production.vars]` ✅
-   **Secrets**: `RESEND_API_KEY` (from 1Password Private `RESEND_API_KEY` item)
    and `EMAIL_FROM_ADDRESS=support@padloc.app` are set ✅

### Blocker: `api.example.com` route not bound

**Symptom**: `curl https://api.example.com/healthcheck` → HTTP 522 (origin
timeout). DNS resolves (CNAME created), TLS cert is valid (matched by `*.example.com`
wildcard), but Cloudflare proxy cannot reach the origin Worker because no Worker
route/custom domain binding exists.

**Root cause**: The Workers custom domain API
(`POST /accounts/{id}/workers/domains`) requires a **User API Token** with
`workers:write` scope. The available bootstrap Account API Token has
`Workers Scripts Write` only — it can list domains (GET works) but cannot create
them (POST fails with
`10405 Method not allowed for this authentication scheme`).

**Fix**: Open Cloudflare Dashboard → Workers → padloc-worker → Settings →
Triggers → Custom Domains → Add domain → enter `api.example.com`. Cloudflare will
automatically provision the TLS certificate and create the route binding.

**Alternative**: Obtain a Cloudflare User API Token with `workers:write` scope
and use it to call `POST /accounts/{account_id}/workers/domains`.

### Deploy token issue

The repo-local Hush deploy token (mintDeployToken from cf-project.sh) lacks
`Workers KV Storage Write` permission. Deploying via this token fails with
`kv bindings require kv write perms [code: 10023]`. Workaround used: bootstrap
Account API Token for this deployment.

**Fix needed**: The `cf-project.sh mint-deploy-token` helper must include
`Workers KV Storage Write` permission in the minted token scope. The current
mint call does not include this permission.

### Secrets not in Hush

The following secrets were NOT in repo-local Hush at deploy time:

-   `RESEND_API_KEY`: Retrieved from 1Password Private vault item
    "RESEND_API_KEY" (credential redacted — retrieve from 1Password
    Private/RESEND_API_KEY, field "credential").
-   `EMAIL_FROM_ADDRESS`: Set to `support@padloc.app` (derived from CH5 branding;
    not found in 1Password)

**Action item**: Store `RESEND_API_KEY` in repo-local Hush under the worker
target so future deploys don't require manual secret retrieval.

## 2026-05-19 T5: PWA build + Cloudflare Pages deploy + app.example.com DNS

### Build

```sh
PL_SERVER_URL=https://api.example.com PL_PWA_URL=https://app.example.com \
  npm run build --prefix packages/pwa
```

Result: webpack 5.52.0 compiled successfully (47 assets, 879 modules).

### Verification

**`api.example.com` is correctly baked into built output:**

-   `packages/pwa/dist/main.js`: `new AjaxSender("https://api.example.com")`
-   `packages/pwa/dist/index.html` CSP:
    `connect-src https://api.example.com https://api.pwnedpasswords.com`

**No `/server` runtime references** in built JS (only found in `.map` files).

**`padloc.app` references**: Found only in locale translation files and UI help
strings (`window.open("https://padloc.app/help/migrate-v3")`). These are
compile-time-baked content strings, not API runtime calls. Per prior freeze,
these remain deferred and do not block the shipped PWA+Worker path.

### Cloudflare Pages deploy

-   Created Pages project `padloc-pwa` (production branch: `main`)
-   Deployed `packages/pwa/dist` (59 files, 5.56 sec) → `padloc-pwa.pages.dev`
-   Attached custom domain `app.example.com` (status: `active`, validation: HTTP, CA:
    Google)
-   Created DNS CNAME: `app.example.com` → `padloc-pwa.pages.dev` (proxied=false,
    record id: `71b6d4c6a332fa8d9e40eda7404236b3`)
-   `app.example.com` live over HTTPS: HTTP/2 200, `server: cloudflare`

### Blocker: `api.example.com` not accessible

`curl https://api.example.com` returns "Could not resolve host". The Worker
(`padloc-worker`) has no custom domain route or DNS record for `api.example.com`.
The PWA is correctly compiled to call `https://api.example.com`, but the Worker
must be deployed with a route/custom-domain binding for the API to be reachable.
This is a separate setup task from the PWA deploy.

### Helper commands used

```bash
# Pages project create + deploy + domain attach + DNS CNAME (manual steps)
CLOUDFLARE_ACCOUNT_ID=25bb5f8d9ec4a36106f0ff6b519133b1 \
CLOUDFLARE_API_TOKEN="$(hush run -- bash -c 'printf "%s" "$CLOUDFLARE_API_TOKEN"')" \
  cf-surface.sh pages-project-ensure padloc-pwa main

cf-surface.sh pages-deploy padloc-pwa packages/pwa/dist main

cf-surface.sh pages-domain-attach padloc-pwa app.example.com

cf-surface.sh dns-upsert-cname padloc de2e5d88a0d7eca9dfe423318e2c25ea \
  app.example.com padloc-pwa.pages.dev --proxied false
```

No `wrangler pages project create` or `wrangler pages deploy` ad-hoc commands
needed — all routed through `cf-surface.sh`. `cf-project.sh` not used for Pages
ops since the PWA is a static site, not a Worker requiring Wrangler deploy.

## 2026-05-19 — Email auth + CH5 setup hardening

-   Production email auth failure was not a missing provider account alone. Two
    repo/runtime bugs were involved: Worker-shared code referenced
    `process.env.PL_APP_NAME`, and the production/staging `RESEND_API_KEY`
    secrets had been uploaded as empty strings due a non-exported shell variable
    during `wrangler secret put`.
-   Correct production email proof is a live `startAuthRequest` RPC result with
    `requestStatus=started` plus Worker tail showing `using ResendMessenger` and
    healthcheck `resend: ok`.
-   Repo-scoped Cloudflare deploy token needed KV write added manually before
    Worker deploy automation could work in CI.
-   `preview` now acts as a legacy compatibility env; new stable pre-prod work
    should target `staging`.
