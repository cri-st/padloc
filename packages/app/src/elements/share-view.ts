import { Field, VaultItem } from "@padloc/core/src/item";
import { SimpleContainer } from "@padloc/core/src/container";
import { translate as $l } from "@padloc/locale/src/translate";
import { shared, mixins } from "../styles";
import { StateMixin } from "../mixins/state";
import { Routing } from "../mixins/routing";
import { app } from "../globals";
import { setClipboard } from "../lib/clipboard";
import { decodeShareKeyFragment } from "../lib/share";
import { Button } from "./button";
import "./logo";
import "./icon";
import "./button";
import "./spinner";
import { css, html, LitElement } from "lit";
import { customElement, query, state } from "lit/decorators.js";

type ShareViewStatus = "loading" | "invalid" | "viewed" | "ready" | "revealed";

/**
 * Anonymous, pre-auth landing page for a one-time share link
 * (`/share/:id#k=<key>`). No app chrome -- this is a standalone page a
 * recipient with no Padloc account can open directly. Loading the page
 * only calls the non-destructive `peekShare` (never burns the link); the
 * secret is decrypted client-side, and only after the recipient
 * explicitly clicks "Reveal" (which calls `revealShare`, burning the
 * link server-side exactly once).
 */
@customElement("pl-share-view")
export class ShareView extends Routing(StateMixin(LitElement)) {
    readonly routePattern = /^share\/([^\/]+)/;

    @state()
    private _status: ShareViewStatus = "loading";

    @state()
    private _item: VaultItem | null = null;

    @query("#revealButton")
    private _revealButton: Button;

    private _shareId: string = "";
    private _key: Uint8Array | null = null;

    handleRoute([id]: [string]) {
        this._shareId = id || "";
        this._key = decodeShareKeyFragment(window.location.hash);
        this._item = null;
        this._checkStatus();
    }

    private async _checkStatus() {
        this._status = "loading";

        if (!this._shareId || !this._key) {
            this._status = "invalid";
            return;
        }

        try {
            const status = await app.api.peekShare(this._shareId);
            this._status = status.expired ? "invalid" : status.viewed ? "viewed" : "ready";
        } catch (e) {
            this._status = "invalid";
        }
    }

    private async _reveal() {
        if (!this._shareId || !this._key || this._revealButton?.state === "loading") {
            return;
        }

        this._revealButton.start();

        try {
            const data = await app.api.revealShare(this._shareId);

            const container = new SimpleContainer();
            container.encryptionParams = data.encryptionParams;
            container.encryptedData = data.encryptedData;
            await container.unlock(this._key);

            this._item = new VaultItem().fromBytes(await container.getData());
            this._status = "revealed";
            this._revealButton.success();
        } catch (e) {
            // Never distinguish *why* a reveal failed (expired, already
            // viewed, revoked, or never existed) -- same content-free
            // terminal state for all of them, per spec.
            this._status = "invalid";
            this._revealButton.fail();
        }
    }

    private async _copy(field: Field) {
        await setClipboard(await field.transform(), `${this._item!.name} / ${field.name}`);
    }

    static styles = [
        shared,
        css`
            :host {
                ${mixins.fullbleed()};
                position: fixed;
                z-index: 6;
                display: flex;
                background: var(--color-background);
                overflow: auto;
            }

            :host([hidden]) {
                display: none;
            }

            .card {
                width: 100%;
                max-width: 26em;
                margin: auto;
                box-sizing: border-box;
            }

            .field-value {
                font-family: var(--font-family-mono, monospace);
                word-break: break-all;
            }
        `,
    ];

    render() {
        return html`
            <div class="double-padded centering vertical layout card">
                <pl-logo class="animated" style="margin-bottom: 1em;"></pl-logo>

                <div class="double-padded spacing vertical layout card animated" style="width: 100%;">
                    ${this._status === "loading" ? this._renderLoading() : ""}
                    ${this._status === "invalid" ? this._renderInvalid() : ""}
                    ${this._status === "viewed" ? this._renderViewed() : ""}
                    ${this._status === "ready" ? this._renderReady() : ""}
                    ${this._status === "revealed" ? this._renderRevealed() : ""}
                </div>
            </div>
        `;
    }

    private _renderLoading() {
        return html`
            <div class="centering vertical layout" style="padding: 2em 0;">
                <pl-spinner active></pl-spinner>
            </div>
        `;
    }

    private _renderInvalid() {
        return html`
            <div class="centering vertical spacing layout text-centering">
                <pl-icon icon="warning" class="huge"></pl-icon>
                <h1 class="big">${$l("Link Not Available")}</h1>
                <div class="subtle">
                    ${$l("This link is invalid, has expired, or has already been used. Ask the sender for a new one.")}
                </div>
            </div>
        `;
    }

    private _renderViewed() {
        return html`
            <div class="centering vertical spacing layout text-centering">
                <pl-icon icon="check" class="huge"></pl-icon>
                <h1 class="big">${$l("Already Viewed")}</h1>
                <div class="subtle">${$l("This link has already been used and can't be viewed again.")}</div>
            </div>
        `;
    }

    private _renderReady() {
        return html`
            <div class="centering vertical spacing layout text-centering">
                <pl-icon icon="lock" class="huge"></pl-icon>
                <h1 class="big">${$l("Someone Shared a Password With You")}</h1>
                <div class="subtle">
                    ${$l("This link can only be viewed once. After you reveal it, it can't be opened again.")}
                </div>
                <pl-button id="revealButton" class="primary" @click=${() => this._reveal()}>
                    <pl-icon icon="show" class="right-margined"></pl-icon> ${$l("Reveal")}
                </pl-button>
            </div>
        `;
    }

    private _renderRevealed() {
        const item = this._item!;
        return html`
            <div class="vertical spacing layout">
                <div class="small highlighted text-centering">
                    <pl-icon icon="check" class="inline"></pl-icon> ${$l("This link has now been used up.")}
                </div>

                <h1 class="big text-centering">${item.name}</h1>

                <div class="vertical spacing layout">
                    ${item.fields.map(
                        (field) => html`
                            <div class="padded box vertical layout">
                                <div class="tiny subtle bottom-margined">${field.name}</div>
                                <div class="horizontal center-aligning spacing layout">
                                    <div class="field-value stretch">${field.value}</div>
                                    <pl-button
                                        class="slim transparent"
                                        @click=${() => this._copy(field)}
                                        .label=${$l("Copy")}
                                    >
                                        <pl-icon icon="copy"></pl-icon>
                                    </pl-button>
                                </div>
                            </div>
                        `
                    )}
                </div>
            </div>
        `;
    }
}
