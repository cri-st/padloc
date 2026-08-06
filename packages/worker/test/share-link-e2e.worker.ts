/**
 * Share Link E2E test — runs inside the Worker via wrangler dev, exercising
 * the REAL `ShareLinkDO` (openspec/changes/share-password) through the
 * REAL production entrypoint (`createServer`/`WorkerReceiver`), the exact
 * way a live deployment serves `createShare`/`peekShare`/`revealShare`/
 * `getShareStatus`/`revokeShare` traffic. This is the task 6.1 integration
 * test: create -> peek -> reveal -> already-viewed against a real DO,
 * confirming GET/page-load (`peekShare`) never burns the view, plus the two
 * flagged safety-critical scenarios: revoke-then-reveal-fails, and the
 * hard-delete-vs-soft-expire alarm behavior.
 *
 * Follows the same structural pattern as `vault-crud-e2e.worker.ts`
 * (`LocalSender`/`createClient`/`createAccountAndLogin` helpers, a
 * `runTests()`/`test()` harness, dedicated routes).
 *
 * The expiry/hard-delete scenario is deliberately split across THREE
 * separate routes (`/share-link-expiry-create`, `-reveal`, `-peek`)
 * instead of sleeping for several real seconds inside one fetch handler.
 * `wrangler dev --local` (workerd) was empirically found to silently
 * truncate long `setTimeout`-based waits the longer a single request has
 * already been running (a ~2s `setTimeout` measured exactly on a fresh
 * request, but only ~0.6-1.8s once prior async work already consumed real
 * wall-clock time in the same request) -- there appears to be a shared,
 * cumulative wall-clock budget per request in local dev, not a per-timer
 * one. Driving the wait from the Node-side test runner (`run-share-link-
 * e2e.mjs`, real `setTimeout`, no such constraint) across separate HTTP
 * round-trips sidesteps this entirely and is arguably more realistic
 * anyway -- a real anonymous recipient's browser polls `peekShare` on
 * page load, not from inside one long-lived server request.
 */
import { setPlatform, DeviceInfo, StubPlatform } from "@padloc/core/src/platform";
import { WorkerCryptoProvider } from "../src/crypto";
import { Client } from "@padloc/core/src/client";
import { Account } from "@padloc/core/src/account";
import { Auth } from "@padloc/core/src/auth";
import { Client as SRPClient } from "@padloc/core/src/srp";
import {
    Sender,
    Request as TransportRequest,
    RequestProgress,
    Response as CoreResponse,
} from "@padloc/core/src/transport";
import { Err, ErrorCode } from "@padloc/core/src/error";
import { uuid } from "@padloc/core/src/util";
import { createServer } from "../src/server-factory";
import { Env } from "../src/env";
import { WorkerReceiver, WorkerReceiverConfig } from "../src/transport";
import { Request as PlRequest, Response as PlResponse } from "@padloc/core/src/transport";
import { CreateAccountParams, StartCreateSessionParams, CompleteCreateSessionParams } from "@padloc/core/src/api";
import { marshal, unmarshal } from "@padloc/core/src/encoding";
import { CreateShareParams, ShareLinkInfo, ShareData, ShareStatus } from "@padloc/core/src/share";
import { AccountLockDO } from "../src/locks/account-lock";
import { ShareLinkDO } from "../src/durable-objects/share-link";

// ShareLinkDO must be exported once ANY DO class is exported here -- wrangler
// hard-fails startup for every configured DO binding whose class isn't also
// exported the moment a worker script exports at least one DO class.
export { AccountLockDO, ShareLinkDO };

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

/** Create account and login using the real Padloc protocol (mirrors vault-crud-e2e.worker.ts). */
async function createAccountAndLogin(
    email: string,
    password: string
): Promise<{ accountId: string; client: Client }> {
    const client = await createClient();

    const account = new Account();
    account.email = email;
    account.name = email.split("@")[0];
    account.keyParams.iterations = 1000;
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

    return { accountId: created.id, client };
}

let testEnv: Env;

function ensurePlatform(): void {
    const platform = new StubPlatform();
    platform.crypto = new WorkerCryptoProvider();
    setPlatform(platform);
}

interface TestResult {
    name: string;
    ok: boolean;
    detail: string;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) return false;
    }
    return true;
}

/** Fast, in-process scenarios: no real-time waiting required. */
async function runFastTests(): Promise<TestResult[]> {
    const results: TestResult[] = [];

    async function test(name: string, fn: () => Promise<void>) {
        try {
            await fn();
            results.push({ name, ok: true, detail: "PASS" });
        } catch (err: unknown) {
            results.push({ name, ok: false, detail: `FAIL: ${(err as Error).message || String(err)}` });
        }
    }

    await test(
        "Reveal lifecycle: create -> peek (x3, non-destructive) -> reveal -> second reveal fails -> owner status reflects view receipt",
        async () => {
            const email = `share-lifecycle-${await uuid()}@test.padloc.app`;
            const { client: ownerClient } = await createAccountAndLogin(email, "TestPassword123!");
            const anonClient = await createClient();

            const ciphertext = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
            const info: ShareLinkInfo = await ownerClient.createShare(
                new CreateShareParams({ encryptedData: ciphertext, ttlSeconds: 3600 })
            );
            if (!info.id) throw new Error("createShare: no id returned");

            // GET/page-load (peekShare) is called 3 times before any reveal --
            // none of these may burn the single-view guarantee.
            for (let i = 0; i < 3; i++) {
                const status: ShareStatus = await anonClient.peekShare(info.id);
                if (status.viewed) throw new Error(`peekShare call #${i + 1} reported viewed=true before any reveal`);
                if (status.expired) throw new Error(`peekShare call #${i + 1} reported expired=true unexpectedly`);
            }

            const data: ShareData = await anonClient.revealShare(info.id);
            if (!bytesEqual(data.encryptedData, ciphertext)) {
                throw new Error("revealShare: returned ciphertext does not match what was created");
            }

            const statusAfterReveal: ShareStatus = await anonClient.peekShare(info.id);
            if (!statusAfterReveal.viewed) throw new Error("peekShare after reveal: expected viewed=true");

            let secondRevealFailed = false;
            try {
                await anonClient.revealShare(info.id);
            } catch (err: unknown) {
                if (err instanceof Err && err.code === ErrorCode.NOT_FOUND) secondRevealFailed = true;
            }
            if (!secondRevealFailed) throw new Error("Second revealShare call did not fail with NOT_FOUND");

            const ownerStatus: ShareStatus = await ownerClient.getShareStatus(info.id);
            if (!ownerStatus.viewed) throw new Error("Owner getShareStatus: expected viewed=true");
            if (!ownerStatus.viewedAt) throw new Error("Owner getShareStatus: expected viewedAt to be set");
        }
    );

    await test("Revoke unviewed share -> reveal fails, owner status reflects revocation", async () => {
        const email = `share-revoke-${await uuid()}@test.padloc.app`;
        const { client: ownerClient } = await createAccountAndLogin(email, "TestPassword123!");
        const anonClient = await createClient();

        const info: ShareLinkInfo = await ownerClient.createShare(
            new CreateShareParams({ encryptedData: new Uint8Array([9, 9, 9]), ttlSeconds: 3600 })
        );

        await ownerClient.revokeShare(info.id);

        const ownerStatus: ShareStatus = await ownerClient.getShareStatus(info.id);
        if (!ownerStatus.revoked) throw new Error("Owner getShareStatus after revoke: expected revoked=true");
        if (ownerStatus.viewed) throw new Error("Owner getShareStatus after revoke: expected viewed=false");

        let revealFailed = false;
        try {
            await anonClient.revealShare(info.id);
        } catch (err: unknown) {
            if (err instanceof Err && err.code === ErrorCode.NOT_FOUND) revealFailed = true;
        }
        if (!revealFailed) throw new Error("revealShare on a revoked share did not fail with NOT_FOUND");
    });

    await test("Auth gating: create/getShareStatus/revoke reject an anonymous caller", async () => {
        const anonClient = await createClient();

        let createRejected = false;
        try {
            await anonClient.createShare(new CreateShareParams({ encryptedData: new Uint8Array([1]) }));
        } catch (err: unknown) {
            if (err instanceof Err && err.code === ErrorCode.INVALID_SESSION) createRejected = true;
        }
        if (!createRejected) throw new Error("Anonymous createShare did not reject with INVALID_SESSION");

        let statusRejected = false;
        try {
            await anonClient.getShareStatus("nonexistent");
        } catch (err: unknown) {
            if (err instanceof Err && err.code === ErrorCode.INVALID_SESSION) statusRejected = true;
        }
        if (!statusRejected) throw new Error("Anonymous getShareStatus did not reject with INVALID_SESSION");

        let revokeRejected = false;
        try {
            await anonClient.revokeShare("nonexistent");
        } catch (err: unknown) {
            if (err instanceof Err && err.code === ErrorCode.INVALID_SESSION) revokeRejected = true;
        }
        if (!revokeRejected) throw new Error("Anonymous revokeShare did not reject with INVALID_SESSION");
    });

    return results;
}

interface ExpiryCreateResponse {
    id: string;
    createdAt: number;
    expiresAt: number;
}

async function handleExpiryCreate(): Promise<Response> {
    ensurePlatform();
    const email = `share-expiry-${await uuid()}@test.padloc.app`;
    const { client: ownerClient } = await createAccountAndLogin(email, "TestPassword123!");

    const createdAt = Date.now();
    const info: ShareLinkInfo = await ownerClient.createShare(
        new CreateShareParams({ encryptedData: new Uint8Array([4, 2]), ttlSeconds: 2 })
    );

    const body: ExpiryCreateResponse = { id: info.id, createdAt, expiresAt: info.expiresAt.getTime() };
    return new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
}

async function handleExpiryReveal(id: string): Promise<Response> {
    ensurePlatform();
    const anonClient = await createClient();

    try {
        const data = await anonClient.revealShare(id);
        return new Response(JSON.stringify({ ok: true, bytes: data.encryptedData.length }), {
            headers: { "Content-Type": "application/json" },
        });
    } catch (err: unknown) {
        const code = err instanceof Err ? err.code : "UNKNOWN";
        return new Response(JSON.stringify({ ok: false, code }), { headers: { "Content-Type": "application/json" } });
    }
}

async function handleExpiryPeek(id: string): Promise<Response> {
    ensurePlatform();
    const anonClient = await createClient();

    try {
        const status: ShareStatus = await anonClient.peekShare(id);
        return new Response(JSON.stringify({ found: true, expired: status.expired, viewed: status.viewed }), {
            headers: { "Content-Type": "application/json" },
        });
    } catch (err: unknown) {
        const code = err instanceof Err ? err.code : "UNKNOWN";
        if (err instanceof Err && err.code === ErrorCode.NOT_FOUND) {
            return new Response(JSON.stringify({ found: false, code }), {
                headers: { "Content-Type": "application/json" },
            });
        }
        return new Response(JSON.stringify({ found: false, code, unexpected: true }), {
            status: 500,
            headers: { "Content-Type": "application/json" },
        });
    }
}

export default {
    async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
        testEnv = env;

        const url = new URL(request.url);

        if (request.method === "GET" && url.pathname === "/share-link-tests") {
            try {
                ensurePlatform();
                const results = await runFastTests();
                const passed = results.filter((r) => r.ok).length;
                const failed = results.filter((r) => !r.ok).length;
                const body = JSON.stringify(
                    { ok: failed === 0, passed, failed, total: results.length, results },
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

        if (request.method === "GET" && url.pathname === "/share-link-expiry-create") {
            return handleExpiryCreate();
        }

        if (request.method === "GET" && url.pathname === "/share-link-expiry-reveal") {
            const id = url.searchParams.get("id") || "";
            return handleExpiryReveal(id);
        }

        if (request.method === "GET" && url.pathname === "/share-link-expiry-peek") {
            const id = url.searchParams.get("id") || "";
            return handleExpiryPeek(id);
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
