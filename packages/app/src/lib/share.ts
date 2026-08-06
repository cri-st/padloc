import { base64ToBytes, bytesToBase64 } from "@padloc/core/src/encoding";
import { FieldType, VaultItem } from "@padloc/core/src/item";

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
