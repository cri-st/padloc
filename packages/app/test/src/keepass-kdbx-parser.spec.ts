/**
 * Focused tests for native KeePass (.kdbx) import, including TOTP secret
 * extraction across the two storage conventions used in the KeePass
 * ecosystem (KeePassXC's `otp` otpauth:// field and KeePass/plugin
 * `TimeOtp-Secret*` custom fields).
 *
 * This exercises the real Argon2 KDF wiring (kdbxweb + hash-wasm) end to
 * end: `Kdbx.create()` defaults to a KDBX4 database using Argon2d, so a
 * save() + load() round trip only succeeds if configureKdbxArgon2() is
 * actually wired correctly.
 *
 * Run: npx ts-node --transpile-only --compiler-options '{"module":"commonjs"}' \
 *          packages/app/test/src/keepass-kdbx-parser.spec.ts
 */
import * as kdbxweb from "kdbxweb";
import { FieldType, VaultItem } from "@padloc/core/src/item";
import { bytesToBase32 } from "@padloc/core/src/base32";
import {
    configureKdbxArgon2,
    extractTotpSecret,
    loadKeePassKdbx,
    parseKeePassKdbxEntries,
} from "../../src/lib/keepass-kdbx-parser";

let passed = 0;
let failed = 0;

function ok(cond: boolean, label: string) {
    if (cond) {
        passed++;
        console.log(`  ok - ${label}`);
    } else {
        failed++;
        console.log(`  FAIL - ${label}`);
    }
}

function fieldValue(item: VaultItem, type: FieldType): string | undefined {
    return item.fields.find((f) => f.type === type)?.value;
}

function fieldByName(item: VaultItem, name: string): string | undefined {
    return item.fields.find((f) => f.name === name)?.value;
}

async function run() {
    const password = "correct horse battery staple";
    const credentials = new kdbxweb.Credentials(kdbxweb.ProtectedValue.fromString(password), null);

    const db = kdbxweb.Kdbx.create(credentials, "Test DB");
    const rootGroup = db.getDefaultGroup();

    // Entry A: plain login with a custom extra field
    const entryA = db.createEntry(rootGroup);
    entryA.fields.set("Title", "GitHub");
    entryA.fields.set("UserName", "alice");
    entryA.fields.set("Password", kdbxweb.ProtectedValue.fromString("hunter2"));
    entryA.fields.set("URL", "https://github.com");
    entryA.fields.set("Notes", "work account");
    entryA.fields.set("Security Question", "mother's maiden name");

    // Entry B: KeePassXC-style TOTP (otpauth:// URI in the `otp` field)
    const entryB = db.createEntry(rootGroup);
    entryB.fields.set("Title", "Google");
    entryB.fields.set("UserName", "alice@gmail.com");
    entryB.fields.set(
        "otp",
        "otpauth://totp/Google:alice@gmail.com?secret=JBSWY3DPEHPK3PXP&issuer=Google&algorithm=SHA1&digits=6&period=30"
    );

    // Entry C: KeePass/KeeTrayTOTP-style TOTP (lowercase on purpose, must normalize)
    const entryC = db.createEntry(rootGroup);
    entryC.fields.set("Title", "AWS");
    entryC.fields.set("TimeOtp-Secret-Base32", "gezdgnbvgy3tqojq");

    // Entry D: KeePass hex-encoded TOTP secret
    const hexSecretBytes = new Uint8Array([0xde, 0xad, 0xbe, 0xef, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06]);
    const hexSecretHex = Array.from(hexSecretBytes)
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
    const expectedHexBase32 = bytesToBase32(hexSecretBytes);
    const entryD = db.createEntry(rootGroup);
    entryD.fields.set("Title", "Internal Tool");
    entryD.fields.set("TimeOtp-Secret-Hex", hexSecretHex);

    // Entry F: KeeTrayTOTP/KeePass2Android-style TOTP - "TOTP Seed" (base32, lowercase
    // and grouped with spaces, exactly like what a real export looks like) + "TOTP
    // Settings" ("<interval>;<digits>", informational only - Padloc has no per-item
    // TOTP interval/digits, so we don't need to consume it, just not treat it as junk).
    const entryF = db.createEntry(rootGroup);
    entryF.fields.set("Title", "Legacy 2FA Site");
    entryF.fields.set("TOTP Seed", "pag2 vmmh remi fq2t 43im 3kvt 4esx rixt");
    entryF.fields.set("TOTP Settings", "30;6");

    // Entry G: credit card stored as generic KeePass custom fields (no native "card"
    // entry type in KeePass) - field naming pattern from a real-world import (values
    // replaced with fake/test data - never commit real card numbers/CVVs to a test file).
    const entryG = db.createEntry(rootGroup);
    entryG.fields.set("Title", "Test Bank Visa");
    entryG.fields.set("Contact Information_Issuing Bank", "Test Bank");
    entryG.fields.set("Cardholder Name", "Jane Q. Public");
    entryG.fields.set("Number", "4111111111111111");
    entryG.fields.set("Type", "visa");
    entryG.fields.set("Valid From", "01/12/2024 00:00");
    entryG.fields.set("Verification Number", "123");
    entryG.fields.set("Expire", "08/30");

    // Entry E: lives in the Recycle Bin -> must be excluded from the import
    const recycleBin = db.getGroup(db.meta.recycleBinUuid!)!;
    const entryE = db.createEntry(recycleBin);
    entryE.fields.set("Title", "Deleted Site");
    entryE.fields.set("Password", "shouldnotimport");

    await configureKdbxArgon2();
    const data = await db.save();

    console.log("\n[extractTotpSecret - unit]");
    ok(
        extractTotpSecret(new Map([["otp", "otpauth://totp/X?secret=ABCDEFGHIJKLMNOP&issuer=X"]])) ===
            "ABCDEFGHIJKLMNOP",
        "extracts secret from otpauth:// URI"
    );
    ok(
        extractTotpSecret(new Map([["TimeOtp-Secret-Base32", "abcdefgh"]])) === "ABCDEFGH",
        "normalizes TimeOtp-Secret-Base32 to uppercase"
    );
    ok(
        extractTotpSecret(new Map([["Password", "irrelevant"]])) === undefined,
        "returns undefined when no TOTP field present"
    );
    ok(
        extractTotpSecret(new Map([["TOTP Seed", "pag2 vmmh remi fq2t 43im 3kvt 4esx rixt"]])) ===
            "PAG2VMMHREMIFQ2T43IM3KVT4ESXRIXT",
        "extracts and normalizes a spaced lowercase TOTP Seed field"
    );

    console.log("\n[loadKeePassKdbx + parseKeePassKdbxEntries - round trip via real Argon2 KDF]");
    const loaded = await loadKeePassKdbx(data, password);
    const items = await parseKeePassKdbxEntries(loaded);

    ok(items.length === 6, `parses exactly the 6 non-recycled entries (got ${items.length})`);
    ok(!items.some((i) => i.name === "Deleted Site"), "excludes entries inside the Recycle Bin");

    const github = items.find((i) => i.name === "GitHub");
    ok(!!github, "finds the GitHub entry");
    if (github) {
        ok(fieldValue(github, FieldType.Username) === "alice", "GitHub username mapped");
        ok(fieldValue(github, FieldType.Password) === "hunter2", "GitHub password mapped (unprotected)");
        ok(fieldValue(github, FieldType.Url) === "https://github.com", "GitHub URL mapped");
        ok(fieldValue(github, FieldType.Note) === "work account", "GitHub notes mapped");
        ok(
            fieldByName(github, "Security Question") === "mother's maiden name",
            "custom field preserved as extra field"
        );
    }

    const google = items.find((i) => i.name === "Google");
    ok(!!google, "finds the Google entry");
    if (google) {
        ok(fieldValue(google, FieldType.Totp) === "JBSWY3DPEHPK3PXP", "TOTP secret extracted from otpauth:// URI");
    }

    const aws = items.find((i) => i.name === "AWS");
    ok(!!aws, "finds the AWS entry");
    if (aws) {
        ok(
            fieldValue(aws, FieldType.Totp) === "GEZDGNBVGY3TQOJQ",
            "TOTP secret normalized from lowercase Base32 field"
        );
    }

    const tool = items.find((i) => i.name === "Internal Tool");
    ok(!!tool, "finds the Internal Tool entry");
    if (tool) {
        ok(
            fieldValue(tool, FieldType.Totp) === expectedHexBase32,
            "TOTP secret converted from TimeOtp-Secret-Hex to base32"
        );
    }

    const legacy = items.find((i) => i.name === "Legacy 2FA Site");
    ok(!!legacy, "finds the Legacy 2FA Site entry");
    if (legacy) {
        ok(
            fieldValue(legacy, FieldType.Totp) === "PAG2VMMHREMIFQ2T43IM3KVT4ESXRIXT",
            "TOTP secret extracted from spaced/lowercase TOTP Seed field"
        );
        ok(
            fieldByName(legacy, "TOTP Settings") === undefined,
            "TOTP Settings is not duplicated as an extra text field"
        );
    }

    const card = items.find((i) => i.name === "Test Bank Visa");
    ok(!!card, "finds the Test Bank Visa entry");
    if (card) {
        const typeByName = (name: string) => card.fields.find((f) => f.name === name)?.type;
        ok(typeByName("Number") === FieldType.Credit, "16-digit card number field detected as Credit");
        ok(typeByName("Verification Number") === FieldType.Pin, "CVV-like field detected as Pin, not Phone");
        ok(
            typeByName("Expire") === FieldType.Text,
            "non-ISO expiry date is left as Text rather than mislabeled as Phone"
        );
        ok(
            typeByName("Valid From") === FieldType.Text,
            "non-ISO date field is left as Text rather than mislabeled as Phone"
        );
        ok(typeByName("Cardholder Name") === FieldType.Text, "plain name field stays Text");
        ok(fieldByName(card, "Number") === "4111111111111111", "card number value preserved");
    }

    console.log(`\n${passed} passed, ${failed} failed`);
    if (failed > 0) {
        process.exit(1);
    }
}

run().catch((err) => {
    console.error(err);
    process.exit(1);
});
