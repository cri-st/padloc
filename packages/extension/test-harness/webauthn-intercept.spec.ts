import { chromium, expect, test } from "@playwright/test";
import fs from "fs";
import os from "os";
import path from "path";

const EXT_DIST = path.resolve(__dirname, "../dist");
const HEADFUL = process.env.PADLOC_EXTENSION_HEADFUL === "1";

test("main-world WebAuthn create is intercepted before native browser handling", async () => {
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "padloc-webauthn-intercept-"));
    const context = await chromium.launchPersistentContext(userDataDir, {
        headless: false,
        args: [
            ...(HEADFUL ? [] : ["--headless=new"]),
            `--disable-extensions-except=${EXT_DIST}`,
            `--load-extension=${EXT_DIST}`,
            "--disable-backgrounding-occluded-windows",
            "--disable-renderer-backgrounding",
        ],
    });
    try {
        const worker =
            context.serviceWorkers()[0] || (await context.waitForEvent("serviceworker", { timeout: 15_000 }));
        expect(worker.url()).toContain("chrome-extension://");

        const page = await context.newPage();
        await page.route("https://passkey-test.example.com/**", (route) =>
            route.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><title>Passkey test</title>" })
        );
        await page.goto("https://passkey-test.example.com/");
        await page.waitForLoadState("domcontentloaded");

        const unsupportedAlgorithm = await page.evaluate(async () => {
            try {
                await navigator.credentials.create({
                    publicKey: {
                        challenge: crypto.getRandomValues(new Uint8Array(32)),
                        rp: { id: "example.com", name: "CH5" },
                        user: {
                            id: crypto.getRandomValues(new Uint8Array(16)),
                            name: "agent@example.com",
                            displayName: "Agent",
                        },
                        pubKeyCredParams: [{ type: "public-key", alg: -257 }],
                    },
                });
                return { ok: true };
            } catch (error) {
                return {
                    ok: false,
                    name: error instanceof DOMException ? error.name : "",
                    message: error instanceof Error ? error.message : String(error),
                };
            }
        });
        expect(unsupportedAlgorithm).toMatchObject({
            ok: false,
            name: "NotSupportedError",
        });

        await page.evaluate(() => {
            const controller = new AbortController();
            (window as any).__padlocInterceptController = controller;
            (window as any).__padlocInterceptResult = navigator.credentials
                .create({
                    signal: controller.signal,
                    publicKey: {
                        challenge: crypto.getRandomValues(new Uint8Array(32)),
                        rp: { id: "example.com", name: "CH5" },
                        user: {
                            id: crypto.getRandomValues(new Uint8Array(16)),
                            name: "agent@example.com",
                            displayName: "Agent",
                        },
                        pubKeyCredParams: [{ type: "public-key", alg: -7 }],
                        authenticatorSelection: { userVerification: "required" },
                    },
                })
                .then(() => ({ ok: true }))
                .catch((error) => ({
                    ok: false,
                    name: error instanceof DOMException ? error.name : "",
                    message: error instanceof Error ? error.message : String(error),
                }));
        });
        await expect
            .poll(() => worker.evaluate(() => (globalThis as any).padlocPasskeyDiagnostics?.lastStage))
            .toBe("approval-pending");
        const intercepted = await page.evaluate(async () => {
            (window as any).__padlocInterceptController.abort();
            return (window as any).__padlocInterceptResult;
        });

        expect(intercepted).toMatchObject({
            ok: false,
            name: "AbortError",
        });
        expect((intercepted as { message: string }).message).toContain("aborted");
    } finally {
        await context.close();
        fs.rmSync(userDataDir, { recursive: true, force: true });
    }
});

test("main-world WebAuthn hooks survive extension reload on Google-shaped pages", async () => {
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "padloc-webauthn-google-reload-"));
    const context = await chromium.launchPersistentContext(userDataDir, {
        headless: false,
        args: [
            ...(HEADFUL ? [] : ["--headless=new"]),
            `--disable-extensions-except=${EXT_DIST}`,
            `--load-extension=${EXT_DIST}`,
            "--disable-backgrounding-occluded-windows",
            "--disable-renderer-backgrounding",
        ],
    });
    try {
        const worker =
            context.serviceWorkers()[0] || (await context.waitForEvent("serviceworker", { timeout: 15_000 }));
        const extId = worker.url().match(/^chrome-extension:\/\/([^/]+)\//)?.[1];
        expect(extId).toBeTruthy();

        const googlePage = await context.newPage();
        await googlePage.goto("https://accounts.google.com/", { waitUntil: "domcontentloaded" });
        await expectHooks(googlePage);

        const browser = context.browser();
        expect(browser).toBeTruthy();
        const browserSession = await browser!.newBrowserCDPSession();
        const loaded = await browserSession.send("Extensions.loadUnpacked", { path: EXT_DIST });
        expect((loaded as { id?: string }).id).toBeTruthy();
        const reloadedExtensionPage = await context.newPage();
        await reloadedExtensionPage.goto(`chrome-extension://${extId}/popup.html`);
        const workerAfterReload =
            context.serviceWorkers().find((serviceWorker) => serviceWorker.url().includes(extId)) ||
            (await context.waitForEvent("serviceworker", { timeout: 15_000 }));
        expect(workerAfterReload.url()).toContain(extId);
        await googlePage.reload({ waitUntil: "domcontentloaded" });
        await expectHooks(googlePage);
    } finally {
        await context.close();
        fs.rmSync(userDataDir, { recursive: true, force: true });
    }
});

async function expectHooks(page: import("@playwright/test").Page) {
    const hookState = await page.evaluate(async () => ({
        createHooked: !String(navigator.credentials.create).includes("[native code]"),
        getHooked: !String(navigator.credentials.get).includes("[native code]"),
        uvpaa: await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable(),
        capabilities: PublicKeyCredential.getClientCapabilities
            ? await PublicKeyCredential.getClientCapabilities()
            : {},
    }));
    expect(hookState.createHooked).toBe(true);
    expect(hookState.getHooked).toBe(true);
    expect(typeof hookState.uvpaa).toBe("boolean");
    expect(typeof hookState.capabilities).toBe("object");
}
