import { AsBytes, AsDate, AsSerializable, Serializable } from "./encoding";
import { AESEncryptionParams } from "./crypto";
import { AccountID } from "./account";

/** Unique identifier for a one-time, expiring password share link. */
export type ShareID = string;

/**
 * RPC methods on the password-share-links surface that are intentionally
 * callable WITHOUT a session -- the whole point of a share link is that the
 * recipient never logs in. Both the client (never attach auth) and the
 * server (never process/persist auth even if some client attaches it
 * anyway) MUST treat these methods as identity-free. Security-relevant:
 * see the `share-password` change's security-review follow-up -- an
 * earlier version silently deanonymized a logged-in sender who opened
 * their own share link in the same browser tab, and persisted their
 * session's lastUsed/lastLocation as a side effect of the "anonymous"
 * view.
 */
export const ANONYMOUS_SHARE_METHODS: ReadonlySet<string> = new Set(["peekShare", "revealShare"]);

/**
 * Parameters for creating a new one-time share link. The client encrypts the
 * shared item locally (via [[SimpleContainer]]) and uploads only ciphertext
 * -- the server never sees the encryption key or plaintext.
 */
export class CreateShareParams extends Serializable {
    constructor(vals: Partial<CreateShareParams> = {}) {
        super();
        Object.assign(this, vals);
    }

    /** Ciphertext of the shared item. */
    @AsBytes()
    encryptedData!: Uint8Array;

    /** Encryption parameters used to produce [[encryptedData]]. */
    @AsSerializable(AESEncryptionParams)
    encryptionParams: AESEncryptionParams = new AESEncryptionParams();

    /**
     * Requested time-to-live, in seconds. The server MUST reject values
     * above `ServerConfig.shareLinkMaxTtlSeconds`.
     */
    ttlSeconds: number = 0;
}

/** Info returned to the sender immediately after creating a share link. */
export class ShareLinkInfo extends Serializable {
    constructor(vals: Partial<ShareLinkInfo> = {}) {
        super();
        Object.assign(this, vals);
    }

    id: ShareID = "";

    @AsDate()
    expiresAt: Date = new Date();
}

/** Ciphertext + params returned to an anonymous recipient on reveal. */
export class ShareData extends Serializable {
    constructor(vals: Partial<ShareData> = {}) {
        super();
        Object.assign(this, vals);
    }

    @AsBytes()
    encryptedData!: Uint8Array;

    @AsSerializable(AESEncryptionParams)
    encryptionParams: AESEncryptionParams = new AESEncryptionParams();
}

/**
 * Lifecycle status of a share link, as seen by its owner (via [[getStatus]])
 * or a prospective anonymous viewer (via [[peek]]). Never carries identity
 * or content -- only booleans and a view timestamp.
 */
export class ShareStatus extends Serializable {
    constructor(vals: Partial<ShareStatus> = {}) {
        super();
        Object.assign(this, vals);
    }

    expired: boolean = false;

    viewed: boolean = false;

    @AsDate()
    viewedAt?: Date;

    revoked: boolean = false;
}

/**
 * Storage interface for share link state. Kept platform-agnostic -- like
 * [[AttachmentStorage]], concrete implementations (e.g. a Durable-Object-
 * backed store) live in the hosting package and are injected into
 * [[Server]], rather than imported directly here.
 */
export interface ShareStorage {
    /** Persists a newly created share. Implementations MUST enforce a single allowed view. */
    create(id: ShareID, owner: AccountID, data: CreateShareParams): Promise<void>;

    /** Non-destructive lookup used for anonymous page loads. MUST NOT burn the view. */
    peek(id: ShareID): Promise<{ expired: boolean; viewed: boolean } | null>;

    /** Atomically flips the share to "viewed" and returns its ciphertext exactly once. */
    reveal(id: ShareID): Promise<ShareData | null>;

    /** Owner-facing status lookup, including the view receipt. */
    getStatus(id: ShareID, owner: AccountID): Promise<ShareStatus | null>;

    /** Revokes an unviewed share. Returns `false` if there was nothing to revoke. */
    revoke(id: ShareID, owner: AccountID): Promise<boolean>;
}
