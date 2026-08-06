/**
 * ShareLinkDO contract tests.
 *
 * Exercises the REAL `packages/worker/src/durable-objects/share-link.ts`
 * class (transpiled in-process via esbuild -- no bundling, no type
 * stripping tricks) against a fake `DurableObjectState` whose SQL storage
 * is backed by Node's built-in `node:sqlite`. This gives genuine SQLite
 * semantics (including `UPDATE ... RETURNING`) without needing Miniflare,
 * mirroring how `session-contract.test.mjs` fakes DO-adjacent infrastructure
 * for a fast in-process cycle. The `cloudflare:workers` module (providing
 * the `DurableObject` base class `ShareLinkDO` extends) doesn't exist under
 * plain Node, so `Module.prototype.require` is patched with a minimal
 * shim that only replicates the base constructor's `ctx`/`env` assignment
 * -- the one behavior `ShareLinkDO` actually relies on.
 *
 * Tests:
 *   1. Concurrent reveal race -- two simultaneous reveal() calls resolve to
 *      exactly one success, the other observing no ciphertext.
 *   2. Alarm-driven expiry -- once TTL has elapsed, reveal()/peek() report
 *      the share as expired even before alarm() runs (defense in depth),
 *      and alarm() itself performs the storage cleanup.
 *
 * Run: node test/share-link-do.test.mjs
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

const { ShareLinkDO } = loadTs("../src/durable-objects/share-link.ts");

// ─── Fake DurableObjectState (real SQLite via node:sqlite) ─────────────────

/**
 * Minimal shim over `node:sqlite` matching the subset of the real
 * Cloudflare `SqlStorage.exec()` contract that `ShareLinkDO` depends on: a
 * synchronous call returning a cursor with `.toArray()`. `node:sqlite`
 * returns BLOB columns as `Uint8Array`, but real Cloudflare `SqlStorage`
 * returns them as `ArrayBuffer` (confirmed live against `wrangler dev`) --
 * rows are normalized here so this fake actually matches production and
 * catches the type mismatch class of bug instead of masking it.
 */
class FakeSqlStorage {
    constructor() {
        this._db = new DatabaseSync(":memory:");
    }

    exec(query, ...bindings) {
        const stmt = this._db.prepare(query);
        // node:sqlite's `.run()` doesn't return RETURNING rows; `.all()` does
        // and is safe to call for both SELECT and UPDATE...RETURNING.
        const rows = stmt.all(...bindings).map((row) => {
            const normalized = { ...row };
            for (const key of Object.keys(normalized)) {
                if (normalized[key] instanceof Uint8Array) {
                    normalized[key] = normalized[key].buffer.slice(
                        normalized[key].byteOffset,
                        normalized[key].byteOffset + normalized[key].byteLength
                    );
                }
            }
            return normalized;
        });
        return { toArray: () => rows };
    }
}

class FakeDurableObjectStorage {
    constructor() {
        this.sql = new FakeSqlStorage();
        this._alarm = null;
    }

    async setAlarm(time) {
        this._alarm = time instanceof Date ? time.getTime() : time;
    }

    async getAlarm() {
        return this._alarm;
    }

    async deleteAlarm() {
        this._alarm = null;
    }
}

function makeState() {
    return { storage: new FakeDurableObjectStorage() };
}

// ─── assert helper (matches session-contract.test.mjs style) ──────────────

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

async function testConcurrentRevealRace() {
    console.log("Concurrent reveal race:");
    const state = makeState();
    const share = new ShareLinkDO(state, {});

    await share.create({
        owner: "owner-1",
        encryptedData: new Uint8Array([1, 2, 3, 4]),
        encryptionParamsJson: JSON.stringify({ iv: "abc" }),
        ttlSeconds: 3600,
    });

    const [a, b] = await Promise.all([share.reveal(), share.reveal()]);
    const results = [a, b];
    const successes = results.filter((r) => r !== null);
    const failures = results.filter((r) => r === null);

    assert(successes.length === 1, "exactly one concurrent reveal() call succeeds");
    assert(failures.length === 1, "exactly one concurrent reveal() call observes no ciphertext");
    assert(
        successes[0] && successes[0].encryptedData.length === 4 && successes[0].encryptedData[2] === 3,
        "the successful reveal returns the real ciphertext bytes"
    );

    const third = await share.reveal();
    assert(third === null, "a third reveal() after the link is burned also fails");
}

async function testConcurrentRevealRaceSecondCaseAllFail() {
    // Triangulation: without a prior create(), no reveal can ever succeed --
    // proves reveal() isn't unconditionally returning a value.
    console.log("Concurrent reveal on a never-created share:");
    const state = makeState();
    const share = new ShareLinkDO(state, {});

    const [a, b] = await Promise.all([share.reveal(), share.reveal()]);
    assert(a === null && b === null, "reveal() on a non-existent share always returns null");
}

async function testAlarmDrivenExpiry() {
    console.log("Alarm-driven expiry:");
    const state = makeState();
    const share = new ShareLinkDO(state, {});

    // Negative TTL => expiresAt is already in the past at creation time.
    await share.create({
        owner: "owner-1",
        encryptedData: new Uint8Array([9, 9, 9]),
        encryptionParamsJson: JSON.stringify({ iv: "xyz" }),
        ttlSeconds: -1,
    });

    const peekBeforeAlarm = await share.peek();
    assert(
        peekBeforeAlarm !== null && peekBeforeAlarm.expired === true,
        "peek() reports expired=true post-TTL even before alarm() has run"
    );

    const revealAfterExpiry = await share.reveal();
    assert(revealAfterExpiry === null, "reveal() after expiry never returns ciphertext");

    await share.alarm();

    const statusAfterAlarm = await share.getStatus("owner-1");
    assert(statusAfterAlarm === null, "alarm() cleans up the expired row from storage");
}

async function testUnexpiredShareNotAffectedByAlarmLogic() {
    // Triangulation: a share still within its TTL is untouched by the
    // expiry path -- proves expiry isn't a hardcoded always-true response.
    console.log("Unexpired share stays revealable:");
    const state = makeState();
    const share = new ShareLinkDO(state, {});

    await share.create({
        owner: "owner-2",
        encryptedData: new Uint8Array([7, 7]),
        encryptionParamsJson: JSON.stringify({ iv: "def" }),
        ttlSeconds: 3600,
    });

    const peek = await share.peek();
    assert(peek !== null && peek.expired === false, "peek() reports expired=false while within TTL");

    const status = await share.getStatus("owner-2");
    assert(
        status !== null && status.viewed === false && status.viewedAt === null,
        "getStatus() shows an unviewed receipt before any reveal"
    );
}

// ─── Run ───────────────────────────────────────────────────────────────────

(async () => {
    console.log("=== ShareLinkDO Contract Tests ===");
    await testConcurrentRevealRace();
    await testConcurrentRevealRaceSecondCaseAllFail();
    await testAlarmDrivenExpiry();
    await testUnexpiredShareNotAffectedByAlarmLogic();

    console.log(`\nResults: ${passed} passed, ${failed} failed`);
    process.exit(failed > 0 ? 1 : 0);
})();
