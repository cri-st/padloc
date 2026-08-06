/**
 * Focused tests for the share-link client utilities:
 *
 *  - URL-fragment AES key encode/decode (`#k=<base64url(key)>`). The key
 *    never leaves the browser, so this pure round trip is the only thing
 *    standing between a share link and either "sender's key survives the
 *    copy/paste" or "recipient can never decrypt".
 *  - The "Login item" heuristic gating which items are shareable in v1:
 *    only items carrying at least one `FieldType.Password` field.
 *  - Field-level share filtering: TOTP fields must NEVER be offered as
 *    shareable (a live TOTP secret grants ongoing 2FA bypass, unlike a
 *    one-time password); other field types are opt-in, with a narrow
 *    "simplest" default (Username/Password/Url/Email) pre-selected.
 *  - `buildShareableItem()` always produces a FRESH VaultItem containing
 *    only name + selected fields -- passkeys/history/attachments/tags
 *    are structurally impossible to include, not just filtered out.
 *
 * Run: npx ts-node --transpile-only --compiler-options '{"module":"commonjs"}' \
 *          packages/app/test/src/share.spec.ts
 */
import { Field, FieldType, VaultItem } from "@padloc/core/src/item";
import {
    buildShareableItem,
    computeDefaultSelectedFieldIndices,
    decodeShareKeyFragment,
    encodeShareKeyFragment,
    isFieldSelectedByDefault,
    isFieldShareable,
    isShareableItem,
} from "../../src/lib/share";

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

// ── Field-level share filtering ─────────────────────────────────────────────
console.log("\n[Field-level share filtering]");
{
    const totpField = new Field({ name: "One-Time Password", type: FieldType.Totp, value: "JBSWY3DPEHPK3PXP" });
    const noteField = new Field({ name: "Backup Codes", type: FieldType.Note, value: "1234-5678" });
    const usernameField = new Field({ name: "Username", type: FieldType.Username, value: "alice" });
    const passwordField = new Field({ name: "Password", type: FieldType.Password, value: "hunter2" });
    const urlField = new Field({ name: "URL", type: FieldType.Url, value: "https://example.com" });
    const emailField = new Field({ name: "Email", type: FieldType.Email, value: "alice@example.com" });
    const pinField = new Field({ name: "PIN", type: FieldType.Pin, value: "1234" });

    ok(isFieldShareable(totpField) === false, "TOTP field is NEVER shareable (not offered as an option)");
    ok(isFieldShareable(noteField) === true, "Note field is shareable opt-in (e.g. backup codes, sender's choice)");
    ok(isFieldShareable(usernameField) === true, "Username field is shareable");
    ok(isFieldShareable(pinField) === true, "PIN field is shareable opt-in");

    ok(isFieldSelectedByDefault(usernameField) === true, "Username is selected by default");
    ok(isFieldSelectedByDefault(passwordField) === true, "Password is selected by default");
    ok(isFieldSelectedByDefault(urlField) === true, "Url is selected by default");
    ok(isFieldSelectedByDefault(emailField) === true, "Email is selected by default");
    ok(isFieldSelectedByDefault(noteField) === false, "Note is NOT selected by default (opt-in only)");
    ok(isFieldSelectedByDefault(pinField) === false, "PIN is NOT selected by default (opt-in only)");
    ok(isFieldSelectedByDefault(totpField) === false, "TOTP is never selected (moot -- never offered at all)");
}

// ── Minimal shared item construction ────────────────────────────────────────
console.log("\n[Minimal shared item construction]");
{
    const source = new VaultItem({
        name: "Example Login",
        fields: [
            new Field({ name: "Username", type: FieldType.Username, value: "alice" }),
            new Field({ name: "Password", type: FieldType.Password, value: "hunter2" }),
            new Field({ name: "One-Time Password", type: FieldType.Totp, value: "JBSWY3DPEHPK3PXP" }),
        ],
    });
    const selected = source.fields.filter((f) => f.type !== FieldType.Totp);
    const shared = buildShareableItem(source.name, selected);

    ok(shared.name === "Example Login", "shared item keeps the source name");
    ok(shared.fields.length === 2, "shared item has exactly the caller-selected fields, TOTP excluded");
    ok(
        shared.fields.every((f) => f.type !== FieldType.Totp),
        "shared item's fields never include a TOTP field"
    );
    ok(shared.passkeys.length === 0, "shared item NEVER carries passkeys (fresh VaultItem, never copied)");
    ok(shared.history.length === 0, "shared item NEVER carries edit history");
    ok(shared.attachments.length === 0, "shared item NEVER carries attachments");
    ok(shared.tags.length === 0, "shared item NEVER carries tags");
}

// ── Default selection only claims the FIRST field per type ─────────────────
console.log("\n[Default selection only claims the FIRST field per type]");
{
    // Reproduces a real report: a second Url-typed field named "Backup
    // codes" (e.g. from an import that mistyped it, or a user repurposing
    // the Url field type) must NOT be pre-selected just because its type
    // matches the safe default list -- only the item's actual/first URL
    // field should be.
    const username = new Field({ name: "UserName", type: FieldType.Username, value: "alice" });
    const password = new Field({ name: "Password", type: FieldType.Password, value: "hunter2" });
    const url = new Field({ name: "URL", type: FieldType.Url, value: "https://example.com" });
    const backupCodes = new Field({ name: "Backup codes", type: FieldType.Url, value: "1234-5678, 8765-4321" });
    const textBackupCode = new Field({ name: "whiteout_backup code", type: FieldType.Text, value: "abcd" });

    const fields = [username, password, url, backupCodes, textBackupCode];
    const defaultIndices = computeDefaultSelectedFieldIndices(fields);

    ok(defaultIndices.has(0), "UserName (1st Username field) is selected by default");
    ok(defaultIndices.has(1), "Password (1st Password field) is selected by default");
    ok(defaultIndices.has(2), "URL (1st Url field) is selected by default");
    ok(!defaultIndices.has(3), "Backup codes (2nd Url field) is NOT selected by default, even though its type matches");
    ok(!defaultIndices.has(4), "whiteout_backup code (Text field) is NOT selected by default");
    ok(defaultIndices.size === 3, "exactly 3 fields are pre-selected -- one per safe type, no duplicates");

    // A field is still fully selectable manually -- this test only asserts
    // the DEFAULT, not that "Backup codes" is excluded from the dialog.
    ok(isFieldShareable(backupCodes) === true, "Backup codes remains a selectable option in the dialog");
}

// ── Duplicate Password-type fields (real report: "Facebook (Crist)") ───────
console.log('\n[Duplicate Password-type fields, real report: "Facebook (Crist)"]');
{
    const username = new Field({ name: "UserName", type: FieldType.Username, value: "crist" });
    const password = new Field({ name: "Password", type: FieldType.Password, value: "hunter2" });
    const url = new Field({ name: "URL", type: FieldType.Url, value: "https://facebook.com" });
    const securityPassword = new Field({ name: "Seguridad_Password", type: FieldType.Password, value: "sec1" });
    const securityPasswordSpaces = new Field({
        name: "Seguridad_Password with spaces",
        type: FieldType.Password,
        value: "sec 2",
    });

    const fields = [username, password, url, securityPassword, securityPasswordSpaces];
    const defaultIndices = computeDefaultSelectedFieldIndices(fields);

    ok(defaultIndices.has(0), "UserName is selected by default");
    ok(defaultIndices.has(1), "the FIRST Password field (canonical 'Password') is selected by default");
    ok(defaultIndices.has(2), "URL is selected by default");
    ok(!defaultIndices.has(3), "Seguridad_Password (2nd Password field) is NOT selected by default");
    ok(!defaultIndices.has(4), "Seguridad_Password with spaces (3rd Password field) is NOT selected by default");
    ok(defaultIndices.size === 3, "exactly 3 fields pre-selected, regardless of how many extra Password fields exist");
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
    process.exit(1);
}
