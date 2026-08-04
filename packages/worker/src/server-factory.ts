import { Server } from "@padloc/core/src/server";
import { ServerConfig } from "@padloc/core/src/server";
import { Storage } from "@padloc/core/src/storage";
import { Logger, VoidLogger } from "@padloc/core/src/logging";
import { AuthServer } from "@padloc/core/src/auth";
import { EmailAuthServer } from "@padloc/core/src/auth/email";
import { TotpAuthConfig, TotpAuthServer } from "@padloc/core/src/auth/totp";
import { WebAuthnServer, WebAuthnConfig } from "./auth/webauthn";
import { AttachmentStorage } from "@padloc/core/src/attachment";
import { Messenger } from "@padloc/core/src/messenger";
import { Err, ErrorCode } from "@padloc/core/src/error";
import { ChangeLogger } from "@padloc/core/src/logging";
import { RequestLogger } from "@padloc/core/src/logging";
import { ChangeLoggerConfig } from "@padloc/core/src/logging";
import { RequestLoggerConfig } from "@padloc/core/src/logging";
import { setPlatform } from "@padloc/core/src/platform";
import { setAppNameOverride } from "@padloc/core/src/branding";
import { D1Storage } from "./storage/d1";
import { PersonalProvisioner } from "./provisioner/personal";
import { R2AttachmentStorage } from "./attachments/r2";
import { ResendMessenger, MockMessenger } from "./email/resend";
import { WorkerPlatform } from "./platform";
import { Env } from "./env";

export function createServer(env: Env): Server {
    setPlatform(new WorkerPlatform());
    setAppNameOverride(env.APP_NAME);

    const storage: Storage = env.DB ? new D1Storage(env.DB) : createStubStorage();
    const logger: Logger = new VoidLogger();
    const messenger: Messenger = createMessenger(env);
    const attachmentStorage: AttachmentStorage = createAttachmentStorage(env);
    const changeLoggerConfig = new ChangeLoggerConfig();
    changeLoggerConfig.enabled = true;
    const requestLoggerConfig = new RequestLoggerConfig();
    requestLoggerConfig.enabled = true;
    const changeLogger = new ChangeLogger(storage, changeLoggerConfig);
    const requestLogger = new RequestLogger(storage, requestLoggerConfig);

    const config = new ServerConfig();
    config.verifyEmailOnSignup = env.EMAIL_VERIFY_ON_SIGNUP !== "false";
    if (env.CLIENT_URL) {
        config.clientUrl = env.CLIENT_URL;
    } else if (env.ALLOW_ORIGIN && env.ALLOW_ORIGIN !== "*") {
        config.clientUrl = env.ALLOW_ORIGIN;
    }

    const authServers: AuthServer[] = [new EmailAuthServer(messenger), new TotpAuthServer(new TotpAuthConfig())];
    if (config.clientUrl) {
        try {
            const clientHostName = new URL(config.clientUrl).hostname;
            authServers.push(
                new WebAuthnServer(
                    new WebAuthnConfig({
                        rpID: clientHostName,
                        rpName: clientHostName,
                        origin: config.clientUrl.replace(/\/+$/, ""),
                    })
                )
            );
        } catch {
            // Malformed clientUrl -- skip registering WebAuthn rather than crash startup.
        }
    }


    return new Server(
        config,
        storage,
        messenger,
        logger,
        authServers,
        attachmentStorage,
        new PersonalProvisioner(storage),
        changeLogger,
        requestLogger
    );
}

/** Shared mock messenger — persists across requests for testability. */
let sharedMockMessenger: MockMessenger | null = null;

export function getSharedMockMessenger(): MockMessenger | null {
    return sharedMockMessenger;
}

function createMessenger(env: Env): Messenger {
    // Always use shared MockMessenger for testability, regardless of
    // whether mock mode is explicit or inferred from missing credentials.
    if (!sharedMockMessenger) {
        sharedMockMessenger = new MockMessenger();
    }
    console.log("[createMessenger] email runtime", {
        emailBackend: env.EMAIL_BACKEND || null,
        hasResendApiKey: !!env.RESEND_API_KEY,
        hasEmailFromAddress: !!env.EMAIL_FROM_ADDRESS,
    });
    if (env.EMAIL_BACKEND === "mock") {
        return sharedMockMessenger;
    }
    if (env.RESEND_API_KEY && env.EMAIL_FROM_ADDRESS) {
        console.log("[createMessenger] using ResendMessenger");
        return new ResendMessenger(env.RESEND_API_KEY, env.EMAIL_FROM_ADDRESS, env.APP_NAME, env.CLIENT_URL);
    }
    throw new Err(
        ErrorCode.SERVER_ERROR,
        "Email backend misconfigured: RESEND_API_KEY/EMAIL_FROM_ADDRESS missing and EMAIL_BACKEND is not 'mock'",
        { report: true }
    );
}

function createAttachmentStorage(env: Env): AttachmentStorage {
    if (env.ATTACHMENTS && env.DB) {
        return new R2AttachmentStorage({ bucket: env.ATTACHMENTS, db: env.DB });
    }
    return createStubAttachmentStorage();
}

function createStubStorage(): Storage {
    return {
        get: async () => {
            throw new Error("stub storage: get not implemented");
        },
        save: async () => {},
        delete: async () => {},
        clear: async () => {},
        list: async () => [],
    } as unknown as Storage;
}

function createStubAttachmentStorage(): AttachmentStorage {
    return {
        upload: async () => {
            throw new Error("stub attachment storage: upload not implemented");
        },
        delete: async () => {},
        getUrl: async () => "",
        getSignedUrl: async () => "",
    } as unknown as AttachmentStorage;
}
