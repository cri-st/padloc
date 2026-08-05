/**
 * Central brand identity -- single source of truth for the app's display
 * name, support contact, and public URL, referenced by email templates
 * (via interpolation vars), the browser extension UI, and client defaults
 * (packages/core/src/messenger.ts's getAppName()).
 *
 * Native app identity (name/appId/scheme) has its own existing source of
 * truth at assets/manifest.json, which packages/cordova/config.xml,
 * packages/electron/prepare-build.js, and packages/tauri/build-tauri-conf.js
 * already read from -- this file complements that for web/worker/extension
 * runtime code, not native shells.
 *
 * PL_APP_NAME (see messenger.ts) can still override APP_NAME per-deployment
 * without editing this file, for builds that have `process.env` (app,
 * extension, PWA). Workers don't have `process`, so they instead call
 * `setAppNameOverride()` once per request from `env.APP_NAME` -- see
 * packages/worker/src/server-factory.ts.
 */
export const APP_NAME = "Padloc";
export const SUPPORT_EMAIL = "support@padloc.app";
export const APP_URL = "https://padloc.app";

let appNameOverride: string | undefined;

/** Set (or clear, passing undefined) the current Worker isolate's app name override. */
export function setAppNameOverride(name: string | undefined): void {
    appNameOverride = name || undefined;
}

/**
 * Resolves the effective app name: an explicit Worker-set override first,
 * then `process.env.PL_APP_NAME` (build-time override for app/extension/PWA
 * bundles, guarded since Workers have no `process`), then the given default.
 */
export function resolveAppName(defaultName: string = APP_NAME): string {
    if (appNameOverride) {
        return appNameOverride;
    }
    if (typeof process !== "undefined" && process.env?.PL_APP_NAME) {
        return process.env.PL_APP_NAME;
    }
    return defaultName;
}
