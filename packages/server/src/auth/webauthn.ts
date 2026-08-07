import { Authenticator, AuthServer, AuthRequest, AuthType } from "@padloc/core/src/auth";
import {
    generateRegistrationOptions,
    verifyRegistrationResponse,
    generateAuthenticationOptions,
    verifyAuthenticationResponse,
    MetadataService,
    PublicKeyCredentialCreationOptionsJSON,
    RegistrationResponseJSON,
    PublicKeyCredentialRequestOptionsJSON,
    AuthenticationResponseJSON,
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
    credentialPublicKey: string;
    credentialID: string;
    counter: number;
    aaguid: string;
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

    async init() {
        // await MetadataService.initialize();
    }

    supportsType(type: AuthType) {
        return [AuthType.WebAuthnPlatform, AuthType.WebAuthnPortable].includes(type);
    }

    async initAuthenticator(authenticator: Authenticator, auth: Auth) {
        if (!auth.account) {
            throw new Err(
                ErrorCode.AUTHENTICATION_FAILED,
                "This authentication type can only be initialized for active accounts."
            );
        }

        const authenticatorSelection: AuthenticatorSelectionCriteria =
            authenticator.type === AuthType.WebAuthnPlatform
                ? {
                      authenticatorAttachment: "platform",
                      userVerification: "required",
                  }
                : { authenticatorAttachment: "cross-platform" };

        // SECURITY/COMPAT: @simplewebauthn/server v13's `userID` is now typed as raw bytes
        // (`Uint8Array_`), not a string like older versions accepted -- encode the account id
        // explicitly rather than passing it through unconverted.
        const registrationOptions = await generateRegistrationOptions({
            ...this.config,
            userID: stringToBytes(auth.account),
            userName: auth.email,
            // userDisplayName: account.name,
            // COMPAT: WebAuthn Level 3 (and @simplewebauthn/server v13) dropped "indirect" from
            // AttestationConveyancePreference. "none" matches packages/worker/src/auth/webauthn.ts's
            // already-migrated v13 implementation (this file's server-side counterpart) -- browsers
            // largely ignore the requested conveyance anyway, so this is a naming/consistency choice,
            // not a behavior change.
            attestationType: "none",
            authenticatorSelection,
            // excludeCredentials: auth.authenticators
            //     .filter(
            //         (auth) =>
            //             [AuthType.WebAuthnPlatform, AuthType.WebAuthnPortable].includes(auth.type) &&
            //             !!auth.state &&
            //             auth.state.registrationInfo
            //     )
            //     .map((a: Authenticator<WebAuthnAuthenticatorData>) => ({
            //         id: a.state!.registrationInfo!.credentialID,
            //         type: "public-key",
            //     })),
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
        // COMPAT: v13 renamed this options field `credential` -> `response` (the browser's
        // registration response); see verifyAuthenticationResponse below for the corresponding
        // `credential` rename on the OTHER side (stored credential record).
        const { verified, registrationInfo } = await verifyRegistrationResponse({
            response: credential,
            expectedChallenge: authenticator.state.registrationOptions.challenge,
            expectedOrigin: this.config.origin,
            expectedRPID: this.config.rpID,
        });
        if (!verified) {
            throw new Err(
                ErrorCode.AUTHENTICATION_FAILED,
                "Failed to activate authenticator. Failed to verify Registration options."
            );
        }

        // COMPAT: v13 nests the verified credential under `registrationInfo.credential` (an
        // `{ id, publicKey, counter }` object) instead of flat `credentialID`/`credentialPublicKey`
        // fields. `credential.id` is already a base64url string (not raw bytes), unlike the old
        // `credentialID` Buffer -- Padloc's own persisted `WebAuthnRegistrationInfo` shape (below)
        // is unchanged and independent of the library's internal field names, so no data migration
        // is needed for already-enrolled credentials.
        const { aaguid, credential: verifiedCredential } = registrationInfo!;
        authenticator.state.registrationInfo = {
            credentialID: verifiedCredential.id,
            credentialPublicKey: bytesToBase64(verifiedCredential.publicKey),
            counter: verifiedCredential.counter,
            aaguid,
        };

        authenticator.description = await this._getDescription(authenticator);
    }

    async initAuthRequest(
        authenticator: Authenticator<WebAuthnAuthenticatorData>,
        request: AuthRequest<WebAuthnRequestData>
    ) {
        if (!authenticator.state?.registrationInfo) {
            throw new Err(ErrorCode.AUTHENTICATION_FAILED, "Authenticator not fully registered.");
        }

        // COMPAT: v13's `allowCredentials[].id` is a base64url string (no `type` field anymore),
        // so the stored `credentialID` is passed through directly instead of decoding to bytes.
        const options = await generateAuthenticationOptions({
            rpID: this.config.rpID,
            allowCredentials: [{ id: authenticator.state.registrationInfo.credentialID }],
            userVerification: "preferred",
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

        const { credentialPublicKey, credentialID, counter } = authenticator.state.registrationInfo;
        // COMPAT: v13 renamed the options fields `credential` -> `response` (the browser's
        // authentication response) and `authenticator` -> `credential` (the stored credential
        // record, now shaped as `{ id, publicKey, counter }` instead of
        // `{ credentialID, credentialPublicKey, counter }`).
        const { verified, authenticationInfo } = await verifyAuthenticationResponse({
            response: credential,
            expectedChallenge: request.state.authenticationOptions.challenge,
            expectedOrigin: this.config.origin,
            expectedRPID: this.config.rpID,
            credential: {
                id: credentialID,
                publicKey: base64ToBytes(credentialPublicKey),
                counter,
            },
        });

        if (!verified) {
            throw new Err(ErrorCode.AUTHENTICATION_FAILED, "Failed to complete authentication request.");
        }

        authenticator.state.registrationInfo.counter = authenticationInfo!.newCounter;
    }

    private async _getDescription({ state: { registrationInfo } }: Authenticator) {
        let description = "Unknown Authenticator";
        try {
            const metaData = registrationInfo?.aaguid && (await MetadataService.getStatement(registrationInfo.aaguid));
            if (metaData) {
                description = metaData.description;
            }
        } catch (e) {}
        return description;
    }
}
