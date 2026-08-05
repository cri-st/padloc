/**
 * Focused tests for signup gating (ServerConfig.restrictSignup + domain
 * allowlist + org-invite condition), exercising the REAL
 * Controller._assertSignupAllowed method (not a reimplementation).
 *
 * Run: npx ts-node --transpile-only --compiler-options '{"module":"commonjs"}' \
 *          packages/core/test/signup-gate.spec.ts
 */
import assert from "assert";
import { Controller, ServerConfig } from "../src/server";
import { VoidLogger } from "../src/logging";
import { Auth } from "../src/auth";
import { Err, ErrorCode } from "../src/error";

type InviteEntry = { id: string; orgId: string; orgName: string; expires: string };

function makeController(configInit: Partial<ServerConfig>): any {
    const config = new ServerConfig(configInit);
    const fakeServer: any = {
        config,
        logger: new VoidLogger(),
        changeLogger: undefined,
        requestLogger: undefined,
        storage: {},
    };
    return new Controller(fakeServer, { id: "test" } as any);
}

function makeAuth(email: string, invites: InviteEntry[] = []): Auth {
    const auth = new Auth(email);
    auth.invites = invites;
    return auth;
}

function futureInvite(id = "inv1", orgId = "org1"): InviteEntry {
    return { id, orgId, orgName: "Org", expires: new Date(Date.now() + 3600_000).toISOString() };
}

function expiredInvite(id = "inv1", orgId = "org1"): InviteEntry {
    return { id, orgId, orgName: "Org", expires: new Date(Date.now() - 3600_000).toISOString() };
}

let passed = 0;
let failed = 0;

function ok(cond: boolean, label: string) {
    if (cond) {
        passed++;
        console.log(`  \u2713 ${label}`);
    } else {
        failed++;
        console.log(`  \u2717 ${label}`);
    }
}

function assertAllowed(controller: any, email: string, auth: Auth, invite: any, label: string) {
    let threw: unknown = null;
    try {
        controller._assertSignupAllowed(email, auth, invite);
    } catch (e) {
        threw = e;
    }
    ok(threw === null, label);
}

function assertBlocked(controller: any, email: string, auth: Auth, invite: any, label: string) {
    let err: any = null;
    try {
        controller._assertSignupAllowed(email, auth, invite);
    } catch (e) {
        err = e;
    }
    ok(err instanceof Err && err.code === ErrorCode.PROVISIONING_NOT_ALLOWED, label);
}

// ── Open registration (default) ─────────────────────────────────────────────
console.log("\n[Open registration]");
{
    const c = makeController({ restrictSignup: false });
    assertAllowed(c, "anyone@random.com", makeAuth("anyone@random.com"), undefined, "anyone can sign up when restrictSignup=false");
}

// ── Domain OR invite ────────────────────────────────────────────────────────
console.log("\n[Domain OR invite]");
{
    const c = makeController({ restrictSignup: true, signupAllowDomains: true, signupAllowedDomains: ["example.com"] });
    assertAllowed(c, "user@example.com", makeAuth("user@example.com"), undefined, "allowlisted domain is allowed");
    assertAllowed(c, "USER@EXAMPLE.COM", makeAuth("USER@EXAMPLE.COM"), undefined, "domain match is case-insensitive");
    assertBlocked(c, "user@evil.com", makeAuth("user@evil.com"), undefined, "non-allowlisted domain without invite is blocked");
    assertAllowed(c, "user@evil.com", makeAuth("user@evil.com", [futureInvite()]), undefined, "non-allowlisted domain WITH valid invite is allowed");
    assertBlocked(c, "user@evil.com", makeAuth("user@evil.com", [expiredInvite()]), undefined, "expired invite does not pass");
}

// ── Invite-only (domain toggle off) ─────────────────────────────────────────
console.log("\n[Invite-only]");
{
    const c = makeController({ restrictSignup: true, signupAllowDomains: false, signupAllowedDomains: ["example.com"] });
    assertBlocked(c, "user@example.com", makeAuth("user@example.com"), undefined, "domain ignored when signupAllowDomains=false");
    assertAllowed(c, "user@example.com", makeAuth("user@example.com", [futureInvite()]), undefined, "valid invite passes in invite-only mode");
}

// ── createAccount invite reference must match id + org ───────────────────────
console.log("\n[createAccount invite reference]");
{
    const c = makeController({ restrictSignup: true, signupAllowDomains: false });
    const auth = makeAuth("user@evil.com", [futureInvite("inv1", "org1")]);
    assertAllowed(c, "user@evil.com", auth, { id: "inv1", org: "org1" }, "matching invite id+org is allowed");
    assertBlocked(c, "user@evil.com", auth, { id: "wrong", org: "org1" }, "wrong invite id is blocked");
    assertBlocked(c, "user@evil.com", auth, { id: "inv1", org: "wrong" }, "wrong org is blocked");
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
    process.exit(1);
}
