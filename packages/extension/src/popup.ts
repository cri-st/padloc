import { setPlatform } from "@padloc/core/src/platform";
import { ExtensionPlatform } from "./platform";
import { resolveAppName } from "@padloc/core/src/branding";

function focusWindow() {
    if (document.visibilityState !== "hidden") {
        window.focus();
    }
}

function showStartupError(error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    document.body.innerHTML = `
        <div style="font-family: sans-serif; padding: 16px; color: #b00020; line-height: 1.4;">
            <strong>${resolveAppName()} failed to load.</strong>
            <p style="font-size: 12px; white-space: pre-wrap;">${message}</p>
        </div>
    `;
}

async function startPopup() {
    try {
        setPlatform(new ExtensionPlatform());
        await import("./app");

        const app = document.createElement("pl-extension-app");
        document.body.appendChild(app);

        setTimeout(focusWindow, 100);
        setTimeout(focusWindow, 250);
    } catch (error) {
        console.error(`[${resolveAppName()}] Popup failed to start`, error);
        showStartupError(error);
    }
}

if (document.readyState === "loading") {
    window.addEventListener("DOMContentLoaded", () => void startPopup(), { once: true });
} else {
    void startPopup();
}
