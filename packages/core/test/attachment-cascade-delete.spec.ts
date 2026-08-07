/**
 * Regression test for the attachment cascade-delete gap (supply-chain-compliance-audit,
 * findings-register.md C1): `deleteAccount()` and `deleteOrg()` used to delete the
 * vault storage record without ever calling `attachmentStorage.deleteAll(vaultId)`,
 * orphaning attachment blobs (R2/S3/self-hosted filesystem) instead of erasing them --
 * `deleteVault()` already did this correctly (server.ts:1873-1874); this test proves
 * `deleteAccount`/`deleteOrg` now follow the same pattern.
 *
 * Run: npx ts-node --transpile-only --compiler-options '{"module":"commonjs"}' \
 *          packages/core/test/attachment-cascade-delete.spec.ts
 */
import { Server, ServerConfig } from "../src/server";
import { VoidLogger } from "../src/logging";
import { StubMessenger } from "../src/messenger";
import { MemoryAttachmentStorage, Attachment } from "../src/attachment";
import { MemoryStorage } from "../src/storage";
import { Account } from "../src/account";
import { Auth } from "../src/auth";
import { Session } from "../src/session";
import { Vault } from "../src/vault";
import { Org, OrgMember, OrgRole } from "../src/org";
import { Provisioning } from "../src/provisioning";
import { Err, ErrorCode } from "../src/error";

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

async function assertNotFound(run: () => Promise<unknown>, label: string) {
    try {
        await run();
        ok(false, `${label} (expected NOT_FOUND, but resolved)`);
    } catch (e) {
        ok(e instanceof Err && e.code === ErrorCode.NOT_FOUND, `${label} (got ${e instanceof Err ? e.code : e})`);
    }
}

async function testDeleteAccountCascade() {
    console.log("\n[deleteAccount() cascade-deletes main-vault attachments]");

    const storage = new MemoryStorage();
    const attachmentStorage = new MemoryAttachmentStorage();

    const email = "cascade-account@example.com";
    const account = new Account();
    account.id = "acct-cascade";
    account.email = email;
    account.mainVault = { id: "main-vault-1" };
    account.orgs = [];
    await storage.save(account);

    const vault = new Vault();
    vault.id = account.mainVault.id;
    await storage.save(vault);

    const attachment = new Attachment();
    attachment.id = "att-1";
    attachment.vault = vault.id;
    attachment.size = 42;
    await attachmentStorage.put(attachment);

    // Sanity: attachment is actually there before deletion.
    const before = await attachmentStorage.get(vault.id, attachment.id);
    ok(before.id === attachment.id, "attachment exists before deleteAccount()");

    const auth = new Auth(email);
    await auth.init();
    auth.account = account.id;
    await storage.save(auth);

    const server = new Server(new ServerConfig(), storage, new StubMessenger(), new VoidLogger(), [], attachmentStorage);
    const controller = server.makeController({ id: "req-account" });
    controller.context.account = account;
    controller.context.session = new Session();
    controller.context.auth = auth;
    controller.context.provisioning = new Provisioning();

    await controller.deleteAccount();

    await assertNotFound(
        () => attachmentStorage.get(vault.id, attachment.id),
        "attachment deleted after deleteAccount()"
    );
}

async function testDeleteOrgCascade() {
    console.log("\n[deleteOrg() cascade-deletes attachments across every org vault]");

    const storage = new MemoryStorage();
    const attachmentStorage = new MemoryAttachmentStorage();

    const ownerEmail = "org-owner@example.com";
    const account = new Account();
    account.id = "owner-acct";
    account.email = ownerEmail;
    account.orgs = [];
    await storage.save(account);

    const vault1 = new Vault();
    vault1.id = "org-vault-1";
    await storage.save(vault1);

    const vault2 = new Vault();
    vault2.id = "org-vault-2";
    await storage.save(vault2);

    const att1 = new Attachment();
    att1.id = "att-1";
    att1.vault = vault1.id;
    att1.size = 10;
    await attachmentStorage.put(att1);

    const att2 = new Attachment();
    att2.id = "att-2";
    att2.vault = vault2.id;
    att2.size = 10;
    await attachmentStorage.put(att2);

    // Sanity: both attachments exist before deletion.
    ok((await attachmentStorage.get(vault1.id, att1.id)).id === att1.id, "vault1 attachment exists before deleteOrg()");
    ok((await attachmentStorage.get(vault2.id, att2.id)).id === att2.id, "vault2 attachment exists before deleteOrg()");

    const org = new Org();
    org.id = "org-cascade";
    org.vaults = [
        { id: vault1.id, name: "Vault 1" },
        { id: vault2.id, name: "Vault 2" },
    ];
    org.members = [
        new OrgMember({
            accountId: account.id,
            email: ownerEmail,
            role: OrgRole.Owner,
        }),
    ];
    await storage.save(org);

    const server = new Server(new ServerConfig(), storage, new StubMessenger(), new VoidLogger(), [], attachmentStorage);
    const controller = server.makeController({ id: "req-org" });
    controller.context.account = account;
    controller.context.session = new Session();
    controller.context.auth = new Auth(ownerEmail);
    controller.context.provisioning = new Provisioning();

    await controller.deleteOrg(org.id);

    await assertNotFound(
        () => attachmentStorage.get(vault1.id, att1.id),
        "vault1 attachment deleted after deleteOrg()"
    );
    await assertNotFound(
        () => attachmentStorage.get(vault2.id, att2.id),
        "vault2 attachment deleted after deleteOrg()"
    );
}

async function main() {
    await testDeleteAccountCascade();
    await testDeleteOrgCascade();

    console.log(`\n${passed} passed, ${failed} failed`);
    if (failed > 0) {
        process.exitCode = 1;
    }
}

main();
