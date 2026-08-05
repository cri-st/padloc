import { expect } from "chai";
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
});
