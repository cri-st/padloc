/**
 * Account Lockout E2E test — runs inside the Worker via wrangler dev.
 *
 * Exercises the real persistent per-account lockout added to
 * Server.completeCreateSession() (packages/core/src/server.ts) and the
 * Auth.failedLoginAttempts/lockedUntil fields (packages/core/src/auth.ts).
 *
 * Uses the same in-process LocalSender pattern as vault-crud-e2e.worker.ts
 * (proven-working import set -- deliberately does NOT pull in the
 * TOTP/otp.ts import graph that auth-flow-e2e.worker.ts uses, since that
 * combination triggers a pre-existing "this.handlerDefinitions is not
 * iterable" bundling bug unrelated to this change).
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
import { WorkerReceiver, WorkerReceiverConfig } from "../src/transport";
import { Request as PlRequest, Response as PlResponse } from "@padloc/core/src/transport";
import { CreateAccountParams, StartCreateSessionParams, CompleteCreateSessionParams } from "@padloc/core/src/api";
import { marshal, unmarshal } from "@padloc/core/src/encoding";
import { AccountLockDO } from "../src/locks/account-lock";
import { ShareLinkDO } from "../src/durable-objects/share-link";
import { Env } from "../src/env";
import { RateLimitDO } from "../src/durable-objects/rate-limit";

// ShareLinkDO/RateLimitDO must be exported once ANY DO class is exported
// here -- wrangler hard-fails startup for every configured DO binding
// whose class isn't also exported the moment a worker script exports at
// least one DO class.
export { AccountLockDO, ShareLinkDO, RateLimitDO };

let testEnv: Env;

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

async function createAccount(email: string, password: string): Promise<void> {
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

    await client.createAccount(new CreateAccountParams({ account, auth, authToken: "" }));
}

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

    await test(
        "Persistent lockout blocks even the correct password after repeated failures across fresh sessions",
        async () => {
            const email = `lockout-${await uuid()}@test.padloc.app`;
            const password = "CorrectPassword123!";
            const wrongPassword = "WrongPassword456!";

            await createAccount(email, password);

            const client = await createClient();

            async function attemptLogin(pwd: string): Promise<"ok" | "invalid_credentials" | "locked"> {
                const startRes = await client.startCreateSession(new StartCreateSessionParams({ email }));
                const loginAuth = new Auth(email);
                loginAuth.keyParams = startRes.keyParams;
                const loginAuthKey = await loginAuth.getAuthKey(pwd);
                const loginSrp = new SRPClient();
                await loginSrp.initialize(loginAuthKey);
                await loginSrp.setB(startRes.B);
                try {
                    await client.completeCreateSession(
                        new CompleteCreateSessionParams({
                            accountId: startRes.accountId,
                            srpId: startRes.srpId,
                            A: loginSrp.A!,
                            M: loginSrp.M1!,
                        })
                    );
                    return "ok";
                } catch (err: unknown) {
                    if (err instanceof Err && err.code === ErrorCode.AUTHENTICATION_TRIES_EXCEEDED) {
                        return "locked";
                    }
                    if (err instanceof Err && err.code === ErrorCode.INVALID_CREDENTIALS) {
                        return "invalid_credentials";
                    }
                    throw err;
                }
            }

            // Each attempt opens a FRESH SRP session (fresh startCreateSession
            // call), resetting SRPSession.failedAttempts -- mirroring an
            // attacker who requests a new session per guess to dodge a
            // purely per-session lockout.
            let lockedAt = -1;
            for (let i = 0; i < 12; i++) {
                const result = await attemptLogin(wrongPassword);
                if (result === "locked") {
                    lockedAt = i;
                    break;
                }
                if (result !== "invalid_credentials") {
                    throw new Error(`Unexpected result on attempt ${i}: ${result}`);
                }
            }

            if (lockedAt === -1) {
                throw new Error("Account was never locked after 12 wrong-password attempts across fresh sessions");
            }

            const correctAttemptResult = await attemptLogin(password);
            if (correctAttemptResult !== "locked") {
                throw new Error(
                    `Correct password was accepted (or wrongly rejected as ${correctAttemptResult}) while account should be locked`
                );
            }
        }
    );

    await test("Login without triggering lockout still succeeds normally", async () => {
        const email = `lockout-control-${await uuid()}@test.padloc.app`;
        const password = "AnotherCorrectPassword789!";
        await createAccount(email, password);

        const client = await createClient();
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
            })
        );
        if (!session || !session.id) {
            throw new Error("Expected a valid session for correct-password login with no prior failures");
        }
    });

    return results;
}

export default {
    async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
        testEnv = env;

        const url = new URL(request.url);

        if (request.method === "GET" && url.pathname === "/account-lockout-tests") {
            try {
                const platform = new StubPlatform();
                platform.crypto = new WorkerCryptoProvider();
                setPlatform(platform);

                const results = await runTests();
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

        const config = new WorkerReceiverConfig();
        config.allowOrigin = env.ALLOW_ORIGIN || "*";
        const receiver = new WorkerReceiver(config);

        try {
            return await receiver.handleFetch(
                request,
                async (req: PlRequest): Promise<PlResponse> => {
                    return createServer(env).handle(req);
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
