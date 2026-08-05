import type * as KdbxWeb from "kdbxweb";
import { Field, FieldType, VaultItem, createVaultItem, guessFieldType } from "@padloc/core/src/item";
import { bytesToBase32 } from "@padloc/core/src/base32";
import { translate as $l } from "@padloc/locale/src/translate";

let argon2Configured = false;

/** Lazy-loads kdbxweb into its own chunk - most users never import a KeePass file. */
function loadKdbxweb(): Promise<typeof KdbxWeb> {
    return import(/* webpackChunkName: "keepass-kdbx" */ "kdbxweb");
}

/**
 * Wires kdbxweb's Argon2 KDF (used by every KDBX4 database, which is the
 * current KeePass file format) to a WASM implementation. kdbxweb ships
 * without one on purpose (see its README) since there's no single fast
 * implementation for every environment. Idempotent - safe to call before
 * every load/save. Returns the (lazily loaded) kdbxweb module for reuse.
 */
export async function configureKdbxArgon2(): Promise<typeof KdbxWeb> {
    const kdbxweb = await loadKdbxweb();

    if (argon2Configured) {
        return kdbxweb;
    }

    const { argon2d, argon2id } = await import(/* webpackChunkName: "keepass-kdbx" */ "hash-wasm");

    kdbxweb.CryptoEngine.setArgon2Impl(
        async (password, salt, memory, iterations, length, parallelism, type, version) => {
            if (version !== 0x13) {
                // hash-wasm only implements Argon2 v1.3 (0x13), which is what every
                // KDBX4 file produced by a current KeePass/KeePassXC uses by default.
                throw new Error(`Unsupported Argon2 version 0x${version.toString(16)}; only Argon2 v1.3 is supported`);
            }

            const argon2Fn = type === kdbxweb.CryptoEngine.Argon2TypeArgon2id ? argon2id : argon2d;
            const hash = await argon2Fn({
                password: new Uint8Array(password),
                salt: new Uint8Array(salt),
                parallelism,
                iterations,
                // kdbxweb already converts kdfParameters' byte-based "M" into KiB
                // before calling this function, matching hash-wasm's memorySize unit.
                memorySize: memory,
                hashLength: length,
                outputType: "binary",
            });
            return hash.buffer;
        }
    );

    argon2Configured = true;
    return kdbxweb;
}

type KdbxFieldValue = string | KdbxWeb.ProtectedValue | undefined;

function fieldValueToString(value: KdbxFieldValue): string {
    if (!value) {
        return "";
    }
    return typeof value === "string" ? value : value.getText();
}

const STANDARD_FIELD_TYPES: Record<string, FieldType> = {
    UserName: FieldType.Username,
    Password: FieldType.Password,
    URL: FieldType.Url,
    Notes: FieldType.Note,
};

const TOTP_FIELD_KEYS = [
    "otp",
    "TOTP Seed",
    "TOTP Settings",
    "TimeOtp-Secret-Base32",
    "TimeOtp-Secret-Hex",
    "TimeOtp-Secret-Base64",
    "TimeOtp-Secret",
];

const NON_EXTRA_FIELD_KEYS = new Set(["Title", ...Object.keys(STANDARD_FIELD_TYPES), ...TOTP_FIELD_KEYS]);

/**
 * Extracts a TOTP secret (base32-encoded, as Padloc's Totp field expects)
 * from a KeePass entry's custom fields, if present. Supports the storage
 * conventions in use across the KeePass ecosystem, checked in this
 * priority order:
 *  - KeePassXC: `otp` field containing a full `otpauth://` URI
 *  - KeeTrayTOTP / KeePass2Android: `TOTP Seed` (+ informational `TOTP Settings`)
 *  - KeePass 2.47+ native / KeeOtp: `TimeOtp-Secret[-Base32|-Hex|-Base64]`
 */
export function extractTotpSecret(fields: Map<string, KdbxFieldValue>): string | undefined {
    const otp = fieldValueToString(fields.get("otp"));
    if (otp) {
        try {
            const secret = new URL(otp).searchParams.get("secret");
            if (secret) {
                return secret.toUpperCase();
            }
        } catch {
            // not a valid otpauth:// URI; fall through to the conventions below
        }
    }

    const seed = fieldValueToString(fields.get("TOTP Seed")).replace(/\s+/g, "");
    if (seed) {
        return seed.toUpperCase();
    }

    const base32 = fieldValueToString(fields.get("TimeOtp-Secret-Base32")).replace(/\s+/g, "");
    if (base32) {
        return base32.toUpperCase();
    }

    const hex = fieldValueToString(fields.get("TimeOtp-Secret-Hex")).replace(/\s+/g, "");
    if (hex) {
        const bytes = new Uint8Array(hex.length / 2);
        for (let i = 0; i < bytes.length; i++) {
            bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
        }
        return bytesToBase32(bytes);
    }

    const base64 = fieldValueToString(fields.get("TimeOtp-Secret-Base64"));
    if (base64) {
        const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
        return bytesToBase32(bytes);
    }

    const raw = fieldValueToString(fields.get("TimeOtp-Secret"));
    if (raw) {
        return bytesToBase32(new TextEncoder().encode(raw));
    }

    return undefined;
}

/**
 * Guesses a Padloc field type for an arbitrary KeePass custom field, on top of
 * Padloc's own `guessFieldType` (also used by the CSV importer). Two adjustments
 * specific to KeePass exports:
 *  - Recognizes common credit-card synonyms (`CVV`/`CVC`/"Verification Number",
 *    "Card Number"/`PAN`) that `guessFieldType` doesn't match by name, since KeePass
 *    has no native "this is a credit card" entry type to key off of.
 *  - Distrusts `guessFieldType`'s `Phone` guess unless the field name actually looks
 *    phone-related: its underlying pattern is `/\d+\/`, matching ANY digit, so it
 *    false-positives on expiry dates, short CVVs, and other incidental numeric
 *    fields far more often than it correctly identifies a phone number.
 */
function guessKdbxFieldType(name: string, value: string): FieldType {
    if (/cvv|cvc|security.?code|verification/i.test(name)) {
        return FieldType.Pin;
    }
    if (/card.?(no|number)|\bpan\b/i.test(name)) {
        return FieldType.Credit;
    }

    const guessed = guessFieldType({ name, value });
    if (guessed === FieldType.Phone && !/phone|tel|mobile/i.test(name)) {
        return FieldType.Text;
    }
    return guessed;
}

function kdbxEntryToVaultItem(entry: KdbxWeb.KdbxEntry): Promise<VaultItem> {
    const fields: Field[] = [];

    for (const [key, type] of Object.entries(STANDARD_FIELD_TYPES)) {
        const value = fieldValueToString(entry.fields.get(key));
        if (value) {
            fields.push(new Field({ name: $l(key), value, type }));
        }
    }

    const totpSecret = extractTotpSecret(entry.fields);
    if (totpSecret) {
        fields.push(new Field({ name: $l("One-Time Password"), value: totpSecret, type: FieldType.Totp }));
    }

    // Anything else the user added as a custom field - keep it, rather than silently
    // dropping data we don't have a dedicated mapping for. KeePass has no native "this
    // is a credit card/license" entry type, so custom fields for those are just
    // arbitrary named strings - guess a sensible Padloc field type instead of always
    // falling back to plain text.
    //
    // Padloc's own Credit pattern only matches 16+ digit runs, missing 15-digit Amex
    // numbers (and anything else off the common-card-length beaten path). A bare
    // "Number" field co-occurring with a CVV-like field is a strong, entry-level
    // signal that it's a card number regardless of digit count - much safer than
    // trusting the field name "Number" in isolation, which could mean anything.
    const looksLikeCardEntry = [...entry.fields.keys()].some((key) => /cvv|cvc|security.?code|verification/i.test(key));

    for (const [key, value] of entry.fields) {
        if (NON_EXTRA_FIELD_KEYS.has(key)) {
            continue;
        }
        const strValue = fieldValueToString(value);
        if (strValue) {
            const type =
                looksLikeCardEntry && /^number$/i.test(key.trim())
                    ? FieldType.Credit
                    : guessKdbxFieldType(key, strValue);
            fields.push(new Field({ name: key, value: strValue, type }));
        }
    }

    const name = fieldValueToString(entry.fields.get("Title")) || $l("Unnamed");
    return createVaultItem({ name, fields, tags: entry.tags });
}

/** Recursively collects every entry in the database, skipping the Recycle Bin. */
function collectEntries(group: KdbxWeb.KdbxGroup, recycleBinUuid: KdbxWeb.KdbxUuid | undefined): KdbxWeb.KdbxEntry[] {
    if (recycleBinUuid && group.uuid.equals(recycleBinUuid)) {
        return [];
    }
    return [...group.entries, ...group.groups.flatMap((subGroup) => collectEntries(subGroup, recycleBinUuid))];
}

/** Converts every non-recycled entry in a loaded KeePass database into Padloc vault items. */
export async function parseKeePassKdbxEntries(db: KdbxWeb.Kdbx): Promise<VaultItem[]> {
    const entries = db.groups.flatMap((group) => collectEntries(group, db.meta.recycleBinUuid));
    return Promise.all(entries.map(kdbxEntryToVaultItem));
}

/**
 * Loads a .kdbx file's contents (already read into an ArrayBuffer) with the
 * given master password and/or key file.
 */
export async function loadKeePassKdbx(
    data: ArrayBuffer,
    password: string,
    keyFile?: ArrayBuffer
): Promise<KdbxWeb.Kdbx> {
    const kdbxweb = await configureKdbxArgon2();
    const credentials = new kdbxweb.Credentials(kdbxweb.ProtectedValue.fromString(password), keyFile ?? null);
    return kdbxweb.Kdbx.load(data, credentials);
}
