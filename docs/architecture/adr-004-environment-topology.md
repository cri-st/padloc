# ADR-004: Environment Topology

**Status**: Accepted  
**Date**: 2026-05-04  
**Context**: Padloc Cloudflare-native backend migration

## Decision

Padloc operates across three canonical environments: local/dev, staging, and
production. Each environment has its own Cloudflare Worker, D1 database, R2
bucket, KV namespace, Durable Object definition, and secret scope. Environments
share code but never share storage.

## Environment Map

| Environment | Trigger                           | Worker Name             | D1 Database      | R2 Bucket                    | KV Namespace              | DO Class        |
| ----------- | --------------------------------- | ----------------------- | ---------------- | ---------------------------- | ------------------------- | --------------- |
| dev         | `wrangler dev` (local)            | `padloc-worker-dev`     | `padloc-dev`     | `padloc-attachments-dev`     | `PADLOC_HINTS_DEV`        | `AccountLockDO` |
| staging     | Push to `main` / explicit staging | `padloc-worker-staging` | `padloc-preview` | `padloc-attachments-preview` | `PADLOC_HINTS_PREVIEW`    | `AccountLockDO` |
| production  | Explicit promotion/deploy         | `padloc-worker`         | `padloc-prod`    | `padloc-attachments-prod`    | `PADLOC_HINTS_PRODUCTION` | `AccountLockDO` |

## Wrangler Environment Configuration

The `wrangler.jsonc` (or `wrangler.toml`) declares Wrangler environments with
`--env` flag:

```toml
# Base configuration (dev)
name = "padloc-server-dev"
compatibility_date = "2026-01-01"
main = "packages/worker/src/index.ts"

[[d1_databases]]
binding = "DB"
database_name = "padloc-dev"
database_id = "<dev-id>"

[[r2_buckets]]
binding = "ATTACHMENTS"
bucket_name = "padloc-dev"

[[kv_namespaces]]
binding = "KV_HINTS"
id = "<dev-kv-id>"

[durable_objects]
bindings = [
  { name = "ACCOUNT_LOCK_DO", class_name = "AccountLockDO" }
]

[env.preview]
name = "padloc-server-preview"

[[env.preview.d1_databases]]
binding = "DB"
database_name = "padloc-preview"
database_id = "<preview-id>"

[[env.preview.r2_buckets]]
binding = "ATTACHMENTS"
bucket_name = "padloc-preview"

[[env.preview.kv_namespaces]]
binding = "KV_HINTS"
id = "<preview-kv-id>"

[env.production]
name = "padloc-server"

[[env.production.d1_databases]]
binding = "DB"
database_name = "padloc"
database_id = "<production-id>"

[[env.production.r2_buckets]]
binding = "ATTACHMENTS"
bucket_name = "padloc"

[[env.production.kv_namespaces]]
binding = "KV_HINTS"
id = "<production-kv-id>"
```

## Binding Names (Canonical)

All binding names are fixed across environments. Only the underlying resource
changes.

| Binding Name         | Type            | Purpose                                        |
| -------------------- | --------------- | ---------------------------------------------- |
| `DB`                 | D1Database      | Authoritative store for all metadata (ADR-002) |
| `ATTACHMENTS`        | R2Bucket        | Binary attachment objects                      |
| `KV_HINTS`           | KVNamespace     | Non-authoritative rate-limit hints and flags   |
| `ACCOUNT_LOCK_DO`    | DurableObject   | Per-account/org request serialization          |
| `RESEND_API_KEY`     | Secret (string) | Resend email API authentication                |
| `SESSION_SECRET`     | Secret (string) | Session token signing key                      |
| `EMAIL_FROM_ADDRESS` | Secret (string) | Outbound email sender address                  |

## Deploy Flow

### Staging

-   Every push to `main` should auto-deploy the staging environment.
-   Provider-native preview deployments can still exist, but they are not the
    stable pre-prod target.
-   Staging runs the same auth/email/runtime contract as production with
    stage-scoped secrets.

### Production

-   Production deploys from `main` only, triggered by a tagged release or an
    explicit promotion action.
-   Production does not rebuild from source. It promotes a recorded release
    candidate artifact.
-   Rollback re-promotes a previously recorded candidate, never builds a new
    binary.

## Local Development

Local dev uses `wrangler dev` with Miniflare emulation for D1, R2, KV, and DO.
No real Cloudflare resources are touched. The local D1 database is an ephemeral
SQLite file.

```bash
wrangler dev                    # Start local worker with all bindings
wrangler dev --env=preview      # Start with preview env bindings (remote D1)
wrangler d1 execute DB --local --file=./migrations/001_initial.sql
```

## DNS / Hostname Pattern

| Environment | Worker Hostname          | PWA Hostname         |
| ----------- | ------------------------ | -------------------- |
| dev         | `localhost:8787`         | `localhost:3000`     |
| staging     | `api-staging.example.com` | `staging.example.com` |
| production  | `api.example.com`         | `app.example.com`         |

The exact production hostnames are determined when the project is deployed and
DNS is configured. The pattern follows the environment topology principle:
parallel subdomain families for app and API surfaces.

## Split-Brain Prevention

-   The worker reads its environment from `env` bindings only. No environment
    variable tricks or runtime detection.
-   Migration scripts target the correct D1 database by Wrangler environment
    flag: `wrangler d1 execute --env=staging|production`.
-   Secrets are scoped per environment using `wrangler secret put --env=<name>`.

## Legacy Compatibility Note

-   `preview` remains as a legacy compatibility environment in some repo history
    and Cloudflare resources.
-   New CH5 work should treat `staging` as the canonical stable pre-production
    environment.

## References

-   `.sisyphus/plans/padloc-cloudflare-native-backend.md`
-   `environment-topology-and-staging-promotion` skill
-   `cloudflare-workers-expert` skill
