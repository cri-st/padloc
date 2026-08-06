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
    // SECURITY: build DOM nodes with textContent instead of innerHTML --
    // `message` is unlikely to contain attacker-controlled markup in
    // practice (these are module-load/init failures), but there's no
    // guarantee of that for every future error source, and textContent
    // costs nothing extra here.
    document.body.innerHTML = "";
    const container = document.createElement("div");
    container.style.cssText = "font-family: sans-serif; padding: 16px; color: #b00020; line-height: 1.4;";
    const title = document.createElement("strong");
    title.textContent = `${resolveAppName()} failed to load.`;
    const detail = document.createElement("p");
    detail.style.cssText = "font-size: 12px; white-space: pre-wrap;";
    detail.textContent = message;
    container.append(title, detail);
    document.body.appendChild(container);
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
