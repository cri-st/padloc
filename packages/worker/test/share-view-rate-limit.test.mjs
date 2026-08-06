/**
 * Share-view rate limit tests (openspec/changes/share-password, Req: Rate
 * Limiting). Exercises the REAL `shareViewRateLimitKeys`/
 * `checkShareViewRateLimit` exports from `packages/worker/src/index.ts`
 * together with the REAL `packages/worker/src/rate-limiter.ts`'s
 * `RateLimiter` -- both transpiled in-process via esbuild (single-file,
 * `bundle: false`, same technique as `share-link-do.test.mjs`). Every
 * `index.ts` import besides the two pure exports under test is stubbed out
 * (this test never invokes the `fetch` handler itself, only the extracted
 * rate-limit helpers), so no Workers-runtime globals or `cloudflare:workers`
 * module are ever needed.
 *
 * Tests:
 *   1. Per-share-ID brute-force cap -- rapid `revealShare` guesses against
 *      ONE share id, each from a DIFFERENT IP, still get capped once the
 *      share-scoped bucket is exhausted.
 *   2. Per-IP enumeration cap -- rapid `revealShare` guesses against MANY
 *      different share ids, all from ONE IP, still get capped once the
 *      IP-scoped bucket is exhausted.
 *   3. Requests below both caps are allowed; non-view RPC methods
 *      (`createShare`, `getShareStatus`, ...) are never gated by this
 *      limiter.
 *
 * Run: node test/share-view-rate-limit.test.mjs
 */

import { buildSync } from "esbuild";
import Module from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const originalRequire = Module.prototype.require;
Module.prototype.require = function (id) {
    // `index.ts` pulls in the full Worker dependency graph (transport,
    // server-factory, hq-instrumentation, @padloc/core, ...) for its
    // `fetch` handler; none of it is needed to exercise the two pure,
    // exported rate-limit helpers under test, so every relative/@padloc
    // import (and `cloudflare:workers`, transitively reachable via
    // `./durable-objects/share-link`) is stubbed to an empty module.
    if (id === "cloudflare:workers" || id.startsWith(".") || id.startsWith("@padloc/")) {
        return {};
    }
    return originalRequire.apply(this, arguments);
};

// ─── TS loader (esbuild transpile, no bundling) ────────────────────────────

function loadTs(relPath) {
    const absPath = path.resolve(__dirname, relPath);
    const result = buildSync({
        entryPoints: [absPath],
        bundle: false,
        write: false,
        format: "cjs",
        platform: "node",
        target: "es2020",
    });
    const code = result.outputFiles[0].text;
    const mod = new Module(absPath);
    mod.filename = absPath;
    mod.paths = Module._nodeModulePaths(path.dirname(absPath));
    mod._compile(code, absPath);
    return mod.exports;
}

const { shareViewRateLimitKeys, checkShareViewRateLimit } = loadTs("../src/index.ts");
const { RateLimiter } = loadTs("../src/rate-limiter.ts");

// ─── Fake KVNamespace (in-memory, mirrors rate-limit-test.ts's double) ─────

class InMemoryKV {
    constructor() {
        this.store = new Map();
    }

    async get(key) {
        const entry = this.store.get(key);
        return entry ? entry.value : null;
    }

    async put(key, value) {
        this.store.set(key, { value: JSON.parse(value) });
    }
}

let passed = 0;
let failed = 0;

function ok(cond, label) {
    if (cond) {
        passed++;
        console.log(`  \u2713 ${label}`);
    } else {
        failed++;
        console.log(`  \u2717 ${label}`);
    }
}

async function main() {
    // ── shareViewRateLimitKeys: scope ───────────────────────────────────────────
    console.log("\n[shareViewRateLimitKeys: which RPC methods are gated]");
    {
        ok(
            shareViewRateLimitKeys("createShare", ["share1"], "1.2.3.4") === null,
            "createShare is not gated (returns null)"
        );
        ok(
            shareViewRateLimitKeys("getShareStatus", ["share1"], "1.2.3.4") === null,
            "getShareStatus is not gated (returns null)"
        );
        const keys = shareViewRateLimitKeys("revealShare", ["share1"], "1.2.3.4");
        ok(
            Array.isArray(keys) && keys.includes("share-view:ip:1.2.3.4") && keys.includes("share-view:share:share1"),
            "revealShare derives both an IP-scoped and a share-scoped key"
        );
    }

    // ── Per-share brute-force attempts (Req: Rate Limiting scenario) ───────────
    console.log("\n[Per-share brute-force attempts]");
    {
        const limiter = new RateLimiter(new InMemoryKV(), { maxRequests: 3, windowMs: 60_000 });
        const shareId = "target-share";

        let allowedCount = 0;
        for (let i = 0; i < 3; i++) {
            // A different IP on every attempt -- only the share-scoped bucket
            // should be responsible for capping these.
            const allowed = await checkShareViewRateLimit("revealShare", [shareId], `10.0.0.${i}`, limiter);
            if (allowed) allowedCount++;
        }
        ok(allowedCount === 3, "first 3 guesses against one share id (different IPs) are allowed");

        const fourth = await checkShareViewRateLimit("revealShare", [shareId], "10.0.0.99", limiter);
        ok(fourth === false, "4th guess against the SAME share id is rejected despite a fresh IP");
    }

    // ── Per-IP enumeration attempts (Req: Rate Limiting scenario) ──────────────
    console.log("\n[Per-IP enumeration attempts]");
    {
        const limiter = new RateLimiter(new InMemoryKV(), { maxRequests: 3, windowMs: 60_000 });
        const ip = "203.0.113.7";

        let allowedCount = 0;
        for (let i = 0; i < 3; i++) {
            // A different share id on every attempt -- only the IP-scoped
            // bucket should be responsible for capping these.
            const allowed = await checkShareViewRateLimit("peekShare", [`share-${i}`], ip, limiter);
            if (allowed) allowedCount++;
        }
        ok(allowedCount === 3, "first 3 guesses from one IP (different share ids) are allowed");

        const fourth = await checkShareViewRateLimit("peekShare", ["share-99"], ip, limiter);
        ok(fourth === false, "4th guess from the SAME IP is rejected despite a fresh share id");
    }

    // ── Non-view methods are never gated by this limiter ────────────────────────
    console.log("\n[Non-view RPC methods bypass the share-view limiter]");
    {
        const limiter = new RateLimiter(new InMemoryKV(), { maxRequests: 1, windowMs: 60_000 });
        // Exhaust every bucket this limiter could plausibly use for this IP/share.
        await checkShareViewRateLimit("revealShare", ["share1"], "9.9.9.9", limiter);

        const createAllowed = await checkShareViewRateLimit("createShare", ["share1"], "9.9.9.9", limiter);
        ok(createAllowed === true, "createShare from the same exhausted IP is still allowed (different RPC kind)");

        const revokeAllowed = await checkShareViewRateLimit("revokeShare", ["share1"], "9.9.9.9", limiter);
        ok(revokeAllowed === true, "revokeShare from the same exhausted IP is still allowed (different RPC kind)");
    }

    console.log(`\n${passed} passed, ${failed} failed`);
    if (failed > 0) {
        process.exit(1);
    }
}

main();
