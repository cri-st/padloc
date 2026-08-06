import { browser } from "webextension-polyfill-ts";
import { css } from "lit";
import { App } from "@padloc/app/src/elements/app";
import { debounce } from "@padloc/core/src/util";
import { Storable } from "@padloc/core/src/storage";
import { VaultItem } from "@padloc/core/src/item";
import { shouldAttemptBiometricReunlock, unlockWithBiometric, verifyUserPresenceWithBiometric } from "./auth/biometric";
import {
    AgenticAutofillApprovalPrompt,
    messageTab,
    PasskeyApprovalPrompt,
    PasskeyCredentialSelectionPrompt,
    SavePrompt,
} from "./message";
import { clearSessionMasterKey, getSessionMasterKey, saveSessionMasterKey } from "./storage";
import { awaitWorkerUnlock, installUnlockPersistenceHooks } from "./unlock-persistence";
import { waitForWorkerReady } from "./worker-readiness";
import { verifyPasskeyUserPresence } from "./passkey-user-verification";
// import { messageTab } from "./message";

const notifyStateChanged = debounce(() => {
    browser.runtime.sendMessage({
        type: "state-changed",
    });
}, 500);

class RouterState extends Storable {
    id = "";
    path = "";
    params: { [key: string]: string } = {};
    lastMatchingItems: string[] = [];

    constructor(vals: Partial<RouterState> = {}) {
        super();
        Object.assign(this, vals);
    }
}

export class ExtensionApp extends App {
    static styles = [
        ...App.styles,
        css`
            .save-prompt-overlay {
                position: absolute;
                inset: 0;
                z-index: 1000;
                display: flex;
                align-items: center;
                justify-content: center;
                padding: var(--spacing);
                box-sizing: border-box;
                background: rgba(0, 0, 0, 0.45);
                pointer-events: auto;
            }

            .save-prompt-card {
                width: min(100%, 28em);
                max-height: 100%;
                overflow: auto;
                padding: calc(var(--spacing) * 1.25);
                box-sizing: border-box;
                border-radius: 0.75em;
                color: var(--color-foreground);
                background: var(--color-background);
                box-shadow: 0 0.75em 2.5em rgba(0, 0, 0, 0.28);
            }

            .save-prompt-header,
            .save-prompt-actions,
            .save-prompt-username,
            .save-prompt-password {
                display: flex;
                align-items: center;
                gap: var(--spacing);
            }

            .save-prompt-header {
                margin-bottom: var(--spacing);
                font-weight: 600;
            }

            .save-prompt-body {
                display: grid;
                gap: calc(var(--spacing) * 0.75);
            }

            .save-prompt-host {
                overflow-wrap: anywhere;
                font-weight: 600;
            }

            .save-prompt-label {
                min-width: 5em;
                color: var(--color-foreground-dimmed);
            }

            .save-prompt-value {
                min-width: 0;
                overflow-wrap: anywhere;
            }

            .save-prompt-actions {
                justify-content: flex-end;
                margin-top: calc(var(--spacing) * 1.25);
            }

            .save-prompt-btn {
                min-height: 2.5em;
                padding: 0.5em 1em;
                border: 0;
                border-radius: 0.5em;
                cursor: pointer;
                font: inherit;
            }

            .save-prompt-btn-primary {
                color: var(--color-background);
                background: var(--color-highlight);
            }

            .passkey-selection-list {
                display: grid;
                gap: calc(var(--spacing) * 0.5);
            }

            .passkey-selection-option {
                display: grid;
                grid-template-columns: auto minmax(0, 1fr);
                gap: var(--spacing);
                align-items: center;
                padding: calc(var(--spacing) * 0.75);
                border: 1px solid var(--color-foreground-dimmed);
                border-radius: 0.5em;
                cursor: pointer;
            }

            .passkey-selection-identity {
                display: grid;
                min-width: 0;
            }
        `,
    ];

    private _isLocked = true;
    private _isLoggedIn = false;
    private _workerReady = false;
    private _pendingSavePrompt: SavePrompt | null = null;
    private _savePromptOverlay: HTMLElement | null = null;
    private _pendingAutofillApproval: AgenticAutofillApprovalPrompt | null = null;
    private _autofillApprovalOverlay: HTMLElement | null = null;
    private _pendingPasskeyApproval: PasskeyApprovalPrompt | null = null;
    private _passkeyApprovalOverlay: HTMLElement | null = null;
    private _pendingPasskeySelection: PasskeyCredentialSelectionPrompt | null = null;
    private _passkeySelectionOverlay: HTMLElement | null = null;
    private _lastFreshUserVerificationAt = 0;
    private _unlockHooksInstalled = false;
    private _sessionSyncPromise: Promise<void> | null = null;

    private get _matchingItems() {
        return this.app.state.context.browser?.url ? this.app.getItemsForUrl(this.app.state.context.browser.url) : [];
    }

    /**
     * Wait for the background worker to be ready after cold start.
     * MV3 service workers can restart at any time, so we give the worker
     * a brief window to initialize before making routing decisions.
     */
    private async _waitForWorkerReady(): Promise<void> {
        if (this._workerReady) return;

        await waitForWorkerReady(() => browser.runtime.sendMessage({ type: "ping" }));

        // Continue even if the worker did not answer. The bounded probe is only
        // a cold-start aid and must never block the popup indefinitely.
        this._workerReady = true;
    }

    private _installUnlockPersistenceHooks() {
        if (this._unlockHooksInstalled) {
            return;
        }

        installUnlockPersistenceHooks(this.app, (reason) => {
            if (reason === "login" || reason === "password") this._lastFreshUserVerificationAt = Date.now();
            return this._persistUnlockedState();
        });

        this._unlockHooksInstalled = true;
    }

    private async _persistUnlockedState() {
        if (this._sessionSyncPromise) {
            return this._sessionSyncPromise;
        }

        this._sessionSyncPromise = this._saveSessionMasterKey().finally(() => {
            this._sessionSyncPromise = null;
        });

        await this._sessionSyncPromise;
        await this._notifyUnlockedState();
    }

    async load() {
        this._installUnlockPersistenceHooks();

        // Capture active tab BEFORE calling super.load() to avoid stateChanged race.
        // stateChanged fires during super.load() and uses state.context.browser,
        // so it must be set correctly before that happens.
        const [tab] = await browser.tabs.query({ currentWindow: true, active: true });

        // Wait for worker to settle on cold start before making routing decisions
        await this._waitForWorkerReady();

        await super.load();

        // Now set browser context after super.load() completes
        this.app.state.context.browser = tab;

        if (this.app.state.locked) {
            const masterKey = await getSessionMasterKey({
                accountId: this.app.account?.id,
                sessionId: this.app.session?.id,
            });
            if (masterKey) {
                try {
                    await this.app.unlockWithMasterKey(masterKey);
                    await this._unlocked();
                } catch (error) {
                    await clearSessionMasterKey();
                }
            }

            if (
                shouldAttemptBiometricReunlock({
                    locked: this.app.state.locked,
                    hasSessionMasterKey: !!masterKey,
                    hasRememberedMasterKey: !!this.app.state.rememberedMasterKey,
                })
            ) {
                await this._restoreBiometricUnlock();
            }
        }

        const routerState = await this._getRouterState();
        const matchingItems = this._matchingItems;
        const hasNewMatchingItems =
            matchingItems.length !== routerState.lastMatchingItems.length ||
            matchingItems.some(({ item }) => !routerState.lastMatchingItems.includes(item.id));

        // Determine the correct route:
        // - If we have matching items for the current tab AND they're new or we're on items without search, show items
        // - Otherwise restore the saved router state
        if (
            matchingItems.length &&
            (hasNewMatchingItems || (routerState.path === "items" && !routerState.params.search))
        ) {
            this.router.go("items", { host: "true" }, true);
            this._saveRouterState();
        } else {
            this.router.go(routerState.path || "vaults", routerState.params, true);
        }

        this.router.addEventListener("route-changed", () => this._saveRouterState());
        this.router.addEventListener("params-changed", () => this._saveRouterState());

        this.addEventListener("field-clicked", (event: Event) => {
            const e = event as CustomEvent<{ item: VaultItem; index: number }>;
            return this._fieldClicked(e);
        });
        this.addEventListener("field-dragged", (e: any) => this._fieldDragged(e));

        // this._autoFill(
        //     new CustomEvent("auto-fill", {
        //         detail: {
        //             item: {
        //                 name: "Test",
        //                 fields: [
        //                     { name: "username", value: "martin@maklesoft.com" },
        //                     { name: "password", value: "mypassword" }
        //                 ]
        //             } as VaultItem,
        //             index: 0
        //         }
        //     })
        // );
    }

    async stateChanged() {
        super.stateChanged();

        if (this._isLocked !== this.app.state.locked) {
            this._isLocked = this.app.state.locked;
            if (this._isLocked) {
                await this._locked();
            } else {
                await this._unlocked();
            }
        }

        if (this._isLoggedIn !== this.app.state.loggedIn) {
            this._isLoggedIn = this.app.state.loggedIn;
            if (this._isLoggedIn) {
                await this._loggedIn();
            } else {
                await this._loggedOut();
            }
        }

        notifyStateChanged();
    }

    async _unlocked() {
        if (!this.state.account || !this.state.account.masterKey) {
            return;
        }
        void this._persistUnlockedState();
        this._wrapper.classList.toggle("active", true);
        void this._checkForSavePrompt();
        void this._checkForAgenticAutofillApproval();
        void this._checkForPasskeyApproval();
        void this._checkForPasskeySelection();
    }

    async _locked() {
        await this._syncLockedState("locked");
    }

    private async _restoreBiometricUnlock() {
        const result = await unlockWithBiometric(this.app);
        if (result === "unlocked") {
            this._lastFreshUserVerificationAt = Date.now();
            this._unlocked();
            return true;
        }
        return false;
    }

    async _loggedIn() {
        await browser.runtime.sendMessage({
            type: "loggedIn",
        });
    }

    async _loggedOut() {
        await this._syncLockedState("loggedOut");
    }

    private async _saveSessionMasterKey() {
        if (!this.state.account?.masterKey || !this.app.account || !this.app.session) {
            return;
        }

        await saveSessionMasterKey({
            accountId: this.app.account.id,
            sessionId: this.app.session.id,
            masterKey: this.state.account.masterKey,
        });
    }

    private async _notifyUnlockedState() {
        await awaitWorkerUnlock(() => browser.runtime.sendMessage({ type: "unlocked" }));
    }

    private async _syncLockedState(type: "locked" | "loggedOut") {
        await clearSessionMasterKey();
        await browser.runtime.sendMessage({ type });
    }

    private async _getRouterState() {
        try {
            return await this.app.storage.get(RouterState, "");
        } catch (e) {
            return new RouterState();
        }
    }

    private async _saveRouterState() {
        const { host, ...params } = this.router.params;
        const lastMatchingItems = this._matchingItems.map(({ item }) => item.id);
        await this.app.storage.save(new RouterState({ path: this.router.path, params, lastMatchingItems }));
    }

    protected async _fieldClicked(e: CustomEvent<{ item: VaultItem; index: number }>) {
        const { item, index } = e.detail;
        const field = item.fields[index];
        if (!field) return;
        const value = await field.transform();
        await messageTab({ type: "fillActive", value });
    }

    protected async _fieldDragged(e: CustomEvent<{ item: VaultItem; index: number; event: DragEvent }>) {
        super._fieldDragged(e);

        const event = e.detail.event;

        const dragleave = () => {
            document.body.style.width = "0";
            document.body.style.height = "0";
            document.body.style.opacity = "0";
        };

        const dragend = () => {
            document.body.style.width = "";
            document.body.style.height = "";
            document.body.style.opacity = "1";
            document.removeEventListener("dragleave", dragleave);
        };

        // const drag = (e: DragEvent) => {
        //     console.log("drag", e);
        // };

        document.addEventListener("dragleave", dragleave, { once: true });
        event.target!.addEventListener("dragend", dragend, { once: true });
        // document.addEventListener("drag", drag);

        // const field = item.fields[index];
        // const value = await transformedValue(field);
        //
        // await messageTab({
        //     type: "fillOnDrop",
        //     value
        // });
    }

    private async _checkForSavePrompt() {
        if (this.app.state.locked || !this.app.state.loggedIn) return;

        try {
            const response = await browser.runtime.sendMessage({ type: "getSavePrompt" });
            if (response?.type === "getSavePromptResponse" && response.prompt) {
                this._pendingSavePrompt = response.prompt;
                this._renderSavePromptOverlay();
            }
        } catch {
            // Worker may not be ready
        }
    }

    private _renderSavePromptOverlay() {
        if (!this._pendingSavePrompt) return;

        const prompt = this._pendingSavePrompt;
        const hostname = (() => {
            try {
                return new URL(prompt.url).hostname;
            } catch {
                return prompt.url;
            }
        })();

        const isUpdate = !!prompt.existingItem;

        const overlayHtml = `
            <div class="save-prompt-overlay">
                <div class="save-prompt-card">
                    <div class="save-prompt-header">
                        <pl-icon icon="lock" class="save-prompt-icon"></pl-icon>
                        <span class="save-prompt-title">${isUpdate ? "Update Login?" : "Save Login?"}</span>
                    </div>
                    <div class="save-prompt-body">
                        <div class="save-prompt-host">${this._escapeHtml(hostname)}</div>
                        <div class="save-prompt-username">
                            <span class="save-prompt-label">Username</span>
                            <span class="save-prompt-value">${this._escapeHtml(prompt.username) || "(empty)"}</span>
                        </div>
                        <div class="save-prompt-password">
                            <span class="save-prompt-label">Password</span>
                            <span class="save-prompt-value">${prompt.password ? "••••••••" : "(empty)"}</span>
                        </div>
                    </div>
                    <div class="save-prompt-actions">
                        <button class="save-prompt-btn save-prompt-btn-primary" id="save-prompt-action">
                            ${isUpdate ? "Update" : "Save"}
                        </button>
                        <button class="save-prompt-btn save-prompt-btn-dismiss" id="save-prompt-dismiss">
                            Not Now
                        </button>
                    </div>
                </div>
            </div>
        `;

        this._wrapper.insertAdjacentHTML("beforeend", overlayHtml);
        this._savePromptOverlay = this._wrapper.querySelector(".save-prompt-overlay");

        if (this._savePromptOverlay) {
            this._savePromptOverlay.querySelector("#save-prompt-action")?.addEventListener("click", () => {
                void this._handleSavePromptAction(isUpdate);
            });
            this._savePromptOverlay.querySelector("#save-prompt-dismiss")?.addEventListener("click", () => {
                void this._handleDismissPrompt();
            });
        }
    }

    private async _checkForAgenticAutofillApproval() {
        if (this.app.state.locked || !this.app.state.loggedIn) return;

        try {
            const response = await browser.runtime.sendMessage({ type: "getAgenticAutofillApprovalPrompt" });
            if (response?.type === "getAgenticAutofillApprovalPromptResponse" && response.prompt) {
                this._pendingAutofillApproval = response.prompt;
                this._renderAgenticAutofillApprovalOverlay();
            }
        } catch {
            // Worker may not be ready
        }
    }

    private _renderAgenticAutofillApprovalOverlay() {
        if (!this._pendingAutofillApproval || this._autofillApprovalOverlay) return;

        const prompt = this._pendingAutofillApproval;
        const fieldRows = prompt.fields
            .map(
                (field) => `
                    <div class="save-prompt-username">
                        <span class="save-prompt-label">${this._escapeHtml(field.role)}</span>
                        <span class="save-prompt-value">${this._escapeHtml(field.itemName)} / ${this._escapeHtml(
                    field.fieldName
                )} (${this._escapeHtml(field.valuePreview)})</span>
                    </div>
                `
            )
            .join("");
        const overlayHtml = `
            <div class="save-prompt-overlay">
                <div class="save-prompt-card">
                    <div class="save-prompt-header">
                        <pl-icon icon="lock" class="save-prompt-icon"></pl-icon>
                        <span class="save-prompt-title">Approve Autofill?</span>
                    </div>
                    <div class="save-prompt-body">
                        <div class="save-prompt-host">${this._escapeHtml(prompt.origin)}</div>
                        ${fieldRows}
                        <div class="save-prompt-password">
                            <span class="save-prompt-label">Payment fields</span>
                            <span class="save-prompt-value">${prompt.paymentFieldCount}</span>
                        </div>
                        <div class="save-prompt-password">
                            <span class="save-prompt-label">Transaction-only fields</span>
                            <span class="save-prompt-value">${prompt.transactionOnlyCount}</span>
                        </div>
                        ${
                            prompt.finalSubmitWarning
                                ? `<div class="save-prompt-password">
                                    <span class="save-prompt-label">Final submit</span>
                                    <span class="save-prompt-value">Separate human approval required</span>
                                </div>`
                                : ""
                        }
                    </div>
                    <div class="save-prompt-actions">
                        <button class="save-prompt-btn save-prompt-btn-primary" id="agentic-autofill-approve">Approve</button>
                        <button class="save-prompt-btn save-prompt-btn-dismiss" id="agentic-autofill-dismiss">Not Now</button>
                    </div>
                </div>
            </div>
        `;

        this._wrapper.insertAdjacentHTML("beforeend", overlayHtml);
        this._autofillApprovalOverlay = this._wrapper.querySelector(".save-prompt-overlay:last-child");
        this._autofillApprovalOverlay?.querySelector("#agentic-autofill-approve")?.addEventListener("click", () => {
            void this._handleAgenticAutofillApproval();
        });
        this._autofillApprovalOverlay?.querySelector("#agentic-autofill-dismiss")?.addEventListener("click", () => {
            void this._handleAgenticAutofillDismiss();
        });
    }

    private _dismissAgenticAutofillApprovalOverlay() {
        if (this._autofillApprovalOverlay) {
            this._autofillApprovalOverlay.remove();
            this._autofillApprovalOverlay = null;
        }
        this._pendingAutofillApproval = null;
    }

    private async _handleAgenticAutofillApproval() {
        if (!this._pendingAutofillApproval) return;
        const planId = this._pendingAutofillApproval.planId;
        const promptNonce = this._pendingAutofillApproval.promptNonce;
        this._dismissAgenticAutofillApprovalOverlay();
        await browser.runtime.sendMessage({ type: "approveAgenticAutofill", planId, promptNonce });
    }

    private async _handleAgenticAutofillDismiss() {
        if (!this._pendingAutofillApproval) return;
        const planId = this._pendingAutofillApproval.planId;
        this._dismissAgenticAutofillApprovalOverlay();
        await browser.runtime.sendMessage({ type: "dismissAgenticAutofill", planId });
    }

    private async _checkForPasskeyApproval() {
        if (this.app.state.locked || !this.app.state.loggedIn) return;
        try {
            const response = await browser.runtime.sendMessage({ type: "getPasskeyApprovalPrompt" });
            if (response?.type === "getPasskeyApprovalPromptResponse" && response.prompt) {
                this._pendingPasskeyApproval = response.prompt;
                this._renderPasskeyApprovalOverlay();
            }
        } catch {
            // The ceremony may have expired or the worker may still be waking.
        }
    }

    private _renderPasskeyApprovalOverlay() {
        if (!this._pendingPasskeyApproval || this._passkeyApprovalOverlay) return;
        const prompt = this._pendingPasskeyApproval;
        const action = prompt.operation === "create" ? "Create Passkey" : "Use Passkey";
        const identity = prompt.userDisplayName || prompt.userName || "Saved account";
        this._wrapper.insertAdjacentHTML(
            "beforeend",
            `<div class="save-prompt-overlay">
                <div class="save-prompt-card">
                    <div class="save-prompt-header">
                        <pl-icon icon="fingerprint" class="save-prompt-icon"></pl-icon>
                        <span class="save-prompt-title">${action}?</span>
                    </div>
                    <div class="save-prompt-body">
                        <div class="save-prompt-host">${this._escapeHtml(prompt.rpName || prompt.rpId)}</div>
                        <div class="save-prompt-username">
                            <span class="save-prompt-label">Account</span>
                            <span class="save-prompt-value">${this._escapeHtml(identity)}</span>
                        </div>
                        <div class="save-prompt-password">
                            <span class="save-prompt-label">Origin</span>
                            <span class="save-prompt-value">${this._escapeHtml(prompt.origin)}</span>
                        </div>
                    </div>
                    <div class="save-prompt-actions">
                        <button class="save-prompt-btn save-prompt-btn-primary" id="passkey-approve">${action}</button>
                        <button class="save-prompt-btn save-prompt-btn-dismiss" id="passkey-dismiss">Cancel</button>
                    </div>
                </div>
            </div>`
        );
        this._passkeyApprovalOverlay = this._wrapper.querySelector(".save-prompt-overlay:last-child");
        this._passkeyApprovalOverlay?.querySelector("#passkey-approve")?.addEventListener("click", () => {
            void this._handlePasskeyApproval();
        });
        this._passkeyApprovalOverlay?.querySelector("#passkey-dismiss")?.addEventListener("click", () => {
            void this._handlePasskeyDismiss();
        });
    }

    private _dismissPasskeyApprovalOverlay() {
        this._passkeyApprovalOverlay?.remove();
        this._passkeyApprovalOverlay = null;
        this._pendingPasskeyApproval = null;
    }

    private async _handlePasskeyApproval() {
        const prompt = this._pendingPasskeyApproval;
        if (!prompt || Date.now() >= prompt.expiresAt) return this._dismissPasskeyApprovalOverlay();
        const verification = await verifyPasskeyUserPresence({
            recentlyVerified: Date.now() - this._lastFreshUserVerificationAt <= 60_000,
            verifyBiometric: () => verifyUserPresenceWithBiometric(this.app),
            requirePassword: async () => {
                this._dismissPasskeyApprovalOverlay();
                await this.app.lock();
            },
        });
        if (verification === "cancelled") {
            const button = this._passkeyApprovalOverlay?.querySelector("#passkey-approve");
            if (button) button.textContent = "Verification cancelled";
            return;
        }
        if (verification === "password-required") return;
        this._dismissPasskeyApprovalOverlay();
        await browser.runtime.sendMessage({
            type: "approvePasskey",
            requestId: prompt.requestId,
            promptNonce: prompt.promptNonce,
            userVerified: true,
        });
        for (let attempt = 0; attempt < 30; attempt++) {
            if (await this._checkForPasskeySelection()) return;
            await new Promise((resolve) => setTimeout(resolve, 100));
        }
    }

    private async _handlePasskeyDismiss() {
        const prompt = this._pendingPasskeyApproval;
        this._dismissPasskeyApprovalOverlay();
        if (prompt) {
            await browser.runtime.sendMessage({
                type: "dismissPasskey",
                requestId: prompt.requestId,
                promptNonce: prompt.promptNonce,
            });
        }
    }

    private async _checkForPasskeySelection(): Promise<boolean> {
        if (this.app.state.locked || !this.app.state.loggedIn) return false;
        try {
            const response = await browser.runtime.sendMessage({ type: "getPasskeySelectionPrompt" });
            if (response?.type !== "getPasskeySelectionPromptResponse" || !response.prompt) return false;
            this._pendingPasskeySelection = response.prompt;
            this._renderPasskeySelectionOverlay();
            return true;
        } catch {
            return false;
        }
    }

    private _renderPasskeySelectionOverlay() {
        if (!this._pendingPasskeySelection || this._passkeySelectionOverlay) return;
        const prompt = this._pendingPasskeySelection;
        const candidates = prompt.candidates
            .map(
                (candidate, index) => `<label class="passkey-selection-option" for="passkey-selection-${index}">
                    <input type="radio" id="passkey-selection-${index}" name="passkey-selection" value="${this._escapeHtml(
                    candidate.selectionId
                )}" />
                    <span class="passkey-selection-identity">
                        <strong>${this._escapeHtml(candidate.userDisplayName)}</strong>
                        <span>${this._escapeHtml(candidate.userName)}</span>
                    </span>
                </label>`
            )
            .join("");
        this._wrapper.insertAdjacentHTML(
            "beforeend",
            `<div class="save-prompt-overlay">
                <div class="save-prompt-card">
                    <div class="save-prompt-header">
                        <pl-icon icon="fingerprint" class="save-prompt-icon"></pl-icon>
                        <span class="save-prompt-title">Choose a Passkey</span>
                    </div>
                    <div class="save-prompt-body">
                        <div class="save-prompt-host">${this._escapeHtml(prompt.rpId)}</div>
                        <div class="passkey-selection-list">${candidates}</div>
                    </div>
                    <div class="save-prompt-actions">
                        <button class="save-prompt-btn save-prompt-btn-primary" id="passkey-selection-confirm">Continue</button>
                        <button class="save-prompt-btn save-prompt-btn-dismiss" id="passkey-selection-dismiss">Cancel</button>
                    </div>
                </div>
            </div>`
        );
        this._passkeySelectionOverlay = this._wrapper.querySelector(".save-prompt-overlay:last-child");
        this._passkeySelectionOverlay?.querySelector("#passkey-selection-confirm")?.addEventListener("click", () => {
            void this._handlePasskeySelection();
        });
        this._passkeySelectionOverlay?.querySelector("#passkey-selection-dismiss")?.addEventListener("click", () => {
            void this._handlePasskeySelectionDismiss();
        });
    }

    private _dismissPasskeySelectionOverlay() {
        this._passkeySelectionOverlay?.remove();
        this._passkeySelectionOverlay = null;
        this._pendingPasskeySelection = null;
    }

    private async _handlePasskeySelection() {
        const prompt = this._pendingPasskeySelection;
        if (!prompt || Date.now() >= prompt.expiresAt) return this._dismissPasskeySelectionOverlay();
        const selected = this._passkeySelectionOverlay?.querySelector<HTMLInputElement>(
            "input[name='passkey-selection']:checked"
        );
        if (!selected) {
            const button = this._passkeySelectionOverlay?.querySelector("#passkey-selection-confirm");
            if (button) button.textContent = "Choose an account";
            return;
        }
        this._dismissPasskeySelectionOverlay();
        await browser.runtime.sendMessage({
            type: "selectPasskeyCredential",
            requestId: prompt.requestId,
            promptNonce: prompt.promptNonce,
            selectionId: selected.value,
        });
    }

    private async _handlePasskeySelectionDismiss() {
        const prompt = this._pendingPasskeySelection;
        this._dismissPasskeySelectionOverlay();
        if (!prompt) return;
        await browser.runtime.sendMessage({
            type: "dismissPasskeySelection",
            requestId: prompt.requestId,
            promptNonce: prompt.promptNonce,
        });
    }

    private _dismissSavePromptOverlay() {
        if (this._savePromptOverlay) {
            this._savePromptOverlay.remove();
            this._savePromptOverlay = null;
        }
        this._pendingSavePrompt = null;
    }

    private async _handleSavePromptAction(isUpdate: boolean) {
        if (!this._pendingSavePrompt) return;
        const promptId = this._pendingSavePrompt.id;
        this._dismissSavePromptOverlay();
        try {
            if (isUpdate) {
                await browser.runtime.sendMessage({ type: "updateCredential", promptId });
            } else {
                await browser.runtime.sendMessage({ type: "saveCredential", promptId });
            }
        } catch {
            // Silently handle - user can still see the updated item in the list
        }
    }

    private async _handleDismissPrompt() {
        if (!this._pendingSavePrompt) return;
        const promptId = this._pendingSavePrompt.id;
        this._dismissSavePromptOverlay();
        try {
            await browser.runtime.sendMessage({ type: "dismissPrompt", promptId });
        } catch {
            // Silently handle
        }
    }

    private _escapeHtml(str: string): string {
        return str
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#039;");
    }
}

if (!customElements.get("pl-extension-app")) {
    customElements.define("pl-extension-app", ExtensionApp);
}
