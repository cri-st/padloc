import { Auth, Authenticator, AuthenticatorStatus, AuthRequest, AuthServer, AuthType } from "../auth";
import { Messenger, EmailAuthMessage } from "../messenger";
import { ErrorCode, Err } from "../error";
import { randomNumber } from "../util";
import { getCryptoProvider } from "../platform";
import { stringToBytes } from "../encoding";

export class EmailAuthServer implements AuthServer {
    constructor(public messenger: Messenger) {}

    supportsType(type: AuthType) {
        return type === AuthType.Email;
    }

    async initAuthenticator(authenticator: Authenticator, auth: Auth, { email = auth.email }: { email?: string } = {}) {
        authenticator.state = { email };
        if (authenticator.status !== AuthenticatorStatus.Active) {
            authenticator.state.activationCode = await this._generateCode();
            const requestId = authenticator.id.split("-")[0];
            const sentAt = new Date().toISOString();
            try {
                await this.messenger.send(
                    email,
                    new EmailAuthMessage({ code: authenticator.state.activationCode, requestId })
                );
                return { email, requestId, sentAt };
            } catch (e) {
                throw new Err(ErrorCode.AUTHENTICATION_FAILED, `Failed to send email to ${email}`, {
                    report: true,
                    error: e instanceof Error ? e : undefined,
                });
            }
        } else {
            return { email };
        }
    }

    async activateAuthenticator(authenticator: Authenticator, { code: activationCode }: { code: string }) {
        // SECURITY: timing-safe, matching the pattern already used for
        // TOTP/HOTP (otp.ts's validateHotp) and SRP's M1 -- a plain `!==`
        // over a 6-digit (10^6) space is a real, if narrow, response-time
        // side channel that the rest of the codebase deliberately avoids
        // for equivalent secrets.
        const verified =
            !!authenticator.state.activationCode &&
            !!activationCode &&
            (await getCryptoProvider().timingSafeEqual(
                stringToBytes(authenticator.state.activationCode),
                stringToBytes(activationCode)
            ));
        if (!verified) {
            throw new Err(
                ErrorCode.AUTHENTICATION_FAILED,
                "Failed to activate authenticator. Incorrect activation code!"
            );
        }
        authenticator.description = authenticator.state.email;
    }

    async initAuthRequest(authenticator: Authenticator, request: AuthRequest) {
        let verificationCode = await this._generateCode();
        const email = authenticator.state.email;
        request.state = {
            email,
            verificationCode,
        };
        const requestId = request.id.split("-")[0];
        const sentAt = new Date().toISOString();
        const message = new EmailAuthMessage({ code: verificationCode, requestId });
        try {
            await this.messenger.send(authenticator.state.email, message);
            return { email, subject: message.title, sentAt };
        } catch (e) {
            throw new Err(ErrorCode.AUTHENTICATION_FAILED, `Failed to send email to ${email}`, {
                report: true,
                error: e instanceof Error ? e : undefined,
            });
        }
    }

    async verifyAuthRequest(
        _method: Authenticator,
        request: AuthRequest,
        { code: verificationCode }: { code: string }
    ) {
        const verified =
            !!request.state.verificationCode &&
            !!verificationCode &&
            (await getCryptoProvider().timingSafeEqual(
                stringToBytes(request.state.verificationCode),
                stringToBytes(verificationCode)
            ));
        if (!verified) {
            throw new Err(ErrorCode.AUTHENTICATION_FAILED, "Incorrect verification code.");
        }
    }

    private async _generateCode(len = 6) {
        return (await randomNumber(0, Math.pow(10, len) - 1)).toString().padStart(len, "0");
    }
}
