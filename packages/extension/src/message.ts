import { browser } from "webextension-polyfill-ts";
import { VaultItem } from "@padloc/core/src/item";
import { AutofillBrokerRequest, AutofillBrokerResponse } from "./autofill-broker-protocol";
import { PasskeyRuntimeRequest } from "./passkey-protocol";

/**
 * Mapping of field role to value for multi-field fill orchestration.
 * Legacy login keys stay supported while the Padloc/Magic Browser bridge grows
 * identity, address, and transaction-only payment roles.
 */
export type FieldMappings = {
    username?: string;
    password?: string;
    totp?: string;
    fullName?: string;
    firstName?: string;
    lastName?: string;
    email?: string;
    phone?: string;
    addressLine1?: string;
    addressLine2?: string;
    city?: string;
    region?: string;
    postalCode?: string;
    country?: string;
    cardholderName?: string;
    cardNumber?: string;
    cardExpiry?: string;
    cardExpiryMonth?: string;
    cardExpiryYear?: string;
    cardCvv?: string;
};

/**
 * Credential data captured from a form submission for save/update prompts.
 */
export interface CredentialData {
    username: string;
    password: string;
    url: string;
}

/**
 * Pending save/update prompt state tracked in the background service worker.
 */
export interface SavePrompt {
    id: string;
    url: string;
    username: string;
    password: string;
    existingItem?: VaultItem;
    dismissedUntil?: number; // timestamp when prompt can be shown again
}

export interface AgenticAutofillApprovalPrompt {
    planId: string;
    promptNonce: string;
    origin: string;
    fieldCount: number;
    transactionOnlyCount: number;
    paymentFieldCount: number;
    finalSubmitWarning: boolean;
    fields: Array<{
        role: string;
        itemName: string;
        fieldName: string;
        valuePreview: string;
        transactionOnly: boolean;
    }>;
}

export interface PasskeyApprovalPrompt {
    requestId: string;
    promptNonce: string;
    operation: "create" | "get";
    origin: string;
    rpId: string;
    rpName: string;
    userName?: string;
    userDisplayName?: string;
    expiresAt: number;
}

export interface PasskeyCredentialSelectionPrompt {
    requestId: string;
    promptNonce: string;
    origin: string;
    rpId: string;
    candidates: Array<{
        selectionId: string;
        userName: string;
        userDisplayName: string;
    }>;
    expiresAt: number;
}

export type Message =
    | { type: "loggedIn" }
    | { type: "loggedOut" }
    | { type: "locked" }
    | { type: "unlocked" }
    | { type: "fillActive"; value: string }
    | { type: "fillFields"; mappings: FieldMappings }
    | { type: "fillOnDrop"; value: string }
    | { type: "calcTOTP"; secret: string }
    | { type: "isContentReady" }
    | { type: "hasActiveInput" }
    | { type: "state-changed" }
    | { type: "ping" }
    | { type: "pong" } // pong response from worker
    | { type: "formSubmitDetected"; data: CredentialData }
    | { type: "getSavePrompt" }
    | { type: "getSavePromptResponse"; prompt: SavePrompt | null }
    | { type: "saveCredential"; promptId: string; vaultId?: string }
    | { type: "updateCredential"; promptId: string; vaultId?: string }
    | { type: "dismissPrompt"; promptId: string }
    | { type: "getAgenticAutofillApprovalPrompt" }
    | { type: "getAgenticAutofillApprovalPromptResponse"; prompt: AgenticAutofillApprovalPrompt | null }
    | { type: "approveAgenticAutofill"; planId: string; promptNonce: string }
    | { type: "dismissAgenticAutofill"; planId: string }
    | { type: "getPasskeyApprovalPrompt" }
    | { type: "getPasskeyApprovalPromptResponse"; prompt: PasskeyApprovalPrompt | null }
    | { type: "approvePasskey"; requestId: string; promptNonce: string; userVerified: boolean }
    | { type: "dismissPasskey"; requestId: string; promptNonce: string }
    | { type: "getPasskeySelectionPrompt" }
    | { type: "getPasskeySelectionPromptResponse"; prompt: PasskeyCredentialSelectionPrompt | null }
    | { type: "selectPasskeyCredential"; requestId: string; promptNonce: string; selectionId: string }
    | { type: "dismissPasskeySelection"; requestId: string; promptNonce: string }
    | { type: "agenticAutofillBroker"; request: AutofillBrokerRequest }
    | { type: "agenticAutofillBrokerResponse"; response: AutofillBrokerResponse }
    | PasskeyRuntimeRequest;

/**
 * Delivers `msg` to a tab's content script.
 *
 * Always targets frame 0 (the tab's top-level document) explicitly, never the
 * WebExtensions default of broadcasting to every frame in the tab. Without this,
 * any cross-origin iframe on the page (ads, embedded widgets) that happens to have
 * a focused/fillable input receives `fillActive`/`fillFields` payloads meant for
 * the page the user is actually looking at.
 *
 * Pass `tabId` to target a specific, already-verified tab instead of re-querying
 * "the active tab" at delivery time - required wherever the caller already bound
 * a plan/approval to a specific tab and must not let a focus change mid-flow
 * redirect delivery to a different tab.
 */
export async function messageTab(msg: Message, opts: { tabId?: number } = {}) {
    let tabId = opts.tabId;
    if (typeof tabId !== "number") {
        const [activeTab] = await browser.tabs.query({ active: true, currentWindow: true });
        tabId = activeTab?.id;
    }
    if (typeof tabId !== "number") {
        return Promise.resolve();
    }

    const contentReady: boolean = await browser.tabs
        .sendMessage(tabId, { type: "isContentReady" }, { frameId: 0 })
        .catch(() => false);

    if (!contentReady) {
        await browser.tabs.executeScript(tabId, { file: "/content.js" });
    }

    return browser.tabs.sendMessage(tabId, msg, { frameId: 0 });
}
