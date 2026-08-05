import { defineConfig } from "@playwright/test";
import fs from "fs";
import path from "path";

const EXTENSION_DIST = path.resolve(__dirname, "../dist");
const manifestPath = path.join(EXTENSION_DIST, "manifest.json");

if (!fs.existsSync(manifestPath)) {
    throw new Error(
        `Extension manifest not found at ${manifestPath}. ` +
            "Run 'npm run web-extension:build' before 'npm run test:extension'."
    );
}

export default defineConfig({
    testDir: __dirname,
    workers: 1,
    timeout: 60_000,
    retries: process.env.PADLOC_PASSKEY_E2E === "1" ? 0 : process.env.CI ? 1 : 0,
    reporter: [
        ["list"],
        ["html", { outputFolder: path.resolve(__dirname, ".playwright-html"), open: "never" }],
        ["json", { outputFile: path.resolve(__dirname, ".playwright-results.json") }],
    ],
    use: {
        baseURL: process.env.PL_SERVER_URL || "https://api-staging.example.com",
    },
    projects: [
        {
            name: "chromium-extension",
        },
    ],
});
