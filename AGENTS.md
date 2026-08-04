# Padloc

## Purpose

-   CH5-branded fork of Padloc running as a Cloudflare Worker API plus a static
    PWA and native Cordova shells.
-   Shipped surfaces (web app, API base, and native app display name) are
    declared per stage in `config/environment-targets.json` (`targets.<stage>`),
    the per-stage reference map. Never assume literal hostnames or the app name;
    read them from that map.

## Repo Layout

-   `packages/worker` - Cloudflare Worker API, D1/R2/KV/DO bindings, auth/email
    runtime.
-   `packages/pwa` - static web client that bakes `PL_SERVER_URL` at build time.
-   `packages/cordova` - iOS/Android shell around the web app.
-   `packages/core` - shared auth, vault, crypto, and messaging logic.
-   `assets/` - manifests, support docs, and email templates.
-   `config/` - CH5 runtime target map and runtime requirements contract.
-   `.hush/` - repo-local Hush v3 state. Runtime secrets live here for operator
    flows and are pushed to Cloudflare.

## Commands

-   Install deps: `npm ci`
-   Local worker only: `npm run worker:dev`
-   Local web only: `npm run pwa:start`
-   Legacy local stack: `npm run start`
-   Changed-only tests/proofs: `npm run test:changed -- --since <ref>` or
    `npm run test:changed -- --files <csv>`; this wraps `ch5 plan padloc` and
    refuses broad fallback tasks unless `--allow-fallback` is explicit.
-   Extension harness is headless by default. Use `PADLOC_EXTENSION_HEADFUL=1`
    or `npm run test:extension:headful` only for visual debugging.
-   DevMux local status: `npm run svc:status`
-   Runtime contract check: `npm run runtime-config:check`
-   Worker dry-run: `npm run worker:deploy:dry-run`
-   Staging deploy: `npm run deploy:staging`
-   Production deploy: `npm run deploy:production`

## Secrets

-   Cloudflare runtime is authoritative. Worker secrets must exist in Cloudflare
    even if Hush stores the source values.
-   Repo-local Hush targets:
    -   `runtime` - shared local/runtime compatibility target
    -   `runtime-staging` - staging deploy/runtime target
    -   `runtime-production` - production deploy/runtime target
    -   `wrangler-deploy-staging` - governed `ch5-padloc-staging` Cloudflare
        deploy token (least-priv for every staging binding). Consumed by
        `scripts/deploy-staging`.
    -   `wrangler-deploy-production` - governed `ch5-padloc-prod` Cloudflare
        deploy token (least-priv for every production binding). Consumed by
        `scripts/deploy-production`.
-   Cloudflare deploy-auth is **hush-in-CI** (company standard):
    `scripts/deploy-<stage>` is the self-contained entrypoint that resolves the
    governed token from Hush and runs migrations + worker deploy + PWA Pages
    deploy. The IDENTICAL command runs on a laptop, a harness, or CI. CI holds
    only `SOPS_AGE_KEY` (to unlock Hush) — never a Cloudflare API-token secret.
    Rotation = re-mint the token + push.
-   Do not create `.env`, `.dev.vars`, or plaintext secret files.
-   Production email auth requires a valid `RESEND_API_KEY` and a verified
    `EMAIL_FROM_ADDRESS` sender. Both are delivered as Cloudflare-side Worker
    secrets (`config/runtime-requirements.json` marks them `delivery: secret`);
    the intended per-stage sender value is declared as `emailFromAddress` in
    `config/environment-targets.json`. Do not hardcode it here.

## Hosting

-   `config/environment-targets.json` (`targets.<stage>`) is the declared
    per-stage reference for app URL, API base, worker/Pages names, allowed
    origin, display name, and email sender. `npm run runtime-config:check` only
    validates that this file and `config/runtime-requirements.json` are
    complete — it does NOT cross-check the live deployment. Read the map instead
    of assuming literals.
-   At runtime the Worker resolves the client (app) URL from `CLIENT_URL`,
    falling back to `ALLOW_ORIGIN` (when not `*`), then a localhost default
    (`packages/worker/src/server-factory.ts`). This is the URL used in generated
    links (invite, email verification). `ALLOW_ORIGIN` is declared as derived
    from `allowedOrigin` in `config/runtime-requirements.json`.
-   `packages/worker/wrangler.toml` defines only the `dev` and `preview` envs
    (localhost); it has no `staging`/`production` blocks. The deploy scripts do
    not set the Worker's `CLIENT_URL`/`ALLOW_ORIGIN`: `scripts/deploy-staging`
    passes only `--var VERSION/HQ_RELEASE` and `scripts/deploy-production` passes
    none. So staging/production Worker runtime vars and secrets are authoritative
    on the Cloudflare side (see Secrets), not injected from the repo.
-   The PWA bakes its API base from `PL_SERVER_URL` at build time (local default
    `http://127.0.0.1:${PL_WORKER_PORT:-8787}`). For staging/production,
    `scripts/deploy-<stage>` passes `PL_SERVER_URL`/`PL_PWA_URL` as literals to
    `npm run pwa:build`.

## Rules

-   Do not create pull requests for this repository. Push work to a topic
    branch, require exact-SHA branch CI, then fast-forward the verified commit
    to `main`; close any accidentally created pull request without merging it.
-   Treat `preview` as a legacy compatibility env. New stable pre-prod work
    should use `staging`.
-   Personal autofill records are Padloc-owned encrypted items. Magic Browser
    owns browser execution/redacted proof. Bridge doctrine lives in
    `docs/agentic-autofill-bridge.md`.
-   Do not reintroduce `process.env.PL_APP_NAME` assumptions into
    Worker/runtime-shared code; Workers do not provide `process`.
-   Keep `clientUrl` on the app host (the stage's `appUrl`), never the API host.
    It is resolved at runtime from `CLIENT_URL` (fallback `ALLOW_ORIGIN`) — see
    Hosting.
-   The PWA must always be built with an explicit `PL_SERVER_URL`; do not rely
    on runtime mutation.
-   If email auth breaks, first verify the live Worker secret values and sender
    domain before changing app logic.
-   For user-authorized local Chrome testing, hand off between the Chrome
    control surface and Computer Use when ordinary visible browser UI (including
    toolbar, extension, or internal management UI) is not addressable by the
    first tool. This authorization covers normal reversible UI operation only;
    it does not override required human-presence, confirmation, credential,
    CAPTCHA, security, or other higher-priority safety boundaries.

## Sharp Edges

-   `packages/worker/src/server-factory.ts` currently falls back to
    `MockMessenger` if either email secret is missing. That is useful locally
    and dangerous in production; keep an eye on it when changing auth.
-   The governed `ch5-padloc-{staging,prod}` deploy tokens are least-privilege
    for every binding across their stage (Workers Scripts / D1 / KV / R2 Storage
    Write, Pages Write, Account Settings Read, Workers Tail Read). Add or remove
    a binding in `packages/worker/wrangler.toml` → re-mint that stage's token
    (`cf-mint-project-token --project padloc --stage <staging|prod> --dir . --hush-file env/project/<staging|production>`)
    so the token stays complete; an under-scoped token breaks the deploy.
-   `packages/worker/src/email/templates.ts` is generated from `assets/email/*`;
    regenerate after changing email copy.
-   Cordova platform plugin fixes applied under `packages/cordova/platforms/`
    are generated-state only and will be lost if the platform is re-added.
