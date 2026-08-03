# Deploy (pre-built images)

This folder deploys Padloc using the images published by
`.github/workflows/docker-publish.yml` to Docker Hub — nothing is built on
the host. It publishes two images:

-   `<DOCKERHUB_USERNAME>/padloc-server` — API/backend (`Dockerfile-server`)
-   `<DOCKERHUB_USERNAME>/padloc-pwa` — web app build (`Dockerfile-pwa`)

`caddy` (official image, not custom-built) serves the built web app and
reverse-proxies `/server*` to the `server` container, with automatic HTTPS.

## One-time setup

1. On GitHub: **Settings -> Secrets and variables -> Actions**, add:
    - `DOCKERHUB_USERNAME` — your Docker Hub username/namespace
    - `DOCKERHUB_TOKEN` — a Docker Hub access token (Docker Hub -> Account
      Settings -> Security -> New Access Token)
2. Push to `main` (touching `Dockerfile-server`, `Dockerfile-pwa`,
   `packages/server/**`, `packages/pwa/**`, etc.) or run the workflow
   manually from the Actions tab. This builds and pushes both images.

## Deploy

```sh
cd deploy
cp .env.example .env
# edit .env: DOCKERHUB_USERNAME, PL_HOSTNAME, email settings

docker compose pull
docker compose up -d
```

The app is now available at `https://$PL_HOSTNAME`.

## Updating

```sh
docker compose pull
docker compose up -d
```

## Notes

-   `PL_HOSTNAME` must already resolve (DNS A/AAAA record) to this host —
    Caddy needs that to obtain a Let's Encrypt certificate on port 80/443.
-   Server data (leveldb) and file attachments persist in the `data` and
    `attachments` named volumes. Back these up.
-   This intentionally skips the custom `nginx/` image (bundles the paid
    NGINX Amplify agent) — Caddy needs no custom image and handles TLS
    automatically. Swap it for the `nginx/` setup in
    `docs/examples/hosting/docker/postgres-nginx-letsencrypt` if you need
    that instead.
