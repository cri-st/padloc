/**
 * Auth Flow E2E test — runs inside the Worker via wrangler dev.
 *
 * Tests the real Padloc protocol:
 *   - Real SRP verifier generation (via auth.getAuthKey → SRPClient.initialize)
 *   - Full signup → login → session (happy path)
 *   - Duplicate email rejection
 *   - Wrong password rejection
 *   - Non-existent account login rejection
 *   - Revoked session rejection
 *
 * Note: EMAIL_VERIFY_ON_SIGNUP=false in dev env, so account creation bypasses
 * email verification. The SRP key exchange remains fully exercised.
 */
import { setPlatform, DeviceInfo, StubPlatform } from "@padloc/core/src/platform";
import { WorkerCryptoProvider } from "../src/crypto";
import { Client } from "@padloc/core/src/client";
import { Session } from "@padloc/core/src/session";
import { Account } from "@padloc/core/src/account";
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
import { createServer, getSharedMockMessenger } from "../src/server-factory";
import { WorkerReceiver, WorkerReceiverConfig } from "../src/transport";
import { Request as PlRequest, Response as PlResponse } from "@padloc/core/src/transport";
import {
    CreateAccountParams,
    StartCreateSessionParams,
    CompleteCreateSessionParams,
    StartRegisterAuthenticatorParams,
    CompleteRegisterMFAuthenticatorParams,
    StartAuthRequestParams,
    CompleteAuthRequestParams,
} from "@padloc/core/src/api";
import { marshal, unmarshal, bytesToBase32, base32ToBytes } from "@padloc/core/src/encoding";
import { AccountLockDO } from "../src/locks/account-lock";
import { AuthType, AuthPurpose } from "@padloc/core/src/auth";
import { totp } from "@padloc/core/src/otp";
import { RateLimitDO } from "../src/durable-objects/rate-limit";
import { ShareLinkDO } from "../src/durable-objects/share-link";

export { AccountLockDO, ShareLinkDO, RateLimitDO };

let testEnv: any;

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
        // Marshal request to JSON (like the real HTTP transport)
        const raw = req.toRaw();
        const json = marshal(raw);

        // Unmarshal back (simulates server receiving JSON)
        const serverReq = new TransportRequest().fromRaw(unmarshal(json));
        serverReq.device = this.device;

        // Process through server
        const serverRes = await createServer(testEnv).handle(serverReq);

        // Marshal response to JSON (like the real HTTP transport)
        const resRaw = serverRes.toRaw();
        const resJson = marshal(resRaw);

        // Unmarshal back (simulates client receiving JSON)
        return new CoreResponse().fromRaw(unmarshal(resJson));
    }
}

async function createClient(device?: DeviceInfo): Promise<Client> {
    const dev = device || new DeviceInfo({ platform: "test" });
    return new Client({ session: null, account: null, device: dev }, new LocalSender(dev));
}

/**
 * Create account and login using the real Padloc protocol from App.signup() / App.login().
 *
 * Signup flow (mirrors App.signup lines 648-693):
 *   1. account = new Account(); account.email = email; account.name = name
 *   2. await account.initialize(password)
 *   3. auth = new Auth(email)
 *   4. authKey = await auth.getAuthKey(password)
 *   5. srp = new SRPClient(); await srp.initialize(authKey)
 *   6. auth.verifier = srp.v  (as bytes)
 *   7. await api.createAccount(CreateAccountParams({ account, auth, authToken }))
 *
 * Login flow (mirrors App.login lines 699-752):
 *   1. startRes = await api.startCreateSession(StartCreateSessionParams({ email }))
 *   2. auth = new Auth(email); auth.keyParams = startRes.keyParams
 *   3. authKey = await auth.getAuthKey(password)
 *   4. srp = new SRPClient(); await srp.initialize(authKey)
 *   5. await srp.setB(startRes.B)
 *   6. session = await api.completeCreateSession(CompleteCreateSessionParams({
 *        accountId: startRes.accountId, A: srp.A, M: srp.M1, srpId: startRes.srpId
 *      }))
 *   7. session.key = srp.K
 */
async function createAccountAndLogin(
    email: string,
    password: string
): Promise<{ accountId: string; mainVaultId: string; sessionKey: Uint8Array; client: Client }> {
    const client = await createClient();

    // ── Step 1: Build account (mirrors App.signup lines 667-670) ──
    const account = new Account();
    account.email = email;
    account.name = email.split("@")[0];
    account.keyParams.iterations = PBKDF2_ITER_MIN;
    await account.initialize(password);

    // ── Step 2: Build auth with REAL SRP verifier (mirrors App.signup lines 673-679) ──
    const auth = new Auth(email);
    // Share account's keyParams so the server stores consistent params
    // that the client can use during login to derive the same auth key.
    auth.keyParams = account.keyParams;
    const authKey = await auth.getAuthKey(password);
    const srpInit = new SRPClient();
    await srpInit.initialize(authKey);
    // srpInit.v is already Uint8Array (SRP Client.v getter calls i2b internally)
    auth.verifier = srpInit.v!;

    // ── Step 3: Create account (EMAIL_VERIFY_ON_SIGNUP=false in dev env) ──
    const params = new CreateAccountParams({ account, auth, authToken: "" });
    const created = await client.createAccount(params);

    // ── Step 4: Login (mirrors App.login lines 712-752) ──
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

    // Apply session key (mirrors App.login line 739)
    // loginSrp.K is already Uint8Array (SRP Client.K getter calls i2b internally)
    session.key = loginSrp.K!;
    client.state.session = session;

    return {
        accountId: created.id,
        mainVaultId: created.mainVault.id,
        sessionKey: session.key,
        client,
    };
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

    // ── Test 1: Full signup → login → session (happy path) ──
    await test("Full signup → login → session works", async () => {
        const email = `auth-happy-${await uuid()}@test.padloc.app`;
        const password = "TestPassword123!";

        const { accountId, mainVaultId, sessionKey, client } = await createAccountAndLogin(email, password);

        if (!accountId) throw new Error("createAccount succeeded but returned no ID");

        // Verify session works by fetching account
        const fetchedAccount = await client.getAccount();
        if (fetchedAccount.email !== email) throw new Error("Account email mismatch after login");
        if (fetchedAccount.mainVault.id !== mainVaultId) throw new Error("Main vault ID mismatch");
        if (!sessionKey || sessionKey.length === 0) throw new Error("Session key is empty");
    });

    // ── Test 2: Duplicate email rejection ──
    await test("Duplicate email signup rejected", async () => {
        const email = `dup-email-${await uuid()}@test.padloc.app`;
        const password = "FirstPassword123!";

        await createAccountAndLogin(email, password);

        const client2 = await createClient();
        const account2 = new Account();
        account2.email = email;
        account2.name = "Duplicate";
        await account2.initialize(password);

        const auth2 = new Auth(email);
        const authKey2 = await auth2.getAuthKey(password);
        const srp2 = new SRPClient();
        await srp2.initialize(authKey2);
        auth2.verifier = srp2.v!;

        const params2 = new CreateAccountParams({ account: account2, auth: auth2, authToken: "" });

        let rejected = false;
        try {
            await client2.createAccount(params2);
        } catch (err: unknown) {
            if (err instanceof Err && err.code === ErrorCode.ACCOUNT_EXISTS) {
                rejected = true;
            }
        }
        if (!rejected) throw new Error("Duplicate email signup was not rejected with ACCOUNT_EXISTS");
    });

    // ── Test 3: Wrong password rejection ──
    await test("Wrong password rejected during login", async () => {
        const email = `wrong-pw-${await uuid()}@test.padloc.app`;
        const correctPassword = "CorrectPassword123!";
        const wrongPassword = "WrongPassword456!";

        // Create account with correct password
        await createAccountAndLogin(email, correctPassword);

        // Try to login with wrong password
        const client2 = await createClient();
        const startRes = await client2.startCreateSession(new StartCreateSessionParams({ email }));

        const wrongAuth = new Auth(email);
        wrongAuth.keyParams = startRes.keyParams;
        const wrongAuthKey = await wrongAuth.getAuthKey(wrongPassword);
        const wrongSrp = new SRPClient();
        await wrongSrp.initialize(wrongAuthKey);
        await wrongSrp.setB(startRes.B);

        let rejected = false;
        try {
            await client2.completeCreateSession(
                new CompleteCreateSessionParams({
                    accountId: startRes.accountId,
                    srpId: startRes.srpId,
                    A: wrongSrp.A!,
                    M: wrongSrp.M1!,
                    addTrustedDevice: false,
                })
            );
        } catch (err: unknown) {
            if (err instanceof Err && err.code === ErrorCode.INVALID_CREDENTIALS) {
                rejected = true;
            }
        }
        if (!rejected) throw new Error("Wrong password was not rejected with INVALID_CREDENTIALS");
    });

    // ── Test 4: Non-existent account login rejected ──
    await test("Non-existent account login rejected", async () => {
        const email = `nonexistent-${await uuid()}@test.padloc.app`;

        const client = await createClient();
        let rejected = false;
        try {
            await client.startCreateSession(new StartCreateSessionParams({ email }));
        } catch (err: unknown) {
            // Untrusted device without authToken → AUTHENTICATION_REQUIRED
            // (real Padloc requires email verification for new devices)
            if (
                err instanceof Err &&
                (err.code === ErrorCode.NOT_FOUND || err.code === ErrorCode.AUTHENTICATION_REQUIRED)
            ) {
                rejected = true;
            }
        }
        if (!rejected) throw new Error("Non-existent account login was not rejected");
    });

    // ── Test 5: Revoked session rejected ──
    await test("Revoked session rejected", async () => {
        const email = `revoked-session-${await uuid()}@test.padloc.app`;
        const password = "TestPassword123!";

        const { client } = await createAccountAndLogin(email, password);

        // Normal request should work
        const account = await client.getAccount();
        if (account.email !== email) throw new Error("Account email mismatch");

        // Revoke the session and verify subsequent requests fail
        const sessionId = client.state.session?.id;
        if (!sessionId) throw new Error("No session ID found");

        await client.revokeSession(sessionId);

        // Create a new client that tries to use the revoked session
        const client2 = await createClient();
        // Manually set the revoked session ID with a dummy key
        const revokedSession = new Session();
        revokedSession.id = sessionId;
        revokedSession.key = new Uint8Array(32);
        client2.state.session = revokedSession;
        client2.state.account = null;

        let sessionRejected = false;
        let lastError: unknown;
        try {
            await client2.getAccount();
        } catch (err: unknown) {
            lastError = err;
            // Revoked session is deleted from storage → NOT_FOUND or INVALID_SESSION
            if (
                err instanceof Err &&
                (err.code === ErrorCode.INVALID_SESSION ||
                    err.code === ErrorCode.NOT_FOUND ||
                    err.code === ErrorCode.SESSION_EXPIRED)
            ) {
                sessionRejected = true;
            }
        }
        if (!sessionRejected)
            throw new Error(
                `Revoked session was not rejected. Error: ${
                    lastError instanceof Err ? lastError.code : String(lastError)
                }`
            );
    });

    // ── TOTP MFA Tests ──

    // ── Test 6: TOTP registration happy path ──
    await test("TOTP registration succeeds", async () => {
        const email = `totp-reg-${await uuid()}@test.padloc.app`;
        const password = "TestPassword123!";
        const { client } = await createAccountAndLogin(email, password);

        // Start registering TOTP authenticator
        const regParams = new StartRegisterAuthenticatorParams({
            type: AuthType.Totp,
            purposes: [AuthPurpose.Login],
        });
        const regResponse = await client.startRegisterAuthenticator(regParams);

        if (!regResponse.id) throw new Error("TOTP registration returned no authenticator ID");
        if (!regResponse.data || !regResponse.data.secret) throw new Error("TOTP registration returned no secret");

        // Generate valid TOTP code from the returned secret
        const secretBytes = base32ToBytes(regResponse.data.secret);
        const code = await totp(secretBytes, Date.now(), { interval: 30, digits: 6, hash: "SHA-1" });

        // Complete registration with valid code
        const completeParams = new CompleteRegisterMFAuthenticatorParams({
            id: regResponse.id,
            data: { code },
        });
        const completeResponse = await client.completeRegisterAuthenticator(completeParams);

        if (completeResponse.id !== regResponse.id) throw new Error("TOTP completion returned wrong authenticator ID");
    });

    // ── Test 7: TOTP auth request returns correct type ──
    await test("TOTP startAuthRequest returns correct type", async () => {
        const email = `totp-authreq-${await uuid()}@test.padloc.app`;
        const password = "TestPassword123!";
        const { client } = await createAccountAndLogin(email, password);

        // Register TOTP (init only — don't complete, so no counter collision)
        const regResponse = await client.startRegisterAuthenticator(
            new StartRegisterAuthenticatorParams({
                type: AuthType.Totp,
                purposes: [AuthPurpose.Login],
            })
        );

        // Delete the registering authenticator so we can test auth request path clean
        await client.deleteAuthenticator(regResponse.id);

        // Re-register and complete with a code (consumes one counter)
        const reg2 = await client.startRegisterAuthenticator(
            new StartRegisterAuthenticatorParams({
                type: AuthType.Totp,
                purposes: [AuthPurpose.Login],
            })
        );
        const secretBytes = base32ToBytes(reg2.data.secret);
        const code = await totp(secretBytes, Date.now(), { interval: 30, digits: 6, hash: "SHA-1" });
        await client.completeRegisterAuthenticator(
            new CompleteRegisterMFAuthenticatorParams({
                id: reg2.id,
                data: { code },
            })
        );

        // Now start an auth request — verifies TOTP path is reachable
        const authResponse = await client.startAuthRequest(
            new StartAuthRequestParams({
                email,
                type: AuthType.Totp,
                purpose: AuthPurpose.Login,
            })
        );

        if (authResponse.type !== AuthType.Totp) throw new Error("Auth request returned wrong type");
        if (!authResponse.id) throw new Error("Auth request returned no ID");
    });

    // ── Test 8: TOTP wrong code rejection ──
    await test("TOTP wrong code rejected", async () => {
        const email = `totp-wrong-${await uuid()}@test.padloc.app`;
        const password = "TestPassword123!";
        const { client } = await createAccountAndLogin(email, password);

        // Register TOTP
        const regParams = new StartRegisterAuthenticatorParams({
            type: AuthType.Totp,
            purposes: [AuthPurpose.Login],
        });
        const regResponse = await client.startRegisterAuthenticator(regParams);
        const secretBytes = base32ToBytes(regResponse.data.secret);
        const code = await totp(secretBytes, Date.now(), { interval: 30, digits: 6, hash: "SHA-1" });

        await client.completeRegisterAuthenticator(
            new CompleteRegisterMFAuthenticatorParams({
                id: regResponse.id,
                data: { code },
            })
        );

        // Start auth request
        const authResponse = await client.startAuthRequest(
            new StartAuthRequestParams({
                email,
                type: AuthType.Totp,
                purpose: AuthPurpose.Login,
            })
        );

        // Try to complete with WRONG code
        let rejected = false;
        try {
            await client.completeAuthRequest(
                new CompleteAuthRequestParams({
                    email,
                    id: authResponse.id,
                    data: { code: "000000" },
                })
            );
        } catch (err: unknown) {
            if (err instanceof Err && err.code === ErrorCode.AUTHENTICATION_FAILED) {
                rejected = true;
            }
        }
        if (!rejected) throw new Error("Wrong TOTP code was not rejected");
    });

    // ── Test 9: TOTP counter replay — same counter rejected after registration ──
    await test("TOTP same-counter code rejected after registration", async () => {
        const email = `totp-replay-${await uuid()}@test.padloc.app`;
        const password = "TestPassword123!";
        const { client } = await createAccountAndLogin(email, password);

        const regResponse = await client.startRegisterAuthenticator(
            new StartRegisterAuthenticatorParams({
                type: AuthType.Totp,
                purposes: [AuthPurpose.Login],
            })
        );
        const secretBytes = base32ToBytes(regResponse.data.secret);

        // Registration consumes the current counter. Using the same counter
        // for auth request should be rejected as a replay.
        const code = await totp(secretBytes, Date.now(), { interval: 30, digits: 6, hash: "SHA-1" });
        await client.completeRegisterAuthenticator(
            new CompleteRegisterMFAuthenticatorParams({
                id: regResponse.id,
                data: { code },
            })
        );

        // Start auth request at the same counter window
        const authResponse = await client.startAuthRequest(
            new StartAuthRequestParams({
                email,
                type: AuthType.Totp,
                purpose: AuthPurpose.Login,
            })
        );

        // Attempting to verify at the same counter should fail (not yet advanced)
        let replayRejected = false;
        try {
            await client.completeAuthRequest(
                new CompleteAuthRequestParams({
                    email,
                    id: authResponse.id,
                    data: { code },
                })
            );
        } catch (err: unknown) {
            if (err instanceof Err && err.code === ErrorCode.AUTHENTICATION_FAILED) {
                replayRejected = true;
            }
        }
        if (!replayRejected) throw new Error("Same-counter TOTP code was not rejected (replay protection broken)");
    });

    return results;
}

export default {
    async fetch(request: Request, env: any, ctx: ExecutionContext): Promise<Response> {
        testEnv = env;

        const url = new URL(request.url);

        if (request.method === "GET" && url.pathname === "/auth-flow-tests") {
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
