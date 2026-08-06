/**
 * Focused tests for the password-share-links RPC handlers
 * (openspec/changes/share-password), exercising the REAL Controller
 * methods (not reimplementations): auth gating for create/status/revoke
 * vs. anonymous peek/reveal, TTL-cap validation, and content-free
 * terminal-state error mapping (missing/expired/already-viewed/revoked
 * shares all collapse to the same error from the caller's perspective).
 *
 * Run: npx ts-node --transpile-only --compiler-options '{"module":"commonjs"}' \
 *          packages/core/test/share-rpc-auth.spec.ts
 */
import { Controller, Context, ServerConfig } from "../src/server";
import { VoidLogger } from "../src/logging";
import { Account } from "../src/account";
import { Auth } from "../src/auth";
import { Err, ErrorCode } from "../src/error";
import { CreateShareParams, ShareData, ShareStatus, ShareStorage } from "../src/share";
import { AESEncryptionParams } from "../src/crypto";
import { Request, RequestAuthentication } from "../src/transport";

interface StoredShare {
    owner: string;
    encryptedData: Uint8Array;
    encryptionParams: AESEncryptionParams;
    viewed: boolean;
    viewedAt?: Date;
    revoked: boolean;
    expired: boolean;
}

/** In-memory `ShareStorage` double -- mirrors `ShareLinkDO`'s externally observable behavior. */
class FakeShareStorage implements ShareStorage {
    shares = new Map<string, StoredShare>();

    async create(id: string, owner: string, data: CreateShareParams): Promise<void> {
        this.shares.set(id, {
            owner,
            encryptedData: data.encryptedData,
            encryptionParams: data.encryptionParams,
            viewed: false,
            revoked: false,
            expired: false,
        });
    }

    async peek(id: string): Promise<{ expired: boolean; viewed: boolean } | null> {
        const share = this.shares.get(id);
        if (!share) {
            return null;
        }
        return { expired: share.expired, viewed: share.viewed };
    }

    async reveal(id: string): Promise<ShareData | null> {
        const share = this.shares.get(id);
        if (!share || share.viewed || share.revoked || share.expired) {
            return null;
        }
        share.viewed = true;
        share.viewedAt = new Date();
        return new ShareData({ encryptedData: share.encryptedData, encryptionParams: share.encryptionParams });
    }

    async getStatus(id: string, owner: string): Promise<ShareStatus | null> {
        const share = this.shares.get(id);
        if (!share || share.owner !== owner) {
            return null;
        }
        return new ShareStatus({
            expired: share.expired,
            viewed: share.viewed,
            viewedAt: share.viewedAt,
            revoked: share.revoked,
        });
    }

    async revoke(id: string, owner: string): Promise<boolean> {
        const share = this.shares.get(id);
        if (!share || share.owner !== owner || share.viewed) {
            return false;
        }
        share.revoked = true;
        return true;
    }
}

interface ControllerTestDouble {
    context: Context;
    authenticate(req: Request, ctx: Context): Promise<void>;
    createShare(params: CreateShareParams): Promise<{ id: string; expiresAt: Date }>;
    peekShare(id: string): Promise<ShareStatus>;
    revealShare(id: string): Promise<ShareData>;
    getShareStatus(id: string): Promise<ShareStatus>;
    revokeShare(id: string): Promise<void>;
}

function makeController(
    opts: { authed?: boolean; accountId?: string; shareStorage?: ShareStorage; configInit?: Partial<ServerConfig> } = {}
): ControllerTestDouble {
    const config = new ServerConfig(opts.configInit);
    const fakeServer = {
        config,
        logger: new VoidLogger(),
        changeLogger: undefined,
        requestLogger: undefined,
        storage: {},
        shareStorage: opts.shareStorage,
    };
    const context: { id: string; account?: Account; session?: object; auth?: Auth; provisioning?: object } = {
        id: "test",
    };
    if (opts.authed) {
        const account = new Account();
        account.id = opts.accountId || "acct1";
        context.account = account;
        context.session = {};
        context.auth = new Auth("sender@example.com");
        context.provisioning = {};
    }
    // Controller expects a real `Server`/`Context`; this is a minimal duck-typed
    // double exercising only what `_requireAuth()` and the share handlers touch.
    return new Controller(
        fakeServer as unknown as ConstructorParameters<typeof Controller>[0],
        context as ConstructorParameters<typeof Controller>[1]
    ) as unknown as ControllerTestDouble;
}

function makeShareParams(ttlSeconds = 3600): CreateShareParams {
    return new CreateShareParams({
        encryptedData: new Uint8Array([1, 2, 3]),
        encryptionParams: new AESEncryptionParams(),
        ttlSeconds,
    });
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

async function assertRejects(run: () => Promise<unknown>, code: ErrorCode, label: string) {
    let err: unknown = null;
    try {
        await run();
    } catch (e) {
        err = e;
    }
    ok(err instanceof Err && err.code === code, label);
}

async function assertResolves<T>(run: () => Promise<T>, label: string): Promise<T | undefined> {
    try {
        const result = await run();
        ok(true, label);
        return result;
    } catch (e) {
        ok(false, `${label} (threw ${e instanceof Err ? e.code : e})`);
        return undefined;
    }
}

async function main() {
    // ── createShare / getShareStatus / revokeShare reject unauthenticated ──────
    console.log("\n[Auth gating: create/status/revoke reject unauthed]");
    {
        const storage = new FakeShareStorage();
        const anon = makeController({ authed: false, shareStorage: storage });
        await assertRejects(
            () => anon.createShare(makeShareParams()),
            ErrorCode.INVALID_SESSION,
            "createShare rejects unauthenticated caller"
        );
        await assertRejects(
            () => anon.getShareStatus("nonexistent"),
            ErrorCode.INVALID_SESSION,
            "getShareStatus rejects unauthenticated caller"
        );
        await assertRejects(
            () => anon.revokeShare("nonexistent"),
            ErrorCode.INVALID_SESSION,
            "revokeShare rejects unauthenticated caller"
        );
    }

    // ── peekShare / revealShare work anonymously ────────────────────────────────
    console.log("\n[Auth gating: peek/reveal work anonymously]");
    {
        const storage = new FakeShareStorage();
        const sender = makeController({ authed: true, shareStorage: storage });
        const link = await assertResolves(() => sender.createShare(makeShareParams()), "sender creates a share");
        const anon = makeController({ authed: false, shareStorage: storage });

        const status = await assertResolves(
            () => anon.peekShare(link!.id),
            "anonymous peekShare does not throw auth error"
        );
        ok(status instanceof ShareStatus && status.viewed === false, "peek reports unviewed before reveal");

        const revealed = await assertResolves(
            () => anon.revealShare(link!.id),
            "anonymous revealShare does not throw auth error"
        );
        ok(
            revealed instanceof ShareData && revealed.encryptedData.length === 3,
            "reveal returns the stored ciphertext"
        );
    }

    // ── TTL exceeds configured maximum ──────────────────────────────────────────
    console.log("\n[Share Creation: TTL exceeds configured maximum]");
    {
        const storage = new FakeShareStorage();
        const sender = makeController({
            authed: true,
            shareStorage: storage,
            configInit: { shareLinkMaxTtlSeconds: 3600 },
        });
        await assertRejects(
            () => sender.createShare(makeShareParams(7200)),
            ErrorCode.BAD_REQUEST,
            "createShare rejects TTL above shareLinkMaxTtlSeconds"
        );
        const link = await assertResolves(
            () => sender.createShare(makeShareParams(3600)),
            "createShare accepts TTL at the configured maximum"
        );
        ok(!!link, "share link info returned for accepted TTL");
    }

    // ── Share Creation: non-finite/non-positive TTL bypasses the max-TTL policy ──
    // Security finding: `NaN > shareLinkMaxTtlSeconds` is `false`, so an
    // upper-bound-only check silently accepted a non-numeric ttlSeconds
    // (e.g. a client bypassing the fixed TTL_OPTIONS dropdown and calling
    // the RPC directly), which then made every downstream expiry
    // comparison against it evaluate to `false` -- an effectively
    // permanent share, defeating the admin-configured TTL ceiling.
    console.log("\n[Share Creation: non-finite/non-positive TTL is rejected]");
    {
        const storage = new FakeShareStorage();
        const sender = makeController({
            authed: true,
            shareStorage: storage,
            configInit: { shareLinkMaxTtlSeconds: 3600 },
        });
        await assertRejects(
            () => sender.createShare(makeShareParams(NaN)),
            ErrorCode.BAD_REQUEST,
            "createShare rejects NaN ttlSeconds (would otherwise bypass the max-TTL check entirely)"
        );
        await assertRejects(
            () => sender.createShare(makeShareParams(Infinity)),
            ErrorCode.BAD_REQUEST,
            "createShare rejects Infinity ttlSeconds"
        );
        await assertRejects(
            () => sender.createShare(makeShareParams(0)),
            ErrorCode.BAD_REQUEST,
            "createShare rejects zero ttlSeconds"
        );
        await assertRejects(
            () => sender.createShare(makeShareParams(-3600)),
            ErrorCode.BAD_REQUEST,
            "createShare rejects negative ttlSeconds"
        );
    }

    // ── SECURITY: anonymous peek/reveal never process attached auth ────────────
    // A security review found that a logged-in visitor opening a share link
    // in the same browser had their session silently authenticated and
    // persisted (session.lastUsed/lastLocation) as a side effect of the
    // "anonymous" call, even though peekShare/revealShare never call
    // _requireAuth(). Controller.authenticate() must skip ALL auth
    // processing for these two methods, even when req.auth IS present, so
    // a stale/invalid session on the visitor's device can never turn an
    // anonymous share view into a hard auth error either.
    console.log("\n[Security: anonymous share methods never process attached auth]");
    {
        const storage = new FakeShareStorage();
        const sender = makeController({ authed: true, shareStorage: storage });
        const link = await assertResolves(
            () => sender.createShare(makeShareParams()),
            "sender creates a share for the auth-skip test"
        );

        const anon = makeController({ authed: false, shareStorage: storage });

        const forgedReq = new Request();
        forgedReq.method = "peekShare";
        forgedReq.params = [link!.id];
        // A garbage/forged auth block -- if authenticate() processed this
        // at all, it would throw (unknown session) before peekShare ever
        // ran. It must be ignored outright for this method.
        forgedReq.auth = new RequestAuthentication({
            session: "nonexistent-session-id",
            time: new Date(),
            signature: new Uint8Array([9, 9, 9]),
        });

        let authThrew = false;
        try {
            await anon.authenticate(forgedReq, anon.context);
        } catch (e) {
            authThrew = true;
        }
        ok(!authThrew, "authenticate() does not throw for peekShare even with a forged/invalid auth block attached");
    }

    // ── Lifecycle Terminal States: content-free error mapping ──────────────────
    console.log("\n[Lifecycle Terminal States: content-free errors]");
    {
        const storage = new FakeShareStorage();
        const sender = makeController({ authed: true, shareStorage: storage });
        const anon = makeController({ authed: false, shareStorage: storage });

        await assertRejects(
            () => anon.revealShare("never-created"),
            ErrorCode.NOT_FOUND,
            "reveal of never-created share"
        );

        const expiring = await assertResolves(
            () => sender.createShare(makeShareParams()),
            "create share for expiry test"
        );
        storage.shares.get(expiring!.id)!.expired = true;
        await assertRejects(
            () => anon.revealShare(expiring!.id),
            ErrorCode.NOT_FOUND,
            "reveal after expiry (content-free)"
        );

        const viewOnce = await assertResolves(
            () => sender.createShare(makeShareParams()),
            "create share for already-viewed test"
        );
        await assertResolves(() => anon.revealShare(viewOnce!.id), "first reveal succeeds");
        await assertRejects(
            () => anon.revealShare(viewOnce!.id),
            ErrorCode.NOT_FOUND,
            "second reveal after prior view returns the SAME error code as never-created/expired"
        );
    }

    // ── Revocation ───────────────────────────────────────────────────────────────
    console.log("\n[Revocation]");
    {
        const storage = new FakeShareStorage();
        const sender = makeController({ authed: true, shareStorage: storage });
        const anon = makeController({ authed: false, shareStorage: storage });

        const unviewed = await assertResolves(() => sender.createShare(makeShareParams()), "create unviewed share");
        await assertResolves(() => sender.revokeShare(unviewed!.id), "revoke unviewed share succeeds");
        await assertRejects(
            () => anon.revealShare(unviewed!.id),
            ErrorCode.NOT_FOUND,
            "reveal after revoke gets the same error as an already-viewed link"
        );

        const viewed = await assertResolves(
            () => sender.createShare(makeShareParams()),
            "create share to view then revoke"
        );
        await assertResolves(() => anon.revealShare(viewed!.id), "reveal viewed share once");
        await assertRejects(
            () => sender.revokeShare(viewed!.id),
            ErrorCode.NOT_FOUND,
            "revoke after view is a no-op/error: nothing to revoke"
        );
    }

    // ── View Receipt ─────────────────────────────────────────────────────────────
    console.log("\n[View Receipt]");
    {
        const storage = new FakeShareStorage();
        const sender = makeController({ authed: true, accountId: "sender1", shareStorage: storage });
        const anon = makeController({ authed: false, shareStorage: storage });

        const link = await assertResolves(
            () => sender.createShare(makeShareParams()),
            "create share for receipt test"
        );
        const before = await assertResolves(() => sender.getShareStatus(link!.id), "status check before reveal");
        ok(before instanceof ShareStatus && before.viewed === false, "unviewed share status reports not viewed");

        await assertResolves(() => anon.revealShare(link!.id), "recipient reveals the share");

        const after = await assertResolves(() => sender.getShareStatus(link!.id), "status check after reveal");
        ok(
            after instanceof ShareStatus && after.viewed === true && after.viewedAt instanceof Date,
            "viewed share status reports viewedAt"
        );
    }

    // ── Not-supported guard (no ShareStorage injected, e.g. self-hosted Node server) ──
    console.log("\n[Not supported: shareStorage not configured]");
    {
        const sender = makeController({ authed: true });
        const anon = makeController({ authed: false });
        await assertRejects(
            () => sender.createShare(makeShareParams()),
            ErrorCode.NOT_SUPPORTED,
            "createShare without shareStorage reports not_supported"
        );
        await assertRejects(
            () => anon.peekShare("anything"),
            ErrorCode.NOT_SUPPORTED,
            "peekShare without shareStorage reports not_supported"
        );
    }

    console.log(`\n${passed} passed, ${failed} failed`);
    if (failed > 0) {
        process.exit(1);
    }
}

main();
