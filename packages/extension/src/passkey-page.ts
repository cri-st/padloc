import {
    deserializeWebAuthnValue,
    isPasskeyResult,
    PASSKEY_EXTENSION_MESSAGE_SOURCE,
    PASSKEY_PAGE_MESSAGE_SOURCE,
    PASSKEY_PROTOCOL_VERSION,
    PasskeyOperation,
    PasskeyResult,
    serializeWebAuthnValue,
    SerializedPublicKeyCredential,
} from "./passkey-protocol";
import { isPasskeyProviderOriginEnabled } from "./passkey-rp-policy";

type CredentialMethod = (options?: CredentialCreationOptions | CredentialRequestOptions) => Promise<Credential | null>;

function requestId(): string {
    const randomUUID = (crypto as Crypto & { randomUUID?: () => string }).randomUUID;
    if (typeof randomUUID === "function") return randomUUID.call(crypto);
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function makeError(name: string, message: string): Error {
    if (typeof DOMException === "function") return new DOMException(message, name);
    const error = new Error(message);
    error.name = name;
    return error;
}

export function reconstructCredential(serialized: SerializedPublicKeyCredential): Credential {
    const response = deserializeWebAuthnValue(serialized.response) as Record<string, unknown>;
    if ("attestationObject" in response) {
        Object.defineProperties(response, {
            getTransports: {
                value: () => [...((response.transports as string[] | undefined) || [])],
            },
            getAuthenticatorData: {
                value: () => response.authenticatorData as ArrayBuffer,
            },
            getPublicKey: {
                value: () => (response.publicKey as ArrayBuffer | undefined) || null,
            },
            getPublicKeyAlgorithm: {
                value: () => (response.publicKeyAlgorithm as number | undefined) ?? -7,
            },
        });
        const constructor = (globalThis as any).AuthenticatorAttestationResponse;
        if (constructor?.prototype) {
            try {
                Object.setPrototypeOf(response, constructor.prototype);
            } catch {
                // Standards-shaped methods remain available on restrictive pages.
            }
        }
    } else {
        const constructor = (globalThis as any).AuthenticatorAssertionResponse;
        if (constructor?.prototype) {
            try {
                Object.setPrototypeOf(response, constructor.prototype);
            } catch {
                // Standards-shaped fields remain available on restrictive pages.
            }
        }
    }
    const credential = {
        id: serialized.id,
        type: serialized.type,
        rawId: deserializeWebAuthnValue(serialized.rawId),
        authenticatorAttachment: serialized.authenticatorAttachment ?? null,
        response,
        getClientExtensionResults: () =>
            deserializeWebAuthnValue(serialized.clientExtensionResults || {}) as Record<string, unknown>,
        toJSON() {
            return serializedWebAuthnCredentialToJSON(serialized);
        },
    } as unknown as Credential;

    const PublicKeyCredentialConstructor = (globalThis as any).PublicKeyCredential;
    if (PublicKeyCredentialConstructor?.prototype) {
        try {
            Object.setPrototypeOf(credential, PublicKeyCredentialConstructor.prototype);
        } catch {
            // The credential remains standards-shaped when a browser disallows prototype reassignment.
        }
    }
    return credential;
}

async function requestFromExtension(
    operation: PasskeyOperation,
    options: CredentialCreationOptions | CredentialRequestOptions
): Promise<PasskeyResult> {
    const id = requestId();
    return new Promise<PasskeyResult>((resolve, reject) => {
        const signal = (options as CredentialRequestOptions).signal;
        if (signal?.aborted) {
            reject(makeError("AbortError", "The WebAuthn request was aborted"));
            return;
        }
        const responseTimeout = window.setTimeout(() => {
            cancelExtensionRequest();
            cleanup();
            resolve({
                type: "passkeyResult",
                protocolVersion: PASSKEY_PROTOCOL_VERSION,
                requestId: id,
                outcome: "fallback",
                reason: "page-bridge-timeout",
            });
        }, Math.min(Math.max(Number(options.publicKey?.timeout) || 60_000, 1_000), 120_000));
        const cleanup = () => {
            window.clearTimeout(responseTimeout);
            window.removeEventListener("message", onResult);
            signal?.removeEventListener("abort", onAbort);
        };
        const onAbort = () => {
            cancelExtensionRequest();
            cleanup();
            reject(makeError("AbortError", "The WebAuthn request was aborted"));
        };
        const cancelExtensionRequest = () => {
            window.postMessage(
                {
                    source: PASSKEY_PAGE_MESSAGE_SOURCE,
                    kind: "cancel",
                    detail: {
                        protocolVersion: PASSKEY_PROTOCOL_VERSION,
                        requestId: id,
                    },
                },
                "*"
            );
        };
        const onResult = (event: MessageEvent) => {
            // SECURITY: matches the check already done by the sibling
            // ISOLATED-world bridge (passkey-content-bridge.ts's
            // `event.source !== target`). Without it, any code able to
            // `postMessage` into this top-level window (e.g. a same-page
            // iframe, even cross-origin -- postMessage delivery is always
            // cross-origin-permitted) could inject a forged WebAuthn
            // result into the promise resolving the page's
            // navigator.credentials.create()/get() call.
            if (event.source !== window) {
                return;
            }
            if (event.data?.source !== PASSKEY_EXTENSION_MESSAGE_SOURCE || event.data?.kind !== "result") {
                return;
            }
            const result = event.data.detail;
            if (!isPasskeyResult(result, id)) return;
            cleanup();
            resolve(result);
        };
        window.addEventListener("message", onResult);
        signal?.addEventListener("abort", onAbort, { once: true });
        window.postMessage(
            {
                source: PASSKEY_PAGE_MESSAGE_SOURCE,
                kind: "request",
                detail: {
                    protocolVersion: PASSKEY_PROTOCOL_VERSION,
                    requestId: id,
                    operation,
                    mediation: (options as CredentialRequestOptions).mediation,
                    options: serializeWebAuthnValue(options.publicKey) as Record<string, unknown>,
                },
            },
            "*"
        );
    });
}

export function installPasskeyPageInterceptor(credentials: CredentialsContainer = navigator.credentials): void {
    const marker = "__padlocPasskeyInterceptorV1";
    if ((credentials as any)[marker]) return;

    const nativeCreate = credentials.create.bind(credentials) as CredentialMethod;
    const nativeGet = credentials.get.bind(credentials) as CredentialMethod;

    const wrap =
        (operation: PasskeyOperation, nativeMethod: CredentialMethod): CredentialMethod =>
        async (options) => {
            if (!options?.publicKey) return nativeMethod(options);
            const result = await requestFromExtension(operation, options);
            if (result.outcome === "fallback") return nativeMethod(options);
            if (result.outcome === "error") throw makeError(result.error.name, result.error.message);
            return reconstructCredential(result.credential);
        };

    Object.defineProperties(credentials, {
        create: { configurable: true, value: wrap("create", nativeCreate) },
        get: { configurable: true, value: wrap("get", nativeGet) },
        [marker]: { configurable: false, value: true },
    });
}

export function installPasskeyCanaryInterceptor(
    origin: string,
    credentials: CredentialsContainer = navigator.credentials
): boolean {
    if (!isPasskeyProviderOriginEnabled(origin)) return false;
    installPasskeyPageInterceptor(credentials);
    return true;
}

export function serializedWebAuthnCredentialToJSON(serialized: SerializedPublicKeyCredential): Record<string, unknown> {
    const toJSONValue = (value: unknown): unknown => {
        if (Array.isArray(value)) return value.map(toJSONValue);
        if (value && typeof value === "object") {
            const record = value as Record<string, unknown>;
            if (record.__padlocWebAuthnType === "buffer" && typeof record.base64url === "string") {
                return record.base64url;
            }
            return Object.fromEntries(Object.entries(record).map(([key, child]) => [key, toJSONValue(child)]));
        }
        return value;
    };
    return toJSONValue(serialized) as Record<string, unknown>;
}

if (
    typeof navigator !== "undefined" &&
    navigator.credentials &&
    typeof window !== "undefined" &&
    (!window.top || window.top === window)
) {
    installPasskeyCanaryInterceptor(window.location.origin);
}
