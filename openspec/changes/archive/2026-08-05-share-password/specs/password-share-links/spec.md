# Password Share Links Specification

## Purpose

One-time, expiring, anonymous links for Login items: client encrypts locally, server stores ciphertext only, one reveal burns the link.

## Requirements

### Requirement: Share Creation

Authenticated sender MUST create shares for Login items only. Client MUST AES-256 encrypt the item locally (`SimpleContainer`) before upload; server MUST persist ciphertext+params only, never key/plaintext. Sender picks a TTL preset (1h/1d/7d/14d); server MUST reject TTL above `ServerConfig` max. Share MUST be created with `maxViews = 1`.

#### Scenario: Sender creates a share link
- GIVEN sender owns a Login item
- WHEN they choose TTL "1d" and confirm
- THEN server stores ciphertext+params+expiry; client returns `<clientUrl>/share/:id#k=<key>`

#### Scenario: TTL exceeds configured maximum
- GIVEN `shareLinkMaxTtlSeconds` caps TTL at 14d
- WHEN sender requests a larger TTL
- THEN `createShare` MUST reject with a validation error

#### Scenario: Unauthenticated creation attempt
- GIVEN no valid session
- WHEN `createShare` is called
- THEN server MUST reject with an authentication error

### Requirement: Anonymous Reveal Access

Recipient endpoint MUST work without login. Page load (GET, incl. bots) MUST NOT consume the view; only an explicit "Reveal" click MUST. Concurrent reveals MUST resolve to one success.

#### Scenario: Page load does not burn the link
- GIVEN a valid, unviewed share id
- WHEN a client or bot loads `/share/:id`
- THEN server MUST NOT mark it viewed or return ciphertext

#### Scenario: Explicit reveal burns the link
- GIVEN recipient is on the loaded page
- WHEN they click "Reveal"
- THEN server marks it viewed atomically, returns ciphertext once

#### Scenario: Concurrent reveal race
- GIVEN two reveal requests arrive simultaneously
- WHEN both processed
- THEN one gets ciphertext; the other gets an already-viewed error

### Requirement: Lifecycle Terminal States

Expired or already-viewed shares MUST deny reveal with a content-free error.

#### Scenario: Reveal after expiry
- GIVEN a share whose TTL elapsed
- WHEN reveal is requested
- THEN server MUST return "expired", never ciphertext

#### Scenario: Reveal after prior view
- GIVEN a share already consumed
- WHEN reveal is requested again
- THEN server MUST return "already viewed"

### Requirement: Revocation

Sender MUST revoke an unviewed share on request.

#### Scenario: Revoke unviewed share
- GIVEN a share not yet viewed or expired
- WHEN sender revokes it
- THEN later reveals get the same error as an already-viewed link

#### Scenario: Revoke after view
- GIVEN a share already viewed
- WHEN sender attempts revoke
- THEN server MUST return a no-op/error: nothing to revoke

### Requirement: View Receipt

Sender MUST see whether/when viewed; receipt MUST show only a timestamp, never identity or content.

#### Scenario: Unviewed share status
- GIVEN a share not yet revealed
- WHEN sender checks status
- THEN response MUST show "not viewed"

#### Scenario: Viewed share status
- GIVEN a share revealed at time T
- WHEN sender checks status
- THEN response MUST show `viewedAt = T`, nothing else

### Requirement: Rate Limiting

View endpoint MUST enforce per-share-ID and per-IP attempt limits.

#### Scenario: Per-share brute-force attempts
- GIVEN attempts on one share id exceed the cap
- WHEN next attempt arrives
- THEN server MUST reject with a rate-limit error

#### Scenario: Per-IP enumeration attempts
- GIVEN one IP exceeds its limit across many share ids
- WHEN next request arrives
- THEN server MUST reject with a rate-limit error

### Requirement: Item-Type Scope

Only Login-type items MUST be shareable in v1; other types MUST be rejected at creation naming the type.

#### Scenario: Login item accepted
- GIVEN sender selects a Login-type item
- WHEN they create a share
- THEN server MUST accept and process it

#### Scenario: Non-Login item rejected
- GIVEN sender selects a non-Login item (e.g. Card, Note)
- WHEN they attempt to create a share
- THEN request MUST be rejected before upload, naming the type
