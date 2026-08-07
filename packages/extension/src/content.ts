import { browser } from "webextension-polyfill-ts";
// import { throttle } from "@padloc/core/src/util";
import { FieldMappings, Message, CredentialData } from "./message";
import { AutofillFieldRole, classifyAutofillField, isFillableInputType } from "./autofill-classifier";

const css = `
    @font-face {
        font-family: "Nunito";
        font-style: normal;
        font-weight: 400;
        src: url("${browser.runtime.getURL("Nunito-Regular.ttf")}") format("truetype");
    }

    @font-face {
        font-family: "Nunito";
        font-style: normal;
        font-weight: 600;
        src: url("${browser.runtime.getURL("Nunito-SemiBold.ttf")}") format("truetype");
    }

    @font-face {
        font-family: "FontAwesome";
        src: url("${browser.runtime.getURL("fontawesome-webfont.ttf")}") format("truetype");
        font-weight: normal;
        font-style: normal;
    }

    @keyframes ripple {
        from {
            opacity: 0.3;
            transform: scale(1);
        }

        to {
            opacity: 0;
            transform: scale(2);
        }
    }

    @keyframes highlight {
        from {
            opacity: 0;
            transform: scale(1.1);
        }

        to {
            opacity: 1;
            transform: scale(1);
        }
    }

    .ripple {
        position: absolute;
        z-index: 9999999;
        border-radius: 8px;
        background: #3bb7f9;
        animation: ripple 0.8s both;
        pointer-events: none;
        will-change: transform, opacity;
    }

    .highlight {
        position: absolute;
        left: 0;
        top: 0;
        z-index: 9999999;
        border-radius: 8px;
        border: solid 2px #3bb7f9;
        box-sizing: border-box;
        pointer-events: none;
        will-change: transform, width, height, opacity;
        animation: highlight 0.3s both;
    }

    .highlight.out {
        animation-direction: reverse;
    }

    .drag-element {
        position: absolute;
        top: 0;
        left: 0;
        z-index: 9999999;
        border-radius: 8px;
        background: #3bb7f9;
        color: white;
        padding: 6px;
        cursor: grabbing;
        will-change: transform;
        font-family: "Nunito";
        font-size: 14px;
    }

    body.dragging {
        cursor: grabbing !important;
    }
`;

class ExtensionContent {
    // private _hoveredInput: HTMLInputElement | null = null;
    //
    // private _highlightElement: HTMLDivElement;

    async init() {
        const style = document.createElement("style");
        style.type = "text/css";
        style.appendChild(document.createTextNode(css));
        if (document.head) {
            document.head.appendChild(style);
        } else {
            document.documentElement.appendChild(style);
        }
        browser.runtime.onMessage.addListener((msg: Message) => this._handleMessage(msg));
        this._listenForFormSubmit();
    }

    private _handleMessage(msg: Message) {
        switch (msg.type) {
            case "fillActive":
                // Defense-in-depth: messageTab() already scopes delivery to frame 0, but
                // never fill from a nested frame even if some transport path ever delivers
                // here anyway - a cross-origin iframe must never receive real field values.
                if (window.self !== window.top) return Promise.resolve(false);
                return Promise.resolve(this._fill(msg.value));
            case "fillFields":
                if (window.self !== window.top) return Promise.resolve(false);
                return Promise.resolve(this._fillFields(msg.mappings));
            // case "fillOnDrop":
            //     // console.log("autofill", msg);
            //     return new Promise(resolve => {
            //         let timeout: number;
            //
            //         const dragover = (e: DragEvent) => {
            //             // console.log("dragover", performance.now());
            //             if (timeout) {
            //                 clearTimeout(timeout);
            //             }
            //             this._updateHovered(e);
            //         };
            //
            //         const dragleave = () => {
            //             // console.log("dragleave", performance.now());
            //             timeout = window.setTimeout(() => {
            //                 if (this._hoveredInput) {
            //                     resolve(this._fill(msg.value, this._hoveredInput));
            //                 } else {
            //                     resolve(false);
            //                 }
            //
            //                 this._highlight(null);
            //                 this._hoveredInput = null;
            //                 document.removeEventListener("dragover", dragover);
            //                 document.removeEventListener("dragleave", dragleave);
            //             }, 100);
            //         };
            //
            //         document.addEventListener("dragover", dragover);
            //         document.addEventListener("dragleave", dragleave);
            //     });
            case "hasActiveInput":
                const activeInput = this._getActiveInput();
                // console.log("has active input", activeInput);
                return Promise.resolve(!!activeInput);
            case "isContentReady":
                return Promise.resolve(true);
        }
    }

    private _getActiveElement(doc: DocumentOrShadowRoot): Element | null {
        const el = doc.activeElement;
        return (el && el.shadowRoot && this._getActiveElement(el.shadowRoot)) || el;
    }

    private _isElementFillable(el: Element) {
        return el instanceof HTMLInputElement && isFillableInputType(el.type);
    }

    private _getActiveInput(): HTMLInputElement | null {
        const el = this._getActiveElement(document);
        return el && this._isElementFillable(el) ? (el as HTMLInputElement) : null;
    }

    /**
     * Find the label element associated with an input, if any.
     * Handles both native <label for> and aria-labelledby.
     */
    private _getLabelText(input: HTMLInputElement): string {
        // aria-labelledby takes precedence
        const labelledBy = input.getAttribute("aria-labelledby");
        if (labelledBy) {
            try {
                const labelEl = input.ownerDocument?.getElementById(labelledBy);
                if (labelEl) return labelEl.textContent?.trim().toLowerCase() || "";
            } catch {
                // Cross-origin frames may throw
            }
        }

        // aria-label
        const ariaLabel = input.getAttribute("aria-label");
        if (ariaLabel) return ariaLabel.toLowerCase();

        // Native label via form attribute
        if (input.form) {
            const labels = input.form.labels;
            if (labels?.length) return (labels[0]?.textContent || "").trim().toLowerCase();
        }

        // Walk up to find a label ancestor
        let parent = input.parentElement;
        for (let depth = 0; depth < 5 && parent; depth++) {
            if (parent.tagName === "LABEL") {
                return (parent.textContent || "").trim().toLowerCase();
            }
            parent = parent.parentElement;
        }

        return "";
    }

    private async _fill(value: string, input: HTMLInputElement | null = this._getActiveInput()) {
        if (!input) {
            return false;
        }

        // React 18+, Vue, Angular, and Solid all respond to the `beforeinput` event
        // before they read `input.value`. Fire it first with a ranges to match real user input.
        const selectionStart = input.selectionStart ?? value.length;
        const selectionEnd = input.selectionEnd ?? value.length;

        input.dispatchEvent(
            new InputEvent("beforeinput", {
                bubbles: true,
                cancelable: true,
                data: value,
                inputType: "insertText",
            })
        );

        input.value = value;

        // Restore selection range — required for React/Vue controlled inputs that gate
        // on selectionStart/selectionEnd during composition
        input.setSelectionRange(selectionStart, selectionEnd);

        // Keyboard events — required for Angular and some Vue setups
        input.dispatchEvent(
            new KeyboardEvent("keydown", {
                bubbles: true,
                key: "Enter",
                keyCode: 13,
                which: 13,
            })
        );
        input.dispatchEvent(
            new KeyboardEvent("keyup", {
                bubbles: true,
                key: "Enter",
                keyCode: 13,
                which: 13,
            })
        );

        // Core input event — universally required by React, Vue, Angular, Solid
        input.dispatchEvent(new InputEvent("input", { bubbles: true, cancelable: true }));

        // change event — fires on blur for most frameworks
        input.dispatchEvent(new Event("change", { bubbles: true }));

        // React 16-17 legacy _wrapper event (bridged internally)
        input.dispatchEvent(
            new KeyboardEvent("keypress", {
                bubbles: true,
                key: "Enter",
                keyCode: 13,
                which: 13,
            })
        );

        return true;
    }

    /**
     * Scans the document and shadow roots for fillable input elements,
     * classifies each as an autofill role, and returns them grouped by role.
     */
    private _detectFieldTypes(): Map<HTMLInputElement, AutofillFieldRole> {
        const map = new Map<HTMLInputElement, AutofillFieldRole>();
        this._collectFields(document, map);
        return map;
    }

    private _collectFields(root: Document | ShadowRoot, map: Map<HTMLInputElement, AutofillFieldRole>) {
        const elements = root.querySelectorAll("input");
        for (const el of elements) {
            if (!this._isElementFillable(el)) continue;
            const role = this._classifyField(el as HTMLInputElement);
            if (role !== null) {
                map.set(el as HTMLInputElement, role);
            }
        }

        // Also check inputs associated via form="" attribute but rendered outside the form
        const formIds = new Set<string>();
        for (const input of map.keys()) {
            const formAttr = input.getAttribute("form");
            if (formAttr) formIds.add(formAttr);
        }
        for (const formId of formIds) {
            const externalForm = root.querySelector(`#${CSS.escape(formId)}`);
            if (externalForm instanceof HTMLFormElement) {
                for (const input of externalForm.querySelectorAll("input")) {
                    if (!this._isElementFillable(input)) continue;
                    if (!map.has(input)) {
                        const role = this._classifyField(input);
                        if (role !== null) map.set(input, role);
                    }
                }
            }
        }

        // Walk shadow roots recursively
        const allElements = root.querySelectorAll("*");
        for (const el of allElements) {
            if (el.shadowRoot) {
                this._collectFields(el.shadowRoot, map);
            }
        }
    }

    /**
     * Classifies a single input element as a login, identity, address, payment, or null role.
     * Uses type, name, id, autocomplete, placeholder, aria-label, label text, pattern,
     * maxlength, inputmode, and data-* attributes.
     */
    private _classifyField(input: HTMLInputElement): AutofillFieldRole | null {
        const labelText = this._getLabelText(input);
        return classifyAutofillField({
            type: input.type,
            name: input.name,
            id: input.id,
            autocomplete: input.getAttribute("autocomplete"),
            placeholder: input.placeholder,
            labelText,
            dataFieldType: input.dataset["fieldType"],
            dataField: input.dataset["field"],
            maxLength: input.maxLength,
            pattern: input.getAttribute("pattern"),
            inputmode: input.getAttribute("inputmode"),
        });
    }

    /**
     * Fills multiple fields based on detected field types on the page.
     * Fills username first, then password, then TOTP (if available).
     * Falls back to single-field fill for the active input if no form fields detected.
     */
    private async _fillFields(mappings: FieldMappings): Promise<boolean> {
        if (!hasFillMappings(mappings)) {
            return false;
        }

        const fieldMap = this._detectFieldTypes();
        if (fieldMap.size === 0) {
            // No form detected — fall back to active input fill
            if (mappings.password) {
                return this._fill(mappings.password);
            }
            if (mappings.username) {
                return this._fill(mappings.username);
            }
            return false;
        }

        let filled = false;

        const fieldsByRole = new Map<AutofillFieldRole, HTMLInputElement[]>();

        for (const [input, role] of fieldMap) {
            const fields = fieldsByRole.get(role) || [];
            fields.push(input);
            fieldsByRole.set(role, fields);
        }

        const fillFirst = async (value: string | undefined, roles: AutofillFieldRole[]) => {
            if (!value) return false;
            for (const role of roles) {
                const target = fieldsByRole.get(role)?.[0];
                if (target) {
                    await this._fill(value, target);
                    filled = true;
                    return true;
                }
            }
            return false;
        };

        await fillFirst(mappings.username, [AutofillFieldRole.Username, AutofillFieldRole.ContactEmail]);
        await fillFirst(mappings.password, [AutofillFieldRole.Password]);
        const totpFilled = await fillFirst(mappings.totp, [AutofillFieldRole.Totp]);
        await fillFirst(mappings.fullName, [AutofillFieldRole.PersonFullName]);
        await fillFirst(mappings.firstName, [AutofillFieldRole.PersonFirstName]);
        await fillFirst(mappings.lastName, [AutofillFieldRole.PersonLastName]);
        await fillFirst(mappings.email, [AutofillFieldRole.ContactEmail, AutofillFieldRole.Username]);
        await fillFirst(mappings.phone, [AutofillFieldRole.ContactPhone]);
        await fillFirst(mappings.addressLine1, [AutofillFieldRole.AddressLine1]);
        await fillFirst(mappings.addressLine2, [AutofillFieldRole.AddressLine2]);
        await fillFirst(mappings.city, [AutofillFieldRole.AddressCity]);
        await fillFirst(mappings.region, [AutofillFieldRole.AddressRegion]);
        await fillFirst(mappings.postalCode, [AutofillFieldRole.AddressPostalCode]);
        await fillFirst(mappings.country, [AutofillFieldRole.AddressCountry]);
        await fillFirst(mappings.cardholderName, [AutofillFieldRole.PaymentCardholderName]);
        await fillFirst(mappings.cardNumber, [AutofillFieldRole.PaymentCardPan]);
        await fillFirst(mappings.cardExpiry, [AutofillFieldRole.PaymentCardExpiry]);
        await fillFirst(mappings.cardExpiryMonth, [AutofillFieldRole.PaymentCardExpiryMonth]);
        await fillFirst(mappings.cardExpiryYear, [AutofillFieldRole.PaymentCardExpiryYear]);
        await fillFirst(mappings.cardCvv, [AutofillFieldRole.PaymentCardCvvTransient]);

        if (mappings.totp && !totpFilled) {
            const target =
                fieldsByRole.get(AutofillFieldRole.Totp)?.[0] ||
                fieldsByRole.get(AutofillFieldRole.Password)?.[0] ||
                fieldsByRole.get(AutofillFieldRole.Username)?.[0];
            if (target) {
                await this._fill(mappings.totp, target);
                filled = true;
            }
        }

        return filled;
    }

    /**
     * Attaches submit listeners to forms containing password fields.
     * Captures username + password on submit and sends to background service worker.
     * Suppresses subsequent detection for the same host within the same page session
     * to avoid duplicate prompts after navigation.
     */
    private _listenForFormSubmit() {
        // SECURITY: the content script runs in every frame of the page
        // (manifest.json's all_frames:true, needed for legitimate
        // same-site iframe login forms). Without this guard, ANY
        // embedded iframe on ANY page -- including a third-party ad/
        // tracker iframe with no relationship to the top-level site --
        // could programmatically create and submit a hidden password
        // form to repeatedly trigger the "Save password?" prompt (UI
        // annoyance / fingerprinting whether Padloc is installed).
        // Restrict capture to the top-level frame, or a frame same-origin
        // with it (legitimate same-site embedded login forms); a
        // genuinely cross-origin frame throws accessing `window.top`'s
        // location, which is exactly the case to block.
        if (window.top !== window) {
            try {
                if (window.top?.location.origin !== window.location.origin) {
                    return;
                }
            } catch {
                return;
            }
        }
        const submittedUrls = new Set<string>();

        const findPasswordInputs = (root: Document | ShadowRoot): HTMLInputElement[] => {
            const inputs: HTMLInputElement[] = [];
            const elements = root.querySelectorAll("input");
            for (const el of elements) {
                if (el instanceof HTMLInputElement && el.type === "password") {
                    inputs.push(el);
                }
            }
            const allElements = root.querySelectorAll("*");
            for (const el of allElements) {
                if (el.shadowRoot) {
                    inputs.push(...findPasswordInputs(el.shadowRoot));
                }
            }
            return inputs;
        };

        const findUsernameInput = (form: HTMLFormElement): HTMLInputElement | null => {
            const inputs = form.querySelectorAll("input");
            for (const input of inputs) {
                if (input.type === "email" || input.type === "text" || input.type === "tel") {
                    const name = (input.name || "").toLowerCase();
                    const id = (input.id || "").toLowerCase();
                    const autocomplete = (input.getAttribute("autocomplete") || "").toLowerCase();
                    if (
                        name.includes("user") ||
                        name.includes("login") ||
                        name.includes("email") ||
                        name.includes("account") ||
                        name.includes("username") ||
                        id.includes("user") ||
                        id.includes("login") ||
                        id.includes("email") ||
                        autocomplete === "username" ||
                        autocomplete === "email"
                    ) {
                        return input;
                    }
                }
            }
            return null;
        };

        const handleSubmit = async (event: Event) => {
            const form = event.target;
            if (!(form instanceof HTMLFormElement)) return;

            const passwordInputs = findPasswordInputs(form.ownerDocument || document);
            if (passwordInputs.length === 0) return;

            const url = form.ownerDocument?.location?.href;
            if (!url) return;

            // Deduplicate: don't prompt twice for the same URL in the same page session
            if (submittedUrls.has(url)) return;
            submittedUrls.add(url);

            const usernameInput = findUsernameInput(form);
            const username = usernameInput?.value || "";
            const password = passwordInputs[0]?.value || "";

            if (!username && !password) return;

            const data: CredentialData = { username, password, url };
            browser.runtime.sendMessage({ type: "formSubmitDetected", data }).catch(() => {});
        };

        const attachToForms = (root: Document | ShadowRoot) => {
            const forms = root.querySelectorAll("form");
            for (const form of forms) {
                const passwordInputs = findPasswordInputs(form.ownerDocument || document);
                if (passwordInputs.length > 0) {
                    form.addEventListener("submit", handleSubmit);
                }
            }
            const allElements = root.querySelectorAll("*");
            for (const el of allElements) {
                if (el.shadowRoot) attachToForms(el.shadowRoot);
            }
        };

        attachToForms(document);
    }
    //     const { left, top, width, height } = el.getBoundingClientRect();
    //     const ripple = document.createElement("div");
    //     const { scrollTop, scrollLeft } = document.documentElement;
    //     Object.assign(ripple.style, {
    //         top: `${top + scrollTop}px`,
    //         left: `${left + scrollLeft}px`,
    //         width: width + "px",
    //         height: height + "px"
    //     });
    //     ripple.classList.add("ripple");
    //     document.body.appendChild(ripple);
    //     setTimeout(() => ripple.remove(), 800);
    // }

    // private _highlight(el: HTMLElement | null) {
    //     if (this._highlightElement) {
    //         const hel = this._highlightElement;
    //         hel.classList.add("out");
    //         setTimeout(() => hel.remove(), 500);
    //     }
    //
    //     if (el) {
    //         this._highlightElement = document.createElement("div");
    //         this._highlightElement.classList.add("highlight");
    //         document.body.appendChild(this._highlightElement);
    //
    //         const { left, top, width, height } = el.getBoundingClientRect();
    //         const { scrollTop, scrollLeft } = document.documentElement;
    //         Object.assign(this._highlightElement.style, {
    //             top: `${top + scrollTop}px`,
    //             left: `${left + scrollLeft}px`,
    //             width: width + "px",
    //             height: height + "px",
    //             opacity: 1
    //         });
    //     }
    // }

    // private _keydown({ code, ctrlKey, metaKey, altKey }: KeyboardEvent) {
    //     if (code === "Escape") {
    //         this.close();
    //     }
    //     if (!this._item) {
    //         return;
    //     }
    //
    //     const matchNumber = code.match(/Digit(\d)/);
    //     const index = (matchNumber && parseInt(matchNumber[1])) || NaN;
    //     if (!isNaN(index) && !!this._item.fields[index - 1]) {
    //         const input = this._getActiveInput();
    //         if ((ctrlKey || metaKey) && altKey && input) {
    //             this._fillIndex(index - 1);
    //         } else if (!input) {
    //             this._fieldIndex = index - 1;
    //         }
    //     }
    // }
    //
    // private _dragstart(index: number) {
    //     this._fieldIndex = index;
    //     document.body.classList.add("dragging");
    //     this.classList.add("dragging");
    // }

    // private _getFillableFromPoint(
    //     root: Document | ShadowRoot,
    //     x: number,
    //     y: number,
    //     depth = 0
    // ): HTMLInputElement | null {
    //     const els = root.elementsFromPoint(x, y);
    //
    //     // Check all elements on this level first
    //     const input = els.find(el => this._isElementFillable(el));
    //
    //     if (input) {
    //         return input as HTMLInputElement;
    //     }
    //
    //     // If no fillable elements on this level were found, go one level deeper
    //     for (const el of els) {
    //         if (el.shadowRoot && el.shadowRoot !== root) {
    //             const input = this._getFillableFromPoint(el.shadowRoot, x, y, depth + 1);
    //             if (input) {
    //                 return input;
    //             }
    //         }
    //     }
    //
    //     // If nothing was found, return null
    //     return null;
    // }

    // private _updateHovered = throttle((e: DragEvent) => {
    //     // console.log("update hovered", performance.now());
    //     const input = this._getFillableFromPoint(document, e.clientX, e.clientY);
    //     if (input !== this._hoveredInput) {
    //         this._highlight(input);
    //         this._hoveredInput = input;
    //     }
    // }, 50);
}

function hasFillMappings(mappings: FieldMappings): boolean {
    return Object.values(mappings).some((value) => !!value);
}

const padlocContentWindow = window as Window & { extension?: ExtensionContent };

if (typeof padlocContentWindow.extension === "undefined") {
    padlocContentWindow.extension = new ExtensionContent();
    padlocContentWindow.extension.init();
}
