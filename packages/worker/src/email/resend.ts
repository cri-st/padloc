import {
    Message,
    MessageData,
    EmailAuthMessage,
    JoinOrgInviteMessage,
    ConfirmMembershipInviteMessage,
} from "@padloc/core/src/messenger";
import { Err, ErrorCode } from "@padloc/core/src/error";
import { getTemplate, interpolate } from "./templates";

function escapeHtml(value: string): string {
    return value
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

/**
 * Renders a message's html/txt bodies. HTML-interpolated values are
 * entity-escaped before substitution — msg.data fields (org name, account
 * display name, etc.) are user-controlled and must never be placed into the
 * HTML template unescaped (CWE-79). Text bodies are left as-is.
 */
function renderTemplate<T extends MessageData>(msg: Message<T>): { html: string; txt: string } {
    const { html, txt } = getTemplate(msg.template);
    const vars = { ...msg.data } as Record<string, string>;
    const htmlVars: Record<string, string> = {};
    for (const [key, value] of Object.entries(vars)) {
        htmlVars[key] = typeof value === "string" ? escapeHtml(value) : value;
    }
    return {
        html: interpolate(html, htmlVars),
        txt: interpolate(txt, vars),
    };
}

export class ResendMessenger {
    constructor(private apiKey: string, private fromAddress: string) {}

    async send<T extends MessageData>(addr: string, msg: Message<T>): Promise<void> {
        const { html, txt } = renderTemplate(msg);
        const idempotencyKey = this._idempotencyKey(msg);

        const res = await fetch("https://api.resend.com/emails", {
            method: "POST",
            headers: {
                Authorization: `Bearer ${this.apiKey}`,
                "Content-Type": "application/json",
                "Idempotency-Key": idempotencyKey,
            },
            body: JSON.stringify({
                from: this.fromAddress,
                to: addr,
                subject: msg.title,
                html,
                text: txt,
            }),
        });

        if (!res.ok) {
            console.error("Resend send failed", {
                status: res.status,
                template: msg.template,
            });
            throw new Err(ErrorCode.SERVER_ERROR, `Resend request failed [${res.status}]`, {
                report: true,
            });
        }
    }

    private _idempotencyKey<T extends MessageData>(msg: Message<T>): string {
        if (msg instanceof EmailAuthMessage) {
            return `email-auth:${msg.data.requestId}`;
        }
        if (msg instanceof JoinOrgInviteMessage || msg instanceof ConfirmMembershipInviteMessage) {
            const data = msg.data as { acceptInviteUrl?: string };
            return `org-invite:${data.acceptInviteUrl ?? "unknown"}`;
        }
        return `email:${msg.template}:${Date.now()}`;
    }
}

export class MockMessenger {
    sent: {
        recipient: string;
        subject: string;
        html: string;
        text: string;
        idempotencyKey: string;
        template: string;
    }[] = [];

    async send<T extends MessageData>(addr: string, msg: Message<T>): Promise<void> {
        const { html, txt } = renderTemplate(msg);
        const key = `mock:${msg.template}:${Date.now()}`;
        this.sent.push({
            recipient: addr,
            subject: msg.title,
            html,
            text: txt,
            idempotencyKey: key,
            template: msg.template,
        });
    }

    lastMessage(addr: string) {
        const entry = this.sent.find((m) => m.recipient === addr);
        return entry ? { subject: entry.subject, html: entry.html, text: entry.text, template: entry.template } : null;
    }

    messagesFor(addr: string) {
        return this.sent.filter((m) => m.recipient === addr);
    }
}

