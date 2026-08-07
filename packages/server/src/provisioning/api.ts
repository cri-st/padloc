import {
    AccountQuota,
    BasicProvisioner,
    BasicProvisionerConfig,
    Provisioning,
    ProvisioningStatus,
} from "@padloc/core/src/provisioning";
import { getIdFromEmail } from "@padloc/core/src/util";
import { Storage } from "@padloc/core/src/storage";
import { ErrorCode } from "@padloc/core/src/error";
import { Config, ConfigParam } from "@padloc/core/src/config";
import { createServer, IncomingMessage, ServerResponse } from "http";
import { readBody } from "../transport/http";
import { getCryptoProvider } from "@padloc/core/src/platform";
import { stringToBytes } from "@padloc/core/src/encoding";
import { AccountID } from "@padloc/core/src/account";

export class DefaultAccountQuota extends Config implements AccountQuota {
    @ConfigParam("number")
    vaults = 1;

    @ConfigParam("number")
    storage = 1000;
}

export class ApiProvisionerConfig extends BasicProvisionerConfig {
    @ConfigParam("number")
    port: number = 4000;

    @ConfigParam("string", true)
    apiKey?: string;
}

interface ProvisioningUpdate {
    email: string;

    status: ProvisioningStatus;

    statusLabel: string;

    statusMessage: string;

    actionUrl?: string;

    actionLabel?: string;

    scheduled?: ScheduledProvisioningUpdate[];

    metaData?: { [prop: string]: string };
}

interface ScheduledProvisioningUpdate extends ProvisioningUpdate {
    time: number;
}

interface ProvisioningRequest {
    default: ProvisioningUpdate;
    updates: ProvisioningUpdate[];
}

// SECURITY: mirrors `core/util.ts`'s `setPath` FORBIDDEN_PATH_SEGMENTS
// guard. `vals` here traces back to fully client-controlled JSON request
// bodies (`ApiProvisioner._handleUpdateRequest`'s `defaultProv`, parsed
// straight from an authenticated but still untrusted HTTP request).
// `Object.assign(this, vals)` with a "__proto__" key invokes the
// inherited accessor setter and reassigns THIS instance's own prototype
// (e.g. to `null`, breaking every inherited method including the
// `toRaw()` serialization this entry needs to be persisted); a
// "constructor"/"prototype" key overwrite stages further gadget attacks.
// Filtering these keys before assigning closes the same bug class
// `setPath` already guards against for SCIM PATCH.
// A plain array (not a `Record`/object-literal lookup) is used
// deliberately: an object literal with a `__proto__` key does NOT create
// an own "__proto__" property at all -- it sets the object's actual
// prototype instead, silently dropping the intended membership check.
const FORBIDDEN_ASSIGN_KEYS = ["__proto__", "constructor", "prototype"];

export class ProvisioningEntry extends Provisioning {
    constructor(vals: Partial<ProvisioningEntry> = {}) {
        super();
        const target = this as Record<string, unknown>;
        for (const [key, value] of Object.entries(vals)) {
            if (!FORBIDDEN_ASSIGN_KEYS.includes(key)) {
                target[key] = value;
            }
        }
    }

    id: string = "";

    scheduledUpdates: ScheduledProvisioningUpdate[] = [];

    metaData?: any = undefined;
}

export class ApiProvisioner extends BasicProvisioner {
    constructor(public readonly config: ApiProvisionerConfig, public readonly storage: Storage) {
        super(storage, config);
    }

    protected async _getProvisioningEntry({ email, accountId }: { email: string; accountId?: string | undefined }) {
        const id = await getIdFromEmail(email);

        try {
            const entry = await this.storage.get(ProvisioningEntry, id);
            entry.scheduledUpdates.sort((a, b) => new Date(a.time).getTime() - new Date(b.time).getTime());
            const dueUpdate = entry.scheduledUpdates.filter((u) => new Date(u.time) <= new Date()).pop();
            if (dueUpdate) {
                this._applyUpdate(entry, dueUpdate);
                entry.scheduledUpdates = entry.scheduledUpdates.filter((u) => new Date(u.time) > new Date());
                await this.storage.save(entry);
            }
            return entry;
        } catch (e) {
            if (e.code !== ErrorCode.NOT_FOUND) {
                throw e;
            }
        }

        const account = await this._getDefaultAccountProvisioning();
        account.id = id;
        (account.email = email), (account.accountId = accountId);

        const provisioning = new ProvisioningEntry({
            id,
            account,
        });

        return provisioning;
    }

    async getProvisioning({ email, accountId }: { email: string; accountId?: AccountID }) {
        return this._getProvisioningEntry({ email, accountId });
    }

    async accountDeleted({ email }: { email: string; accountId?: string }): Promise<void> {
        const id = await getIdFromEmail(email);
        try {
            const provisioning = await this.storage.get(ProvisioningEntry, id);
            if (provisioning) {
                provisioning.account.status = ProvisioningStatus.Deleted;
            }
            await this.storage.save(provisioning);
        } catch (e) {
            if (e.code !== ErrorCode.NOT_FOUND) {
                throw e;
            }
        }
    }

    async init() {
        return this._startServer();
    }

    private _applyUpdate(entry: ProvisioningEntry, update: ProvisioningUpdate) {
        entry.account.status = update.status;
        entry.account.statusLabel = update.statusLabel;
        entry.account.statusMessage = update.statusMessage;
        entry.account.actionUrl = update.actionUrl || this.config.default.actionUrl;
        entry.account.actionLabel = update.actionLabel || this.config.default.actionLabel;
        entry.metaData = update.metaData;
    }

    private async _handleUpdateRequest({ default: defaultProv, updates = [] }: ProvisioningRequest) {
        if (defaultProv) {
            const entry = new ProvisioningEntry(defaultProv);
            entry.id = "[default]";
            await this.storage.save(entry);
        }

        for (const update of updates) {
            const entry = (await this._getProvisioningEntry({ email: update.email })) as ProvisioningEntry;
            this._applyUpdate(entry, update);
            entry.scheduledUpdates = update.scheduled || [];
            await this.storage.save(entry);
        }
    }

    private _validateUpdate(update: ProvisioningUpdate) {
        const validStatuses = Object.values(ProvisioningStatus);

        if (!validStatuses.includes(update.status)) {
            return `'updates.status' parameter must be one of ${validStatuses.map((s) => `"${s}"`).join(", ")}`;
        }

        if (typeof update.statusLabel !== "string") {
            return "'updates.statusLabel' parameter must be a string";
        }

        if (typeof update.statusMessage !== "string") {
            return "'updates.statusMessage' parameter must be a string";
        }

        if (typeof update.scheduled !== "undefined" && !Array.isArray(update.scheduled)) {
            return "'updates.scheduled' parameter must be an array!";
        }

        if (typeof update.actionUrl !== "undefined" && typeof update.actionUrl !== "string") {
            return "'updates.actionUrl' parameter must be a string";
        }

        if (update.actionUrl && !update.actionLabel) {
            return "If 'updates.actionUrl' is provided, 'updates.actionLabel' must be provided as well.";
        }

        if (typeof update.actionLabel !== "undefined" && typeof update.actionLabel !== "string") {
            return "'updates.actionLabel' parameter must be a string";
        }

        return null;
    }

    private _validate(request: any): string | null {
        if (!request.updates && !request.default) {
            return "Request must contain either 'updates' or 'default' parameter";
        }

        if (request.default) {
            const err = this._validateUpdate(request.default);
            if (err) {
                return err;
            }
        }

        if (request.updates && !Array.isArray(request.updates)) {
            return "'update' parameter should be an Array";
        }

        for (const update of request.updates || []) {
            if (!update.email || typeof update.email !== "string") {
                return "'updates.email' parameter must be a non-empty string";
            }

            const error = this._validateUpdate(update);
            if (error) {
                return error;
            }

            if (update.scheduled) {
                if (!Array.isArray(update.scheduled)) {
                    return "'updates.scheduled' must be an array";
                }

                for (const scheduled of update.scheduled) {
                    const ts = new Date(scheduled.time).getTime();

                    if (isNaN(ts) || ts < Date.now()) {
                        return "'scheduled.time' must be a valid time in the future!";
                    }

                    const error = this._validateUpdate(scheduled);
                    if (error) {
                        return error;
                    }
                }
            }
        }

        return null;
    }

    protected async _handlePost(httpReq: IncomingMessage, httpRes: ServerResponse) {
        let request: ProvisioningRequest;

        try {
            const body = await readBody(httpReq);
            request = JSON.parse(body);
        } catch (e) {
            httpRes.statusCode = 400;
            httpRes.end("Failed to read request body.");
            return;
        }

        const validationError = this._validate(request);
        if (validationError) {
            httpRes.statusCode = 400;
            httpRes.end(validationError);
            return;
        }

        try {
            await this._handleUpdateRequest(request);
        } catch (e) {
            httpRes.statusCode = 500;
            httpRes.end("Unexpected Error");
            return;
        }

        httpRes.statusCode = 200;
        httpRes.end();
    }

    protected async _handleGet(httpReq: IncomingMessage, httpRes: ServerResponse) {
        const email = new URL(httpReq.url!, "http://localhost").searchParams.get("email");

        if (!email) {
            httpRes.statusCode = 400;
            httpRes.end("Missing parameter: 'email'");
            return;
        }

        let entry: ProvisioningEntry;

        try {
            const id = await getIdFromEmail(email);
            entry = await this.storage.get(ProvisioningEntry, id);
        } catch (e) {
            if (e.code === ErrorCode.NOT_FOUND) {
                httpRes.statusCode = 404;
                httpRes.end();
                return;
            } else {
                throw e;
            }
        }

        const { accountId, status, statusLabel, statusMessage, actionUrl, actionLabel, scheduledUpdates, metaData } =
            entry.toRaw();

        httpRes.statusCode = 200;
        httpRes.end(
            JSON.stringify(
                {
                    accountId,
                    status,
                    statusLabel,
                    statusMessage,
                    actionUrl,
                    actionLabel,
                    scheduledUpdates,
                    metaData,
                },
                null,
                4
            )
        );
    }

    protected async _handleRequest(httpReq: IncomingMessage, httpRes: ServerResponse) {
        // SECURITY: previously (a) auth was skipped ENTIRELY if `apiKey`
        // wasn't configured -- an insecure-by-default open door for this
        // provisioner's POST (arbitrarily set any account's
        // status/statusLabel/actionUrl/metaData by email) and GET (dump
        // any account's provisioning status by email) endpoints -- and (b)
        // the comparison was a plain `!==`, not constant-time, unlike
        // every other secret-token check in this codebase (SCIM,
        // WebAuthn). Both fixed: fail closed when unconfigured, and use
        // `timingSafeEqual` like scim.ts does.
        if (!this.config.apiKey) {
            httpRes.statusCode = 401;
            httpRes.end();
            return;
        }
        let authHeader = httpReq.headers["authorization"];
        authHeader = Array.isArray(authHeader) ? authHeader[0] : authHeader;
        const apiKeyMatch = authHeader?.match(/^Bearer (.+)$/);
        const providedKey = apiKeyMatch?.[1];
        const authorized =
            !!providedKey &&
            (await getCryptoProvider().timingSafeEqual(
                stringToBytes(this.config.apiKey),
                stringToBytes(providedKey)
            ));
        if (!authorized) {
            httpRes.statusCode = 401;
            httpRes.end();
            return;
        }

        switch (httpReq.method) {
            case "POST":
                return this._handlePost(httpReq, httpRes);
            case "GET":
                return this._handleGet(httpReq, httpRes);
            default:
                httpRes.statusCode = 405;
                httpRes.end();
        }
    }

    private async _startServer() {
        const server = createServer((req, res) => this._handleRequest(req, res));

        server.listen(this.config.port);
    }
}
