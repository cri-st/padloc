/**
 * WebAuthn (biometric/security key) auth server for the Cloudflare Worker
 * backend, using @simplewebauthn/server v13+ -- rearchitected since v7 to
 * use WebCrypto/Uint8Array instead of Node's Buffer/crypto module, so it
 * needs no `nodejs_compat` compatibility flag (unlike packages/server's
 * self-host version, which still pins the old v5.4.3 Buffer-based API).
 *
 * NOTE: packages/worker/tsconfig.json must set `experimentalDecorators:
 * true` so esbuild compiles the @ConfigParam() decorators on WebAuthnConfig
 * with the same legacy transform @padloc/core uses. Without it, esbuild
 * falls back to the TC39 decorator transform for worker-local classes and
 * the whole worker crashes at startup with
 * "Cannot read properties of undefined (reading '_paramDefinitions')".
 *
 * API shape differs from the self-host version's v5.4.3:
 * - generateRegistrationOptions/generateAuthenticationOptions are now async.
 * - attestationType no longer accepts "indirect" -- use "none".
 * - userID is now Uint8Array (was a raw account-id string).
 * - Registration verification returns a single `credential: { id, publicKey,
 *   counter, transports? }` object (id is already a base64url string,
 *   publicKey is a Uint8Array) instead of separate credentialID/
 *   credentialPublicKey/counter fields -- no Buffer wrapping needed anywhere.
 */
import { Authenticator, AuthServer, AuthRequest, AuthType } from "@padloc/core/src/auth";
import {
    generateRegistrationOptions,
    verifyRegistrationResponse,
    generateAuthenticationOptions,
    verifyAuthenticationResponse,
} from "@simplewebauthn/server";
import type {
    PublicKeyCredentialCreationOptionsJSON,
    RegistrationResponseJSON,
    PublicKeyCredentialRequestOptionsJSON,
    AuthenticationResponseJSON,
    AuthenticatorTransportFuture,
} from "@simplewebauthn/server";
import { Err, ErrorCode } from "@padloc/core/src/error";
import { base64ToBytes, bytesToBase64, stringToBytes } from "@padloc/core/src/encoding";
import { Auth } from "@padloc/core/src/auth";
import { Config, ConfigParam } from "@padloc/core/src/config";

export class WebAuthnConfig extends Config {
    constructor(init: Partial<WebAuthnConfig> = {}) {
        super();
        Object.assign(this, init);
    }

    @ConfigParam()
    rpName!: string;

    @ConfigParam()
    rpID!: string;

    @ConfigParam()
    origin!: string;
}

interface WebAuthnRegistrationInfo {
    /** base64url -- returned directly as a string by v13's verifyRegistrationResponse */
    credentialID: string;
    /** base64 encoding of the raw public key bytes */
    credentialPublicKey: string;
    counter: number;
    aaguid: string;
    transports?: AuthenticatorTransportFuture[];
}

interface WebAuthnAuthenticatorData {
    registrationOptions?: PublicKeyCredentialCreationOptionsJSON;
    registrationInfo?: WebAuthnRegistrationInfo;
}

interface WebAuthnRequestData {
    authenticationOptions?: PublicKeyCredentialRequestOptionsJSON;
}

export class WebAuthnServer implements AuthServer {
    constructor(public config: WebAuthnConfig) {}

    async init() {}

    supportsType(type: AuthType) {
        return [AuthType.WebAuthnPlatform, AuthType.WebAuthnPortable].includes(type);
    }

    async initAuthenticator(authenticator: Authenticator<WebAuthnAuthenticatorData>, auth: Auth) {
        if (!auth.account) {
            throw new Err(
                ErrorCode.AUTHENTICATION_FAILED,
                "This authentication type can only be initialized for active accounts."
            );
        }

        const authenticatorSelection =
            authenticator.type === AuthType.WebAuthnPlatform
                ? ({ authenticatorAttachment: "platform", userVerification: "required" } as const)
                : ({ authenticatorAttachment: "cross-platform" } as const);

        const registrationOptions = await generateRegistrationOptions({
            rpName: this.config.rpName,
            rpID: this.config.rpID,
            userName: auth.email,
            userID: stringToBytes(auth.account),
            attestationType: "none",
            authenticatorSelection,
        });

        authenticator.state = {
            registrationOptions,
        };

        return registrationOptions;
    }

    async activateAuthenticator(
        authenticator: Authenticator<WebAuthnAuthenticatorData>,
        credential: RegistrationResponseJSON
    ) {
        if (!authenticator.state?.registrationOptions) {
            throw new Err(
                ErrorCode.AUTHENTICATION_FAILED,
                "Failed to activate authenticator. No registration options provided."
            );
        }
        const { verified, registrationInfo } = await verifyRegistrationResponse({
            response: credential,
            expectedChallenge: authenticator.state.registrationOptions.challenge,
            expectedOrigin: this.config.origin,
            expectedRPID: this.config.rpID,
        });
        if (!verified || !registrationInfo) {
            throw new Err(
                ErrorCode.AUTHENTICATION_FAILED,
                "Failed to activate authenticator. Failed to verify Registration options."
            );
        }

        const { credential: webAuthnCredential, aaguid } = registrationInfo;
        authenticator.state.registrationInfo = {
            credentialID: webAuthnCredential.id,
            credentialPublicKey: bytesToBase64(webAuthnCredential.publicKey),
            counter: webAuthnCredential.counter,
            aaguid,
            transports: webAuthnCredential.transports,
        };

        // registrationOptions carries the full challenge/rp/user/pubKeyCredParams
        // blob used only during registration. Drop it once we've captured
        // registrationInfo so it doesn't bloat the persisted auth object
        // (read+written on every subsequent auth request).
        delete authenticator.state.registrationOptions;

        authenticator.description = this._getDescription(authenticator.type);
    }

    async initAuthRequest(
        authenticator: Authenticator<WebAuthnAuthenticatorData>,
        request: AuthRequest<WebAuthnRequestData>
    ) {
        if (!authenticator.state?.registrationInfo) {
            throw new Err(ErrorCode.AUTHENTICATION_FAILED, "Authenticator not fully registered.");
        }

        const options = await generateAuthenticationOptions({
            rpID: this.config.rpID,
            allowCredentials: [
                {
                    id: authenticator.state.registrationInfo.credentialID,
                    transports: authenticator.state.registrationInfo.transports,
                },
            ],
            userVerification:
                authenticator.type === AuthType.WebAuthnPlatform ? "required" : "preferred",
        });

        request.state = {
            authenticationOptions: options,
        };

        return options;
    }

    async verifyAuthRequest(
        authenticator: Authenticator<WebAuthnAuthenticatorData>,
        request: AuthRequest<WebAuthnRequestData>,
        credential: AuthenticationResponseJSON
    ) {
        if (!authenticator.state?.registrationInfo || !request.state?.authenticationOptions) {
            throw new Err(ErrorCode.AUTHENTICATION_FAILED, "Failed to complete authentication request.");
        }

        const { credentialID, credentialPublicKey, counter, transports } = authenticator.state.registrationInfo;
        const { verified, authenticationInfo } = await verifyAuthenticationResponse({
            response: credential,
            expectedChallenge: request.state.authenticationOptions.challenge,
            expectedOrigin: this.config.origin,
            expectedRPID: this.config.rpID,
            requireUserVerification: authenticator.type === AuthType.WebAuthnPlatform,
            credential: {
                id: credentialID,
                publicKey: base64ToBytes(credentialPublicKey),
                counter,
                transports,
            },
        });

        if (!verified) {
            throw new Err(ErrorCode.AUTHENTICATION_FAILED, "Failed to complete authentication request.");
        }

        authenticator.state.registrationInfo.counter = authenticationInfo.newCounter;
    }

    private _getDescription(type: AuthType): string {
        return type === AuthType.WebAuthnPlatform ? "Biometric Authenticator" : "Security Key";
    }
}
