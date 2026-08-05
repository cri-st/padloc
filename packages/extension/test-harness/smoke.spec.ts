import { test as base, expect, chromium, BrowserContext, Page, Worker } from "@playwright/test";
import path from "path";
import fs from "fs";
import os from "os";
import { execFile } from "child_process";
import { promisify } from "util";
import { verifyAssertion, verifyRegistration } from "../test/passkey-rp/shared-verifier";

const EXT_DIST = path.resolve(__dirname, "../dist");
const LOGIN_FIXTURE = path.join(__dirname, "fixtures", "login-form.html");
const LOGIN_URL = "https://passkey-test.example.com/";
const execFileAsync = promisify(execFile);

type ExtensionFixtures = {
    userDataDir: string;
    context: BrowserContext;
    page: Page;
    extensionWorker: Worker;
    extensionId: string;
};

const launchExtensionContext = (userDataDir: string) =>
    chromium.launchPersistentContext(userDataDir, {
        channel: "chromium",
        headless: true,
        args: [
            `--disable-extensions-except=${EXT_DIST}`,
            `--load-extension=${EXT_DIST}`,
            "--disable-backgrounding-occluded-windows",
            "--disable-renderer-backgrounding",
        ],
    });

const test = base.extend<ExtensionFixtures>({
    userDataDir: async ({}, use) => {
        const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "padloc-extension-test-"));
        await use(userDataDir);
        fs.rmSync(userDataDir, { recursive: true, force: true });
    },
    context: async ({ userDataDir }, use) => {
        const context = await launchExtensionContext(userDataDir);
        await use(context);
        await context.close().catch(() => undefined);
    },
    extensionWorker: async ({ context }, use) => {
        let [worker] = context.serviceWorkers();
        if (!worker) worker = await context.waitForEvent("serviceworker");
        await use(worker);
    },
    extensionId: async ({ extensionWorker }, use) => {
        await use(extensionWorker.url().split("/")[2]);
    },
    page: async ({ context }, use) => {
        const page = context.pages()[0] || (await context.newPage());
        const fixtureHtml = fs.readFileSync(LOGIN_FIXTURE, "utf8");
        await page.route(`${LOGIN_URL}**`, (route) =>
            route.fulfill({ status: 200, contentType: "text/html", body: fixtureHtml })
        );
        await use(page);
    },
});

test.describe("Extension smoke — unpacked extension runtime", () => {
    test("loads without console errors in popup", async ({ page, extensionId }) => {
        expect(extensionId).toBeTruthy();

        const errors: string[] = [];
        const warnings: string[] = [];
        page.on("console", (msg) => {
            if (msg.type() === "error") errors.push(msg.text());
            if (msg.type() === "warning") warnings.push(msg.text());
        });
        page.on("pageerror", (err) => errors.push(err.message));

        await page.goto(`chrome-extension://${extensionId}/popup.html`);
        await page.waitForLoadState("networkidle");

        const critical = errors.filter((e) => !e.includes("favicon") && !e.includes("net::ERR_BLOCKED_BY_CLIENT"));
        expect(critical, `Console errors: ${JSON.stringify(critical)}`).toHaveLength(0);

        const criticalWarnings = warnings.filter(
            (warning) =>
                warning.includes("Lit is in dev mode") ||
                warning.includes("lit-element") ||
                warning.includes("scheduled an update")
        );
        expect(criticalWarnings, `Console warnings: ${JSON.stringify(criticalWarnings)}`).toHaveLength(0);
    });

    test("popup opens from toolbar action", async ({ page, extensionId }) => {
        expect(extensionId).toBeTruthy();

        await page.goto(`chrome-extension://${extensionId}/popup.html`);
        const body = await page.locator("body").innerHTML();
        expect(body.trim().length, "Popup body should not be empty").toBeGreaterThan(0);
    });

    test("background worker initializes its runtime bridge", async ({ extensionWorker }) => {
        await expect
            .poll(() => extensionWorker.evaluate(() => (globalThis as any).padlocPasskeyDiagnostics?.lastStage))
            .toBe("idle");
        const diagnostics = await extensionWorker.evaluate(() => ({
            brokerType: typeof (globalThis as any).padlocAgenticAutofillBroker,
            passkeyDiagnostics: (globalThis as any).padlocPasskeyDiagnostics,
            runtimeId: chrome.runtime.id,
        }));
        expect(diagnostics.runtimeId).toBeTruthy();
        expect(diagnostics.brokerType).toBe("function");
        expect(diagnostics.passkeyDiagnostics).toMatchObject({ lastStage: "idle" });
    });

    test("extension loads on a plain page and badge updates", async ({ page, extensionWorker }) => {
        await page.goto(LOGIN_URL);
        await page.waitForTimeout(1500);

        const badge = await extensionWorker.evaluate(async () => {
            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
            return chrome.action.getBadgeText({ tabId: tab.id });
        });
        expect(typeof badge).toBe("string");
    });

    test("content script detects form fields on fixture page", async ({ page }) => {
        await page.goto(LOGIN_URL);
        await page.waitForLoadState("networkidle");

        const fields = await page.evaluate(() => {
            const inputs = document.querySelectorAll("input");
            return Array.from(inputs).map((el) => ({
                type: el.getAttribute("type"),
                name: el.getAttribute("name"),
                id: el.getAttribute("id"),
            }));
        });

        expect(fields.some((f: any) => f.type === "email" || f.name === "username")).toBeTruthy();
        expect(fields.some((f: any) => f.type === "password")).toBeTruthy();
    });

    test("content script responds to isContentReady on fixture page", async ({ page, extensionWorker }) => {
        await page.goto(LOGIN_URL);
        await page.waitForLoadState("networkidle");
        await page.waitForTimeout(500);

        const ready = await extensionWorker.evaluate(async () => {
            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
            return chrome.tabs.sendMessage(tab.id, { type: "isContentReady" });
        });
        expect(ready, "Content script should respond true to isContentReady").toBe(true);
    });

    test("enabled CH5 canary installs the provider while an abandoned bridge request stays bounded", async ({
        page,
    }) => {
        await page.goto(LOGIN_URL);
        await page.waitForFunction(() => Boolean((navigator.credentials as any).__padlocPasskeyInterceptorV1), null, {
            timeout: 3_000,
        });
        const result = await page.evaluate(
            () =>
                new Promise<any>((resolve, reject) => {
                    const timeout = window.setTimeout(
                        () => reject(new Error("Passkey bridge response timed out")),
                        3_000
                    );
                    window.addEventListener("message", (event) => {
                        if (event.data?.source !== "padloc-passkey-extension" || event.data?.kind !== "result") return;
                        const detail = event.data.detail;
                        if (detail?.requestId !== "browser-bridge-smoke") return;
                        window.clearTimeout(timeout);
                        resolve(detail);
                    });
                    window.postMessage(
                        {
                            source: "padloc-passkey-page",
                            kind: "request",
                            detail: {
                                protocolVersion: 1,
                                requestId: "browser-bridge-smoke",
                                operation: "get",
                                options: {
                                    challenge: { __padlocWebAuthnType: "buffer", base64url: "AA" },
                                    timeout: 1_000,
                                },
                                origin: "https://attacker.invalid",
                            },
                        },
                        "*"
                    );
                })
        );

        expect(result).toMatchObject({
            type: "passkeyResult",
            protocolVersion: 1,
            requestId: "browser-bridge-smoke",
            outcome: "fallback",
        });
    });

    test("dist contains manifest.json before any browser work", () => {
        const manifestPath = path.join(EXT_DIST, "manifest.json");
        expect(fs.existsSync(manifestPath), `${manifestPath} must exist`).toBe(true);
    });

    test("popup initializes the extension app when logged out", async ({ page, extensionId }) => {
        expect(extensionId).toBeTruthy();

        await page.goto(`chrome-extension://${extensionId}/popup.html`);
        await page.waitForLoadState("networkidle");
        const app = page.locator("pl-extension-app");
        await expect(app).toHaveCount(1, { timeout: 10_000 });
        await expect
            .poll(() => page.evaluate(() => customElements.get("pl-extension-app")?.name || ""))
            .toBe("ExtensionApp");
        await expect(page.getByText("CH5 Auth failed to load.")).toHaveCount(0);
    });

    test("manifest grants identity permission for OAuth", async () => {
        const manifestPath = path.join(EXT_DIST, "manifest.json");
        const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
        expect(manifest.permissions || []).toContain("identity");
    });

    test("manifest exposes content_scripts for all_urls", async () => {
        const manifestPath = path.join(EXT_DIST, "manifest.json");
        const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
        const cs = (manifest.content_scripts || []).find((s: any) => s.matches && s.matches.includes("<all_urls>"));
        expect(cs, "content script must be registered for <all_urls>").toBeTruthy();
    });

    test("content script autofill routes username/password/totp to correct fields", async ({
        page,
        extensionWorker,
    }) => {
        await page.goto(LOGIN_URL);
        await page.waitForLoadState("networkidle");
        await page.waitForTimeout(500);

        await extensionWorker.evaluate(async () => {
            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
            return chrome.tabs.sendMessage(tab.id, {
                type: "fillFields",
                mappings: { username: "alice", password: "sekret", totp: "123456" },
            });
        });

        await page.waitForTimeout(300);

        const usernameVal = await page.locator("#username").inputValue();
        const passwordVal = await page.locator("#password").inputValue();
        const totpVal = await page.locator("#totp").inputValue();

        expect(usernameVal, "Username field should receive alice").toBe("alice");
        expect(passwordVal, "Password field should receive sekret").toBe("sekret");
        expect(totpVal, "TOTP field should receive 123456").toBe("123456");
    });

    test("extension worker routes fillFields message to content script", async ({ page, extensionWorker }) => {
        await page.goto(LOGIN_URL);
        await page.waitForLoadState("networkidle");
        await page.waitForTimeout(500);

        await extensionWorker.evaluate(async () => {
            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
            return chrome.tabs.sendMessage(tab.id, {
                type: "fillFields",
                mappings: { username: "alice", password: "secret123" },
            });
        });

        const usernameVal = await page.locator("#username").inputValue();
        const passwordVal = await page.locator("#password").inputValue();

        expect(usernameVal).toBe("alice");
        expect(passwordVal).toBe("secret123");
    });

    test("controlled CH5 RP creates and verifies a vault-held passkey through the approval popup", async ({
        page,
        context,
        extensionWorker,
        extensionId,
        userDataDir,
    }) => {
        test.skip(process.env.PADLOC_PASSKEY_E2E !== "1", "Requires the local Worker canary environment");
        test.setTimeout(300_000);

        const canaryId = process.env.PADLOC_PASSKEY_CANARY_ID || String(Date.now());
        const email = `passkey-canary-${canaryId}@example.test`;
        const password = "LocalPasskeyCanary-Only-42!";
        const popup = await context.newPage();
        await popup.goto(`chrome-extension://${extensionId}/popup.html`);
        await expect(popup.locator("pl-extension-app")).toHaveCount(1, { timeout: 10_000 });
        const deviceId = await popup.evaluate(async () => {
            const element = document.querySelector("pl-extension-app") as any;
            const application = element?.app || (window as any).app;
            if (!application) throw new Error("Extension App instance was not exposed by the popup");
            await Promise.race([application.loaded, new Promise((resolve) => setTimeout(resolve, 3_000))]);
            if (!application.state.device.id) throw new Error("Extension device ID was not initialized");
            return application.state.device.id as string;
        });
        await execFileAsync(
            process.execPath,
            [
                "-r",
                path.resolve(__dirname, "../../../node_modules/ts-node/register"),
                "-r",
                path.resolve(__dirname, "../node_modules/tsconfig-paths/register"),
                path.resolve(__dirname, "local-account.ts"),
                process.env.PL_SERVER_URL || "http://127.0.0.1:8787",
                email,
                password,
                deviceId,
            ],
            {
                env: {
                    ...process.env,
                    TS_NODE_TRANSPILE_ONLY: "1",
                    TS_NODE_PROJECT: path.resolve(__dirname, "../tsconfig.json"),
                    TS_NODE_COMPILER_OPTIONS: JSON.stringify({
                        module: "commonjs",
                        experimentalDecorators: true,
                        useDefineForClassFields: false,
                    }),
                },
            }
        );
        await popup.evaluate(
            ({ email: accountEmail, password: masterPassword }) => {
                const application = (window as any).app;
                (window as any).__padlocLoginResult = null;
                void application
                    .login({
                        email: accountEmail,
                        password: masterPassword,
                    })
                    .then(
                        () => ((window as any).__padlocLoginResult = { ok: true }),
                        (error: Error) =>
                            ((window as any).__padlocLoginResult = {
                                ok: false,
                                name: error.name,
                                message: error.message,
                                code: (error as any).code,
                                detail: String(error),
                            })
                    );
            },
            { email, password }
        );
        await popup.waitForFunction(() => {
            const application = (window as any).app;
            const loginResult = (window as any).__padlocLoginResult;
            if (loginResult?.ok === false) throw new Error(JSON.stringify(loginResult));
            return (
                application?.state.loggedIn === true &&
                application?.state.locked === false &&
                Boolean(application?.mainVault)
            );
        });

        await page.goto(LOGIN_URL);
        await page.waitForFunction(() => Boolean((navigator.credentials as any).__padlocPasskeyInterceptorV1));
        await page.evaluate((accountEmail) => {
            const state = ((window as any).__padlocPasskeyCanary = {});
            const registrationChallenge = crypto.getRandomValues(new Uint8Array(32));
            state.registrationChallenge = Array.from(registrationChallenge);
            void navigator.credentials
                .create({
                    publicKey: {
                        challenge: registrationChallenge,
                        rp: {
                            id: "example.com",
                            name: '<img src=x onerror="globalThis.__padlocPromptInjected=true"> CH5 Passkey Canary',
                        },
                        user: {
                            id: new TextEncoder().encode(accountEmail),
                            name: accountEmail,
                            displayName: "<script>globalThis.__padlocPromptInjected=true</script>",
                        },
                        pubKeyCredParams: [{ type: "public-key", alg: -7 }],
                        authenticatorSelection: {
                            authenticatorAttachment: "platform",
                            residentKey: "required",
                            userVerification: "required",
                        },
                        attestation: "none",
                        timeout: 60_000,
                    },
                })
                .then((credential) => {
                    state.registration = credential;
                    state.registrations = [credential];
                    state.createResult = { ok: true, credential: (credential as any).toJSON() };
                })
                .catch((error) => {
                    state.createResult = { ok: false, name: error.name, message: error.message };
                });
        }, email);

        await page.waitForTimeout(1_000);
        const earlyCreateResult = await page.evaluate(() => (window as any).__padlocPasskeyCanary.createResult);
        if (earlyCreateResult) {
            throw new Error(`Passkey create returned before approval: ${JSON.stringify(earlyCreateResult)}`);
        }
        const currentExtensionWorker =
            context.serviceWorkers().find((worker) => worker.url().startsWith(`chrome-extension://${extensionId}/`)) ||
            extensionWorker;
        const passkeyWorkerState = await currentExtensionWorker.evaluate(() => ({
            diagnostics: (globalThis as any).padlocPasskeyDiagnostics,
            brokerType: typeof (globalThis as any).padlocAgenticAutofillBroker,
            runtimeId: chrome.runtime.id,
        }));
        expect(passkeyWorkerState, "Background passkey diagnostics must be available").toMatchObject({
            diagnostics: {
                lastStage: "approval-pending",
                connectionCount: 1,
                requestCount: 1,
            },
            brokerType: "function",
            runtimeId: extensionId,
        });
        await expect
            .poll(() => extensionWorker.evaluate(() => chrome.action.getBadgeText({})), { timeout: 10_000 })
            .toBe("PK");
        const approvalResponse = await popup.evaluate(() =>
            chrome.runtime.sendMessage({ type: "getPasskeyApprovalPrompt" })
        );
        expect(approvalResponse).toMatchObject({
            type: "getPasskeyApprovalPromptResponse",
            prompt: { operation: "create", rpId: "example.com" },
        });
        await popup.evaluate(async () => {
            await (document.querySelector("pl-extension-app") as any)._checkForPasskeyApproval();
        });
        expect(await popup.evaluate(() => (window as any).__padlocPromptInjected)).toBeUndefined();
        await expect(popup.locator(".save-prompt-overlay img[src='x']")).toHaveCount(0);
        await expect(popup.locator(".save-prompt-overlay script")).toHaveCount(0);
        await expect(popup.locator(".save-prompt-overlay")).toContainText("<img src=x onerror=");
        await expect(popup.locator(".save-prompt-overlay")).toContainText("<script>globalThis.__padlocPromptInjected");
        await popup.evaluate(() => {
            (document.querySelector("pl-extension-app") as any)._lastFreshUserVerificationAt = 0;
        });
        await popup.locator("#passkey-approve").click({ timeout: 5_000 });
        await popup.waitForFunction(() => (window as any).app?.state.locked === true);
        expect(
            await page.evaluate(() => (window as any).__padlocPasskeyCanary.createResult),
            "Password fallback must not approve the pending ceremony"
        ).toBeUndefined();
        expect(
            await popup.evaluate(() => chrome.runtime.sendMessage({ type: "getPasskeyApprovalPrompt" })),
            "Password fallback must retain the background approval prompt"
        ).toMatchObject({
            type: "getPasskeyApprovalPromptResponse",
            prompt: { operation: "create", rpId: "example.com" },
        });
        await popup.evaluate(async (masterPassword) => {
            await (window as any).app.unlock(masterPassword);
            await (document.querySelector("pl-extension-app") as any)._unlocked();
        }, password);
        await popup.waitForFunction(() => (window as any).app?.state.locked === false);
        await expect(popup.locator("#passkey-approve")).toBeVisible({ timeout: 10_000 });
        await popup.locator("#passkey-approve").click();
        await page.waitForFunction(() => Boolean((window as any).__padlocPasskeyCanary.createResult), null, {
            timeout: 30_000,
        });
        const createResult = await page.evaluate(() => (window as any).__padlocPasskeyCanary.createResult);
        expect(createResult).toMatchObject({
            ok: true,
            credential: {
                type: "public-key",
                authenticatorAttachment: "platform",
                response: { publicKeyAlgorithm: -7, transports: ["internal"] },
            },
        });
        const registrationChallenge = new Uint8Array(
            await page.evaluate(() => (window as any).__padlocPasskeyCanary.registrationChallenge)
        );
        const registered = verifyRegistration({
            clientDataJSON: Buffer.from(createResult.credential.response.clientDataJSON, "base64url"),
            attestationObject: Buffer.from(createResult.credential.response.attestationObject, "base64url"),
            credentialID: Buffer.from(createResult.credential.rawId, "base64url"),
            expectedChallenge: registrationChallenge,
            expectedOrigin: LOGIN_URL.slice(0, -1),
            expectedRpID: "example.com",
            requireUV: true,
            requireBackupEligible: true,
            requireBackupState: true,
        });

        await page.evaluate(() => {
            const state = (window as any).__padlocPasskeyCanary;
            const registration = state.registration as PublicKeyCredential;
            const assertionChallenge = crypto.getRandomValues(new Uint8Array(32));
            state.assertionChallenge = Array.from(assertionChallenge);
            void navigator.credentials
                .get({
                    publicKey: {
                        challenge: assertionChallenge,
                        rpId: "example.com",
                        allowCredentials: [{ type: "public-key", id: registration.rawId, transports: ["internal"] }],
                        userVerification: "required",
                        timeout: 60_000,
                    },
                })
                .then(async (credential) => {
                    const assertion = credential as PublicKeyCredential;
                    const response = assertion.response as AuthenticatorAssertionResponse;
                    const registrationResponse = registration.response as AuthenticatorAttestationResponse;
                    const publicKey = await crypto.subtle.importKey(
                        "spki",
                        registrationResponse.getPublicKey()!,
                        { name: "ECDSA", namedCurve: "P-256" },
                        false,
                        ["verify"]
                    );
                    const clientDataHash = new Uint8Array(
                        await crypto.subtle.digest("SHA-256", response.clientDataJSON)
                    );
                    const authenticatorData = new Uint8Array(response.authenticatorData);
                    const signedData = new Uint8Array(authenticatorData.length + clientDataHash.length);
                    signedData.set(authenticatorData);
                    signedData.set(clientDataHash, authenticatorData.length);
                    const der = new Uint8Array(response.signature);
                    let offset = 2;
                    const readInteger = () => {
                        if (der[offset++] !== 0x02) throw new Error("Invalid DER integer");
                        const length = der[offset++];
                        const value = der.slice(offset, offset + length);
                        offset += length;
                        return value[0] === 0 ? value.slice(1) : value;
                    };
                    const r = readInteger();
                    const s = readInteger();
                    const p1363 = new Uint8Array(64);
                    p1363.set(r, 32 - r.length);
                    p1363.set(s, 64 - s.length);
                    const verified = await crypto.subtle.verify(
                        { name: "ECDSA", hash: "SHA-256" },
                        publicKey,
                        p1363,
                        signedData
                    );
                    const expectedRpHash = new Uint8Array(
                        await crypto.subtle.digest("SHA-256", new TextEncoder().encode("example.com"))
                    );
                    const rpHashMatches = expectedRpHash.every((byte, index) => authenticatorData[index] === byte);
                    const clientData = JSON.parse(new TextDecoder().decode(response.clientDataJSON));
                    state.getResult = {
                        ok: true,
                        verified,
                        rpHashMatches,
                        clientType: clientData.type,
                        origin: clientData.origin,
                        idMatches: assertion.id === registration.id,
                        credential: assertion.toJSON(),
                    };
                })
                .catch((error) => {
                    state.getResult = { ok: false, name: error.name, message: error.message };
                });
        });

        await expect
            .poll(() => extensionWorker.evaluate(() => chrome.action.getBadgeText({})), { timeout: 10_000 })
            .toBe("PK");
        await popup.evaluate(async () => {
            await (document.querySelector("pl-extension-app") as any)._checkForPasskeyApproval();
        });
        await popup.locator("#passkey-approve").click();
        await page.waitForFunction(() => Boolean((window as any).__padlocPasskeyCanary.getResult), null, {
            timeout: 30_000,
        });
        const getResult = await page.evaluate(() => (window as any).__padlocPasskeyCanary.getResult);
        expect(getResult).toEqual({
            ok: true,
            verified: true,
            rpHashMatches: true,
            clientType: "webauthn.get",
            origin: "https://passkey-test.example.com",
            idMatches: true,
            credential: expect.any(Object),
        });
        const assertionChallenge = new Uint8Array(
            await page.evaluate(() => (window as any).__padlocPasskeyCanary.assertionChallenge)
        );
        const assertionCredential = getResult.credential;
        expect(
            verifyAssertion({
                clientDataJSON: Buffer.from(assertionCredential.response.clientDataJSON, "base64url"),
                authenticatorData: Buffer.from(assertionCredential.response.authenticatorData, "base64url"),
                signature: Buffer.from(assertionCredential.response.signature, "base64url"),
                credentialID: Buffer.from(assertionCredential.rawId, "base64url"),
                expectedCredentialID: Buffer.from(createResult.credential.rawId, "base64url"),
                publicKeyJwk: registered.publicKeyJwk,
                expectedChallenge: assertionChallenge,
                expectedOrigin: LOGIN_URL.slice(0, -1),
                expectedRpID: "example.com",
                requireUV: true,
                requireBackupEligible: true,
                requireBackupState: true,
            })
        ).toMatchObject({ counter: 0 });

        const additionalAccounts = Array.from({ length: 4 }, (_, index) =>
            email.replace("@example.test", `+profile-${index + 2}@example.test`)
        );
        for (const [index, accountEmail] of additionalAccounts.entries()) {
            await page.evaluate(
                ({ accountEmail: nextAccount, userIndex }) => {
                    const state = (window as any).__padlocPasskeyCanary;
                    state.additionalCreateResult = null;
                    void navigator.credentials
                        .create({
                            publicKey: {
                                challenge: crypto.getRandomValues(new Uint8Array(32)),
                                rp: { id: "example.com", name: "CH5 Passkey Canary" },
                                user: {
                                    id: new TextEncoder().encode(nextAccount),
                                    name: nextAccount,
                                    displayName: `Passkey Canary Profile ${userIndex}`,
                                },
                                pubKeyCredParams: [{ type: "public-key", alg: -7 }],
                                authenticatorSelection: {
                                    authenticatorAttachment: "platform",
                                    residentKey: "required",
                                    userVerification: "required",
                                },
                                attestation: "none",
                                timeout: 60_000,
                            },
                        })
                        .then((credential) => {
                            state.registrations.push(credential);
                            state.additionalCreateResult = { ok: true, id: (credential as PublicKeyCredential).id };
                        })
                        .catch((error) => {
                            state.additionalCreateResult = { ok: false, name: error.name, message: error.message };
                        });
                },
                { accountEmail, userIndex: index + 2 }
            );
            await expect
                .poll(() => extensionWorker.evaluate(() => chrome.action.getBadgeText({})), { timeout: 10_000 })
                .toBe("PK");
            await popup.evaluate(async () => {
                await (document.querySelector("pl-extension-app") as any)._checkForPasskeyApproval();
            });
            await popup.locator("#passkey-approve").click();
            await page.waitForFunction(
                () => Boolean((window as any).__padlocPasskeyCanary.additionalCreateResult),
                null,
                {
                    timeout: 30_000,
                }
            );
            expect(
                await page.evaluate(() => (window as any).__padlocPasskeyCanary.additionalCreateResult)
            ).toMatchObject({
                ok: true,
            });
        }

        const selectedAccount = additionalAccounts[2];
        await page.evaluate(() => {
            const state = (window as any).__padlocPasskeyCanary;
            state.selectionGetResult = null;
            void navigator.credentials
                .get({
                    publicKey: {
                        challenge: crypto.getRandomValues(new Uint8Array(32)),
                        rpId: "example.com",
                        userVerification: "required",
                        timeout: 60_000,
                    },
                })
                .then((credential) => {
                    const assertion = credential as PublicKeyCredential;
                    state.selectionGetResult = {
                        ok: true,
                        id: assertion.id,
                        expectedId: state.registrations[3].id,
                    };
                })
                .catch((error) => {
                    state.selectionGetResult = { ok: false, name: error.name, message: error.message };
                });
        });
        await expect
            .poll(() => extensionWorker.evaluate(() => chrome.action.getBadgeText({})), { timeout: 10_000 })
            .toBe("PK");
        await popup.evaluate(async () => {
            await (document.querySelector("pl-extension-app") as any)._checkForPasskeyApproval();
        });
        await popup.locator("#passkey-approve").click();
        await expect(popup.locator(".passkey-selection-option")).toHaveCount(5, { timeout: 10_000 });
        await popup.locator(".passkey-selection-option", { hasText: selectedAccount }).click();
        await popup.locator("#passkey-selection-confirm").click();
        await page.waitForFunction(() => Boolean((window as any).__padlocPasskeyCanary.selectionGetResult), null, {
            timeout: 30_000,
        });
        expect(await page.evaluate(() => (window as any).__padlocPasskeyCanary.selectionGetResult)).toEqual({
            ok: true,
            id: await page.evaluate(() => (window as any).__padlocPasskeyCanary.registrations[3].id),
            expectedId: await page.evaluate(() => (window as any).__padlocPasskeyCanary.registrations[3].id),
        });

        const persisted = await popup.evaluate(async () => {
            await (window as any).app.reload();
            const credentials = (window as any).app.vaults.flatMap((vault: any) =>
                Array.from(vault.items).flatMap((item: any) => item.passkeys || [])
            );
            return credentials.map((credential: any) => ({
                rpId: credential.rpId,
                userName: credential.userName,
                counter: credential.counter,
                counterPolicy: credential.counterPolicy,
                backupEligible: credential.backupEligible,
                backupState: credential.backupState,
                hasLastUsed: credential.lastUsed instanceof Date,
                privateKeyPresent: Boolean(credential.keyMaterial?.privateKeyJwk?.d),
            }));
        });
        expect(persisted).toHaveLength(5);
        expect(persisted).toEqual(
            expect.arrayContaining([
                {
                    rpId: "example.com",
                    userName: email,
                    counter: 0,
                    counterPolicy: "none",
                    backupEligible: true,
                    backupState: true,
                    hasLastUsed: true,
                    privateKeyPresent: true,
                },
                {
                    rpId: "example.com",
                    userName: selectedAccount,
                    counter: 0,
                    counterPolicy: "none",
                    backupEligible: true,
                    backupState: true,
                    hasLastUsed: true,
                    privateKeyPresent: true,
                },
            ])
        );
        expect(persisted.every((credential: any) => credential.privateKeyPresent)).toBe(true);
        await popup.close();
        await page.close();
        await context.close();
        const restartedContext = await launchExtensionContext(userDataDir);
        try {
            let [restartedWorker] = restartedContext.serviceWorkers();
            if (!restartedWorker) restartedWorker = await restartedContext.waitForEvent("serviceworker");
            const restartedExtensionId = restartedWorker.url().split("/")[2];
            expect(restartedExtensionId).toBe(extensionId);
            const restartedPopup = await restartedContext.newPage();
            await restartedPopup.goto(`chrome-extension://${extensionId}/popup.html`);
            await restartedPopup.waitForFunction(() => Boolean((window as any).app?.state?.loggedIn));
            if (await restartedPopup.evaluate(() => (window as any).app.state.locked)) {
                await restartedPopup.evaluate(
                    async (masterPassword) => (window as any).app.unlock(masterPassword),
                    password
                );
            }
            const restartedPage = await restartedContext.newPage();
            const fixtureHtml = fs.readFileSync(LOGIN_FIXTURE, "utf8");
            await restartedPage.route(`${LOGIN_URL}**`, (route) =>
                route.fulfill({ status: 200, contentType: "text/html", body: fixtureHtml })
            );
            await restartedPage.goto(LOGIN_URL);
            await restartedPage.waitForFunction(() =>
                Boolean((navigator.credentials as any).__padlocPasskeyInterceptorV1)
            );
            const restartChallenge = Array.from(crypto.getRandomValues(new Uint8Array(32)));
            await restartedPage.evaluate(
                ({ challenge, credentialID }) => {
                    const decode = (value: string) =>
                        Uint8Array.from(
                            atob(
                                value
                                    .replace(/-/g, "+")
                                    .replace(/_/g, "/")
                                    .padEnd(Math.ceil(value.length / 4) * 4, "=")
                            ),
                            (character) => character.charCodeAt(0)
                        );
                    const state = ((window as any).__padlocRestartAssertion = {});
                    void navigator.credentials
                        .get({
                            publicKey: {
                                challenge: new Uint8Array(challenge),
                                rpId: "example.com",
                                allowCredentials: [
                                    { type: "public-key", id: decode(credentialID), transports: ["internal"] },
                                ],
                                userVerification: "required",
                                timeout: 60_000,
                            },
                        })
                        .then(
                            (credential) =>
                                (state.result = { ok: true, credential: (credential as PublicKeyCredential).toJSON() }),
                            (error) => (state.result = { ok: false, name: error.name })
                        );
                },
                { challenge: restartChallenge, credentialID: createResult.credential.rawId }
            );
            await expect.poll(() => restartedWorker.evaluate(() => chrome.action.getBadgeText({}))).toBe("PK");
            await restartedPopup.evaluate(async () => {
                await (document.querySelector("pl-extension-app") as any)._checkForPasskeyApproval();
            });
            await restartedPopup.locator("#passkey-approve").click();
            await restartedPage.waitForFunction(() => Boolean((window as any).__padlocRestartAssertion.result));
            const restartResult = await restartedPage.evaluate(() => (window as any).__padlocRestartAssertion.result);
            expect(restartResult.ok).toBe(true);
            expect(
                verifyAssertion({
                    clientDataJSON: Buffer.from(restartResult.credential.response.clientDataJSON, "base64url"),
                    authenticatorData: Buffer.from(restartResult.credential.response.authenticatorData, "base64url"),
                    signature: Buffer.from(restartResult.credential.response.signature, "base64url"),
                    credentialID: Buffer.from(restartResult.credential.rawId, "base64url"),
                    expectedCredentialID: Buffer.from(createResult.credential.rawId, "base64url"),
                    publicKeyJwk: registered.publicKeyJwk,
                    expectedChallenge: new Uint8Array(restartChallenge),
                    expectedOrigin: LOGIN_URL.slice(0, -1),
                    expectedRpID: "example.com",
                    requireUV: true,
                    requireBackupEligible: true,
                    requireBackupState: true,
                })
            ).toMatchObject({ counter: 0 });
            await restartedPopup.evaluate(async () => {
                await (window as any).app.deleteAccount();
            });
        } finally {
            await restartedContext.close();
        }
    });
});
