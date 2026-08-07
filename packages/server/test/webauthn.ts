import { test, suite } from "mocha";
import { assert } from "chai";
import { createHash, createSign, generateKeyPairSync, randomBytes } from "crypto";
import { encodeCBOR, CBORType } from "@levischuck/tiny-cbor";
import { WebAuthnServer, WebAuthnConfig } from "../src/auth/webauthn";
import { Authenticator, AuthRequest, AuthType, Auth } from "@padloc/core/src/auth";
import { bytesToBase64 } from "@padloc/core/src/encoding";

/**
 * Minimal software WebAuthn authenticator, used ONLY to exercise the real
 * @simplewebauthn/server v13 integration (packages/server/src/auth/webauthn.ts)
 * end-to-end -- real ECDSA (ES256) key generation, real CBOR-encoded "none"
 * attestation/authenticatorData, and a real signature over
 * authenticatorData || SHA-256(clientDataJSON) -- without a browser or a
 * physical security key. This is what regressed silently on the v13 major
 * bump (async signatures, `credential`/`response` param renames,
 * `credentialID`/`credentialPublicKey` -> `id`/`publicKey`) since the only
 * prior "WebAuthn" coverage (packages/worker/test/crypto-parity.ts) never
 * calls into this module at all.
 */
class FakeAuthenticator {
    readonly credentialId = randomBytes(32);
    private readonly keyPair = generateKeyPairSync("ec", { namedCurve: "P-256" });
    private counter = 0;

    private cosePublicKey(): Uint8Array {
        const jwk = this.keyPair.publicKey.export({ format: "jwk" });
        const x = Buffer.from(jwk.x!, "base64url");
        const y = Buffer.from(jwk.y!, "base64url");
        // COSE_Key map for an EC2 P-256 key: kty=EC2(2), alg=ES256(-7), crv=P-256(1).
        const coseKey: Map<string | number, CBORType> = new Map([
            [1, 2],
            [3, -7],
            [-1, 1],
            [-2, x],
            [-3, y],
        ]);
        return encodeCBOR(coseKey);
    }

    private authenticatorData(rpID: string, includeAttestedCredentialData: boolean): Uint8Array {
        const rpIdHash = createHash("sha256").update(rpID).digest();
        // Flag bits: UP (bit0) + UV (bit2), plus AT (bit6) when attested credential data follows.
        const flags = includeAttestedCredentialData ? 0b01000101 : 0b00000101;
        const counterBuf = Buffer.alloc(4);
        counterBuf.writeUInt32BE(this.counter);
        const parts = [rpIdHash, Buffer.from([flags]), counterBuf];
        if (includeAttestedCredentialData) {
            const aaguid = Buffer.alloc(16);
            const credIdLen = Buffer.alloc(2);
            credIdLen.writeUInt16BE(this.credentialId.length);
            parts.push(aaguid, credIdLen, this.credentialId, Buffer.from(this.cosePublicKey()));
        }
        return Buffer.concat(parts);
    }

    register(challenge: string, origin: string, rpID: string) {
        this.counter = 0;
        const clientDataJSON = Buffer.from(JSON.stringify({ type: "webauthn.create", challenge, origin, crossOrigin: false }));
        const authData = this.authenticatorData(rpID, true);
        const attestationObject: Map<string | number, CBORType> = new Map([
            ["fmt", "none"],
            ["attStmt", new Map()],
            ["authData", authData],
        ]);
        return {
            id: bytesToBase64(this.credentialId),
            rawId: bytesToBase64(this.credentialId),
            type: "public-key" as const,
            clientExtensionResults: {},
            response: {
                clientDataJSON: bytesToBase64(clientDataJSON),
                attestationObject: bytesToBase64(encodeCBOR(attestationObject)),
            },
        };
    }

    authenticate(challenge: string, origin: string, rpID: string) {
        this.counter += 1;
        const clientDataJSON = Buffer.from(JSON.stringify({ type: "webauthn.get", challenge, origin, crossOrigin: false }));
        const clientDataHash = createHash("sha256").update(clientDataJSON).digest();
        const authData = this.authenticatorData(rpID, false);
        const signer = createSign("SHA256");
        signer.update(Buffer.concat([authData, clientDataHash]));
        signer.end();
        const signature = signer.sign(this.keyPair.privateKey); // DER-encoded ECDSA signature, per spec

        return {
            id: bytesToBase64(this.credentialId),
            rawId: bytesToBase64(this.credentialId),
            type: "public-key" as const,
            clientExtensionResults: {},
            response: {
                clientDataJSON: bytesToBase64(clientDataJSON),
                authenticatorData: bytesToBase64(authData),
                signature: bytesToBase64(signature),
            },
        };
    }
}

suite("WebAuthnServer (real @simplewebauthn/server v13 integration)", () => {
    test("registration + authentication round trip", async () => {
        const config = new WebAuthnConfig({
            rpName: "Padloc Test",
            rpID: "localhost",
            origin: "https://localhost",
        });
        const server = new WebAuthnServer(config);

        const auth = new Auth("webauthn-test@example.com");
        auth.account = "acct-webauthn-test";

        const authenticator = new Authenticator();
        authenticator.type = AuthType.WebAuthnPortable;

        const fakeAuthenticator = new FakeAuthenticator();

        // ── Registration ──
        const registrationOptions = await server.initAuthenticator(authenticator, auth);
        assert.ok(registrationOptions.challenge, "registration options include a real challenge");

        const registrationCredential = fakeAuthenticator.register(
            registrationOptions.challenge,
            config.origin,
            config.rpID
        );
        await server.activateAuthenticator(authenticator, registrationCredential);

        assert.ok(authenticator.state?.registrationInfo, "authenticator activated with real registrationInfo");
        assert.equal(
            authenticator.state!.registrationInfo!.credentialID,
            bytesToBase64(fakeAuthenticator.credentialId),
            "stored credentialID matches the real registered credential (v13's id/publicKey rename handled correctly)"
        );

        // ── Authentication ──
        const request = new AuthRequest();
        request.type = AuthType.WebAuthnPortable;
        const authenticationOptions = await server.initAuthRequest(authenticator, request);
        assert.ok(authenticationOptions.challenge, "authentication options include a real challenge");

        const authenticationCredential = fakeAuthenticator.authenticate(
            authenticationOptions.challenge,
            config.origin,
            config.rpID
        );

        const counterBefore = authenticator.state!.registrationInfo!.counter;
        await server.verifyAuthRequest(authenticator, request, authenticationCredential);
        assert.equal(
            authenticator.state!.registrationInfo!.counter,
            counterBefore + 1,
            "signature counter advances after a real, correctly-verified ES256 signature"
        );

        // ── Negative case: a forged/corrupted signature must be rejected ──
        const forgedRequest = new AuthRequest();
        forgedRequest.type = AuthType.WebAuthnPortable;
        const forgedOptions = await server.initAuthRequest(authenticator, forgedRequest);
        const forgedCredential = fakeAuthenticator.authenticate(forgedOptions.challenge, config.origin, config.rpID);
        forgedCredential.response.signature = bytesToBase64(randomBytes(70));

        let rejected = false;
        try {
            await server.verifyAuthRequest(authenticator, forgedRequest, forgedCredential);
        } catch (e) {
            rejected = true;
        }
        assert.ok(rejected, "a forged/corrupted signature is rejected by real verification, not silently accepted");
    });
});
