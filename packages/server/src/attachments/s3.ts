import { Attachment, AttachmentID, AttachmentStorage } from "@padloc/core/src/attachment";
import { VaultID } from "@padloc/core/src/vault";
import {
    DeleteObjectCommand,
    DeleteObjectsCommand,
    GetObjectCommand,
    ListObjectsCommand,
    ObjectIdentifier,
    PutObjectCommand,
    S3Client,
} from "@aws-sdk/client-s3";
import { Readable } from "stream";
import { Config, ConfigParam } from "@padloc/core/src/config";
import { Err, ErrorCode } from "@padloc/core/src/error";

// SECURITY: `vault`/`id` are free-text, client-influenced fields (mirrors
// the fs.ts attachment backend's hardening -- see that file's
// SAFE_SEGMENT comment for the filesystem-traversal variant of this
// issue). S3 has no real directory traversal since Key is just a flat
// string, but an unrestricted `vault` value still lets a caller build an
// S3 Key/Prefix that reaches into another vault's object space, or,
// worse, an empty/overly-broad `vault` value passed to `deleteAll`'s
// Prefix would bulk-delete far more objects than intended (Prefix: ""
// matches the ENTIRE bucket). Restricting every segment to a safe
// identifier shape before it reaches the S3 client closes both.
const SAFE_SEGMENT = /^[a-zA-Z0-9_-]+$/;

function assertSafeSegment(value: string, label: string) {
    if (typeof value !== "string" || !SAFE_SEGMENT.test(value)) {
        throw new Err(ErrorCode.BAD_REQUEST, `Invalid ${label}.`);
    }
}

function streamToBytes(stream: Readable): Promise<Uint8Array> {
    return new Promise<Uint8Array>((resolve, reject) => {
        const chunks: any[] = [];
        stream.on("data", (chunk) => chunks.push(chunk));
        stream.on("error", reject);
        stream.on("end", () => resolve(new Uint8Array(Buffer.concat(chunks))));
    });
}

export class S3AttachmentStorageConfig extends Config {
    @ConfigParam()
    region!: string;

    @ConfigParam()
    bucket!: string;

    @ConfigParam()
    endpoint!: string;

    @ConfigParam()
    accessKeyId!: string;

    @ConfigParam("string", true)
    secretAccessKey!: string;
}

export class S3AttachmentStorage implements AttachmentStorage {
    private _client: S3Client;

    constructor(public config: S3AttachmentStorageConfig) {
        this._client = new S3Client({
            region: this.config.region,
            endpoint: this.config.endpoint,
            credentials: {
                accessKeyId: this.config.accessKeyId,
                secretAccessKey: this.config.secretAccessKey,
            },
        });
    }

    async get(vault: VaultID, id: AttachmentID) {
        assertSafeSegment(vault, "vault id");
        assertSafeSegment(id, "attachment id");
        const obj = await this._client.send(
            new GetObjectCommand({
                Bucket: this.config.bucket,
                Key: `${vault}/${id}`,
            })
        );

        const bytes = await streamToBytes(obj.Body as Readable);
        return new Attachment().fromBytes(bytes);
    }

    async put(att: Attachment) {
        assertSafeSegment(att.vault, "vault id");
        assertSafeSegment(att.id, "attachment id");
        await this._client.send(
            new PutObjectCommand({
                Bucket: this.config.bucket,
                Key: `${att.vault}/${att.id}`,
                Body: att.toBytes(),
            })
        );
    }

    async delete(vault: VaultID, id: AttachmentID) {
        assertSafeSegment(vault, "vault id");
        assertSafeSegment(id, "attachment id");
        await this._client.send(
            new DeleteObjectCommand({
                Bucket: this.config.bucket,
                Key: `${vault}/${id}`,
            })
        );
    }

    async deleteAll(vault: VaultID) {
        assertSafeSegment(vault, "vault id");
        const list = await this._client.send(
            new ListObjectsCommand({
                Bucket: this.config.bucket,
                Prefix: vault,
            })
        );
        if (!list.Contents) {
            return;
        }
        await this._client.send(
            new DeleteObjectsCommand({
                Bucket: this.config.bucket,
                Delete: { Objects: list.Contents as ObjectIdentifier[] },
            })
        );
    }

    async getUsage(vault: VaultID): Promise<number> {
        assertSafeSegment(vault, "vault id");
        const list = await this._client.send(
            new ListObjectsCommand({
                Bucket: this.config.bucket,
                Prefix: vault,
            })
        );
        return list.Contents?.reduce((total, entry) => total + (entry.Size || 0), 0) || 0;
    }
}
