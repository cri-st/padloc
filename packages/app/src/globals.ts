import { App } from "@padloc/core/src/app";
import { Router } from "./lib/route";
import { AjaxSender } from "./lib/ajax";

const sender = new AjaxSender(process.env.PL_SERVER_URL!);
export const app = new App(sender);
// SECURITY: `app` used to also be assigned to `window.app`, exposing the
// unlocked account, decrypted vaults in memory, the session token, and an
// authenticated API client to ANY JavaScript running in the page context
// -- a trivial, ready-made exfiltration/tamper gadget for a future XSS
// (including one introduced by a compromised npm dependency), turning
// what would otherwise require building real exploit primitives into a
// single `window.app.vaults`/`window.app.api.xxx()` call. Verified no
// live code (app/pwa/cordova, cypress specs) actually reads `window.app`
// -- every internal consumer already imports `{ app }` from this module.
// `window.getPlatform` was the same story (no external reader) and is
// dropped too. `window.router` is KEPT: packages/electron/src/index.ts
// genuinely depends on `window.router.basePath` at startup.
export const router = (window.router = new Router());
