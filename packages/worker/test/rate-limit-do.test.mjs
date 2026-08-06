/**
 * RateLimitDO contract tests.
 *
 * Exercises the REAL `packages/worker/src/durable-objects/rate-limit.ts`
 * class (transpiled in-process via esbuild -- no bundling) against a fake
 * `DurableObjectState` whose SQL storage is backed by Node's built-in
 * `node:sqlite`, mirroring `share-link-do.test.mjs`'s harness exactly.
 *
 * Security context: this DO replaces the KV-backed `RateLimiter`
 * (`rate-limiter.ts`) for the share-view throttle specifically, because a
 * security audit found KV's separate get()-then-put() has no
 * compare-and-swap -- two concurrent requests for the same identity can
 * both read the same token count before either write lands, letting both
 * through for the price of one token. A Durable Object closes this the
 * same way `ShareLinkDO` closes the equivalent single-view race: the
 * Cloudflare runtime processes every RPC call into ONE DO instance to
 * completion before starting the next, so two `consume()` calls can never
 * observe the same pre-decrement token count.
 *
 * Tests:
 *   1. Sequential consumption correctly decrements and exhausts the bucket.
 *   2. "Concurrent" (Promise.all) consume() calls against a bucket with
 *      exactly enough tokens for ONE never both succeed -- the logic never
 *      double-spends a token, matching the atomicity the real DO's
 *      single-threaded-per-instance execution model guarantees in
 *      production.
 *   3. Window reset -- once windowMs has elapsed, the bucket refills.
 *
 * Run: node test/rate-limit-do.test.mjs
 */

import { buildSync } from "esbuild";
import { DatabaseSync } from "node:sqlite";
import Module from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const originalRequire = Module.prototype.require;
Module.prototype.require = function (id) {
    if (id === "cloudflare:workers") {
        return {
            DurableObject: class DurableObject {
                constructor(ctx, env) {
                    this.ctx = ctx;
                    this.env = env;
                }
            },
        };
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

const { RateLimitDO } = loadTs("../src/durable-objects/rate-limit.ts");

// ─── Fake DurableObjectState (real SQLite via node:sqlite) ─────────────────

class FakeSqlStorage {
    constructor() {
        this._db = new DatabaseSync(":memory:");
    }

    exec(query, ...bindings) {
        const stmt = this._db.prepare(query);
        const rows = stmt.all(...bindings);
        return { toArray: () => rows };
    }
}

class FakeDurableObjectStorage {
    constructor() {
        this.sql = new FakeSqlStorage();
    }
}

function makeState() {
    return { storage: new FakeDurableObjectStorage() };
}

// ─── assert helper (matches share-link-do.test.mjs style) ─────────────────

let passed = 0;
let failed = 0;

function assert(condition, label) {
    if (condition) {
        passed++;
        console.log(`  ✓ ${label}`);
    } else {
        failed++;
        console.log(`  ✗ ${label}`);
    }
}

// ─── Tests ──────────────────────────────────────────────────────────────

async function testSequentialConsumption() {
    console.log("Sequential consumption:");
    const limiter = new RateLimitDO(makeState(), {});

    const r1 = await limiter.consume(3, 60_000);
    assert(r1.allowed === true && r1.remaining === 2, "1st of 3: allowed, 2 remaining");

    const r2 = await limiter.consume(3, 60_000);
    assert(r2.allowed === true && r2.remaining === 1, "2nd of 3: allowed, 1 remaining");

    const r3 = await limiter.consume(3, 60_000);
    assert(r3.allowed === true && r3.remaining === 0, "3rd of 3: allowed, 0 remaining");

    const r4 = await limiter.consume(3, 60_000);
    assert(r4.allowed === false && r4.remaining === 0, "4th call: rejected, bucket exhausted");
    assert(typeof r4.retryAfterMs === "number" && r4.retryAfterMs > 0, "rejection includes a positive retryAfterMs");
}

async function testConcurrentConsumeNeverDoubleSpends() {
    console.log("\nConcurrent consume() never double-spends a token:");
    const limiter = new RateLimitDO(makeState(), {});

    // Bucket starts with exactly 1 token (maxRequests=1) -- two
    // "simultaneous" callers must never BOTH be told `allowed: true`.
    const [a, b] = await Promise.all([limiter.consume(1, 60_000), limiter.consume(1, 60_000)]);
    const results = [a, b];
    const allowed = results.filter((r) => r.allowed);
    const rejected = results.filter((r) => !r.allowed);

    assert(allowed.length === 1, "exactly one concurrent consume() call is allowed");
    assert(rejected.length === 1, "exactly one concurrent consume() call is rejected");

    const third = await limiter.consume(1, 60_000);
    assert(third.allowed === false, "a third call within the same window is also rejected");
}

async function testWindowReset() {
    console.log("\nWindow reset:");
    const limiter = new RateLimitDO(makeState(), {});

    const r1 = await limiter.consume(1, 50);
    assert(r1.allowed === true, "1st call in a fresh window: allowed");

    const r2 = await limiter.consume(1, 50);
    assert(r2.allowed === false, "2nd call in the SAME window: rejected");

    await new Promise((resolve) => setTimeout(resolve, 60));

    const r3 = await limiter.consume(1, 50);
    assert(r3.allowed === true, "call after the window elapsed: allowed again (bucket refilled)");
}

// ─── Run ───────────────────────────────────────────────────────────────────

(async () => {
    console.log("=== RateLimitDO Contract Tests ===");
    await testSequentialConsumption();
    await testConcurrentConsumeNeverDoubleSpends();
    await testWindowReset();

    console.log(`\nResults: ${passed} passed, ${failed} failed`);
    process.exit(failed > 0 ? 1 : 0);
})();
