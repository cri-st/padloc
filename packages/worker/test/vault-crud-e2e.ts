/**
 * Vault CRUD E2E test — direct HTTP test against the Worker endpoint.
 * Tests vault CRUD, authz, and sync flows using raw API calls.
 * Uses reduced PBKDF2 iterations (10k) for faster test execution.
 */
import { marshal, unmarshal, bytesToBase64 } from "@padloc/core/src/encoding";
import { Err, ErrorCode } from "@padloc/core/src/error";
import { uuid } from "@padloc/core/src/util";
import { setPlatform, DeviceInfo, getCryptoProvider } from "@padloc/core/src/platform";
import { WorkerCryptoProvider } from "../src/crypto";
import { MemoryStorage } from "@padloc/core/src/storage";
import { Account } from "@padloc/core/src/account";
import { Auth } from "@padloc/core/src/auth";
import { Client as SRPClient } from "@padloc/core/src/srp";
import { PBKDF2Params, PBKDF2_ITER_MIN } from "@padloc/core/src/crypto";
import { Request, Response } from "@padloc/core/src/transport";
import { Session } from "@padloc/core/src/session";
import { Vault } from "@padloc/core/src/vault";
import { Org } from "@padloc/core/src/org";

const TEST_ITERATIONS = PBKDF2_ITER_MIN;

setPlatform({
    crypto: new WorkerCryptoProvider(),
    storage: new MemoryStorage(),
    getDeviceInfo: async () => new DeviceInfo({ platform: "node", runtime: "node", id: "test-node" }),
    getClipboard: async () => "",
    setClipboard: async () => {},
    scanQR: async () => "",
    stopScanQR: async () => {},
    composeEmail: async () => {},
    openExternalUrl: () => {},
    saveFile: async () => {},
    supportedAuthTypes: [],
    registerAuthenticator: async () => () => ({}),
    startAuthRequest: async () => ({}),
    completeAuthRequest: async () => ({}),
    platformAuthType: null,
    supportsPlatformAuthenticator: async () => false,
    registerPlatformAuthenticator: async () => "",
    getPlatformAuthToken: async () => "",
    biometricKeyStore: {
        isSupported: async () => false,
        getKey: async () => new Uint8Array(),
        storeKey: async () => {},
    },
} as any);

const WORKER_URL = process.env.WORKER_URL || "http://127.0.0.1:8787/";

function bigIntToBytes(n: Uint8Array | null): Uint8Array {
    if (!n) return new Uint8Array();
    return n;
}

async function callApi(method: string, params: unknown[], sessionKey?: Uint8Array): Promise<any> {
    const req = new Request();
    req.method = method;
    req.params = params;
    req.device = new DeviceInfo({ platform: "node" });

    if (sessionKey) {
        const session = new Session();
        session.key = sessionKey;
        await session.authenticate(req);
    }

    const body = marshal(req.toRaw());
    const res = await fetch(WORKER_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
    });
    const text = await res.text();

    if (!res.ok) {
        const parsed = JSON.parse(text);
        throw new Err(parsed.error?.code || ErrorCode.SERVER_ERROR, parsed.error?.message || text);
    }

    const coreRes = new Response().fromRaw(unmarshal(text));

    if (coreRes.error) {
        throw new Err(coreRes.error.code as ErrorCode, coreRes.error.message);
    }

    if (sessionKey) {
        const session = new Session();
        session.key = sessionKey;
        if (!(await session.verify(coreRes))) {
            throw new Err(ErrorCode.INVALID_RESPONSE);
        }
    }

    return coreRes.result;
}

async function createAccountAndLogin(
    email: string,
    password: string
): Promise<{ accountId: string; mainVaultId: string; sessionKey: Uint8Array }> {
    const account = new Account();
    account.email = email;
    account.name = email.split("@")[0];
    account.keyParams.iterations = TEST_ITERATIONS;
    await account.initialize(password);

    const auth = new Auth(email);
    await auth.init();
    auth.keyParams.iterations = TEST_ITERATIONS;

    const authKey = await auth.getAuthKey(password);
    const clientSRP = new SRPClient();
    await clientSRP.initialize(authKey);

    await callApi("createAccount", [
        {
            account: account.toRaw(),
            auth: auth.toRaw(),
            authToken: "",
        },
    ]);

    const startRes = await callApi("startCreateSession", [{ email }]);

    const loginKeyParams = new PBKDF2Params({
        algorithm: "PBKDF2",
        hash: "SHA-256",
        salt: startRes.keyParams.salt,
        iterations: startRes.keyParams.iterations,
        keySize: 256,
    });
    const x = await getCryptoProvider().deriveKey(new TextEncoder().encode(password), loginKeyParams);

    const loginSRP = new SRPClient();
    await loginSRP.initialize(x);
    await loginSRP.setB(startRes.B);

    const sessionKey = bigIntToBytes(loginSRP.K);

    await callApi("completeCreateSession", [
        {
            accountId: startRes.accountId,
            srpId: startRes.srpId,
            A: bytesToBase64(bigIntToBytes(loginSRP.A)),
            M: bytesToBase64(bigIntToBytes(loginSRP.M1)),
            addTrustedDevice: true,
        },
    ]);

    return {
        accountId: startRes.accountId,
        mainVaultId: account.mainVault.id,
        sessionKey,
    };
}

function assert(condition: boolean, message: string) {
    if (!condition) {
        throw new Error(`ASSERTION FAILED: ${message}`);
    }
}

const results: { name: string; status: "PASS" | "FAIL"; error?: string }[] = [];

function test(name: string, fn: () => Promise<void>) {
    return fn()
        .then(() => results.push({ name, status: "PASS" }))
        .catch((err) => results.push({ name, status: "FAIL", error: String(err.message || err) }));
}

async function main() {
    console.log("=== Vault CRUD E2E Tests ===\n");

    await test("Vault CRUD happy path", async () => {
        const email = `vault-test-${await uuid()}@test.padloc.app`;
        const { mainVaultId, sessionKey } = await createAccountAndLogin(email, "TestPassword123!");

        const vaultRaw = await callApi("getVault", [mainVaultId], sessionKey);
        const vault = new Vault().fromRaw(vaultRaw);
        assert(vault.id === mainVaultId, "Retrieved main vault");
        assert(!!vault.revision, "Vault has revision");

        const originalRevision = vault.revision;

        const updateData = {
            ...vault.toRaw(),
            encryptedData: "updated-encrypted-payload-test-data",
            revision: vault.revision,
        };
        const updatedVaultRaw = await callApi("updateVault", [updateData], sessionKey);
        const updatedVault = new Vault().fromRaw(updatedVaultRaw);
        assert(updatedVault.revision !== originalRevision, "Revision changed after update");

        const org = new Org();
        org.name = "Test Org";
        const orgRaw = await callApi("createOrg", [org.toRaw()], sessionKey);
        assert(!!orgRaw.id, "Org created with ID");

        const sharedVault = new Vault();
        sharedVault.name = "Shared Vault";
        sharedVault.org = { id: orgRaw.id, name: orgRaw.name, revision: orgRaw.revision };

        const createdSharedVaultRaw = await callApi("createVault", [sharedVault.toRaw()], sessionKey);
        assert(!!createdSharedVaultRaw.id, "Shared vault created with ID");
        assert(createdSharedVaultRaw.org?.id === orgRaw.id, "Shared vault belongs to org");

        const retrievedSharedVaultRaw = await callApi("getVault", [createdSharedVaultRaw.id], sessionKey);
        assert(retrievedSharedVaultRaw.id === createdSharedVaultRaw.id, "Shared vault retrieved");

        const accountRaw = await callApi("getAccount", [], sessionKey);
        assert(!!accountRaw.mainVault.id, "Account sync returns vault reference");

        await callApi("deleteVault", [createdSharedVaultRaw.id], sessionKey);

        let notFound = false;
        try {
            await callApi("getVault", [createdSharedVaultRaw.id], sessionKey);
        } catch (err: unknown) {
            if (err instanceof Err && err.code === ErrorCode.NOT_FOUND) {
                notFound = true;
            }
        }
        assert(notFound, "Deleted vault returns NOT_FOUND");

        console.log("  Vault CRUD: all sub-steps passed");
    });

    await test("Unauthorized vault access rejected", async () => {
        const emailA = `user-a-${await uuid()}@test.padloc.app`;
        const { mainVaultId: vaultIdA, sessionKey: keyA } = await createAccountAndLogin(emailA, "TestPassword123!");

        const vaultARaw = await callApi("getVault", [vaultIdA], keyA);
        const vaultA = new Vault().fromRaw(vaultARaw);
        assert(vaultA.id === vaultIdA, "User A can access own vault");

        const emailB = `user-b-${await uuid()}@test.padloc.app`;
        const { sessionKey: keyB } = await createAccountAndLogin(emailB, "DifferentPassword456!");

        let unauthorized = false;
        try {
            await callApi("getVault", [vaultIdA], keyB);
        } catch (err: unknown) {
            if (err instanceof Err && err.code === ErrorCode.NOT_FOUND) {
                unauthorized = true;
            }
        }
        assert(unauthorized, "User B cannot access User A's vault (NOT_FOUND)");

        let updateUnauthorized = false;
        try {
            await callApi("updateVault", [{ ...vaultA.toRaw(), revision: vaultA.revision }], keyB);
        } catch (err: unknown) {
            if (
                err instanceof Err &&
                (err.code === ErrorCode.NOT_FOUND || err.code === ErrorCode.INSUFFICIENT_PERMISSIONS)
            ) {
                updateUnauthorized = true;
            }
        }
        assert(updateUnauthorized, "User B cannot update User A's vault");
    });

    await test("Idempotent retry — OUTDATED_REVISION on duplicate", async () => {
        const email = `retry-test-${await uuid()}@test.padloc.app`;
        const { mainVaultId, sessionKey } = await createAccountAndLogin(email, "TestPassword123!");

        const vaultRaw = await callApi("getVault", [mainVaultId], sessionKey);
        const vault = new Vault().fromRaw(vaultRaw);

        const updatePayload = { ...vault.toRaw(), encryptedData: "first-update-payload" };
        await callApi("updateVault", [updatePayload], sessionKey);

        let outdatedRevision = false;
        try {
            await callApi("updateVault", [{ ...vault.toRaw() }], sessionKey);
        } catch (err: unknown) {
            if (err instanceof Err && err.code === ErrorCode.OUTDATED_REVISION) {
                outdatedRevision = true;
            }
        }
        assert(outdatedRevision, "Duplicate retry with stale revision returns OUTDATED_REVISION");
    });

    console.log("\n=== Results ===");
    for (const r of results) {
        const icon = r.status === "PASS" ? "✅" : "❌";
        console.log(`${icon} ${r.name}${r.error ? ` — ${r.error}` : ""}`);
    }

    const passed = results.filter((r) => r.status === "PASS").length;
    const failed = results.filter((r) => r.status === "FAIL").length;
    console.log(`\n${passed}/${results.length} passed, ${failed} failed`);

    if (failed > 0) {
        process.exit(1);
    }
}

main().catch((err) => {
    console.error("Fatal:", err);
    process.exit(1);
});
