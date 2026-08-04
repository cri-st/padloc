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
 * without editing this file.
 */
export const APP_NAME = "CH5 Auth";
export const SUPPORT_EMAIL = "support@ch5.me";
export const APP_URL = "https://pad.ch5.me";
