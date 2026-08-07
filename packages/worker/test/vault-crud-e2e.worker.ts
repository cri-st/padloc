/**
 * Vault CRUD E2E test — runs inside the Worker via wrangler dev.
 * Tests vault CRUD, authz, and sync flows through the Worker endpoint.
 */
import { setPlatform, DeviceInfo, StubPlatform } from "@padloc/core/src/platform";
import { WorkerCryptoProvider } from "../src/crypto";
import { Client } from "@padloc/core/src/client";
import { Account } from "@padloc/core/src/account";
import { Vault } from "@padloc/core/src/vault";
import { Org } from "@padloc/core/src/org";
import { Auth } from "@padloc/core/src/auth";
import { Client as SRPClient } from "@padloc/core/src/srp";
import { PBKDF2_ITER_MIN } from "@padloc/core/src/crypto";
import {
    Sender,
    Request as TransportRequest,
    RequestProgress,
    Response as CoreResponse,
} from "@padloc/core/src/transport";
import { Err, ErrorCode } from "@padloc/core/src/error";
import { uuid } from "@padloc/core/src/util";
import { createServer } from "../src/server-factory";
import { WorkerReceiver, WorkerReceiverConfig } from "../src/transport";
import { Request as PlRequest, Response as PlResponse } from "@padloc/core/src/transport";
import { CreateAccountParams, StartCreateSessionParams, CompleteCreateSessionParams } from "@padloc/core/src/api";
import { marshal, unmarshal } from "@padloc/core/src/encoding";
import { AccountLockDO } from "../src/locks/account-lock";
import { ShareLinkDO } from "../src/durable-objects/share-link";
import { RateLimitDO } from "../src/durable-objects/rate-limit";

// ShareLinkDO/RateLimitDO must be exported once ANY DO class is exported
// here -- wrangler hard-fails startup for every configured DO binding
// whose class isn't also exported the moment a worker script exports at
// least one DO class.
export { AccountLockDO, ShareLinkDO, RateLimitDO };

/**
 * LocalSender that properly marshals/unmarshals through the Server,
 * mirroring the real HTTP transport cycle. This ensures @AsBytes()
 * fields go through base64 encode/decode like the real wire format.
 */
class LocalSender implements Sender {
    device: DeviceInfo;

    constructor(device: DeviceInfo) {
        this.device = device;
    }

    async send(req: TransportRequest, _progress?: RequestProgress): Promise<PlResponse> {
        const raw = req.toRaw();
        const json = marshal(raw);
        const serverReq = new TransportRequest().fromRaw(unmarshal(json));
        serverReq.device = this.device;
        const serverRes = await createServer(testEnv).handle(serverReq);
        const resRaw = serverRes.toRaw();
        const resJson = marshal(resRaw);
        return new CoreResponse().fromRaw(unmarshal(resJson));
    }
}

async function createClient(device?: DeviceInfo): Promise<Client> {
    const dev = device || new DeviceInfo({ platform: "test" });
    return new Client({ session: null, account: null, device: dev }, new LocalSender(dev));
}

/**
 * Create account and login using the real Padloc protocol.
 * Mirrors the working T18 auth-flow-e2e helper.
 */
async function createAccountAndLogin(
    email: string,
    password: string
): Promise<{ accountId: string; mainVaultId: string; sessionKey: Uint8Array; client: Client }> {
    const client = await createClient();

    const account = new Account();
    account.email = email;
    account.name = email.split("@")[0];
    account.keyParams.iterations = PBKDF2_ITER_MIN;
    await account.initialize(password);

    const auth = new Auth(email);
    auth.keyParams = account.keyParams;
    const authKey = await auth.getAuthKey(password);
    const srpInit = new SRPClient();
    await srpInit.initialize(authKey);
    auth.verifier = srpInit.v!;

    const params = new CreateAccountParams({ account, auth, authToken: "" });
    const created = await client.createAccount(params);

    const startRes = await client.startCreateSession(new StartCreateSessionParams({ email }));

    const loginAuth = new Auth(email);
    loginAuth.keyParams = startRes.keyParams;
    const loginAuthKey = await loginAuth.getAuthKey(password);
    const loginSrp = new SRPClient();
    await loginSrp.initialize(loginAuthKey);
    await loginSrp.setB(startRes.B);

    const session = await client.completeCreateSession(
        new CompleteCreateSessionParams({
            accountId: startRes.accountId,
            srpId: startRes.srpId,
            A: loginSrp.A!,
            M: loginSrp.M1!,
            addTrustedDevice: true,
        })
    );

    session.key = loginSrp.K!;
    client.state.session = session;

    return {
        accountId: created.id,
        mainVaultId: created.mainVault.id,
        sessionKey: session.key,
        client,
    };
}

let testEnv: any;

interface TestResult {
    name: string;
    ok: boolean;
    detail: string;
}

async function runTests(): Promise<TestResult[]> {
    const results: TestResult[] = [];

    async function test(name: string, fn: () => Promise<void>) {
        try {
            await fn();
            results.push({ name, ok: true, detail: "PASS" });
        } catch (err: unknown) {
            results.push({ name, ok: false, detail: `FAIL: ${(err as Error).message || String(err)}` });
        }
    }

    await test("Vault CRUD happy path", async () => {
        const email = `vault-test-${await uuid()}@test.padloc.app`;
        const { accountId, mainVaultId, client } = await createAccountAndLogin(email, "TestPassword123!");

        const vault = await client.getVault(mainVaultId);
        if (vault.id !== mainVaultId) throw new Error("getVault: Vault ID mismatch");
        if (vault.owner !== accountId) throw new Error("getVault: Vault owner mismatch");

        const originalRevision = vault.revision;
        const updatePayload = { ...vault.toRaw(), encryptedData: "updated-encrypted-payload" };
        const updatedVault = await client.updateVault(new Vault().fromRaw(updatePayload));
        if (updatedVault.revision === originalRevision) throw new Error("updateVault: Revision did not change");
    });

    await test("Org creation and shared vault", async () => {
        const email = `vault-org-${await uuid()}@test.padloc.app`;
        const { accountId, mainVaultId, client } = await createAccountAndLogin(email, "TestPassword123!");

        const vault = await client.getVault(mainVaultId);
        if (!vault.id) throw new Error("step1 getVault: failed");

        const org = new Org();
        org.name = "Test Org";
        const createdOrg = await client.createOrg(org);
        if (!createdOrg.id) throw new Error("step2 createOrg: no ID");

        let hydratedOrg = await client.getOrg(createdOrg.id);
        if (!hydratedOrg.publicKey) {
            const ownerAccount = await client.getAccount();
            await ownerAccount.unlock("TestPassword123!");
            await hydratedOrg.initialize(ownerAccount);
            hydratedOrg = await client.updateOrg(hydratedOrg);
        }
        if (!hydratedOrg.publicKey) throw new Error("step2b getOrg: org not initialized for owner");

        const refreshedAccount = await client.getAccount();
        if (refreshedAccount.orgs.length === 0) throw new Error("step3 account has no orgs after createOrg");

        const sharedVault = new Vault();
        sharedVault.name = "Shared Vault";
        sharedVault.org = { id: hydratedOrg.id, name: hydratedOrg.name, revision: hydratedOrg.revision };
        const createdSharedVault = await client.createVault(sharedVault);
        if (!createdSharedVault.id) throw new Error("step4 createVault: no ID");
        if (createdSharedVault.org?.id !== hydratedOrg.id) throw new Error("step4 createVault: org mismatch");

        hydratedOrg = await client.getOrg(hydratedOrg.id);
        const ownerMember = hydratedOrg.getMember({ email });
        if (!ownerMember) throw new Error("step4b getOrg: owner missing from org");
        ownerMember.vaults.push({ id: createdSharedVault.id, readonly: false });
        hydratedOrg = await client.updateOrg(hydratedOrg);

        const retrievedSharedVault = await client.getVault(createdSharedVault.id);
        if (retrievedSharedVault.id !== createdSharedVault.id)
            throw new Error("step5 getVault: Shared vault retrieval failed");

        const accountAfterSync = await client.getAccount();
        if (!accountAfterSync.mainVault.id) throw new Error("step6 getAccount: missing vault reference");

        await client.deleteVault(createdSharedVault.id);

        let notFound = false;
        try {
            await client.getVault(createdSharedVault.id);
        } catch (err: unknown) {
            if (err instanceof Err && err.code === ErrorCode.NOT_FOUND) notFound = true;
        }
        if (!notFound) throw new Error("step7 getVault: Deleted vault did not return NOT_FOUND");
    });

    await test("Unauthorized vault access rejected", async () => {
        const emailA = `user-a-${await uuid()}@test.padloc.app`;
        const { mainVaultId: vaultAId, client: clientA } = await createAccountAndLogin(emailA, "TestPassword123!");

        const vaultA = await clientA.getVault(vaultAId);

        const emailB = `user-b-${await uuid()}@test.padloc.app`;
        const { client: clientB } = await createAccountAndLogin(emailB, "DifferentPassword456!");

        let unauthorized = false;
        try {
            await clientB.getVault(vaultAId);
        } catch (err: unknown) {
            if (err instanceof Err && err.code === ErrorCode.NOT_FOUND) unauthorized = true;
        }
        if (!unauthorized) throw new Error("User B accessed User A's vault");

        let updateUnauthorized = false;
        try {
            await clientB.updateVault(new Vault().fromRaw({ ...vaultA.toRaw(), revision: vaultA.revision }));
        } catch (err: unknown) {
            if (
                err instanceof Err &&
                (err.code === ErrorCode.NOT_FOUND || err.code === ErrorCode.INSUFFICIENT_PERMISSIONS)
            )
                updateUnauthorized = true;
        }
        if (!updateUnauthorized) throw new Error("User B updated User A's vault");
    });

    await test("Idempotent retry — OUTDATED_REVISION on duplicate", async () => {
        const email = `retry-test-${await uuid()}@test.padloc.app`;
        const { mainVaultId, client } = await createAccountAndLogin(email, "TestPassword123!");

        const vault = await client.getVault(mainVaultId);

        const updatePayload = { ...vault.toRaw(), encryptedData: "first-update" };
        await client.updateVault(new Vault().fromRaw(updatePayload));

        let outdatedRevision = false;
        try {
            await client.updateVault(new Vault().fromRaw(vault.toRaw()));
        } catch (err: unknown) {
            if (err instanceof Err && err.code === ErrorCode.OUTDATED_REVISION) outdatedRevision = true;
        }
        if (!outdatedRevision) throw new Error("Stale revision update did not return OUTDATED_REVISION");
    });

    return results;
}

export default {
    async fetch(request: Request, env: any, ctx: ExecutionContext): Promise<Response> {
        testEnv = env;

        const url = new URL(request.url);

        if (request.method === "GET" && url.pathname === "/vault-crud-tests") {
            try {
                const platform = new StubPlatform();
                platform.crypto = new WorkerCryptoProvider();
                setPlatform(platform);

                const results = await runTests();
                const passed = results.filter((r) => r.ok).length;
                const failed = results.filter((r) => !r.ok).length;
                const body = JSON.stringify(
                    {
                        ok: failed === 0,
                        passed,
                        failed,
                        total: results.length,
                        results,
                    },
                    null,
                    2
                );
                return new Response(body, {
                    status: failed === 0 ? 200 : 400,
                    headers: { "Content-Type": "application/json" },
                });
            } catch (err: unknown) {
                const msg = err instanceof Error ? err.message : String(err);
                return new Response(JSON.stringify({ ok: false, error: msg }), {
                    status: 500,
                    headers: { "Content-Type": "application/json" },
                });
            }
        }

        const config = new WorkerReceiverConfig();
        config.allowOrigin = env.ALLOW_ORIGIN || "*";
        const receiver = new WorkerReceiver(config);

        try {
            return await receiver.handleFetch(
                request,
                async (req: PlRequest): Promise<PlResponse> => {
                    const server = createServer(env);
                    return server.handle(req);
                },
                env,
                ctx
            );
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : "server_error";
            return new Response(JSON.stringify({ error: { code: "server_error", message: msg } }), {
                status: 500,
                headers: { "Content-Type": "application/json" },
            });
        }
    },
};
