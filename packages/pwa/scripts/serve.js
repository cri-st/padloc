#!/usr/bin/env node
/**
 * Thin wrapper around `http-server`'s programmatic API (not its CLI) so we
 * can attach real HTTP security response headers to every response.
 *
 * SECURITY: the PWA's only Content-Security-Policy is delivered via a
 * `<meta http-equiv="Content-Security-Policy">` tag (see
 * packages/pwa/webpack.config.js). The `frame-ancestors` directive is
 * explicitly ignored by browsers when declared via `<meta>` (CSP spec), and
 * the CLI form of `http-server` has no flag for custom headers -- so a
 * self-hosted deployment using the default `npm start` had NO clickjacking
 * protection at all: the app (a password manager) could be embedded in a
 * third-party `<iframe>` and targeted with UI-redress attacks. This script
 * adds `X-Frame-Options: DENY` plus a real HTTP `Content-Security-Policy:
 * frame-ancestors 'none'` header (which unlike the meta tag DOES apply) to
 * every response, along with a couple of other low-cost hardening headers.
 */
const httpServer = require("http-server");

const port = process.env.PL_PWA_PORT || 3000;
const root = process.env.PL_PWA_DIR || "./dist";

const server = httpServer.createServer({
    root,
    headers: {
        "X-Frame-Options": "DENY",
        "Content-Security-Policy": "frame-ancestors 'none'",
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "strict-origin-when-cross-origin",
    },
});

server.listen(port, () => {
    console.log(`Padloc PWA serving "${root}" on port ${port} (with security headers)`);
});
