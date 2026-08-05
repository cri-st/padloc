# CH5 Auth Context

## What This Repo Is

-   CH5-branded fork of Padloc.
-   Cloudflare Worker API in `packages/worker`.
-   Static PWA in `packages/pwa`.
-   Cordova iPhone shell in `packages/cordova`.

## Live Surfaces

-   Production web: `https://app.example.com`
-   Production API: `https://api.example.com`
-   Staging web: `https://staging.example.com`
-   Staging API: `https://api-staging.example.com`

## Current Runtime Rules

-   The app host and API host are split. Never point `clientUrl` at the API
    host.
-   The PWA and Cordova builds must receive `PL_SERVER_URL` explicitly at build
    time.
-   Worker email auth uses Resend when both `RESEND_API_KEY` and
    `EMAIL_FROM_ADDRESS` exist.
-   Worker/runtime-shared code must not assume `process` exists.

## Operator Notes

-   Repo-local Hush is present in `.hush/` and now exposes `runtime`,
    `runtime-staging`, and `runtime-production` targets.
-   The repo-scoped Cloudflare deploy token was reminted to include KV write so
    Worker deploys can run without the bootstrap token.
-   `packages/worker/src/email/templates.ts` is generated from `assets/email/*`.

## Next Things To Verify

-   staging Pages custom domain activation for `staging.example.com`
-   full signup completion via real delivered email code
-   real TOTP secret migration on the physical iPhone
