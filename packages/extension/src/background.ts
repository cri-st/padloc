import { browser, Menus, Runtime } from "webextension-polyfill-ts";
import { setPlatform } from "@padloc/core/src/platform";
import { App } from "@padloc/core/src/app";
import { debounce, uuid } from "@padloc/core/src/util";
import { FieldType, Field, VaultItem } from "@padloc/core/src/item";
import { PasskeyCredential } from "@padloc/core/src/passkey";
import { resolveAppName } from "@padloc/core/src/branding";
import { bytesToBase64 } from "@padloc/core/src/encoding";
import { ExtensionWorkerPlatform } from "./worker-platform";
import { FetchSender } from "./fetch-sender";
import {
    AgenticAutofillApprovalPrompt,
    CredentialData,
    FieldMappings,
    Message,
    SavePrompt,
    messageTab,
} from "./message";
import { clearSessionMasterKey, configureSessionStorage, getSessionMasterKey } from "./storage";
import { AutofillBrokerRequest, AutofillBrokerResponse, buildLockedBrokerResponse } from "./autofill-broker-protocol";
import {
    applyBrokerBundleResponse,
    approveBrokerPlanResponse,
    buildUnlockedBrokerPlanResponse,
    BrokerApproval,
    mintBrokerBundleResponse,
    PendingBrokerPlan,
    redactBrokerResponse,
    revokeBrokerBundleResponse,
} from "./autofill-broker";
import { PASSKEY_PROTOCOL_VERSION, PasskeyResult } from "./passkey-protocol";
import { PasskeyApprovalCoordinator, PasskeyApprovalResolution } from "./passkey-approval-coordinator";
import { PasskeySelectionCoordinator, PasskeySelectionResolution } from "./passkey-selection-coordinator";
import {
    describePasskeyOperation,
    executePasskeyOperation,
    PasskeyCredentialRepository,
    PasskeyProviderError,
    PasskeySelectionCandidate,
} from "./passkey-provider-engine";
import { approvePasskeyRpSuffix, isPasskeyProviderOriginEnabled } from "./passkey-rp-policy";
import { bindPasskeyRequest, isPasskeyRequestBindingCurrent, PasskeyRequestBinding } from "./passkey-request-binding";

setPlatform(new ExtensionWorkerPlatform());

const API_BASE_URL = process.env.PL_SERVER_URL!;
const PASSKEY_DIAGNOSTICS_ENABLED = process.env.PL_PASSKEY_DIAGNOSTICS === "true";

// MV3 service worker - state must be persisted to storage
let app: App;
let autoLockAlarmName = "pl_autoLock";
let nativeBrokerAlarmName = "pl_agenticAutofillNativeBroker";
let isInitialized = false;
const actionApi = chrome.action;
let badgeAndContextMenuUpdateChain = Promise.resolve();

// Save/update credential prompt state
// Maps promptId -> pending SavePrompt
const pendingPrompts = new Map<string, SavePrompt>();
const pendingAutofillPlans = new Map<string, PendingBrokerPlan>();
const pendingAutofillApprovals = new Map<string, BrokerApproval>();
const pendingAutofillBundles = new Map<string, AutofillBrokerResponse>();
const pendingAutofillPromptNonces = new Map<string, { nonce: string; senderUrl: string }>();

// Suppression map: url -> timestamp when prompt can be shown again
const dismissedUrls = new Map<string, number>();

const DISMISSAL_DURATION_MS = 60 * 60 * 1000; // 1 hour

// Register the cold-start probe synchronously and answer it through Chrome's
// callback contract. This must not depend on the webextension polyfill or App
// initialization, either of which may still be loading when the popup opens.
const nativeRuntime = (
    globalThis as typeof globalThis & {
        chrome: {
            runtime: {
                id: string;
                onMessage: {
                    addListener(
                        listener: (
                            msg: Message,
                            sender: Runtime.MessageSender,
                            sendResponse: (response: unknown) => void
                        ) => boolean | void
                    ): void;
                };
                onConnect: {
                    addListener(
                        listener: (port: {
                            name: string;
                            sender?: Runtime.MessageSender;
                            onMessage: { addListener(listener: (message: Message) => void): void };
                            onDisconnect: { addListener(listener: () => void): void };
                            postMessage(message: unknown): void;
                        }) => void
                    ): void;
                };
                getURL(path: string): string;
            };
        };
    }
).chrome.runtime;

const passkeyApprovalCoordinator = new PasskeyApprovalCoordinator({
    approvalUiSenderUrl: nativeRuntime.getURL("popup.html"),
});
const passkeySelectionCoordinator = new PasskeySelectionCoordinator({
    selectionUiSenderUrl: nativeRuntime.getURL("popup.html"),
});
const passkeyRuntimeDiagnostics = {
    connectionCount: 0,
    requestCount: 0,
    lastStage: "idle",
    lastErrorName: "",
};
if (PASSKEY_DIAGNOSTICS_ENABLED) {
    (
        globalThis as typeof globalThis & { padlocPasskeyDiagnostics?: typeof passkeyRuntimeDiagnostics }
    ).padlocPasskeyDiagnostics = passkeyRuntimeDiagnostics;
}

nativeRuntime.onConnect.addListener((port) => {
    passkeyRuntimeDiagnostics.connectionCount += 1;
    if (port.name !== "padloc-passkey-v1" || !port.sender?.tab) {
        passkeyRuntimeDiagnostics.lastStage = "port-rejected";
        return;
    }
    passkeyRuntimeDiagnostics.lastStage = "port-connected";
    let activeRequestId: string | null = null;
    const abortController = new AbortController();
    let responded = false;
    const respond = (result: PasskeyResult) => {
        if (responded) return;
        responded = true;
        try {
            port.postMessage(result);
        } catch {
            // The page may have navigated or aborted while approval was open.
        }
    };
    port.onMessage.addListener((msg) => {
        if (msg.type !== "passkeyRequest" || activeRequestId) return;
        passkeyRuntimeDiagnostics.requestCount += 1;
        passkeyRuntimeDiagnostics.lastStage = "request-received";
        activeRequestId = msg.requestId;
        const deadline = Date.now() + passkeyRequestTimeoutMs(msg.options);
        void beginPasskeyRequest(msg, port.sender!, respond, abortController.signal, deadline);
    });
    port.onDisconnect.addListener(() => {
        abortController.abort();
        if (activeRequestId) {
            passkeyApprovalCoordinator.cancel(activeRequestId);
            passkeySelectionCoordinator.cancel(activeRequestId);
        }
    });
});

nativeRuntime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!sender.tab && msg.type === "ping") {
        sendResponse({ type: "pong" });
        return true;
    }
    if (sender.tab && msg.type === "passkeyRequest") {
        // Long-running ceremonies use a runtime port so an MV3 worker stays
        // alive. One-shot callers retain native WebAuthn rather than waiting.
        sendResponse(buildPasskeyFallback(msg, sender));
        return true;
    }
});

function buildPasskeyFallback(
    msg: Extract<Message, { type: "passkeyRequest" }>,
    sender: Runtime.MessageSender
): PasskeyResult {
    if (PASSKEY_DIAGNOSTICS_ENABLED) {
        console.debug("[Padloc passkey] background request", msg.requestId, msg.operation);
    }
    const verified = bindPasskeyRequest(msg.origin, sender) !== null;
    return {
        type: "passkeyResult",
        protocolVersion: PASSKEY_PROTOCOL_VERSION,
        requestId: msg.requestId,
        outcome: verified ? "fallback" : "error",
        ...(verified
            ? { reason: "provider-not-configured" }
            : { error: { name: "SecurityError", message: "Unable to verify the requesting origin" } }),
    } as PasskeyResult;
}

async function beginPasskeyRequest(
    msg: Extract<Message, { type: "passkeyRequest" }>,
    sender: Runtime.MessageSender,
    respond: (result: PasskeyResult) => void,
    signal: AbortSignal,
    deadline: number
): Promise<void> {
    const binding = bindPasskeyRequest(msg.origin, sender);
    if (!binding || !isPasskeyProviderOriginEnabled(msg.origin)) {
        respond(passkeyErrorResult(msg, "SecurityError", "Unable to verify the requesting origin"));
        return;
    }

    try {
        const description = describePasskeyOperation({
            request: msg,
            origin: msg.origin,
            rpIdSuffixValidator: approvePasskeyRpSuffix,
        });
        passkeyApprovalCoordinator.begin(
            {
                requestId: msg.requestId,
                operation: description.operation,
                origin: msg.origin,
                rpId: description.rpId,
                rpName: description.rpName,
                userName: description.userName,
                userDisplayName: description.userDisplayName,
            },
            (resolution) => {
                void resolvePasskeyRequest(msg, binding, resolution, respond, signal, deadline);
            }
        );
        passkeyRuntimeDiagnostics.lastStage = "approval-pending";
        if (PASSKEY_DIAGNOSTICS_ENABLED) {
            console.info("[Padloc passkey] approval pending", msg.requestId, description.operation, description.rpId);
        }
        void updateBadgeAndContextMenu();
    } catch (error) {
        passkeyRuntimeDiagnostics.lastStage = "request-rejected";
        passkeyRuntimeDiagnostics.lastErrorName = error instanceof Error ? error.name : "OperationError";
        respond(passkeyErrorFromUnknown(msg, error));
    }
}

async function resolvePasskeyRequest(
    msg: Extract<Message, { type: "passkeyRequest" }>,
    binding: PasskeyRequestBinding,
    resolution: Readonly<PasskeyApprovalResolution>,
    respond: (result: PasskeyResult) => void,
    signal: AbortSignal,
    deadline: number
): Promise<void> {
    try {
        if (resolution.outcome !== "approved") {
            if (resolution.outcome !== "cancelled") {
                respond(passkeyErrorResult(msg, "NotAllowedError", "The passkey request was not approved"));
            }
            if (PASSKEY_DIAGNOSTICS_ENABLED) {
                console.info("[Padloc passkey] ceremony ended", msg.requestId, msg.operation, resolution.outcome);
            }
            return;
        }

        await assertPasskeyCeremonyActive(binding, signal, deadline);

        const application = await getApp();
        if (!application.state.loggedIn || application.state.locked) {
            respond(passkeyErrorResult(msg, "NotAllowedError", "Unlock Padloc to use this passkey"));
            return;
        }

        const credential = await executePasskeyOperation({
            request: msg,
            origin: msg.origin,
            repository: createVaultPasskeyRepository(application),
            userVerified: resolution.userVerified,
            rpIdSuffixValidator: approvePasskeyRpSuffix,
            selectCredential: (candidates) =>
                requestPasskeyCredentialSelection(msg, binding, candidates, signal, deadline),
            assertActive: () => assertPasskeyCeremonyActive(binding, signal, deadline),
        });
        await assertPasskeyCeremonyActive(binding, signal, deadline);
        respond({
            type: "passkeyResult",
            protocolVersion: PASSKEY_PROTOCOL_VERSION,
            requestId: msg.requestId,
            outcome: "credential",
            credential,
        });
        if (PASSKEY_DIAGNOSTICS_ENABLED) {
            console.info("[Padloc passkey] ceremony completed", msg.requestId, msg.operation);
        }
        passkeyRuntimeDiagnostics.lastStage = "completed";
    } catch (error) {
        passkeyRuntimeDiagnostics.lastStage = "failed";
        passkeyRuntimeDiagnostics.lastErrorName = error instanceof Error ? error.name : "OperationError";
        respond(passkeyErrorFromUnknown(msg, error));
        if (PASSKEY_DIAGNOSTICS_ENABLED) {
            console.warn(
                "[Padloc passkey] ceremony failed",
                msg.requestId,
                msg.operation,
                error instanceof Error ? error.name : "OperationError"
            );
        }
    } finally {
        void updateBadgeAndContextMenu();
    }
}

async function requestPasskeyCredentialSelection(
    msg: Extract<Message, { type: "passkeyRequest" }>,
    binding: PasskeyRequestBinding,
    candidates: readonly PasskeySelectionCandidate[],
    signal: AbortSignal,
    deadline: number
): Promise<string | undefined> {
    const description = describePasskeyOperation({
        request: msg,
        origin: msg.origin,
        rpIdSuffixValidator: approvePasskeyRpSuffix,
    });
    passkeyRuntimeDiagnostics.lastStage = "selection-pending";
    void updateBadgeAndContextMenu();

    return new Promise<string | undefined>((resolve, reject) => {
        const finish = async (resolution: Readonly<PasskeySelectionResolution>) => {
            try {
                if (resolution.outcome !== "selected") {
                    resolve(undefined);
                    return;
                }
                await assertPasskeyCeremonyActive(binding, signal, deadline);
                resolve(resolution.selectionId);
            } catch (error) {
                reject(error);
            } finally {
                void updateBadgeAndContextMenu();
            }
        };

        try {
            passkeySelectionCoordinator.begin(
                {
                    requestId: msg.requestId,
                    origin: msg.origin,
                    rpId: description.rpId,
                    candidates,
                },
                (resolution) => void finish(resolution)
            );
        } catch (error) {
            reject(error);
        }
    });
}

async function isPasskeyTabStillBound(binding: PasskeyRequestBinding): Promise<boolean> {
    try {
        const tab = await browser.tabs.get(binding.tabId);
        return isPasskeyRequestBindingCurrent(binding, tab);
    } catch {
        return false;
    }
}

function passkeyRequestTimeoutMs(options: Record<string, unknown>): number {
    return Math.min(Math.max(Number(options.timeout) || 60_000, 1_000), 120_000);
}

async function assertPasskeyCeremonyActive(
    binding: PasskeyRequestBinding,
    signal: AbortSignal,
    deadline: number
): Promise<void> {
    if (signal.aborted || Date.now() >= deadline) {
        throw new PasskeyProviderError("NotAllowedError", "The passkey request is no longer active");
    }
    if (!(await isPasskeyTabStillBound(binding))) {
        throw new PasskeyProviderError("SecurityError", "The requesting page changed during the passkey request");
    }
    if (signal.aborted || Date.now() >= deadline) {
        throw new PasskeyProviderError("NotAllowedError", "The passkey request is no longer active");
    }
}

function createVaultPasskeyRepository(application: App): PasskeyCredentialRepository {
    const findOwner = (credential: PasskeyCredential): VaultItem | null => {
        const credentialKey = bytesToBase64(credential.credentialId);
        for (const vault of application.vaults) {
            for (const item of vault.items) {
                if (
                    item.passkeys.some(
                        (stored) =>
                            stored.rpId === credential.rpId && bytesToBase64(stored.credentialId) === credentialKey
                    )
                ) {
                    return item;
                }
            }
        }
        return null;
    };

    return {
        async listCredentials(rpId) {
            const credentials: PasskeyCredential[] = [];
            for (const vault of application.vaults) {
                for (const item of vault.items) {
                    credentials.push(...item.passkeys.filter((credential) => credential.rpId === rpId));
                }
            }
            return credentials;
        },
        async createCredential(credential) {
            const vault = application.mainVault;
            if (!vault) throw new PasskeyProviderError("NotAllowedError", "A writable Padloc vault is required");
            let created: VaultItem | null = null;
            try {
                created = await application.createItem({
                    name: `${credential.rpName || credential.rpId} Passkey`,
                    vault: { id: vault.id },
                    fields: [
                        new Field({ name: "username", type: FieldType.Username, value: credential.userName }),
                        new Field({ name: "url", type: FieldType.Url, value: `https://${credential.rpId}` }),
                    ],
                    passkeys: [credential],
                });
                await application.syncVaultStrict(vault, [created.id]);
            } catch (error) {
                if (created && application.getItem(created.id)) {
                    await application.deleteItems([created]);
                    await application.syncVaultStrict(vault, [created.id]);
                }
                throw error;
            }
        },
        async updateCredential(credential) {
            const item = findOwner(credential);
            if (!item) throw new PasskeyProviderError("NotAllowedError", "The selected passkey is no longer stored");
            const credentialKey = bytesToBase64(credential.credentialId);
            await application.updateItem(item, {
                passkeys: item.passkeys.map((stored) =>
                    stored.rpId === credential.rpId && bytesToBase64(stored.credentialId) === credentialKey
                        ? credential
                        : stored
                ),
            });
            const located = application.getItem(item.id);
            if (!located) throw new PasskeyProviderError("NotAllowedError", "The selected passkey is no longer stored");
            await application.syncVaultStrict(located.vault, [item.id]);
        },
        async deleteCredential(credential) {
            const item = findOwner(credential);
            if (!item) return;
            const located = application.getItem(item.id);
            if (!located) return;
            await application.deleteItems([item]);
            await application.syncVaultStrict(located.vault, [item.id]);
        },
    };
}

function passkeyErrorResult(
    msg: Extract<Message, { type: "passkeyRequest" }>,
    name: string,
    message: string
): PasskeyResult {
    return {
        type: "passkeyResult",
        protocolVersion: PASSKEY_PROTOCOL_VERSION,
        requestId: msg.requestId,
        outcome: "error",
        error: { name, message },
    };
}

function passkeyErrorFromUnknown(msg: Extract<Message, { type: "passkeyRequest" }>, error: unknown): PasskeyResult {
    if (error instanceof PasskeyProviderError) return passkeyErrorResult(msg, error.name, error.message);
    return passkeyErrorResult(msg, "OperationError", "Padloc could not complete the passkey request");
}

async function handleRuntimeMessage(msg: Message, sender: Runtime.MessageSender) {
    if (sender.tab && !isExtensionDocumentSender(sender)) {
        // Ignore page-origin content-script messages (one-way communication).
        return;
    }

    const application = await getApp();

    switch (msg.type) {
        case "loggedOut":
        case "locked":
            await clearSessionMasterKey();
            await application.load();
            await cancelAutoLock();
            await updateBadgeAndContextMenu();
            break;
        case "unlocked":
            await application.load();
            await restoreSessionUnlock(application);
            await startAutoLockTimer();
            await updateBadgeAndContextMenu();
            return { type: "unlockedAck", unlocked: application.state.loggedIn && !application.state.locked };
        case "state-changed":
            await application.reload();
            await updateBadgeAndContextMenu();
            break;
        case "formSubmitDetected":
            return handleFormSubmitDetected(msg.data, application);
        case "getSavePrompt":
            return handleGetSavePrompt();
        case "saveCredential":
            return handleSaveCredential(msg.promptId, msg.vaultId, application);
        case "updateCredential":
            return handleUpdateCredential(msg.promptId, msg.vaultId, application);
        case "dismissPrompt":
            return handleDismissPrompt(msg.promptId);
        case "getAgenticAutofillApprovalPrompt":
            return handleGetAgenticAutofillApprovalPrompt(sender);
        case "approveAgenticAutofill":
            return handleApproveAgenticAutofill(msg.planId, msg.promptNonce, sender);
        case "dismissAgenticAutofill":
            return handleDismissAgenticAutofill(msg.planId);
        case "getPasskeyApprovalPrompt":
            return {
                type: "getPasskeyApprovalPromptResponse",
                prompt: passkeyApprovalCoordinator.getPrompt(sender.url || ""),
            };
        case "approvePasskey":
            if (
                msg.userVerified !== true ||
                !passkeyApprovalCoordinator.approve(
                    { requestId: msg.requestId, promptNonce: msg.promptNonce, userVerified: true },
                    sender.url || ""
                )
            ) {
                throw new Error("Passkey approval is no longer available");
            }
            return null;
        case "dismissPasskey":
            if (
                !passkeyApprovalCoordinator.dismiss(
                    { requestId: msg.requestId, promptNonce: msg.promptNonce },
                    sender.url || ""
                )
            ) {
                throw new Error("Passkey approval is no longer available");
            }
            return null;
        case "getPasskeySelectionPrompt":
            return {
                type: "getPasskeySelectionPromptResponse",
                prompt: passkeySelectionCoordinator.getPrompt(sender.url || ""),
            };
        case "selectPasskeyCredential":
            if (
                !passkeySelectionCoordinator.select(
                    {
                        requestId: msg.requestId,
                        promptNonce: msg.promptNonce,
                        selectionId: msg.selectionId,
                    },
                    sender.url || ""
                )
            ) {
                throw new Error("Passkey selection is no longer available");
            }
            return null;
        case "dismissPasskeySelection":
            if (
                !passkeySelectionCoordinator.dismiss(
                    { requestId: msg.requestId, promptNonce: msg.promptNonce },
                    sender.url || ""
                )
            ) {
                throw new Error("Passkey selection is no longer available");
            }
            return null;
        case "agenticAutofillBroker":
            return handleAgenticAutofillBroker(msg.request, application);
    }
}

function isExtensionDocumentSender(sender: Runtime.MessageSender): boolean {
    if (sender.id !== nativeRuntime.id || !sender.url) return false;
    try {
        return new URL(sender.url).origin === new URL(nativeRuntime.getURL("/")).origin;
    } catch {
        return false;
    }
}

async function getApp(): Promise<App> {
    if (!app) {
        app = new App(new FetchSender(API_BASE_URL));
        await app.load();
        if (await restoreSessionUnlock(app)) {
            await startAutoLockTimer();
        }
    } else if (app.state.locked) {
        if (await restoreSessionUnlock(app)) {
            await startAutoLockTimer();
        }
    }
    return app;
}

async function restoreSessionUnlock(application: App) {
    if (!application.state.locked || !application.account || !application.session) {
        return false;
    }

    const masterKey = await getSessionMasterKey({
        accountId: application.account.id,
        sessionId: application.session.id,
    });

    if (!masterKey) {
        return false;
    }

    try {
        await application.unlockWithMasterKey(masterKey);
        return true;
    } catch (error) {
        await clearSessionMasterKey();
        return false;
    }
}

async function initBackground() {
    if (isInitialized) return;
    isInitialized = true;

    browser.runtime.onMessage.addListener((msg, sender) =>
        msg.type === "ping" || msg.type === "passkeyRequest" ? undefined : handleRuntimeMessage(msg, sender)
    );

    await configureSessionStorage();

    const _app = await getApp();
    const update = debounce(() => updateBadgeAndContextMenu(), 500);
    _app.subscribe(update);

    // Tab listeners for badge updates
    browser.tabs.onUpdated.addListener(update);
    browser.tabs.onActivated.addListener(update);

    // Context menu click handler
    browser.contextMenus.onClicked.addListener(async ({ menuItemId }: Menus.OnClickData) => {
        await handleContextMenuClick(menuItemId as string);
    });

    // Alarm listener for auto-lock
    browser.alarms.onAlarm.addListener(async (alarm) => {
        if (alarm.name === autoLockAlarmName) {
            await doLock();
        }
        if (alarm.name === nativeBrokerAlarmName) {
            await processPendingNativeBrokerRequest(await getApp());
        }
    });

    // Register commands
    browser.commands.onCommand.addListener(async () => {
        // Commands are handled via popup for MV3
    });

    await enqueueBadgeAndContextMenuUpdate();
    browser.alarms.create(nativeBrokerAlarmName, { periodInMinutes: 1 });
    void processPendingNativeBrokerRequest(_app);
}

function enqueueBadgeAndContextMenuUpdate() {
    badgeAndContextMenuUpdateChain = badgeAndContextMenuUpdateChain
        .catch(() => undefined)
        .then(() => updateBadgeAndContextMenu());
    return badgeAndContextMenuUpdateChain;
}


async function handleContextMenuClick(menuItemId: string) {
    if (menuItemId === "openPopup") {
        actionApi.openPopup();
        return;
    }

    // item/{id}/{fieldIndex} — single-field fill (existing)
    const fieldMatch = menuItemId.match(/^item\/([^\/]+)\/(\d+)$/);
    if (fieldMatch) {
        const [, id, ind] = fieldMatch;
        const application = await getApp();
        const item = application.getItem(id);
        const index = parseInt(ind);
        if (!item || isNaN(index)) return;
        const field = item.item.fields[index];
        if (!field) return;
        const value = await field.transform();
        await messageTab({ type: "fillActive", value });
        return;
    }

    // item/{id} — multi-field fill (username + password, optionally TOTP)
    const itemMatch = menuItemId.match(/^item\/([^\/]+)$/);
    if (!itemMatch) return;

    const [, id] = itemMatch;
    const application = await getApp();
    const item = application.getItem(id);
    if (!item) return;

    await fillItemMultiField(item);
}

type MatchedVaultItem = NonNullable<ReturnType<App["getItem"]>>;

async function fillItemMultiField(item: MatchedVaultItem) {
    const fields = item.item.fields;
    let username: string | undefined;
    let password: string | undefined;
    let totp: string | undefined;

    for (const field of fields) {
        if (field.type === FieldType.Username && !username) {
            username = await field.transform();
        } else if (field.type === FieldType.Password && !password) {
            password = await field.transform();
        } else if (field.type === FieldType.Totp && !totp) {
            totp = await field.transform();
        }
    }

    // Require at least username or password to trigger multi-field fill
    if (!username && !password) {
        // Fall back to single-field: fill first available password or username
        const fallbackField = fields.find((f: Field) => f.type === FieldType.Password || f.type === FieldType.Username);
        if (fallbackField) {
            const value = await fallbackField.transform();
            await messageTab({ type: "fillActive", value });
        }
        return;
    }

    await messageTab({ type: "fillFields", mappings: { username, password, totp } });
}

async function updateBadgeAndContextMenu() {
    const application = await getApp();
    const count = await getCountForActiveTab();
    const passkeyApprovalPending =
        passkeyApprovalCoordinator.pendingCount > 0 || passkeySelectionCoordinator.pendingCount > 0;

    // Update badge
    const badgeText = passkeyApprovalPending
        ? "PK"
        : count && application.settings.extensionBadge
        ? count.toString()
        : "";
    actionApi.setBadgeText({ text: badgeText });
    actionApi.setBadgeBackgroundColor({ color: passkeyApprovalPending ? "#5c6bc0" : "#ff6666" });

    if (passkeyApprovalPending) {
        actionApi.setIcon({ path: "icon.png" });
        actionApi.setTitle({ title: "Passkey approval required" });
    } else if (!application.account) {
        actionApi.setIcon({ path: "icon-grayscale.png" });
        actionApi.setTitle({ title: "Please Log In" });
    } else {
        actionApi.setIcon({ path: "icon.png" });
        actionApi.setTitle({ title: resolveAppName() });
    }

    // Update context menu
    await browser.contextMenus.removeAll();

    const count2 = await getCountForActiveTab();
    if (!count2 || !application.state.loggedIn) return;

    if (application.state.locked) {
        const openPopupAvailable = typeof actionApi.openPopup === "function";
        await browser.contextMenus.create({
            id: "openPopup",
            title: `${count2 > 1 ? `${count2} items` : "1 item"} found${
                !openPopupAvailable ? " (unlock to view)" : ""
            }`,
            enabled: openPopupAvailable,
            contexts: ["editable"],
        });
    } else {
        const menuIds = new Set<string>();
        const items = dedupeMatchedItems(await getItemsForActiveTab());
        for (const { item } of items) {
            const hasUsername = item.fields.some((f) => f.type === FieldType.Username);
            const hasPassword = item.fields.some((f) => f.type === FieldType.Password);
            // Top-level item — clicking it triggers multi-field fill if credentials exist
            await createContextMenuOnce(menuIds, {
                id: `item/${item.id}`,
                title: hasUsername && hasPassword ? `${item.name}  ▸  Fill Login` : item.name,
                contexts: ["editable"],
            });

            // Single-field sub-items
            for (const [index, field] of item.fields.entries()) {
                await createContextMenuOnce(menuIds, {
                    parentId: `item/${item.id}`,
                    id: `item/${item.id}/${index}`,
                    title: field.name,
                    contexts: ["editable"],
                });
            }
        }
    }
}

function dedupeMatchedItems(items: MatchedVaultItem[]): MatchedVaultItem[] {
    const seen = new Set<string>();
    const deduped: MatchedVaultItem[] = [];
    for (const item of items) {
        if (seen.has(item.item.id)) continue;
        seen.add(item.item.id);
        deduped.push(item);
    }
    return deduped;
}

async function createContextMenuOnce(
    menuIds: Set<string>,
    createProperties: Menus.CreateCreatePropertiesType
): Promise<void> {
    if (!createProperties.id) throw new Error("Context menu id required");
    if (menuIds.has(createProperties.id)) return;
    menuIds.add(createProperties.id);
    try {
        await browser.contextMenus.create(createProperties);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!message.includes("duplicate id")) {
            throw error;
        }
        await browser.contextMenus.remove(createProperties.id).catch(() => undefined);
        await browser.contextMenus.create(createProperties);
    }
}

async function getActiveTab() {
    const [tab] = await browser.tabs.query({ currentWindow: true, active: true });
    return tab || null;
}

async function getItemsForActiveTab() {
    const tab = await getActiveTab();
    const application = await getApp();
    return tab && tab.url ? application.getItemsForUrl(tab.url) : [];
}

async function getCountForActiveTab() {
    const tab = await getActiveTab();
    const application = await getApp();
    return tab && tab.url ? await application.state.index.matchUrl(tab.url) : 0;
}

async function cancelAutoLock() {
    await browser.alarms.clear(autoLockAlarmName);
}

async function doLock() {
    const application = await getApp();
    if (application.state.syncing) {
        await startAutoLockTimer();
        return;
    }
    await application.lock();
    await clearSessionMasterKey();
    await application.reload();
}

async function startAutoLockTimer() {
    await cancelAutoLock();
    const application = await getApp();
    if (application.settings.autoLock && !application.state.locked) {
        browser.alarms.create(autoLockAlarmName, {
            delayInMinutes: application.settings.autoLockDelay,
        });
    }
}

// Save/update credential handlers

async function handleFormSubmitDetected(data: CredentialData, application: App): Promise<null> {
    if (application.state.locked || !application.state.loggedIn) {
        return null;
    }

    // Clean up expired dismissals
    const now = Date.now();
    for (const [url, timestamp] of dismissedUrls.entries()) {
        if (now > timestamp) dismissedUrls.delete(url);
    }

    // Check if dismissed
    const dismissalTimestamp = dismissedUrls.get(data.url);
    if (dismissalTimestamp && now < dismissalTimestamp) {
        return null;
    }

    // Check for existing item for this URL
    const existingItems = application.getItemsForUrl(data.url);
    const existingLogin = existingItems.find(({ item }) => item.fields.some((f) => f.type === FieldType.Password));

    const promptId = await uuid();
    const prompt: SavePrompt = {
        id: promptId,
        url: data.url,
        username: data.username,
        password: data.password,
        existingItem: existingLogin?.item,
    };

    pendingPrompts.set(promptId, prompt);

    // Notify popup of pending prompt by sending state-changed
    // Popup will call getSavePrompt to retrieve the prompt
    return null;
}

function handleGetSavePrompt(): { type: "getSavePromptResponse"; prompt: SavePrompt | null } {
    // Return the most recent pending prompt (if any)
    const prompts = Array.from(pendingPrompts.values());
    const latest = prompts.length > 0 ? prompts[prompts.length - 1] : null;
    return { type: "getSavePromptResponse", prompt: latest || null };
}

async function handleSaveCredential(promptId: string, vaultId: string | undefined, application: App): Promise<null> {
    const prompt = pendingPrompts.get(promptId);
    if (!prompt) return null;

    pendingPrompts.delete(promptId);

    if (application.state.locked || !application.state.loggedIn) return null;

    const vault = vaultId ? application.getVault(vaultId!) : application.mainVault;

    if (!vault) return null;

    const name = new URL(prompt.url).hostname || "Saved Login";

    const fields: Field[] = [
        new Field({ name: "username", type: FieldType.Username, value: prompt.username }),
        new Field({ name: "password", type: FieldType.Password, value: prompt.password }),
        new Field({ name: "url", type: FieldType.Url, value: prompt.url }),
    ];

    await application.createItem({
        name,
        vault: { id: vault.id },
        fields,
    });

    return null;
}

async function handleUpdateCredential(promptId: string, _vaultId: string | undefined, application: App): Promise<null> {
    const prompt = pendingPrompts.get(promptId);
    if (!prompt || !prompt.existingItem) return null;

    pendingPrompts.delete(promptId);

    if (application.state.locked || !application.state.loggedIn) return null;

    const item = prompt.existingItem;
    const updatedFields = item.fields.map((f) => {
        if (f.type === FieldType.Username) {
            return new Field({ ...f, value: prompt.username });
        }
        if (f.type === FieldType.Password) {
            return new Field({ ...f, value: prompt.password });
        }
        return f;
    });

    await application.updateItem(item, { fields: updatedFields });

    return null;
}

function handleDismissPrompt(promptId: string): null {
    const prompt = pendingPrompts.get(promptId);
    if (prompt) {
        pendingPrompts.delete(promptId);
        // Suppress prompts for the same URL for 1 hour
        dismissedUrls.set(prompt.url, Date.now() + DISMISSAL_DURATION_MS);
    }
    return null;
}

function handleGetAgenticAutofillApprovalPrompt(sender: Runtime.MessageSender): {
    type: "getAgenticAutofillApprovalPromptResponse";
    prompt: AgenticAutofillApprovalPrompt | null;
} {
    const latest = Array.from(pendingAutofillPlans.values()).pop();
    if (!latest) return { type: "getAgenticAutofillApprovalPromptResponse", prompt: null };
    const senderUrl = requireExtensionUiSender(sender);
    const promptNonce = randomApprovalPromptNonce();
    pendingAutofillPromptNonces.set(latest.planId, { nonce: promptNonce, senderUrl });
    return {
        type: "getAgenticAutofillApprovalPromptResponse",
        prompt: {
            planId: latest.planId,
            promptNonce,
            origin: latest.request.binding ? latest.request.binding.origin : "unknown",
            fieldCount: latest.fields.length,
            transactionOnlyCount: latest.fields.filter((field) => field.transactionOnly).length,
            paymentFieldCount: latest.fields.filter((field) => field.role.startsWith("payment.")).length,
            finalSubmitWarning:
                latest.request.fields?.some(
                    (field) => field.finalSubmit === true || (field.role || "").startsWith("purchase.final_submit")
                ) ?? false,
            fields: latest.fields.map((field) => ({
                role: field.role,
                itemName: field.itemName,
                fieldName: field.fieldName,
                valuePreview: field.valuePreview,
                transactionOnly: field.transactionOnly,
            })),
        },
    };
}

function handleApproveAgenticAutofill(planId: string, promptNonce: string, sender: Runtime.MessageSender) {
    const plan = pendingAutofillPlans.get(planId);
    if (!plan) throw new Error("Autofill approval plan not found");
    const senderUrl = requireExtensionUiSender(sender);
    const expected = pendingAutofillPromptNonces.get(planId);
    if (!expected || promptNonce !== expected.nonce || senderUrl !== expected.senderUrl) {
        throw new Error("Autofill approval requires active approval UI nonce");
    }
    pendingAutofillPromptNonces.delete(planId);
    const { response, approval } = approveBrokerPlanResponse(
        {
            type: "approve",
            protocolVersion: 1,
            requestId: `popup-${planId}`,
            planId,
            approved: true,
            binding: plan.request.binding,
        },
        plan
    );
    pendingAutofillApprovals.set(approval.approvalId, approval);
    void publishRedactedBrokerResponse(response);
    return { type: "agenticAutofillBrokerResponse", response };
}

function handleDismissAgenticAutofill(planId: string): null {
    pendingAutofillPlans.delete(planId);
    pendingAutofillPromptNonces.delete(planId);
    for (const [approvalId, approval] of pendingAutofillApprovals.entries()) {
        if (approval.planId === planId) pendingAutofillApprovals.delete(approvalId);
    }
    return null;
}

function randomApprovalPromptNonce(): string {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function requireExtensionUiSender(sender: Runtime.MessageSender): string {
    const senderUrl = sender.url || "";
    const extensionOrigin = `chrome-extension://${browser.runtime.id}/`;
    if (!senderUrl.startsWith(extensionOrigin)) {
        throw new Error("Autofill approval requires Padloc extension UI sender");
    }
    return senderUrl;
}

async function handleAgenticAutofillBroker(request: AutofillBrokerRequest, application: App) {
    if (application.state.locked || !application.state.loggedIn) {
        return {
            type: "agenticAutofillBrokerResponse",
            response: buildLockedBrokerResponse(request),
        };
    }

    if (request.type === "plan-fill" || request.type === "classify") {
        const items = await getItemsForActiveTab();
        const { response, pendingPlan } = buildUnlockedBrokerPlanResponse(request, items);
        pendingAutofillPlans.set(pendingPlan.planId, pendingPlan);
        void publishRedactedBrokerResponse(response);
        return { type: "agenticAutofillBrokerResponse", response };
    }

    if (request.type === "approve") {
        throw new Error("Autofill approval requires Padloc approval UI");
    }

    if (request.type === "mint-fill-bundle") {
        const plan = request.planId ? pendingAutofillPlans.get(request.planId) : null;
        const approval = request.approvalId ? pendingAutofillApprovals.get(request.approvalId) : null;
        if (!plan) throw new Error("Autofill bundle plan not found");
        if (!approval) throw new Error("Autofill bundle approval not found");
        const response = await mintBrokerBundleResponse(request, plan, approval, await getItemsForActiveTab());
        pendingAutofillApprovals.delete(approval.approvalId);
        const redacted = redactBrokerResponse(response);
        if (response.bundleId) pendingAutofillBundles.set(response.bundleId, response);
        void publishRedactedBrokerResponse(redacted);
        return { type: "agenticAutofillBrokerResponse", response: redacted };
    }

    if (request.type === "apply-fill-bundle") {
        const bundle = request.bundleId ? pendingAutofillBundles.get(request.bundleId) : null;
        if (!bundle) throw new Error("Autofill bundle not found");
        const response = applyBrokerBundleResponse(request, bundle);
        await fillActiveTabFromBundle(bundle);
        pendingAutofillBundles.delete(bundle.bundleId || "");
        pendingAutofillPlans.delete(bundle.planId || "");
        void publishRedactedBrokerResponse(response);
        return { type: "agenticAutofillBrokerResponse", response };
    }

    if (request.type === "revoke-fill-bundle") {
        const bundle = request.bundleId ? pendingAutofillBundles.get(request.bundleId) : null;
        if (!bundle) throw new Error("Autofill bundle not found");
        const response = revokeBrokerBundleResponse(request, bundle);
        pendingAutofillBundles.delete(bundle.bundleId || "");
        pendingAutofillPlans.delete(bundle.planId || "");
        void publishRedactedBrokerResponse(response);
        return { type: "agenticAutofillBrokerResponse", response };
    }

    return {
        type: "agenticAutofillBrokerResponse",
        response: buildLockedBrokerResponse(request),
    };
}

async function fillActiveTabFromBundle(bundle: AutofillBrokerResponse): Promise<void> {
    const bundleFields = bundle.bundleFields || [];
    const mappings = bundleFieldsToMappings(bundleFields);
    if (!Object.values(mappings).some((value) => Boolean(value))) {
        throw new Error("Autofill bundle contains no fillable values");
    }
    await messageTab({ type: "fillFields", mappings });
}

function bundleFieldsToMappings(fields: NonNullable<AutofillBrokerResponse["bundleFields"]>): FieldMappings {
    const mappings: FieldMappings = {};
    for (const field of fields) {
        if (!field.value) continue;
        switch (field.role) {
            case "username":
                mappings.username = field.value;
                break;
            case "password":
                mappings.password = field.value;
                break;
            case "totp":
                mappings.totp = field.value;
                break;
            case "person.full_name":
                mappings.fullName = field.value;
                break;
            case "person.first_name":
                mappings.firstName = field.value;
                break;
            case "person.last_name":
                mappings.lastName = field.value;
                break;
            case "contact.email":
                mappings.email = field.value;
                break;
            case "contact.phone":
                mappings.phone = field.value;
                break;
            case "billing.address.line1":
            case "address.line1":
                mappings.addressLine1 = field.value;
                break;
            case "billing.address.line2":
            case "address.line2":
                mappings.addressLine2 = field.value;
                break;
            case "billing.address.city":
            case "address.city":
                mappings.city = field.value;
                break;
            case "billing.address.region":
            case "address.region":
                mappings.region = field.value;
                break;
            case "billing.address.postal_code":
            case "address.postal_code":
                mappings.postalCode = field.value;
                break;
            case "billing.address.country":
            case "address.country":
                mappings.country = field.value;
                break;
            case "payment.card.cardholder_name":
            case "payment.cardholder_name":
                mappings.cardholderName = field.value;
                break;
            case "payment.card.pan":
                mappings.cardNumber = field.value;
                break;
            case "payment.card.expiry":
            case "payment.card.expiry_mm_yy":
                mappings.cardExpiry = field.value;
                break;
            case "payment.card.expiry_month":
                mappings.cardExpiryMonth = field.value;
                break;
            case "payment.card.expiry_year":
                mappings.cardExpiryYear = field.value;
                break;
            case "payment.card.cvv_transient":
                mappings.cardCvv = field.value;
                break;
        }
    }
    return mappings;
}

async function processPendingNativeBrokerRequest(application: App): Promise<void> {
    let claimed: unknown;
    try {
        claimed = await browser.runtime.sendNativeMessage("me.ch5.padloc", {
            type: "claim-broker-request",
            protocolVersion: 1,
        });
    } catch {
        return;
    }
    if (!claimed || typeof claimed !== "object") return;
    const pending = (claimed as { pending?: unknown }).pending;
    if (!pending || typeof pending !== "object") return;
    const request = (pending as { request?: unknown }).request;
    if (!request || typeof request !== "object") return;
    try {
        await handleAgenticAutofillBroker(request as AutofillBrokerRequest, application);
    } catch (error) {
        const failedRequest = request as AutofillBrokerRequest;
        await publishRedactedBrokerResponse({
            ok: false,
            protocolVersion: 1,
            requestId: typeof failedRequest.requestId === "string" ? failedRequest.requestId : undefined,
            vaultState: application.state.locked ? "locked" : "unknown",
            reason: error instanceof Error ? error.message : "Padloc native broker request failed",
            audit: {
                operation: failedRequest.type || "status",
                sessionId: failedRequest.binding?.sessionId || null,
                origin: failedRequest.binding?.origin || null,
                fieldCount: failedRequest.fields?.length || 0,
                valuePolicy: "redacted audit only; no raw autofill values or passkey secrets",
            },
        });
    }
}

const brokerGlobal = globalThis as typeof globalThis & {
    padlocAgenticAutofillBroker?: (request: AutofillBrokerRequest) => Promise<unknown>;
};

brokerGlobal.padlocAgenticAutofillBroker = async (request: AutofillBrokerRequest) => {
    const response = await handleAgenticAutofillBroker(request, await getApp());
    return response.response;
};

async function publishRedactedBrokerResponse(response: unknown): Promise<void> {
    try {
        await browser.runtime.sendNativeMessage("me.ch5.padloc", {
            type: "cache-redacted-response",
            protocolVersion: 1,
            response,
        });
    } catch {
        // Native host is optional during extension-only tests and first-run setup.
    }
}

function startBackgroundInitialization() {
    void initBackground().catch((error) => {
        isInitialized = false;
        console.error(error);
    });
}

// Initialize on install
browser.runtime.onInstalled.addListener(startBackgroundInitialization);

// Initialize on startup (service worker may be dormant)
browser.runtime.onStartup.addListener(startBackgroundInitialization);

// Also try to initialize immediately in case already installed
startBackgroundInitialization();
