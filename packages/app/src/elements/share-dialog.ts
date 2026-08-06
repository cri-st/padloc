import { VaultItem } from "@padloc/core/src/item";
import { CreateShareParams } from "@padloc/core/src/share";
import { SimpleContainer } from "@padloc/core/src/container";
import { AESKeyParams } from "@padloc/core/src/crypto";
import { getCryptoProvider } from "@padloc/core/src/platform";
import { translate as $l } from "@padloc/locale/src/translate";
import { until } from "lit/directives/until.js";
import { alert } from "../lib/dialog";
import { formatDateFromNow } from "../lib/util";
import { setClipboard } from "../lib/clipboard";
import {
    buildShareableItem,
    encodeShareKeyFragment,
    isFieldSelectedByDefault,
    isFieldShareable,
    isShareableItem,
} from "../lib/share";
import { app } from "../globals";
import { Select } from "./select";
import { Button } from "./button";
import { Dialog } from "./dialog";
import "./input";
import "./toggle";
import { html } from "lit";
import { customElement, query, state } from "lit/decorators.js";

const ONE_HOUR = 60 * 60;
const ONE_DAY = 24 * ONE_HOUR;

const TTL_OPTIONS: { value: number; label: string }[] = [
    { value: ONE_HOUR, label: $l("1 Hour") },
    { value: ONE_DAY, label: $l("1 Day") },
    { value: 7 * ONE_DAY, label: $l("7 Days") },
    { value: 14 * ONE_DAY, label: $l("14 Days") },
];

/**
 * Lets the owner of a Login item create a one-time, expiring share link.
 * The item is AES-encrypted locally (`SimpleContainer`, the same primitive
 * `Attachment` uses) before upload -- the server only ever stores
 * ciphertext, and the decryption key lives exclusively in the resulting
 * link's URL fragment (`#k=...`), which is never sent to the server.
 */
@customElement("pl-share-dialog")
export class ShareDialog extends Dialog<VaultItem, void> {
    @state()
    private _item: VaultItem | null = null;

    @state()
    private _selectedFieldIndices: Set<number> = new Set();

    @state()
    private _link: string = "";

    @state()
    private _expiresAt: Date | null = null;

    @query("#ttlSelect")
    private _ttlSelect: Select<number>;

    @query("#createButton")
    private _createButton: Button;

    async show(item: VaultItem) {
        this._item = item;
        this._link = "";
        this._expiresAt = null;
        this._selectedFieldIndices = new Set(
            item.fields.reduce<number[]>((indices, field, index) => {
                if (isFieldShareable(field) && isFieldSelectedByDefault(field)) {
                    indices.push(index);
                }
                return indices;
            }, [])
        );
        await this.updateComplete;
        this._ttlSelect.value = ONE_DAY;
        return super.show(item);
    }

    private _toggleField(index: number, active: boolean) {
        const next = new Set(this._selectedFieldIndices);
        if (active) {
            next.add(index);
        } else {
            next.delete(index);
        }
        this._selectedFieldIndices = next;
    }

    renderContent() {
        const item = this._item;

        if (!item) {
            return html``;
        }

        return html`
            <div class="padded vertical spacing layout">
                <h1 class="big margined text-centering">${$l("Share Link")}</h1>

                <div class="small subtle text-centering horizontally-padded">
                    ${$l(
                        'Anyone with this link can view "{0}" once. After that -- or once it expires -- the link stops working.',
                        item.name
                    )}
                </div>

                ${this._link
                    ? html`
                          <div class="small highlighted padded text-centering">
                              <pl-icon icon="check" class="inline"></pl-icon> ${$l("Link copied to clipboard!")}
                          </div>

                          <pl-input .value=${this._link} readonly select-on-focus></pl-input>

                          <div class="small subtle text-centering">
                              <pl-icon icon="time" class="inline"></pl-icon>
                              ${this._expiresAt
                                  ? until(
                                        (async () => $l("Expires {0}", await formatDateFromNow(this._expiresAt!)))(),
                                        ""
                                    )
                                  : ""}
                          </div>

                          <div class="horizontal evenly stretching spacing layout">
                              <pl-button @click=${() => setClipboard(this._link, $l("Share Link"))}>
                                  <pl-icon icon="copy" class="right-margined"></pl-icon> ${$l("Copy Again")}
                              </pl-button>
                              <pl-button class="primary" @click=${() => this.done()}>${$l("Done")}</pl-button>
                          </div>
                      `
                    : html`
                          <div class="small subtle horizontally-padded">${$l("Include:")}</div>

                          <div class="vertical layout border-top border-bottom">
                              ${item.fields.map((field, index) =>
                                  isFieldShareable(field)
                                      ? html`
                                            <div
                                                class="padded spacing horizontal center-aligning layout border-bottom:not(:last-child)"
                                            >
                                                <pl-icon icon=${field.icon}></pl-icon>
                                                <div class="stretch ellipsis">${field.name || field.def.name}</div>
                                                <pl-toggle
                                                    .active=${this._selectedFieldIndices.has(index)}
                                                    @change=${(e: CustomEvent<{ value: boolean }>) =>
                                                        this._toggleField(index, e.detail.value)}
                                                ></pl-toggle>
                                            </div>
                                        `
                                      : html``
                              )}
                          </div>

                          <pl-select id="ttlSelect" .options=${TTL_OPTIONS} .label=${$l("Expires After")}></pl-select>

                          <div class="horizontal evenly stretching spacing layout">
                              <pl-button id="createButton" class="primary" @click=${() => this._create()}>
                                  <pl-icon icon="share" class="right-margined"></pl-icon> ${$l("Create Link")}
                              </pl-button>
                              <pl-button @click=${this.dismiss}>${$l("Cancel")}</pl-button>
                          </div>
                      `}
            </div>
        `;
    }

    private async _create() {
        const item = this._item;
        if (!item || this._createButton.state === "loading") {
            return;
        }

        if (!isShareableItem(item)) {
            this.dismiss();
            return;
        }

        const selectedFields = item.fields.filter((_, index) => this._selectedFieldIndices.has(index));
        if (!selectedFields.length) {
            alert($l("Select at least one field to share."), { type: "warning" });
            return;
        }

        this._createButton.start();

        try {
            const key = await getCryptoProvider().generateKey(new AESKeyParams());

            const container = new SimpleContainer();
            await container.unlock(key);
            await container.setData(buildShareableItem(item.name, selectedFields).toBytes());

            const info = await app.api.createShare(
                new CreateShareParams({
                    encryptedData: container.encryptedData!,
                    encryptionParams: container.encryptionParams,
                    ttlSeconds: this._ttlSelect.value || ONE_DAY,
                })
            );

            const link = `${window.location.origin}/share/${info.id}#${encodeShareKeyFragment(key)}`;

            this._expiresAt = info.expiresAt;
            this._link = link;
            this._createButton.success();

            await setClipboard(link, $l("Share Link"));
        } catch (e) {
            this._createButton.fail();
            console.error(e);
            alert(e.message || $l("Failed to create share link. Please try again."), { type: "warning" });
        }
    }
}
