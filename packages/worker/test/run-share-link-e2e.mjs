import http from "http";
import { execFileSync, spawn } from "child_process";
import net from "net";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// Runs test/share-link-e2e.worker.ts through a real `wrangler dev` instance,
// exercising the REAL ShareLinkDO (openspec/changes/share-password) end to
// end through the actual production entrypoint. Task 6.1: create -> peek ->
// reveal -> already-viewed, revoke-then-reveal-fails, and the alarm-driven
// hard-delete-vs-soft-expire lifecycle -- none of it mocked.
//
// The expiry/hard-delete wait happens HERE, across separate HTTP requests to
// the worker, rather than inside one long-lived fetch handler. wrangler dev
// --local (workerd) was empirically found to silently truncate a multi-
// second in-worker `setTimeout` the longer a single request had already
// been running (an exact 2000ms wait measured perfectly on a fresh request,
// but only ~600-1800ms once prior async work shared the same request) --
// there appears to be a cumulative, per-request wall-clock budget in local
// dev, not a per-timer one. Real Node `setTimeout` on this side has no such
// constraint.

const port = Number(process.env.SHARE_LINK_TEST_PORT || 18793);
const packageRoot = new URL("..", import.meta.url);
const persistDir = mkdtempSync(join(tmpdir(), "padloc-share-link-"));
const wranglerArgs = [
    "dev",
    "test/share-link-e2e.worker.ts",
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

function delay(ms) {
    const { promise, resolve } = Promise.withResolvers();
    setTimeout(resolve, ms);
    return promise;
}

async function assertPortAvailable() {
    const { promise, resolve, reject } = Promise.withResolvers();
    const server = net.createServer();
    server.once("error", () => reject(new Error(`port ${port} is already in use`)));
    server.listen({ host: "127.0.0.1", port, exclusive: true }, () => server.close(resolve));
    await promise;
}

async function startChild() {
    await assertPortAvailable();
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

function getJson(path) {
    const { promise, resolve, reject } = Promise.withResolvers();
    const req = http.get(`http://127.0.0.1:${port}${path}`, (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
            body += chunk;
        });
        res.on("end", () => {
            try {
                resolve({ statusCode: res.statusCode || 0, json: JSON.parse(body) });
            } catch (err) {
                reject(new Error(`Failed to parse JSON from ${path}: ${err.message}. Body: ${body}`));
            }
        });
    });
    req.on("error", reject);
    req.setTimeout(15000, () => req.destroy(new Error(`Timed out requesting ${path}`)));
    return promise;
}

async function terminateChild() {
    if (!child || child.exitCode !== null) return;
    child.kill("SIGTERM");

    const { promise: exited, resolve: onExit } = Promise.withResolvers();
    child.once("exit", onExit);
    await Promise.race([exited, delay(5000)]);

    if (child.exitCode === null) {
        child.kill("SIGKILL");
        const { promise: forceExited, resolve: onForceExit } = Promise.withResolvers();
        child.once("exit", onForceExit);
        await forceExited;
    }
}

function probeHealthcheck() {
    const { promise, resolve, reject } = Promise.withResolvers();
    const req = http.get(`http://127.0.0.1:${port}/healthcheck`, (res) => {
        res.resume();
        resolve(res.statusCode);
    });
    req.on("error", reject);
    req.setTimeout(2000, () => req.destroy(new Error("healthcheck timed out")));
    return promise;
}

async function waitForReady() {
    const started = Date.now();
    while (Date.now() - started < 30000) {
        if (child.exitCode !== null) {
            throw new Error(`wrangler exited before serving requests.\n${output}`);
        }

        try {
            await probeHealthcheck();
            return;
        } catch (_error) {
            await delay(500);
        }
    }

    throw new Error(`Timed out waiting for wrangler to become ready.\n${output}`);
}

/**
 * Drives the expiry -> hard-delete scenario across real, separate HTTP
 * requests: create a 2s-TTL share, sleep (Node-side, real time) past
 * expiry, confirm reveal is rejected immediately (independent of whether
 * alarm() has fired), then poll peekShare until the row is physically gone
 * (proving the alarm's hard delete actually happened, not merely that a
 * surviving row got flagged "expired").
 */
async function runExpiryHardDeleteScenario() {
    const { json: created } = await getJson("/share-link-expiry-create");
    const msUntilExpiry = created.createdAt + 2000 - Date.now();
    await delay(Math.max(0, msUntilExpiry) + 500);

    const { json: revealResult } = await getJson(`/share-link-expiry-reveal?id=${encodeURIComponent(created.id)}`);
    if (revealResult.ok || revealResult.code !== "not_found") {
        throw new Error(
            `revealShare on an expired-but-not-yet-alarmed share did not fail with NOT_FOUND: ${JSON.stringify(
                revealResult
            )}`
        );
    }

    const deadline = Date.now() + 20000;
    let hardDeleted = false;
    let lastObserved = null;
    while (Date.now() < deadline && !hardDeleted) {
        const { json: peekResult } = await getJson(`/share-link-expiry-peek?id=${encodeURIComponent(created.id)}`);
        lastObserved = peekResult;
        if (!peekResult.found) {
            hardDeleted = true;
            break;
        }
        await delay(500);
    }

    if (!hardDeleted) {
        throw new Error(
            `alarm() did not hard-delete the expired share within 20s (last observed: ${JSON.stringify(
                lastObserved
            )})`
        );
    }

    return {
        name: "Expiry: reveal rejected immediately once TTL elapses (independent of alarm); alarm eventually hard-deletes the row",
        ok: true,
        detail: "PASS",
    };
}

try {
    await startChild();
    await waitForReady();

    const { statusCode: fastStatus, json: fastResult } = await getJson("/share-link-tests");

    let expiryResult;
    try {
        expiryResult = await runExpiryHardDeleteScenario();
    } catch (err) {
        expiryResult = {
            name: "Expiry: reveal rejected immediately once TTL elapses (independent of alarm); alarm eventually hard-deletes the row",
            ok: false,
            detail: `FAIL: ${err.message}`,
        };
    }

    const allResults = [...fastResult.results, expiryResult];
    const passed = allResults.filter((r) => r.ok).length;
    const failed = allResults.length - passed;
    const ok = fastResult.ok && fastStatus === 200 && expiryResult.ok;

    if (!ok) {
        console.error("Share link E2E tests failed:");
        for (const r of allResults) {
            console.error(`  [${r.ok ? "PASS" : "FAIL"}] ${r.name}: ${r.detail}`);
        }
        console.error(`\nWorker output:\n${output}`);
        process.exitCode = 1;
    } else {
        console.log(`Share link E2E tests passed: ${passed}/${allResults.length}`);
        for (const r of allResults) {
            console.log(`  [PASS] ${r.name}`);
        }
    }
} catch (error) {
    console.error("Share link E2E test run errored:", error.message);
    console.error(`\nWorker output:\n${output}`);
    process.exitCode = 1;
} finally {
    await terminateChild();
    rmSync(persistDir, { recursive: true, force: true });
}
