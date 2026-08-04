import DOMPurify from "dompurify";
import { marked } from "marked";
import TurnDown from "turndown";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { html } from "lit";

// Explicit allowlist scoped to what GFM markdown rendering (marked with
// gfm:true) actually produces, instead of DOMPurify's full default profile
// (svg/mathml/style/forms/etc). Keeps the sanitizer's attack surface bounded
// even against a future/unpatched DOMPurify bypass.
export const MARKDOWN_ALLOWED_TAGS = [
    "p",
    "br",
    "hr",
    "strong",
    "em",
    "del",
    "s",
    "ul",
    "ol",
    "li",
    "a",
    "img",
    "code",
    "pre",
    "blockquote",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "table",
    "thead",
    "tbody",
    "tr",
    "th",
    "td",
];

export const MARKDOWN_ALLOWED_ATTR = ["href", "src", "alt", "title"];

marked.use({
    renderer: {
        code(content: string) {
            return `<pre><code>${content.replace("\n", "<br>")}</code></pre>`;
        },
    },
});

const turndown = new TurnDown({
    headingStyle: "atx",
    bulletListMarker: "-",
    hr: "---",
    codeBlockStyle: "fenced",
});

turndown.addRule("p", {
    filter: "p",
    replacement: (content, node) => {
        if (node.nextSibling && !["OL", "UL"].includes(node.nextSibling.nodeName)) {
            content = content + "\n\n";
        }
        if (node.previousSibling) {
            content = "\n\n" + content;
        }
        return content;
    },
});

turndown.addRule("strikethrough", {
    filter: ["s"],
    replacement: function (content) {
        return "~" + content + "~";
    },
});

turndown.addRule("li", {
    filter: "li",
    replacement: (content, node, options) => {
        content = content
            .replace(/^\n+/, "") // remove leading newlines
            .replace(/\n+$/, "\n") // replace trailing newlines with just a single one
            .replace(/\n/gm, "\n    "); // indent

        var prefix = options.bulletListMarker + " ";
        var parent = node.parentNode as HTMLElement | null;
        if (parent?.nodeName === "OL") {
            var start = parent.getAttribute("start");
            var index = Array.prototype.indexOf.call(parent.children, node);
            prefix = (start ? Number(start) + index : index + 1) + ". ";
        }
        return prefix + content + (node.nextSibling && !/\n$/.test(content) ? "\n" : "");
    },
});

// turndown.addRule("lists", {
//     filter: ["ul", "ol"],
//     replacement: (content, node) => {
//         const parent = node.parentNode;
//         if (parent.nodeName === "LI" && parent.lastElementChild === node) {
//             return "\n" + content;
//         } else {
//             return "\n\n" + content + "\n\n";
//         }
//     },
// });

// Add a hook to make all links open a new window, paired with
// rel=noopener noreferrer to prevent reverse tabnabbing (CWE-1022)
DOMPurify.addHook("afterSanitizeAttributes", function (node) {
    // set all elements owning target to target=_blank
    if ("target" in node) {
        node.setAttribute("target", "_blank");
        node.setAttribute("rel", "noopener noreferrer");
    }
});

export function markdownToHtml(md: string, san = true) {
    let markup = marked(md, {
        headerIds: false,
        gfm: true,
        breaks: true,
    });
    if (san) {
        markup = DOMPurify.sanitize(markup, { ALLOWED_TAGS: MARKDOWN_ALLOWED_TAGS, ALLOWED_ATTR: MARKDOWN_ALLOWED_ATTR });
    }
    return markup;
}

export function htmlToMarkdown(html: string) {
    return turndown.turndown(html);
}

export function markdownToLitTemplate(md: string, san = true) {
    const markup = markdownToHtml(md, san);
    return html`${unsafeHTML(markup)}`;
}
