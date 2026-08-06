import { Config, ConfigParam } from "@padloc/core/src/config";
import { LogEvent, Logger, LoggerListOptions } from "@padloc/core/src/logging";
import { Context } from "@padloc/core/src/server";
import { Mixpanel, init } from "mixpanel";

export class MixpanelConfig extends Config {
    @ConfigParam()
    token!: string;

    @ConfigParam("string[]")
    excludeEvents?: string[];
}

// SECURITY: `log()` below used to spread the ENTIRE caller-supplied `data`
// bag (plus account/provisioning/session context) into the Mixpanel
// payload with only "kind"/"version" excluded -- any field a future
// `this.log("some.event", {...})` call anywhere in the codebase adds
// automatically gets sent to this third party unless it happens to match
// one of those two names. Redact by field-name pattern (applied to the
// FLATTENED, dot-joined keys, so nested fields are covered too) instead
// of trusting every current and future caller to remember to exclude
// sensitive data manually.
const MIXPANEL_SENSITIVE_FIELD_PATTERN =
    /(password|passphrase|\bsecret\b|verifier|private.?key|signing.?key|hmac.?key|encryption.?key|session.?key|^key$|aes.?key|rsa.?key|\biv\b|nonce|encrypted|ciphertext|vault(data)?$|auth.?proof|srp|token)/i;

function redactSensitiveFields(flattened: Record<string, unknown>): Record<string, unknown> {
    const redacted: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(flattened)) {
        redacted[key] = MIXPANEL_SENSITIVE_FIELD_PATTERN.test(key) ? "[REDACTED]" : value;
    }
    return redacted;
}

function flatten(
    obj: any,
    {
        delimiter = ".",
        propertyPrefix,
        exclude = [],
    }: { delimiter?: string; propertyPrefix?: string; exclude?: string[] } = {}
): { [prop: string]: any } {
    const flattened: { [prop: string]: any } = {};

    for (const [prop, value] of Object.entries(obj)) {
        if (exclude.includes(prop)) {
            continue;
        }

        const propName = propertyPrefix ? `${propertyPrefix}${delimiter}${prop}` : prop;

        if (
            ["string", "number", "boolean", "undefined"].includes(typeof value) ||
            value === null ||
            value instanceof Date ||
            Array.isArray(value)
        ) {
            flattened[propName] = value;
        } else {
            Object.assign(flattened, flatten(value, { delimiter, propertyPrefix: propName, exclude }));
        }
    }

    return flattened;
}

export class MixpanelLogger implements Logger {
    private _mixpanel: Mixpanel;

    constructor(public config: MixpanelConfig, public context?: Context) {
        this._mixpanel = init(this.config.token);
    }

    withContext(context: Context) {
        return new MixpanelLogger(this.config, context);
    }

    log(type: string, data: any) {
        if (this.config.excludeEvents?.includes(type)) {
            return new LogEvent(type, data, this.context);
        }

        let mixpanelData = data;

        if (this.context) {
            const context = this.context;
            const auth = context.auth;
            const provisioning = context.provisioning?.account;
            mixpanelData = {
                account: auth && {
                    email: auth.email,
                    status: auth.accountStatus,
                    id: auth.accountId,
                },
                provisioning: provisioning && {
                    status: provisioning.status,
                    metaData: provisioning.metaData || undefined,
                },
                device: context.device?.toRaw(),
                sessionId: context.session?.id,
                location: context.location,
                ...data,
            };
        }

        const distinct_id = data.provisioning?.metaData?.mixpanelId;
        if (distinct_id) {
            try {
                this._mixpanel.track(type, {
                    distinct_id,
                    ...redactSensitiveFields(flatten(mixpanelData, { exclude: ["kind", "version"] })),
                });
            } catch (e) {}
        }

        return new LogEvent(type, data, this.context);
    }

    list(_opts: LoggerListOptions): Promise<LogEvent[]> {
        throw "Not implemented";
    }
}
