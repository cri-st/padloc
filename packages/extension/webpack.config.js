const { resolve, join } = require("path");
const { EnvironmentPlugin } = require("webpack");
const webpack = require("webpack");
const HtmlWebpackPlugin = require("html-webpack-plugin");
const { CleanWebpackPlugin } = require("clean-webpack-plugin");
const manifest = require("./src/manifest.json");
const sharp = require("sharp");
const { version } = require("./package.json");

const serverUrl = process.env.PL_SERVER_URL || `http://127.0.0.1:${process.env.PL_WORKER_PORT || 8787}`;
const buildEnvironment = process.env.PL_BUILD_ENV || "development";
const passkeyDiagnostics = process.env.PL_PASSKEY_DIAGNOSTICS || (buildEnvironment === "production" ? "false" : "true");
const rootDir = resolve(__dirname, "../..");
const assetsDir = resolve(rootDir, process.env.PL_ASSETS_DIR || "assets");

const { name, terms_of_service, web_extension } = require(join(assetsDir, "manifest.json"));
// Allow personal/self-hosted forks to override the ToS link and passkey RP
// allowlist at build time without editing the committed CH5-branded assets.
const termsOfServiceUrl = process.env.PL_TERMS_OF_SERVICE_URL || terms_of_service;
const passkeyRpRoots = process.env.PL_PASSKEY_RP_ROOTS || "";

module.exports = {
    entry: {
        popup: resolve(__dirname, "src/popup.ts"),
        background: resolve(__dirname, "src/background.ts"),
        content: resolve(__dirname, "src/content.ts"),
        "passkey-page": resolve(__dirname, "src/passkey-page.ts"),
        "passkey-content-bridge": resolve(__dirname, "src/passkey-content-bridge.ts"),
    },
    output: {
        path: resolve(__dirname, "dist"),
        filename: "[name].js",
        chunkFilename: "[name].chunk.js",
        publicPath: "",
        hashFunction: "sha256",
    },
    mode: buildEnvironment === "production" ? "production" : "development",
    devtool: buildEnvironment === "production" ? false : "source-map",
    stats: "minimal",
    optimization: {
        minimize: false,
    },
    resolve: {
        extensions: [".ts", ".js", ".css", ".svg", ".png", ".jpg"],
        alias: {
            assets: assetsDir,
            "@padloc/core": resolve(rootDir, "packages/core"),
            "@padloc/app": resolve(rootDir, "packages/app"),
            "@padloc/locale": resolve(rootDir, "packages/locale"),
        },
    },
    module: {
        rules: [
            {
                test: /\.ts$/,
                loader: "ts-loader",
            },
            {
                test: /\.css$/,
                use: ["style-loader", "css-loader"],
            },
            {
                test: /\.(woff|woff2|eot|ttf|otf|svg|png)$/,
                loader: "file-loader",
                options: {
                    name: "[name].[ext]",
                },
            },
            {
                test: /\.txt|md$/i,
                use: "raw-loader",
            },
        ],
    },
    plugins: [
        new webpack.BannerPlugin({
            banner: [
                "globalThis.window = globalThis.window || globalThis;",
                "globalThis.padlocAgenticAutofillBroker = globalThis.padlocAgenticAutofillBroker || (async (request = {}) => ({",
                "    ok: false,",
                "    protocolVersion: 1,",
                "    requestId: request.requestId,",
                "    vaultState: 'locked',",
                "    reason: 'Padloc background app not initialized; fail-closed redacted broker prelude',",
                "    audit: { operation: request.type || 'status', valuePolicy: 'redacted status only; no raw autofill values' },",
                "}));",
            ].join("\n"),
            raw: true,
            entryOnly: true,
        }),
        new EnvironmentPlugin({
            PL_APP_NAME: name,
            PL_SERVER_URL: serverUrl,
            PL_BUILD_ENV: buildEnvironment,
            PL_PASSKEY_DIAGNOSTICS: passkeyDiagnostics,
            PL_BILLING_ENABLED: null,
            PL_BILLING_DISABLE_PAYMENT: null,
            PL_BILLING_STRIPE_PUBLIC_KEY: null,
            PL_SUPPORT_EMAIL: process.env.PL_SUPPORT_EMAIL || "support@padloc.app",
            PL_VERSION: version,
            PL_VENDOR_VERSION: version,
            PL_DISABLE_SW: true,
            PL_TERMS_OF_SERVICE: termsOfServiceUrl,
            PL_PASSKEY_RP_ROOTS: passkeyRpRoots,
            PL_MIGRATE_V3_HELP_URL: process.env.PL_MIGRATE_V3_HELP_URL || "",
        }),
        new CleanWebpackPlugin(),
        new HtmlWebpackPlugin({
            title: name,
            template: resolve(__dirname, "src/popup.html"),
            chunks: ["popup"],
            filename: "popup.html",
            meta: {
                "Content-Security-Policy": {
                    "http-equiv": "Content-Security-Policy",
                    content: `default-src 'self' ${serverUrl} https://api.pwnedpasswords.com blob:; style-src 'self' 'unsafe-inline'; object-src 'self' blob:; frame-src 'self'; img-src 'self' blob: data: *`,
                },
            },
        }),
        {
            apply(compiler) {
                compiler.hooks.emit.tapPromise("Web Extension Manifest", async (compilation) => {
                    const jsonString = JSON.stringify(
                        {
                            ...manifest,
                            version: `${process.env.PL_VENDOR_VERSION || version}.${process.env.RELEASE_BUILD || "0"}`,
                            version_name: process.env.PL_VENDOR_VERSION || version,
                            name: web_extension?.name || name,
                            description: web_extension?.description || `${name} Browser Extension`,
                        },
                        null,
                        4
                    );

                    compilation.assets["manifest.json"] = {
                        source: () => jsonString,
                        size: () => jsonString.length,
                    };

                    const baseIcon = await sharp(resolve(__dirname, assetsDir, "app-icon.png")).resize({
                        width: 128,
                        height: 128,
                    });

                    const iconNormal = await baseIcon.png().toBuffer();
                    const iconGrayscale = await baseIcon.grayscale(true).png().toBuffer();

                    compilation.assets["icon.png"] = {
                        source: () => iconNormal,
                        size: () => Buffer.byteLength(iconNormal),
                    };

                    compilation.assets["icon-grayscale.png"] = {
                        source: () => iconGrayscale,
                        size: () => Buffer.byteLength(iconGrayscale),
                    };

                    return true;
                });
            },
        },
    ],
    devServer: {
        contentBase: resolve(__dirname, "dist"),
        historyApiFallback: true,
        host: "0.0.0.0",
        port: process.env.PL_EXT_PORT || 8090,
    },
};
