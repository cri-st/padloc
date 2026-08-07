import { expect } from "chai";
import type * as PasskeyRpPolicyModule from "../src/passkey-rp-policy";
import { approvePasskeyRpSuffix, isPasskeyProviderOriginEnabled } from "../src/passkey-rp-policy";

suite("Passkey RP canary policy", () => {
    test("enables secure Google origins plus loopback development", () => {
        expect(isPasskeyProviderOriginEnabled("https://accounts.google.com")).to.equal(true);
        expect(isPasskeyProviderOriginEnabled("http://localhost:3000")).to.equal(true);
        expect(isPasskeyProviderOriginEnabled("http://127.0.0.1:4173")).to.equal(true);
    });

    test("does not activate on lookalikes, insecure public, unrelated, or unconfigured origins", () => {
        expect(isPasskeyProviderOriginEnabled("https://attacker-google.com")).to.equal(false);
        expect(isPasskeyProviderOriginEnabled("https://google.com.attacker.example")).to.equal(false);
        expect(isPasskeyProviderOriginEnabled("http://accounts.google.com")).to.equal(false);
        expect(isPasskeyProviderOriginEnabled("https://webauthn.io")).to.equal(false);
        // A self-host domain is not trusted until added via PL_PASSKEY_RP_ROOTS.
        expect(isPasskeyProviderOriginEnabled("https://app.example.com")).to.equal(false);
    });

    test("approves only RP IDs at or below an allowed root and bound to the origin host", () => {
        expect(approvePasskeyRpSuffix("google.com", "accounts.google.com")).to.equal(true);
        expect(approvePasskeyRpSuffix("accounts.google.com", "accounts.google.com")).to.equal(true);
        // Not in the baseline allowlist (would require PL_PASSKEY_RP_ROOTS to be set).
        expect(approvePasskeyRpSuffix("example.com", "app.example.com")).to.equal(false);
        expect(approvePasskeyRpSuffix("com", "accounts.google.com")).to.equal(false);
        expect(approvePasskeyRpSuffix("google.com", "google.com.attacker.example")).to.equal(false);
        expect(approvePasskeyRpSuffix("attacker-google.com", "attacker-google.com")).to.equal(false);
    });

    test("PL_PASSKEY_RP_ROOTS rejects bare public suffixes and known multi-tenant hosts (M4)", () => {
        const previous = process.env.PL_PASSKEY_RP_ROOTS;
        const modulePath = require.resolve("../src/passkey-rp-policy");
        try {
            process.env.PL_PASSKEY_RP_ROOTS = "com,github.io,io,my-real-domain.com";
            delete require.cache[modulePath];
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            const reloaded = require("../src/passkey-rp-policy") as typeof PasskeyRpPolicyModule;
            expect(reloaded.PASSKEY_APPROVED_RP_ROOTS).to.include("my-real-domain.com");
            expect(reloaded.PASSKEY_APPROVED_RP_ROOTS).to.not.include("com");
            expect(reloaded.PASSKEY_APPROVED_RP_ROOTS).to.not.include("github.io");
            expect(reloaded.PASSKEY_APPROVED_RP_ROOTS).to.not.include("io");
            // Google baseline always survives regardless of operator config.
            expect(reloaded.PASSKEY_APPROVED_RP_ROOTS).to.include("google.com");
        } finally {
            if (previous === undefined) {
                delete process.env.PL_PASSKEY_RP_ROOTS;
            } else {
                process.env.PL_PASSKEY_RP_ROOTS = previous;
            }
            delete require.cache[modulePath];
        }
    });
});
