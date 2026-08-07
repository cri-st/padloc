/**
 * Regression test for M3: `packages/worker/src/storage/normalize-email.ts`
 * must lowercase `email` before it reaches D1's `accounts.email`/
 * `auth.email` columns, matching `schema.ts`'s documented "stored
 * lowercased" invariant.
 *
 * Deliberately dependency-free (no `@padloc/core` import) so it can run
 * standalone via plain `node` -- `d1.ts` itself pulls in `@padloc/core`,
 * which has an unrelated pre-existing circular-import crash when
 * standalone-imported outside a full bundle (confirmed present on an
 * unmodified checkout).
 *
 * Run: node test/normalize-email.test.mjs
 */

import { buildSync } from "esbuild";
import Module from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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

const { normalizeEmailForStorage } = loadTs("../src/storage/normalize-email.ts");

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

console.log("=== normalizeEmailForStorage tests (M3) ===");

assert(normalizeEmailForStorage("User@Example.COM") === "user@example.com", "mixed-case email is lowercased");
assert(normalizeEmailForStorage("already@lower.com") === "already@lower.com", "already-lowercase email is unchanged");
assert(normalizeEmailForStorage(null) === null, "null stays null");
assert(normalizeEmailForStorage(undefined) === null, "undefined normalizes to null (not the string 'undefined')");
assert(normalizeEmailForStorage(42) === null, "a non-string value normalizes to null instead of throwing");
assert(normalizeEmailForStorage("") === "", "empty string stays an empty string, not null");

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
