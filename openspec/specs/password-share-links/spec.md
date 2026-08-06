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

#### Scenario: Non-finite or non-positive TTL is rejected
- GIVEN a client calls `createShare` directly (bypassing the UI's fixed TTL presets) with a non-numeric, zero, or negative `ttlSeconds`
- WHEN the server validates the request
- THEN `createShare` MUST reject with a validation error, never silently accept it as an effectively-permanent share

### Requirement: Anonymity Boundary

`peekShare` and `revealShare` MUST remain fully identity-free in both directions: the client MUST NEVER attach session authentication to these calls, and the server MUST NEVER process or persist authentication data for these methods even if a client attaches it anyway (e.g. a sender who is still logged in when opening their own share link in the same browser). Additionally, these two methods' request/response pairs MUST NEVER be idempotency-cached or replayed -- a cached successful `revealShare` result served to a second, different caller would let more than one party see an already-consumed one-time secret, defeating the single-view guarantee.

#### Scenario: Logged-in sender's session is never attached to an anonymous view
- GIVEN a sender is logged into their own account in the same browser
- WHEN they open their own (or anyone else's) `/share/:id` link
- THEN no session/account data is sent with the `peekShare`/`revealShare` call, and no session activity (`lastUsed`/`lastLocation`) is recorded as a result

#### Scenario: A forged or stale auth block attached to an anonymous call is ignored, not processed
- GIVEN a `peekShare` or `revealShare` request somehow carries an auth block (forged, or a leftover stale session)
- WHEN the server receives it
- THEN the server MUST ignore it outright (no signature verification, no session lookup, no persistence) and process the share view normally

#### Scenario: A repeated identical anonymous request is never served from a cache
- GIVEN a `revealShare` request already succeeded once for a given share id
- WHEN a byte-identical request for the same share id arrives again (from the same or a different caller)
- THEN the server MUST re-evaluate the share's real current state (not replay a cached response) and correctly report it as already-viewed

#### Scenario: Unauthenticated creation attempt
- GIVEN no valid session
- WHEN `createShare` is called
- THEN server MUST reject with an authentication error

### Requirement: Field Selection Scope

The share dialog MUST let the sender choose which of the item's fields are included in the share, rather than always sharing the whole item. A `Totp` field MUST NEVER be offered as selectable -- it is excluded from the field list entirely, not merely unchecked. Default selection MUST be by field TYPE, not merely by count: only the FIRST field of each default-shareable type (Username, Password, Url, Email) is pre-checked. Any additional field sharing one of those types (e.g. a second Url field repurposed for something else, or a duplicate/renamed Password field) MUST start unchecked -- it remains fully selectable, just not assumed safe by default. All other selectable field types (e.g. Note, Pin, Text) MUST also start unchecked. The shared payload MUST NEVER include the item's `passkeys`, `history`, `attachments`, or `tags`, regardless of field selection.

#### Scenario: TOTP field is never offered
- GIVEN a Login item has a Totp field
- WHEN the sender opens the share dialog
- THEN the Totp field MUST NOT appear in the field selector

#### Scenario: Safe fields are pre-selected, others are opt-in
- GIVEN a Login item has Username, Password, Url, and Note fields
- WHEN the sender opens the share dialog
- THEN Username, Password, and Url MUST be pre-checked; Note MUST be unchecked

#### Scenario: Only the first field of a duplicated safe type is pre-selected
- GIVEN a Login item has one Username field, one canonical Password field, and two MORE fields also typed Password (e.g. "Seguridad_Password", "Seguridad_Password with spaces")
- WHEN the sender opens the share dialog
- THEN only Username and the FIRST Password field are pre-checked; the extra Password-typed fields start unchecked

#### Scenario: Sender narrows or widens the shared fields
- GIVEN the default selection is shown
- WHEN the sender unchecks Url and checks Note
- THEN the created share MUST contain exactly Username, Password, and Note -- nothing else

#### Scenario: Structural item data is never shareable
- GIVEN any Login item, regardless of field selection
- WHEN a share is created
- THEN the encrypted payload MUST NOT contain the item's passkeys, edit history, attachments, or tags

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

Only Login-type items MUST be shareable in v1. The client MUST hide the "Share Link" action for non-Login items. This is enforced client-side only — the server never sees plaintext, so it cannot classify an item's type and never receives a create request for a non-Login item in the first place.

#### Scenario: Login item accepted
- GIVEN sender selects a Login-type item
- WHEN they create a share
- THEN server MUST accept and process it

#### Scenario: Non-Login item is not offered
- GIVEN sender is viewing a non-Login item (e.g. Card, Note)
- WHEN the item view renders its actions
- THEN the "Share Link" action MUST be hidden; no share request is ever sent to the server for that item
