/**
 * Focused tests for the share-link client utilities:
 *
 *  - URL-fragment AES key encode/decode (`#k=<base64url(key)>`). The key
 *    never leaves the browser, so this pure round trip is the only thing
 *    standing between a share link and either "sender's key survives the
 *    copy/paste" or "recipient can never decrypt".
 *  - The "Login item" heuristic gating which items are shareable in v1:
 *    only items carrying at least one `FieldType.Password` field.
 *
 * Run: npx ts-node --transpile-only --compiler-options '{"module":"commonjs"}' \
 *          packages/app/test/src/share.spec.ts
 */
import { Field, FieldType, VaultItem } from "@padloc/core/src/item";
import { decodeShareKeyFragment, encodeShareKeyFragment, isShareableItem } from "../../src/lib/share";

let passed = 0;
let failed = 0;

function ok(cond: boolean, label: string) {
    if (cond) {
        passed++;
        console.log(`  ok - ${label}`);
    } else {
        failed++;
        console.log(`  NOT OK - ${label}`);
    }
}

function loginItem(): VaultItem {
    return new VaultItem({
        name: "Example Login",
        fields: [
            new Field({ name: "Username", type: FieldType.Username, value: "alice" }),
            new Field({ name: "Password", type: FieldType.Password, value: "hunter2" }),
        ],
    });
}

function noteItem(): VaultItem {
    return new VaultItem({
        name: "Example Note",
        fields: [new Field({ name: "Note", type: FieldType.Note, value: "just some text" })],
    });
}

function creditCardItem(): VaultItem {
    return new VaultItem({
        name: "Example Card",
        fields: [
            new Field({ name: "Card Number", type: FieldType.Credit, value: "4111111111111111" }),
            new Field({ name: "CVC", type: FieldType.Pin, value: "123" }),
        ],
    });
}

// ── Fragment key encode/decode ──────────────────────────────────────────────
console.log("\n[Fragment key encode/decode]");
{
    const key = new Uint8Array([1, 2, 3, 4, 5, 250, 251, 252, 253, 254, 255, 0]);
    const fragment = encodeShareKeyFragment(key);

    ok(fragment.startsWith("k="), "encoded fragment starts with 'k='");
    ok(!fragment.includes("+") && !fragment.includes("/"), "encoded fragment is URL-safe (no '+' or '/')");

    const decoded = decodeShareKeyFragment(fragment);
    ok(decoded !== null, "decoding a freshly-encoded fragment succeeds");
    ok(
        decoded !== null && decoded.length === key.length && decoded.every((b, i) => b === key[i]),
        "decoded bytes exactly match the original key (round trip)"
    );

    // Also decode with the leading '#' that `location.hash` actually carries
    const decodedWithHash = decodeShareKeyFragment(`#${fragment}`);
    ok(
        decodedWithHash !== null && decodedWithHash.every((b, i) => b === key[i]),
        "decoding with a leading '#' (as in location.hash) also round-trips"
    );
}

// ── Fragment key decode edge cases ──────────────────────────────────────────
console.log("\n[Fragment key decode edge cases]");
{
    ok(decodeShareKeyFragment("") === null, "empty hash decodes to null");
    ok(decodeShareKeyFragment("#") === null, "bare '#' decodes to null");
    ok(decodeShareKeyFragment("#k=") === null, "'#k=' with no value decodes to null");
    ok(decodeShareKeyFragment("#other=value") === null, "hash without a 'k' param decodes to null");

    // Triangulation: a second real key, different length/content, must also round-trip
    const otherKey = new Uint8Array(32).map((_, i) => i * 3);
    const otherFragment = encodeShareKeyFragment(otherKey);
    const otherDecoded = decodeShareKeyFragment(otherFragment);
    ok(
        otherDecoded !== null && otherDecoded.length === 32 && otherDecoded.every((b, i) => b === otherKey[i]),
        "a different 32-byte key round-trips independently of the first test"
    );
}

// ── Login-item heuristic ─────────────────────────────────────────────────────
console.log("\n[Login-item heuristic]");
{
    ok(isShareableItem(loginItem()) === true, "item with a Password field is shareable");
    ok(isShareableItem(noteItem()) === false, "Note-only item (no Password field) is not shareable");
    ok(isShareableItem(creditCardItem()) === false, "Credit Card item (no Password field) is not shareable");
    ok(isShareableItem(new VaultItem({ name: "Empty", fields: [] })) === false, "item with no fields is not shareable");
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
    process.exit(1);
}
