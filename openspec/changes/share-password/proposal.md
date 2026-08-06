# Proposal: One-Time, Expiring Password Share Links

## Intent

Padloc only shares items between authenticated org/vault members. Users need a 1Password-style link: generate once, view without login, self-destruct after one view or a TTL.

## Scope

### In Scope
- One-time link for a Login item (zero-knowledge)
- Anonymous page, reveal-once on explicit click
- Server-enforced single-view + expiry
- Sender revoke + viewed-timestamp receipt
- Rate limiting on anonymous view endpoint

### Out of Scope
- Non-Login item types — deferred
- Multi-recipient/re-shareable links
- Server-held-key or PIN delivery (breaks zero-knowledge)
- KV consume tracking (no compare-and-swap)

## Capabilities

### New Capabilities
- `password-share-links`: one-time/expiring anonymous share links (generation, retrieval, revocation, view-receipt).

### Modified Capabilities
None.

## Approach

Client generates an AES-256 key, encrypts the item via `SimpleContainer`, uploads only ciphertext via authenticated `createShare`; link is `<clientUrl>/share/:id#k=<key>` (fragment never reaches server). Anonymous `getShare` decrypts client-side; view burns only on explicit "Reveal" click, never on load, surviving preview bots. A per-share Durable Object (`ShareLinkDO`, modeled on `AccountLockDO`) with alarm expiry makes single-view structural. `ServerConfig` gains TTL/max-views params; base URL reuses `config.clientUrl`.

## Affected Areas

| Area | Impact |
|------|--------|
| `core/api.ts`, `server.ts` — share RPCs | New |
| `core/share.ts` — `Share` model | New |
| `worker/durable-objects/share-link.ts` — `ShareLinkDO` | New |
| `worker/wrangler.toml` — DO migration | Modified |
| `ServerConfig` — TTL/max-views params | Modified |
| `worker/rate-limiter.ts` — view-endpoint limit | Modified |
| `app/elements/item-view.ts` — share action | Modified |
| `share-dialog.ts`, `share-view.ts` | New |
| `app/elements/app.ts` — pre-auth route | Modified |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Bots burn view via preview | Med | Reveal-on-click, not load |
| ID enumeration | Low | High-entropy IDs + rate limit |
| Decorated class crashes worker | Low | Reuse `ServerConfig`, no new worker class |
| Fragment leaked via router | Low | Verify `routing.ts` ignores hash |

## Rollback Plan

Purely additive. Revert by removing the DO migration/binding and route registration.

## Dependencies

- Confirm D1/DO consistency guarantees at design time.

## Success Criteria

- [ ] Link reveals exactly once under concurrency
- [ ] Links expire per TTL, no manual cleanup
- [ ] View never burns on bot preview, only reveal click
- [ ] Sender can revoke; sees viewed-timestamp receipt

## Proposal question round

*(Automatic mode — no live user. Assumptions below, pending confirmation.)*

1. Revocable pre-view? Assume yes.
2. Expiry UI: presets (1h/1d/7d/14d), max via `ServerConfig`.
3. Read receipt? Assume yes, timestamp only.
4. Bot-unfurl: load never burns view; explicit reveal only.
5. Whole item, Login-only v1; others deferred.
6. Abuse posture: per-share cap + IP limit via `rate-limiter.ts`.