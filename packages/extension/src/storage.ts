import { Storage, Storable, StorableConstructor, StorageListOptions, StorageQuery } from "@padloc/core/src/storage";
import { Err, ErrorCode } from "@padloc/core/src/error";
import { bytesToBase64, base64ToBytes } from "@padloc/core/src/encoding";
import { AppState } from "@padloc/core/src/app";
import { browser } from "webextension-polyfill-ts";

type StorageArea = {
    get(keys?: string | string[] | Record<string, unknown> | null): Promise<Record<string, unknown>>;
    set(items: Record<string, unknown>): Promise<void>;
    remove(keys: string | string[]): Promise<void>;
};

type SessionStorageArea = StorageArea & {
    setAccessLevel?: (options: { accessLevel: "TRUSTED_CONTEXTS" | "TRUSTED_AND_UNTRUSTED_CONTEXTS" }) => Promise<void>;
};

interface SessionMasterKeyRecord {
    accountId: string;
    sessionId: string;
    masterKey: string;
}

interface SessionSigningKeyRecord {
    accountId: string;
    sessionId: string;
    sessionKey: string;
}

const sessionMasterKeyStorageKey = "session_master_key";
const sessionSigningKeyStorageKey = "session_signing_key";

function getSessionStorageArea(): SessionStorageArea {
    const storage = browser.storage as typeof browser.storage & { session?: SessionStorageArea };
    if (storage.session) {
        return storage.session;
    }

    return (chrome as typeof chrome & { storage?: { session?: SessionStorageArea } }).storage
        ?.session as SessionStorageArea;
}

export async function configureSessionStorage() {
    await getSessionStorageArea().setAccessLevel?.({ accessLevel: "TRUSTED_CONTEXTS" });
}

export async function saveSessionMasterKey(opts: { accountId: string; sessionId: string; masterKey: Uint8Array }) {
    const data: SessionMasterKeyRecord = {
        accountId: opts.accountId,
        sessionId: opts.sessionId,
        masterKey: bytesToBase64(opts.masterKey),
    };

    await getSessionStorageArea().set({ [sessionMasterKeyStorageKey]: data });
}

export async function getSessionMasterKey(opts: { accountId?: string; sessionId?: string } = {}) {
    const data = await getSessionStorageArea().get(sessionMasterKeyStorageKey);
    const stored = data[sessionMasterKeyStorageKey] as SessionMasterKeyRecord | undefined;

    if (!stored) {
        return null;
    }

    if (
        (opts.accountId && stored.accountId !== opts.accountId) ||
        (opts.sessionId && stored.sessionId !== opts.sessionId)
    ) {
        return null;
    }

    return base64ToBytes(stored.masterKey);
}

export async function clearSessionMasterKey() {
    await getSessionStorageArea().remove(sessionMasterKeyStorageKey);
}

/**
 * `Session.key` (the HMAC key used to sign/verify API requests) must never be
 * written to `browser.storage.local` - that's backed by an unencrypted-on-disk
 * LevelDB, forensically recoverable long after the tab/browser closes. Store it
 * the same way `saveSessionMasterKey` already stores the vault master key: in
 * `browser.storage.session` (memory-only, `TRUSTED_CONTEXTS`-scoped), separate
 * from the generic `ExtensionStorage.save()` path used for the rest of `AppState`.
 */
export async function saveSessionSigningKey(opts: { accountId: string; sessionId: string; sessionKey: Uint8Array }) {
    const data: SessionSigningKeyRecord = {
        accountId: opts.accountId,
        sessionId: opts.sessionId,
        sessionKey: bytesToBase64(opts.sessionKey),
    };

    await getSessionStorageArea().set({ [sessionSigningKeyStorageKey]: data });
}

export async function getSessionSigningKey(opts: { accountId?: string; sessionId?: string } = {}) {
    const data = await getSessionStorageArea().get(sessionSigningKeyStorageKey);
    const stored = data[sessionSigningKeyStorageKey] as SessionSigningKeyRecord | undefined;

    if (!stored) {
        return null;
    }

    if (
        (opts.accountId && stored.accountId !== opts.accountId) ||
        (opts.sessionId && stored.sessionId !== opts.sessionId)
    ) {
        return null;
    }

    return base64ToBytes(stored.sessionKey);
}

export async function clearSessionSigningKey() {
    await getSessionStorageArea().remove(sessionSigningKeyStorageKey);
}

export class ExtensionStorage implements Storage {
    async save(s: Storable) {
        if (s instanceof AppState) {
            await this._saveAppState(s);
            return;
        }
        const data = { [`${s.kind}_${s.id}`]: s.toRaw() };
        await browser.storage.local.set(data);
    }

    async get<T extends Storable>(cls: T | StorableConstructor<T>, id: string) {
        const s = cls instanceof Storable ? cls : new cls();
        const key = `${s.kind}_${id}`;
        const data = await browser.storage.local.get(key);
        if (!data[key]) {
            throw new Err(ErrorCode.NOT_FOUND);
        }
        const result = s.fromRaw(data[key]);
        if (result instanceof AppState) {
            await this._restoreSessionSigningKey(result);
        }
        return result;
    }

    async delete(s: Storable) {
        if (s instanceof AppState) {
            await clearSessionSigningKey();
        }
        await browser.storage.local.remove(`${s.kind}_${s.id}`);
    }

    async clear() {
        await clearSessionSigningKey();
        await browser.storage.local.clear();
    }

    async list<T extends Storable>(_cls: StorableConstructor<T>, _: StorageListOptions): Promise<T[]> {
        throw new Err(ErrorCode.NOT_SUPPORTED);
    }

    async count<T extends Storable>(_cls: StorableConstructor<T>, _: StorageQuery): Promise<number> {
        throw new Err(ErrorCode.NOT_SUPPORTED);
    }

    /**
     * Persists `state` to `browser.storage.local` with `session.key` stripped out,
     * and mirrors that key into the in-memory session-signing-key store instead.
     */
    private async _saveAppState(state: AppState) {
        const session = state.session;
        if (session?.key && state.account?.id && session.id) {
            await saveSessionSigningKey({ accountId: state.account.id, sessionId: session.id, sessionKey: session.key });
        } else {
            await clearSessionSigningKey();
        }

        const raw = state.toRaw();
        if (raw.session && typeof raw.session === "object") {
            delete raw.session.key;
        }
        await browser.storage.local.set({ [`${state.kind}_${state.id}`]: raw });
    }

    /** Re-hydrates `state.session.key` from the in-memory store after a disk load. */
    private async _restoreSessionSigningKey(state: AppState) {
        if (!state.session || state.session.key || !state.account?.id) {
            return;
        }
        const sessionKey = await getSessionSigningKey({ accountId: state.account.id, sessionId: state.session.id });
        if (sessionKey) {
            state.session.key = sessionKey;
        }
    }
}
