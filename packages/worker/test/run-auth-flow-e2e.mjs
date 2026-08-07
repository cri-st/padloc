import http from "http";
import { execFileSync, spawn } from "child_process";
import net from "net";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// Runs test/auth-flow-e2e.worker.ts through a real wrangler dev instance,
// exercising signup/login/session/TOTP-MFA/password-change flows end-to-end
// through the actual HTTP-shaped transport (LocalSender marshals/unmarshals
// exactly like real HTTP). Uses an isolated --persist-to temp dir + a fresh
// D1 migration apply (mirrors run-vault-crud-e2e.mjs / run-account-lockout-e2e.mjs)
// so this test is reproducible on a clean checkout, not dependent on
// whatever local dev state happens to already be migrated on disk.

const port = Number(process.env.AUTH_FLOW_TEST_PORT || 18790);
const packageRoot = new URL("..", import.meta.url);
const persistDir = mkdtempSync(join(tmpdir(), "padloc-auth-flow-"));
const wranglerArgs = [
    "dev",
    "test/auth-flow-e2e.worker.ts",
    "--local",
    "--persist-to",
    persistDir,
    "--env=dev",
    "--ip",
    "127.0.0.1",
    "--port",
    String(port),
];

let output = "";
let child;

async function startChild() {
    await new Promise((resolve, reject) => {
        const server = net.createServer();
        server.once("error", () => reject(new Error(`port ${port} is already in use`)));
        server.listen({ host: "127.0.0.1", port, exclusive: true }, () => server.close(resolve));
    });
    execFileSync(
        "wrangler",
        ["d1", "migrations", "apply", "DB", "--local", "--env=dev", "--persist-to", persistDir],
        { cwd: packageRoot, stdio: "ignore" }
    );
    child = spawn("wrangler", wranglerArgs, { cwd: packageRoot, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", (chunk) => {
        output += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
        output += chunk.toString();
    });
}

function requestTests() {
    return new Promise((resolve, reject) => {
        const req = http.get(`http://127.0.0.1:${port}/auth-flow-tests`, (res) => {
            let body = "";
            res.setEncoding("utf8");
            res.on("data", (chunk) => {
                body += chunk;
            });
            res.on("end", () => {
                resolve({ statusCode: res.statusCode || 0, body });
            });
        });
        req.on("error", reject);
        req.setTimeout(120000, () => {
            req.destroy(new Error("Timed out waiting for auth flow test response"));
        });
    });
}

async function terminateChild() {
    if (!child || child.exitCode !== null) return;
    child.kill("SIGTERM");
    await Promise.race([
        new Promise((resolve) => child.once("exit", resolve)),
        new Promise((resolve) => setTimeout(resolve, 5000)),
    ]);
    if (child.exitCode === null) {
        child.kill("SIGKILL");
        await new Promise((resolve) => child.once("exit", resolve));
    }
}

async function waitForWorker() {
    const started = Date.now();
    while (Date.now() - started < 30000) {
        if (child.exitCode !== null) {
            throw new Error(`wrangler exited before serving requests.\n${output}`);
        }

        try {
            return await requestTests();
        } catch (_error) {
            await new Promise((resolve) => setTimeout(resolve, 500));
        }
    }

    throw new Error(`Timed out waiting for wrangler.\n${output}`);
}

try {
    await startChild();
    const report = await waitForWorker();
    console.log(report.body);
    process.exitCode = report.statusCode >= 200 && report.statusCode < 300 ? 0 : 1;
} catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
} finally {
    await terminateChild();
    rmSync(persistDir, { recursive: true, force: true });
}
