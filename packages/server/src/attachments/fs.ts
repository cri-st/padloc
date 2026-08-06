import { join, resolve, sep } from "path";
import { readFile, writeFile, ensureDir, remove, readdir, stat } from "fs-extra";
import { Attachment, AttachmentID, AttachmentStorage } from "@padloc/core/src/attachment";
import { VaultID } from "@padloc/core/src/vault";
import { Err, ErrorCode } from "@padloc/core/src/error";
import { Config, ConfigParam } from "@padloc/core/src/config";

export class FSAttachmentStorageConfig extends Config {
    @ConfigParam()
    dir: string = "./attachments";
}

// SECURITY: `vault`/`id` are free-text, 100% client-controlled fields
// (GetAttachmentParams/DeleteAttachmentParams) that used to flow straight
// into a filesystem path via `join()`. `join()` happily resolves `..`
// segments, so a value like `id: "../../other-vault/other-attachment"`
// escaped the intended attachment directory entirely -- allowing any
// authenticated user (their own vault is enough to reach this code path)
// to read or, via `delete`/`deleteAll`, RECURSIVELY DELETE arbitrary
// files/directories reachable by the Node process. Every path segment is
// now restricted to a safe identifier shape AND the resolved path is
// verified to still be inside `config.dir` before touching the filesystem.
const SAFE_SEGMENT = /^[a-zA-Z0-9_-]+$/;

function assertSafeSegment(value: string, label: string) {
    if (typeof value !== "string" || !SAFE_SEGMENT.test(value)) {
        throw new Err(ErrorCode.BAD_REQUEST, `Invalid ${label}.`);
    }
}

export class FSAttachmentStorage implements AttachmentStorage {
    constructor(public config: FSAttachmentStorageConfig) {}

    private _getPath(vault: VaultID, id: AttachmentID) {
        assertSafeSegment(vault, "vault id");
        assertSafeSegment(id, "attachment id");

        const base = resolve(this.config.dir);
        const full = resolve(base, vault, id);

        // Defense in depth: even though assertSafeSegment already forbids
        // path separators and "..", double-check the resolved path is
        // still contained within the configured attachments directory.
        if (full !== base && !full.startsWith(base + sep)) {
            throw new Err(ErrorCode.BAD_REQUEST, "Invalid attachment path.");
        }

        return full;
    }

    async get(vault: VaultID, id: AttachmentID) {
        try {
            const data = await readFile(this._getPath(vault, id));
            const att = await new Attachment().fromBytes(data);
            return att;
        } catch (e) {
            throw new Err(ErrorCode.NOT_FOUND);
        }
    }

    async put(att: Attachment) {
        assertSafeSegment(att.vault, "vault id");
        await ensureDir(join(resolve(this.config.dir), att.vault));
        await writeFile(this._getPath(att.vault, att.id), await att.toBytes());
    }

    async delete(vault: VaultID, id: AttachmentID) {
        await remove(this._getPath(vault, id));
    }

    async deleteAll(vault: VaultID) {
        assertSafeSegment(vault, "vault id");
        await remove(join(resolve(this.config.dir), vault));
    }

    async getUsage(vault: VaultID) {
        assertSafeSegment(vault, "vault id");
        try {
            const dir = join(resolve(this.config.dir), vault);
            const files = await readdir(dir);
            let size = 0;
            for (const file of files) {
                const stats = await stat(join(dir, file));
                size += stats.size;
            }
            return size;
        } catch (e) {
            return 0;
        }
    }
}
