import { WebCryptoProvider } from "@padloc/app/src/lib/crypto";
import { DeviceInfo, StubPlatform } from "@padloc/core/src/platform";
import { APP_NAME } from "@padloc/core/src/branding";
import { ExtensionStorage } from "./storage";

/** Minimal, DOM-free platform used by the MV3 background service worker. */
export class ExtensionWorkerPlatform extends StubPlatform {
    crypto = new WebCryptoProvider();
    storage = new ExtensionStorage();

    async getDeviceInfo() {
        const navigatorInfo = globalThis.navigator;
        return new DeviceInfo({
            platform: navigatorInfo?.platform || "",
            userAgent: navigatorInfo?.userAgent || "",
            locale: navigatorInfo?.language || "en",
            description: `${APP_NAME} browser extension`,
            runtime: "extension",
        });
    }
}
