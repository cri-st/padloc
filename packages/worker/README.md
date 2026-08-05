# @padloc/worker

Cloudflare Worker backend for Padloc.

## Wrangler Environments

| Env          | Worker Name             | D1 Database      | R2 Bucket                    | KV Namespace              | DO Class        |
| ------------ | ----------------------- | ---------------- | ---------------------------- | ------------------------- | --------------- |
| `dev`        | `padloc-worker-dev`     | `padloc-dev`     | `padloc-attachments-dev`     | `PADLOC_HINTS_DEV`        | `AccountLockDO` |
| `preview`    | `padloc-worker-preview` | `padloc-preview` | `padloc-attachments-preview` | `PADLOC_HINTS_PREVIEW`    | `AccountLockDO` |
| `staging`    | `padloc-worker-staging` | `padloc-preview` | `padloc-attachments-preview` | `PADLOC_HINTS_PREVIEW`    | `AccountLockDO` |
| `production` | `padloc-worker`         | `padloc-prod`    | `padloc-attachments-prod`    | `PADLOC_HINTS_PRODUCTION` | `AccountLockDO` |

## Local Dev

```sh
# Miniflare-backed local dev (default)
wrangler dev --local --env=dev

# Remote dev (uses real Cloudflare resources)
wrangler dev --remote --env=dev
```

## Secrets Setup

Secrets must be set via `wrangler secret put`. Never put real values in
`wrangler.toml`.

### Per-Environment Secret Commands

```sh
# RESEND_API_KEY
wrangler secret put RESEND_API_KEY --env=dev
wrangler secret put RESEND_API_KEY --env=preview
wrangler secret put RESEND_API_KEY --env=staging
wrangler secret put RESEND_API_KEY --env=production

# EMAIL_FROM_ADDRESS
wrangler secret put EMAIL_FROM_ADDRESS --env=dev
wrangler secret put EMAIL_FROM_ADDRESS --env=preview
wrangler secret put EMAIL_FROM_ADDRESS --env=staging
wrangler secret put EMAIL_FROM_ADDRESS --env=production

# WEBAUTHN_RP_ID
wrangler secret put WEBAUTHN_RP_ID --env=dev
wrangler secret put WEBAUTHN_RP_ID --env=preview
wrangler secret put WEBAUTHN_RP_ID --env=staging
wrangler secret put WEBAUTHN_RP_ID --env=production

# WEBAUTHN_RP_NAME
wrangler secret put WEBAUTHN_RP_NAME --env=dev
wrangler secret put WEBAUTHN_RP_NAME --env=preview
wrangler secret put WEBAUTHN_RP_NAME --env=staging
wrangler secret put WEBAUTHN_RP_NAME --env=production

# ALLOW_ORIGIN (defaults to * if absent in dev only)
wrangler secret put ALLOW_ORIGIN --env=dev
wrangler secret put ALLOW_ORIGIN --env=preview
wrangler secret put ALLOW_ORIGIN --env=staging
wrangler secret put ALLOW_ORIGIN --env=production
```

### Rotation

To rotate a secret, re-run `wrangler secret put` with the new value:

```sh
wrangler secret put RESEND_API_KEY --env=production
```

## Binding Creation

### D1 Databases

```sh
# Create
wrangler d1 create padloc-dev --env=dev
wrangler d1 create padloc-preview --env=preview
wrangler d1 create padloc-prod --env=production

# Apply migrations (once schema exists)
wrangler d1 migrations apply padloc-dev --env=dev
wrangler d1 migrations apply padloc-preview --env=preview
wrangler d1 migrations apply padloc-prod --env=production
```

### R2 Buckets

```sh
wrangler r2 bucket create padloc-attachments-dev --env=dev
wrangler r2 bucket create padloc-attachments-preview --env=preview
wrangler r2 bucket create padloc-attachments-prod --env=production
```

### KV Namespaces

```sh
wrangler kv:namespace create PADLOC_HINTS_DEV --env=dev
wrangler kv:namespace create PADLOC_HINTS_PREVIEW --env=preview
wrangler kv:namespace create PADLOC_HINTS_PRODUCTION --env=production

# After creation, update wrangler.toml with the assigned IDs:
# kv_namespaces -> id = "<assigned-id>"
```

### Durable Objects

Durable Object classes are defined in Worker code. The binding is declared in
`wrangler.toml` (`AccountLockDO`). No separate creation step is needed — the
`[[env.<env>.durable_objects.bindings]]` section in `wrangler.toml` establishes
the binding at deploy time.

When adding the first Durable Object class, add a migration to `wrangler.toml`:

```toml
[[migrations]]
tag = "v1"
new_classes = [ "AccountLockDO" ]
```

## Validation

```sh
# Validate wrangler.toml without deploying
wrangler deploy --dry-run --env=dev
wrangler deploy --dry-run --env=preview
wrangler deploy --dry-run --env=production
```

## Deploy

```sh
wrangler deploy --env=production
wrangler deploy --env=staging
wrangler deploy --env=preview
```

## HQ Observability

Padloc Worker emits CH5 HQ telemetry from
`packages/worker/src/hq-instrumentation.ts`. It sends Sentry-compatible
envelopes for reportable Worker errors and OTLP JSON traces for
`padloc.worker.fetch`, `padloc.worker.healthcheck`, and
`padloc.worker.core_request` spans.

### Env Contract

| Name               | Delivery                  | Required            | Notes                                                                                                                      |
| ------------------ | ------------------------- | ------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `HQ_SENTRY_DSN`    | Hush-backed Worker secret | staging, production | CH5 internal Sentry-compatible DSN. Host must be `logs.example.com` or `staging.logs.example.com`; `sentry.io` is rejected.          |
| `HQ_OTLP_ENDPOINT` | Hush-backed Worker secret | staging, production | CH5 internal OTLP HTTP endpoint. Host must be `logs.example.com` or `staging.logs.example.com`; `/v1/traces` is appended if missing. |
| `HQ_ENVIRONMENT`   | Derived var/secret        | staging, production | Environment tag, e.g. `staging` or `production`. Defaults to `development`.                                                |
| `HQ_RELEASE`       | Derived var/secret        | staging, production | Release tag, e.g. `padloc-worker@<sha>`. Defaults from `VERSION`.                                                          |
| `HQ_SERVICE_NAME`  | Derived var/secret        | staging, production | OTLP `service.name`. Defaults to `padloc-worker`.                                                                          |

### Failure Rules

-   Mis-wire fails loud: one missing endpoint, invalid URL, `sentry.io`, or
    non-CH5 host throws during request startup.
-   Both endpoints absent disables instrumentation and logs visible warning for
    local/dev fallback.
-   HQ outage degrades gracefully: Worker keeps serving, status becomes
    `degraded`, and warning is emitted once.
-   Local proof may set `HQ_ALLOW_LOCAL_ENDPOINTS=1`; do not set it in staging
    or production.

### Secret Commands

```sh
hush run runtime-staging -- wrangler secret put HQ_SENTRY_DSN --env=staging
hush run runtime-staging -- wrangler secret put HQ_OTLP_ENDPOINT --env=staging
hush run runtime-production -- wrangler secret put HQ_SENTRY_DSN --env=production
hush run runtime-production -- wrangler secret put HQ_OTLP_ENDPOINT --env=production
```
