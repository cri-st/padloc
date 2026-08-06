import { base64ToBytes, bytesToBase64 } from "@padloc/core/src/encoding";
import { Field, FieldType, VaultItem } from "@padloc/core/src/item";

/**
 * Shared parsing/serialization for a share link's URL fragment
 * (`#k=<base64url(key)>`). The AES key is generated client-side and
 * embedded only in the fragment, which browsers never send in HTTP
 * requests -- the server never sees it. Used by both the sender's
 * `share-dialog.ts` (encode, when building the link to copy) and the
 * anonymous recipient's `share-view.ts` (decode, when reading
 * `location.hash`).
 */

/** Builds the `k=<base64url(key)>` fragment payload for a share link. */
export function encodeShareKeyFragment(key: Uint8Array): string {
    return `k=${bytesToBase64(key, true)}`;
}

/**
 * Extracts and decodes the AES key from a share link's URL fragment.
 * Accepts `location.hash` verbatim (with or without the leading `#`).
 * Returns `null` if the fragment is missing, empty, or malformed --
 * callers should treat that the same as an invalid/expired link.
 */
export function decodeShareKeyFragment(hash: string): Uint8Array | null {
    const stripped = hash.replace(/^#/, "");
    if (!stripped) {
        return null;
    }

    const encoded = new URLSearchParams(stripped).get("k");
    if (!encoded) {
        return null;
    }

    try {
        const bytes = base64ToBytes(encoded);
        return bytes.length ? bytes : null;
    } catch (e) {
        return null;
    }
}

/**
 * Only Login-shaped items are shareable in v1 (Item-Type Scope
 * requirement). Enforced client-side only -- the server never sees
 * plaintext, so it cannot classify ciphertext itself. An item "looks
 * like" a Login if it carries at least one `FieldType.Password` field.
 */
export function isShareableItem(item: Pick<VaultItem, "fields">): boolean {
    return item.fields.some((field) => field.type === FieldType.Password);
}

/**
 * Field types that are NEVER offered as shareable, regardless of user
 * choice. A live TOTP secret grants ONGOING 2FA bypass for as long as
 * the recipient keeps it -- unlike a password, it isn't a one-time
 * secret, so it's excluded from the share dialog's field list entirely
 * (not shown, not selectable), rather than merely unchecked by default.
 */
const NEVER_SHAREABLE_FIELD_TYPES: FieldType[] = [FieldType.Totp];

/**
 * Field types pre-selected by default when opening the share dialog --
 * the deliberately narrow "simplest" set (username, password, url,
 * email). Any other selectable field type (Note, Pin, Text, ...) is
 * available in the dialog but starts unchecked, so the sender must
 * explicitly opt in to sharing anything beyond the basics.
 */
const DEFAULT_SHAREABLE_FIELD_TYPES: FieldType[] = [
    FieldType.Username,
    FieldType.Password,
    FieldType.Url,
    FieldType.Email,
];

/** Whether a field may ever be offered in the share dialog's field selector. */
export function isFieldShareable(field: Pick<Field, "type">): boolean {
    return !NEVER_SHAREABLE_FIELD_TYPES.includes(field.type);
}

/** Whether a field is pre-selected by default when opening the share dialog. */
export function isFieldSelectedByDefault(field: Pick<Field, "type">): boolean {
    return DEFAULT_SHAREABLE_FIELD_TYPES.includes(field.type);
}

/**
 * Computes which field indices should be pre-selected when opening the
 * share dialog: only the FIRST field of each default-shareable type
 * (Username, Password, Url, Email) -- matching an item's actual core
 * Login template fields. Any LATER field that happens to share one of
 * those types (e.g. a second Url-typed field a user repurposed for
 * something else, like backup codes, or an importer mis-typed) is left
 * unchecked: it stays fully selectable in the dialog, it's just not
 * assumed safe by default merely because its `type` matches.
 */
export function computeDefaultSelectedFieldIndices(fields: Field[]): Set<number> {
    const claimedTypes = new Set<FieldType>();
    const selected = new Set<number>();

    fields.forEach((field, index) => {
        if (!isFieldShareable(field) || !isFieldSelectedByDefault(field) || claimedTypes.has(field.type)) {
            return;
        }
        claimedTypes.add(field.type);
        selected.add(index);
    });

    return selected;
}

/**
 * Builds the minimal item that actually gets encrypted and shared -- a
 * FRESH `VaultItem` containing only `name` and the caller-selected
 * fields. Deliberately never a copy or mutation of the source item, so
 * structural properties that must never be shareable (`passkeys`,
 * `history`, `attachments`, `tags`, `id`) are structurally impossible to
 * include, not merely filtered out.
 */
export function buildShareableItem(name: string, selectedFields: Field[]): VaultItem {
    return new VaultItem({ name, fields: selectedFields });
}
