# Design: One-Time, Expiring Password Share Links

## Technical Approach

Client-side zero-knowledge sharing on the existing RPC/DO architecture — no new HTTP routing (all RPC kinds funnel through `WorkerReceiver._handlePost`, `transport.ts:93-95`). `createShare` reuses `SimpleContainer`/`AESEncryptionParams` (`container.ts:96-100`), as `Attachment` does. Server state (ciphertext, expiry, single-view flag) lives in a per-share Durable Object, injected via a new `ShareStorage` interface — mirrors the `AttachmentStorage` injection (`attachment.ts:169-175`), not a direct DO import into `packages/core`.

## Architecture Decisions

| Decision | Choice | Alternatives considered | Rationale |
|---|---|---|---|
| Key distribution | URL-fragment AES-256 key (`#k=<base64url(key)>`), never sent to server | Server-held key + out-of-band PIN | Fragment never leaves browser; zero new crypto; matches 1Password model |
| Single-view atomicity | **Durable Object (`ShareLinkDO`), definitive** | D1 `UPDATE...RETURNING`; KV (no compare-and-swap) | Structural atomicity (single-threaded DO); alarm expiry replaces cron; mirrors `AccountLockDO` |
| Link base URL | Reuse `config.clientUrl`, resolved as `acceptInviteUrl` in `server-factory.ts:42-46` | Hardcoded/new env var | Single source of truth per Hosting rules |
| Item-type scope enforcement | **Client-side only**: `share-dialog.ts` enables only if item has a `FieldType.Password` field | Server-side validation | Server never sees plaintext — cannot classify ciphertext |
| Worker-side data access | New `ShareStorage` interface in `share.ts`, DO-backed worker impl | Direct DO import in `Controller` | Keeps `packages/core` platform-agnostic |

## Data Flow

```
CREATE (sender, authed)              REVEAL (recipient, anonymous)
encrypt via SimpleContainer            open <clientUrl>/share/:id#k=KEY
createShare → Controller._requireAuth   share-view.ts reads location.hash
  → ShareStorage.create() → ShareLinkDO   (router untouched — see Risks)
  (sql: ciphertext, expiresAt,          peekShare(id) [anon, rate-limited]
   maxViews=1, owner) + setAlarm          → ShareStorage.peek(): no burn
link = clientUrl+"/share/"+id+"#k="+key user clicks Reveal (explicit)
  (key never sent to server)            revealShare(id) [anon] →
                                           ShareStorage.reveal(): DO flips
                                           viewed, returns ciphertext →
                                           client decrypts w/ fragment key
```

## File Changes

| File | Action | Description |
|---|---|---|
| `packages/core/src/share.ts` | Create | `Share`/`ShareLinkInfo`/params classes, `ShareStorage` interface |
| `packages/core/src/api.ts` | Modify | `@Handler` methods: `createShare`, `peekShare`, `revealShare`, `getShareStatus`, `revokeShare` |
| `packages/core/src/server.ts` | Modify | `Controller` impls; `ServerConfig` TTL params; `Server` ctor gains `shareStorage` |
| `packages/worker/src/durable-objects/share-link.ts` | Create | `ShareLinkDO`, modeled on `locks/account-lock.ts`, SQLite, alarm expiry |
| `packages/worker/src/storage/share-do-storage.ts` | Create | `DurableObjectShareStorage implements ShareStorage`, wraps `env.SHARE_LINKS` |
| `packages/worker/wrangler.toml` | Modify | `new_sqlite_classes=["ShareLinkDO"]` migration; `SHARE_LINKS` binding per env |
| `packages/worker/src/env.ts` | Modify | Add `SHARE_LINKS?: DurableObjectNamespace` |
| `packages/worker/src/index.ts` | Modify | Export `ShareLinkDO`; 2nd `RateLimiter` keyed `share-view:${ip}` |
| `packages/worker/src/server-factory.ts` | Modify | Instantiate `DurableObjectShareStorage`, inject into `createServer` |
| `packages/app/src/elements/item-view.ts` | Modify | "Share Link ..." entry beside `icon="share"` "Move To Vault ..." |
| `packages/app/src/elements/share-dialog.ts` | Create | `Dialog<VaultItem, void>`, TTL `pl-select`, `pl-clipboard` copy, per `export-dialog.ts` |
| `packages/app/src/elements/share-view.ts` | Create | Anonymous pre-auth page: peek on connect, explicit Reveal, mask/reveal |
| `packages/app/src/elements/app.ts` | Modify | Add `"share"` to `_pages`, pre-auth allow-list, `unlocked` exclusion |

## Interfaces / Contracts

```typescript
export type ShareID = string;
export class CreateShareParams extends Serializable {
    @AsBytes() encryptedData: Uint8Array;
    @AsSerializable(AESEncryptionParams) encryptionParams: AESEncryptionParams;
    ttlSeconds: number;
}
export class ShareLinkInfo extends Serializable { id: ShareID; expiresAt: Date; }
export class ShareData extends Serializable {
    @AsBytes() encryptedData: Uint8Array;
    @AsSerializable(AESEncryptionParams) encryptionParams: AESEncryptionParams;
}
export class ShareStatus extends Serializable { expired: boolean; viewed: boolean; viewedAt?: Date; revoked: boolean; }
export interface ShareStorage {
    create(id: ShareID, owner: AccountID, data: CreateShareParams): Promise<void>;
    peek(id: ShareID): Promise<{ expired: boolean; viewed: boolean } | null>;
    reveal(id: ShareID): Promise<ShareData | null>;
    getStatus(id: ShareID, owner: AccountID): Promise<ShareStatus | null>;
    revoke(id: ShareID, owner: AccountID): Promise<boolean>;
}
@Handler(CreateShareParams, ShareLinkInfo) createShare(_: CreateShareParams): PromiseWithProgress<ShareLinkInfo>;
@Handler(String, ShareStatus) peekShare(_id: ShareID): PromiseWithProgress<ShareStatus>;
@Handler(String, ShareData) revealShare(_id: ShareID): PromiseWithProgress<ShareData>;
@Handler(String, ShareStatus) getShareStatus(_id: ShareID): PromiseWithProgress<ShareStatus>;
@Handler(String, undefined) revokeShare(_id: ShareID): PromiseWithProgress<void>;
```

## Testing Strategy

| Layer | What to Test | Approach |
|---|---|---|
| Unit | `ShareLinkDO` atomic reveal under concurrency, alarm expiry; client "Login item" heuristic, fragment key encode/decode | `vitest` DO harness (mirrors `AccountLockDO`); `packages/app` tests |
| Integration | Auth gating: create/status/revoke authed, peek/reveal anon | Extend `server.spec.ts`-style tests |
| Integration | Rate limiter rejects rapid `revealShare` guesses/IP | Worker transport test, mocked KV |
| E2E | create → copy → anon session → reveal once → 2nd fails | Manual/Playwright vs `wrangler dev` |

## Threat Matrix

`references/threat-matrix.md` targets shell/VCS/PR-automation boundaries — none apply (no shell, VCS, PR, or executable-file handling):

| Boundary | Applicability |
|---|---|
| Documentation-like paths | N/A |
| Git repository selection | N/A |
| Commit state | N/A |
| Push state | N/A |
| PR commands | N/A |

Anonymous-route risk (enumeration, bot-burn, fragment leak) covered under Architecture Decisions.

## Migration / Rollout

Additive only: `wrangler.toml` adds `new_sqlite_classes=["ShareLinkDO"]`, no data migration. `ServerConfig` fields default safely. Rollback reverts migration/binding and route.

## Open Questions

- [ ] Exact `revealShare` rate-limit thresholds — start conservative (10/min/IP), tune post-launch.
- [ ] `getShareStatus` receipt: push (WebSocket) vs sender-initiated poll — assume poll for v1.
