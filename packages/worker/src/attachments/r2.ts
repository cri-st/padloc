import { Attachment, AttachmentID, AttachmentStorage } from "@padloc/core/src/attachment";
import { VaultID } from "@padloc/core/src/vault";
import { Err, ErrorCode } from "@padloc/core/src/error";

// SECURITY: never surface a raw driver/SDK error message to the HTTP
// client (D1/R2 errors can contain table/column names, SQLITE_*/R2 error
// codes, and other internal structure). Callers pass the real detail as
// `error:` (Err.originalError) so it still reaches operators via
// `report: true` -> captureHqException, without ever reaching the response
// body sent back to the caller.
function toError(value: unknown): Error {
    return value instanceof Error ? value : new Error(String(value));
}

export const MAX_ATTACHMENT_SIZE = 25 * 1024 * 1024;
export const SIGNED_URL_THRESHOLD = 5 * 1024 * 1024;
export const SIGNED_URL_TTL_MS = 15 * 60 * 1000;

const KEY_PREFIX = "att";

function r2Key(vaultId: VaultID, attachmentId: AttachmentID): string {
    return `${KEY_PREFIX}/${vaultId}/${attachmentId}`;
}

interface AttachmentMeta {
    id: string;
    vault_id: string;
    owner_account_id: string;
    r2_key: string;
    size_bytes: number;
    hash: string;
    created_at: string;
}

export interface R2AttachmentStorageConfig {
    bucket: R2Bucket;
    db: D1Database;
}

async function recordOrphan(db: D1Database, r2Key: string, reason: string): Promise<void> {
    await db
        .prepare(`INSERT OR IGNORE INTO orphan_log (r2_key, orphaned_at, reason) VALUES (?, ?, ?)`)
        .bind(r2Key, Date.now(), reason)
        .run();
}

export class R2AttachmentStorage implements AttachmentStorage {
    constructor(private config: R2AttachmentStorageConfig) {}

    private get bucket(): R2Bucket {
        return this.config.bucket;
    }

    private get db(): D1Database {
        return this.config.db;
    }

    async put(att: Attachment, ownerAccountId?: string): Promise<void> {
        if (att.size > MAX_ATTACHMENT_SIZE) {
            throw new Err(ErrorCode.BAD_REQUEST, `Attachment size ${att.size} exceeds maximum ${MAX_ATTACHMENT_SIZE}`);
        }

        const key = r2Key(att.vault, att.id);
        const bytes = att.toBytes();
        const hashHex = await sha256Hex(bytes);

        // SECURITY: persist the REAL uploaded byte length, not the
        // client-declared `att.size`. `getUsage()`/quota enforcement in
        // core/server.ts sums this column, so trusting the declared value
        // let a client report `size: 1` while uploading up to
        // MAX_ATTACHMENT_SIZE of real data, silently exhausting R2 storage
        // without ever tripping the quota check.
        if (bytes.length > MAX_ATTACHMENT_SIZE) {
            throw new Err(
                ErrorCode.BAD_REQUEST,
                `Attachment size ${bytes.length} exceeds maximum ${MAX_ATTACHMENT_SIZE}`
            );
        }

        await this.db
            .prepare(
                `INSERT INTO attachments (id, vault_id, owner_account_id, r2_key, size_bytes, hash, created_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?)`
            )
            .bind(att.id, att.vault, ownerAccountId || "", key, bytes.length, hashHex, new Date().toISOString())
            .run();

        try {
            await this.bucket.put(key, bytes, {
                httpMetadata: {
                    contentType: att.type || "application/octet-stream",
                },
                customMetadata: {
                    hash: hashHex,
                },
            });
        } catch (r2Err) {
            for (let attempt = 1; attempt <= 3; attempt++) {
                try {
                    await this.db.prepare(`DELETE FROM attachments WHERE id = ?`).bind(att.id).run();
                    break;
                } catch (rollbackErr) {
                    if (attempt === 3) {
                        await recordOrphan(this.db, key, "put_rollback_failed");
                        // SECURITY: never surface the raw driver error text to
                        // the HTTP client (it can contain table/column names,
                        // SQLITE_*/R2 error codes, internal structure). The
                        // real detail still reaches operators via `report:
                        // true` + `originalError` -> captureHqException.
                        throw new Err(ErrorCode.SERVER_ERROR, "Attachment upload failed. Please try again.", {
                            report: true,
                            error: toError(r2Err),
                        });
                    }
                }
            }
            throw new Err(ErrorCode.SERVER_ERROR, "Attachment upload failed. Please try again.", {
                report: true,
                error: toError(r2Err),
            });
        }
    }

    async get(vault: VaultID, id: AttachmentID): Promise<Attachment> {
        const row = await this.db
            .prepare(`SELECT * FROM attachments WHERE id = ? AND vault_id = ?`)
            .bind(id, vault)
            .first<AttachmentMeta>();

        if (!row) {
            throw new Err(ErrorCode.NOT_FOUND, `Attachment not found: ${id}`);
        }

        const object = await this.bucket.get(row.r2_key);
        if (!object) {
            throw new Err(ErrorCode.NOT_FOUND, `Attachment object not found in R2: ${row.r2_key}`);
        }

        const bytes = await object.arrayBuffer();
        const att = new Attachment().fromBytes(new Uint8Array(bytes));

        const computedHash = await sha256Hex(new Uint8Array(bytes));
        if (computedHash !== row.hash) {
            throw new Err(ErrorCode.SERVER_ERROR, "Attachment hash mismatch — possible corruption");
        }

        return att;
    }

    async delete(vault: VaultID, id: AttachmentID): Promise<void> {
        const row = await this.db
            .prepare(`SELECT r2_key FROM attachments WHERE id = ? AND vault_id = ?`)
            .bind(id, vault)
            .first<{ r2_key: string }>();

        if (!row) {
            return;
        }

        const key = row.r2_key;

        try {
            await this.bucket.delete(key);
        } catch (r2Err) {
            throw new Err(ErrorCode.SERVER_ERROR, "Attachment delete failed. Please try again.", {
                report: true,
                error: toError(r2Err),
            });
        }

        try {
            await this.db.prepare(`DELETE FROM attachments WHERE id = ? AND vault_id = ?`).bind(id, vault).run();
        } catch (d1Err) {
            await recordOrphan(this.db, key, "delete_d1_failed");
            throw new Err(ErrorCode.SERVER_ERROR, "Attachment delete failed. Please try again.", {
                report: true,
                error: toError(d1Err),
            });
        }
    }

    async deleteAll(vault: VaultID): Promise<void> {
        const prefix = `${KEY_PREFIX}/${vault}/`;
        const listed = await this.bucket.list({ prefix });
        const keys = listed.objects.map((o) => o.key);

        if (keys.length > 0) {
            try {
                await Promise.all(keys.map((key) => this.bucket.delete(key)));
            } catch (r2Err) {
                throw new Err(ErrorCode.SERVER_ERROR, "Attachment delete failed. Please try again.", {
                    report: true,
                    error: toError(r2Err),
                });
            }
        }

        try {
            await this.db.prepare(`DELETE FROM attachments WHERE vault_id = ?`).bind(vault).run();
        } catch (d1Err) {
            for (const key of keys) {
                await recordOrphan(this.db, key, "delete_all_d1_failed");
            }
            throw new Err(ErrorCode.SERVER_ERROR, "Attachment delete failed. Please try again.", {
                report: true,
                error: toError(d1Err),
            });
        }
    }

    async getUsage(vault: VaultID): Promise<number> {
        const result = await this.db
            .prepare(`SELECT COALESCE(SUM(size_bytes), 0) as total FROM attachments WHERE vault_id = ?`)
            .bind(vault)
            .first<{ total: number }>();

        return result?.total ?? 0;
    }

    // SECURITY: NOT CURRENTLY WIRED UP -- no RPC method in
    // packages/core/src/server.ts calls createUploadUrl/confirmUpload/
    // createDownloadUrl/verify today (grep confirms zero callers), so this
    // signed-URL flow is dead code. Before wiring it to a real endpoint,
    // close these two KNOWN, UNFIXED gaps (flagged in review, deliberately
    // left open rather than silently claimed as fixed):
    //
    // 1. TTL reuse / stale size_bytes: the presigned PUT URL stays valid
    //    for SIGNED_URL_TTL_MS (15 min) AFTER confirmUpload() has already
    //    recorded the (correct, head()-verified) size. Nothing stops the
    //    client from PUTting a DIFFERENT, LARGER object to the same signed
    //    URL again before it expires -- R2 accepts the overwrite directly,
    //    entirely bypassing this Worker, so size_bytes in D1 goes stale
    //    and understates real usage. This is a structural limitation of
    //    presigned uploads, not something a single check here can close;
    //    fixing it needs either a much shorter TTL, a one-time-use token
    //    scheme, or a periodic reconciliation job that re-heads() stored
    //    objects and corrects drifted size_bytes.
    // 2. Unverified hash: confirmUpload() persists the client-declared
    //    `hash` verbatim -- it is NEVER checked against the real object
    //    content (unlike `verify()` below, which downloads and hashes the
    //    whole object, an expense the signed-URL/large-file path exists
    //    specifically to avoid). A caller can claim any hash for any
    //    upload; treat `attachments.hash` for signed-URL uploads as
    //    advisory/client-asserted, not integrity-verified, until this is
    //    addressed.
    async createUploadUrl(
        vault: VaultID,
        id: AttachmentID,
        size: number,
        contentType: string
    ): Promise<{ uploadUrl: string; r2Key: string }> {
        if (size > MAX_ATTACHMENT_SIZE) {
            throw new Err(ErrorCode.BAD_REQUEST, `Attachment size ${size} exceeds maximum ${MAX_ATTACHMENT_SIZE}`);
        }

        const key = r2Key(vault, id);

        const uploadUrl = (this.bucket as unknown as { createSignedUrl: (opts: object) => string }).createSignedUrl({
            key,
            method: "PUT",
            expiresIn: SIGNED_URL_TTL_MS,
            httpMetadata: { contentType },
        });

        return { uploadUrl, r2Key: key };
    }

    async confirmUpload(
        vault: VaultID,
        id: AttachmentID,
        _size: number,
        hash: string,
        ownerAccountId: string,
        _contentType: string
    ): Promise<void> {
        const key = r2Key(vault, id);

        // SECURITY: `_size` (like `_contentType`) is 100% client-declared --
        // the whole point of the signed-URL flow is that the actual bytes
        // go straight from the client to R2, bypassing this Worker. This
        // method used to trust it verbatim, which is the EXACT same quota
        // bypass as the small-file `put()` path had (see the fix there):
        // a caller could report `size: 1` while a much larger object sits
        // in R2, defeating `getUsage()`-based quota enforcement. R2's
        // `head()` returns the REAL, authoritative object size -- persist
        // THAT, never the client-declared value, and require the object to
        // actually exist before recording it.
        const object = await this.bucket.head(key);
        if (!object) {
            throw new Err(ErrorCode.NOT_FOUND, "Uploaded object not found. Please retry the upload.");
        }

        if (object.size > MAX_ATTACHMENT_SIZE) {
            await this.bucket.delete(key);
            throw new Err(
                ErrorCode.BAD_REQUEST,
                `Attachment size ${object.size} exceeds maximum ${MAX_ATTACHMENT_SIZE}`
            );
        }

        try {
            await this.db
                .prepare(
                    `INSERT INTO attachments (id, vault_id, owner_account_id, r2_key, size_bytes, hash, created_at)
                     VALUES (?, ?, ?, ?, ?, ?, ?)`
                )
                .bind(id, vault, ownerAccountId, key, object.size, hash, new Date().toISOString())
                .run();
        } catch (d1Err) {
            await recordOrphan(this.db, key, "confirm_d1_failed");
            throw new Err(ErrorCode.SERVER_ERROR, "Attachment upload confirmation failed. Please try again.", {
                report: true,
                error: toError(d1Err),
            });
        }
    }

    async createDownloadUrl(vault: VaultID, id: AttachmentID): Promise<string> {
        const row = await this.db
            .prepare(`SELECT r2_key FROM attachments WHERE id = ? AND vault_id = ?`)
            .bind(id, vault)
            .first<{ r2_key: string }>();

        if (!row) {
            throw new Err(ErrorCode.NOT_FOUND, `Attachment not found: ${id}`);
        }

        const downloadUrl = (this.bucket as unknown as { createSignedUrl: (opts: object) => string }).createSignedUrl({
            key: row.r2_key,
            method: "GET",
            expiresIn: SIGNED_URL_TTL_MS,
        });

        return downloadUrl;
    }

    async verify(vault: VaultID, id: AttachmentID): Promise<boolean> {
        const row = await this.db
            .prepare(`SELECT hash FROM attachments WHERE id = ? AND vault_id = ?`)
            .bind(id, vault)
            .first<{ hash: string }>();

        if (!row) {
            throw new Err(ErrorCode.NOT_FOUND, `Attachment not found: ${id}`);
        }

        const object = await this.bucket.get(r2Key(vault, id));
        if (!object) {
            throw new Err(ErrorCode.NOT_FOUND, `R2 object missing for ${id}`);
        }

        const metaHash = object.customMetadata?.hash as string | undefined;
        if (metaHash && metaHash === row.hash) {
            return true;
        }

        const bytes = await object.arrayBuffer();
        const computed = await sha256Hex(new Uint8Array(bytes));
        return computed === row.hash;
    }
}

async function sha256Hex(input: Uint8Array | ArrayBuffer): Promise<string> {
    const buffer = input instanceof ArrayBuffer ? input : input.buffer;
    const digest = await crypto.subtle.digest("SHA-256", buffer as ArrayBuffer);
    const buf = new Uint8Array(digest);
    return Array.from(buf)
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
}
