/**
 * DurableObjectShareStorage -- wraps the `SHARE_LINKS` Durable Object
 * namespace behind `@padloc/core`'s platform-agnostic `ShareStorage`
 * interface (mirrors how `R2AttachmentStorage` implements
 * `AttachmentStorage`). Translates core `Serializable` values to/from the
 * plain, opaque payloads `ShareLinkDO` stores -- the DO itself never
 * imports `@padloc/core`.
 */
import { AccountID } from "@padloc/core/src/account";
import { AESEncryptionParams } from "@padloc/core/src/crypto";
import { CreateShareParams, ShareData, ShareID, ShareStatus, ShareStorage } from "@padloc/core/src/share";
import { CreateShareInput, ShareLinkStub } from "../durable-objects/share-link";

export class DurableObjectShareStorage implements ShareStorage {
    constructor(private namespace: DurableObjectNamespace) {}

    private _stub(id: ShareID): ShareLinkStub {
        return this.namespace.get(this.namespace.idFromName(id)) as unknown as ShareLinkStub;
    }

    async create(id: ShareID, owner: AccountID, data: CreateShareParams): Promise<void> {
        const input: CreateShareInput = {
            owner,
            encryptedData: data.encryptedData,
            encryptionParamsJson: JSON.stringify(data.encryptionParams.toRaw()),
            ttlSeconds: data.ttlSeconds,
        };
        await this._stub(id).create(input);
    }

    async peek(id: ShareID): Promise<{ expired: boolean; viewed: boolean } | null> {
        return this._stub(id).peek();
    }

    async reveal(id: ShareID): Promise<ShareData | null> {
        const result = await this._stub(id).reveal();
        if (!result) {
            return null;
        }

        const encryptionParams = new AESEncryptionParams().fromRaw(JSON.parse(result.encryptionParamsJson));

        return new ShareData({ encryptedData: result.encryptedData, encryptionParams });
    }

    async getStatus(id: ShareID, owner: AccountID): Promise<ShareStatus | null> {
        const result = await this._stub(id).getStatus(owner);
        if (!result) {
            return null;
        }

        return new ShareStatus({
            expired: result.expired,
            viewed: result.viewed,
            viewedAt: result.viewedAt === null ? undefined : new Date(result.viewedAt),
            revoked: result.revoked,
        });
    }

    async revoke(id: ShareID, owner: AccountID): Promise<boolean> {
        return this._stub(id).revoke(owner);
    }
}
