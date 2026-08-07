# Design: Sec-Expert Round 2 — Dependency, Crash-Resilience, and Session-Lifecycle Hardening

## Technical Approach

Three surgical code changes plus prioritized dependency bumps, no new abstractions. Each fix extends an existing in-file pattern: whole-callback try/catch mirrors the already-guarded `POST` branch in `http.ts`; `unhandledRejection` mirrors the existing `uncaughtException` handler in `init.ts`; session revocation mirrors the exception-filtered delete loop already used by `revokeSession`/`recoverAccount` in `server.ts`. Implements `security-baseline`'s two ADDED requirements (Dependency Vulnerability Disclosure, Session Lifecycle Integrity).

## Architecture Decisions

### Decision: unhandledRejection handler posture

**Choice**: In `packages/server/src/init.ts`, add `process.on("unhandledRejection", ...)` inside `init()`, next to the existing `uncaughtException` handler (lines 368–384) — log + best-effort admin email via `emailSender`/`config.server.reportErrors`, **no `process.exit()`**.

**Alternatives considered**: Mirror `uncaughtException` (`process.exit(1)`) — rejected, turns any missed `.catch()` on a per-request path into a remote single-request DoS. Leave unhandled (Node default) — rejected, uncontrolled crash with zero admin visibility, strictly worse.

**Rationale**: `HTTPReceiver.listen`'s callback already fully try/catches (with this change, the whole body), so a stray rejection means a missed `.catch()` somewhere, not corrupted process state — the failing request already errored to its caller. Crashing the process for one bad request is a self-inflicted DoS. **This MUST ship as an inline code comment above the handler**, not only in this doc, so a future maintainer doesn't "fix" it back into an `uncaughtException` mirror.

### Decision: session-revocation-on-password-change scope

**Choice**: In `packages/core/src/server.ts`'s `updateAuth()`, when `verifier` is set, revoke every `auth.sessions` entry **except** the one that made this call. Mechanism: `_requireAuth()` already returns `session` (currently undestructured) — change to `const { auth, session } = this._requireAuth();`; inside `if (verifier)`, delete-from-storage every other session and filter `auth.sessions` down to the current one, before the trailing `storage.save(auth)`.

**Alternatives considered**: Revoke all sessions including current — rejected, logs the user out of the action they just took; OWASP only requires *other* sessions die. Do nothing — rejected, is the gap being closed.

**Rationale**: `revokeSession` (L923) already deletes one `Session` record and splices `auth.sessions`; `recoverAccount` (L1244) revokes *all* sessions unconditionally, correct there because recovery implies full session-store distrust. Password change is narrower — the requesting session proved possession of the new credential in this exact request, so it's provably not the session being defended against.

### Decision: dependency remediation priority

**Choice**: Fix `@simplewebauthn/server` 5.4.3→13.x first (CRITICAL, crypto-verification path via transitive `elliptic`/`jsrsasign`); re-verify `webauthn.ts` thoroughly. Treat `drizzle-orm` (worker) and `http-server`'s chain (app) as documented accepted-risk per proposal Out-of-Scope.

**Blast radius (confirmed by reading `webauthn.ts` against the v13 changelog)**: `generateRegistrationOptions`/`generateAuthenticationOptions` (L79, L148) and `verifyAuthenticationResponse` (L172) become `async` and need `await`, currently unawaited. `credentialID`/`credentialPublicKey` are renamed `id`/`publicKey` in the verification result and the `verifyAuthenticationResponse` credential arg (L129, L177). `@simplewebauthn/typescript-types` is retired; its types now ship from `@simplewebauthn/server` (drop the L9 import, merge into the existing one). **No stored-data migration needed**: Padloc's own persisted shape, `WebAuthnRegistrationInfo` (local interface, base64 `credentialID`/`credentialPublicKey` fields), is independent of the library's internal naming — only the call-site read/construct mapping changes, so existing enrolled authenticators keep working unmodified.

## Data Flow

    HTTP request ──▶ HTTPReceiver.listen callback (whole-body try/catch)
                          │ (uncaught async rejection escapes callback)
                          ▼
                  process "unhandledRejection" (log + email, no exit)

    updateAuth({verifier}) ──▶ auth.sessions minus current session ──▶ storage.delete × N ──▶ storage.save(auth)

## File Changes

| File | Action | Description |
|------|--------|-------------|
| `packages/server/src/transport/http.ts` | Modify | Wrap whole `createServer` callback in try/catch (only `POST` guarded today) |
| `packages/server/src/init.ts` | Modify | Add `unhandledRejection` handler in `init()`, no exit, inline rationale comment |
| `packages/core/src/server.ts` | Modify | `updateAuth()`: destructure `session`, revoke other `auth.sessions` on verifier change |
| `packages/server/package.json` + lockfile | Modify | `@simplewebauthn/server`→13.x, `nodemailer`→6.10.x, `@aws-sdk/*` non-major |
| `packages/server/src/auth/webauthn.ts` | Modify | Await-ify the 3 call sites above; rename renamed fields; drop retired type import |
| `packages/admin/package.json` | Modify | `diff`→5.2.x |

## Testing Strategy

| Layer | What to Test | Approach |
|-------|-------------|----------|
| Compile | Server package types | `packages/server`'s pinned `tsc --noEmit --skipLibCheck` |
| Integration | WebAuthn register + authenticate round-trip on new major | Existing `packages/server/test` webauthn coverage must pass in *behavior*, not just compile |
| Live/local | Session revocation | 2 sessions on one account; `updateAuth` with new verifier on session A; B's next request → `INVALID_SESSION`; A still works |
| Live/local | `unhandledRejection` | Trigger one in a disposable local `node` process reproducing the handler; confirm process survives + one log line |

## Threat Matrix

N/A — no routing, shell, subprocess, VCS/PR automation, executable-file classification, or process-integration boundary.

## Migration / Rollout

No data migration. The `@simplewebauthn/server` major bump changes only in-memory call shapes, not Padloc's persisted `WebAuthnRegistrationInfo` schema — existing enrolled credentials keep working without re-registration. Same topic-branch, no-PR rollout as Round 1.

## Open Questions

None — both prior forks (unhandledRejection posture, session-revocation scope) are resolved above.

