# Deploy (pre-built images)

Deploys Padloc using the two images published by
`.github/workflows/docker-publish.yml` to Docker Hub — the only things this
CI builds are:

-   `<DOCKERHUB_USERNAME>/padloc-server` — API/backend (`Dockerfile-server`)
-   `<DOCKERHUB_USERNAME>/padloc-pwa` — web app build (`Dockerfile-pwa`)

Everything else in `docker-compose.yml` (`db`, `nginx`, `cloudflared`) is a
**stock, unmodified image** configured entirely through env vars / inline
command in this file — nothing custom to build or maintain for them:

-   `db` — `postgres:17-alpine`, the server's storage backend.
-   `nginx` — `nginx:alpine`, serves the built PWA and reverse-proxies
    `/server*` to the `server` container. Config is generated inline by the
    container's `command:` (no mounted file, no custom Dockerfile).
-   `cloudflared` — `cloudflare/cloudflared:latest`, exposes `nginx`
    through a Cloudflare Tunnel. No inbound ports are opened on the host
    (no `ports:` on any service) and no TLS cert management is needed —
    Cloudflare terminates HTTPS at the edge.

## One-time setup

1. On GitHub: **Settings -> Secrets and variables -> Actions**, add:
    - `DOCKERHUB_USERNAME` — your Docker Hub username/namespace
    - `DOCKERHUB_TOKEN` — a Docker Hub access token (Docker Hub -> Account
      Settings -> Security -> New Access Token)
2. Push to `main` (touching `Dockerfile-server`, `Dockerfile-pwa`,
   `packages/server/**`, `packages/pwa/**`, etc.) or run
   `docker-publish.yml` manually from the Actions tab. This builds and
   pushes both images.
3. Create a Cloudflare Tunnel and point it at this stack (run once, from
   anywhere with `cloudflared` + `cloudflare login`):
    ```sh
    cloudflared tunnel create padloc
    cloudflared tunnel route dns padloc pad.example.com
    cloudflared tunnel token padloc   # -> CF_TUNNEL_TOKEN
    ```
   Public hostname in the tunnel must point to `http://nginx:80` (the
   `nginx` service name on the `padloc` compose network).

## Deploy

```sh
cd deploy
cp .env.example .env
# edit .env: DOCKERHUB_USERNAME, PL_HOSTNAME, postgres/email creds, CF_TUNNEL_TOKEN

docker compose pull
docker compose up -d
```

The app is now available at `https://$PL_HOSTNAME` through the tunnel.

## Updating

```sh
docker compose pull
docker compose up -d
```

`pwa` runs its webpack build **inside the container** on every start (it's
not pre-baked into the pushed image) — first boot takes a couple of minutes
and needs some RAM, then the container exits by design (`restart: on-failure`
only kicks in if the build itself fails, not after a clean exit). If you
only changed `PL_HOSTNAME` and want to rebuild the bundle without touching
`server`/`db`:

```sh
docker compose up -d --force-recreate pwa
```

## Notes

-   Server data (postgres) and file attachments persist in the `postgres`
    and `attachments` named volumes. Back these up.
-   Nothing here opens ports 80/443 on the host — everything rides the
    Cloudflare Tunnel. If you need direct host exposure instead (no
    Cloudflare), drop `cloudflared` and add `ports: ["80:80", "443:443"]`
    to `nginx` plus a TLS story (see
    `docs/examples/hosting/docker/postgres-nginx-letsencrypt` for a
    certbot-based example).
