import { openExternalUrl } from "@padloc/core/src/platform";
import DOMPurify from "dompurify";
import { html, LitElement } from "lit";
import { customElement, property } from "lit/decorators.js";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { markdownToLitTemplate, MARKDOWN_ALLOWED_TAGS, MARKDOWN_ALLOWED_ATTR } from "../lib/markdown";
import { content, shared } from "../styles";
import { icons } from "../styles/icons";

@customElement("pl-rich-content")
export class RichContent extends LitElement {
    @property()
    content = "";

    @property()
    type: "plain" | "markdown" | "html" = "markdown";

    static styles = [shared, icons, content];

    updated() {
        for (const anchor of [...this.renderRoot.querySelectorAll("a[href]")] as HTMLAnchorElement[]) {
            anchor.addEventListener("click", (e) => {
                e.preventDefault();
                if (anchor.getAttribute("href")?.startsWith("#")) {
                    const el = this.renderRoot.querySelector(anchor.getAttribute("href")!);
                    el?.scrollIntoView();
                } else {
                    openExternalUrl(anchor.href);
                }
            });
        }
    }

    render() {
        switch (this.type) {
            case "markdown":
                // SECURITY: `sanitize` used to be an externally-settable
                // `@property` that let a caller render either markdown or
                // raw HTML completely unsanitized. No live call site ever
                // set it to `false` (verified by grep across packages/app),
                // but the component itself is reused for content that can
                // originate from another party (org status messages,
                // provisioning/billing pages, item notes) -- removed
                // entirely so no future caller can accidentally/silently
                // disable sanitization.
                return markdownToLitTemplate(this.content);
            case "html":
                const content = DOMPurify.sanitize(this.content, {
                    ALLOWED_TAGS: [...MARKDOWN_ALLOWED_TAGS, "pl-icon"],
                    ALLOWED_ATTR: [...MARKDOWN_ALLOWED_ATTR, "icon"],
                });
                return html`${unsafeHTML(content)}`;
            default:
                return html`${this.content}`;
        }
    }
}
