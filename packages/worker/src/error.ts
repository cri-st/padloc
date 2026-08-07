import { Err, ErrorCode } from "@padloc/core/src/error";

const SENSITIVE_PATTERNS = [
    /(?:near|at)\s+"?\w*(?:sqlite|sql|syntax|constraint|unique|foreign|primary|index)/i,
    /(?:SQLITE|D1|R2)\w*/i,
    /(?:(?:un)?expected_\w+_error|internal_\w+_error)/i,
    /(?:stack\s*trace|at\s+\w+\s+\(.*\))/i,
    /(?:file|line)\s*[:=]\s*\S+\.\w+:\d+/i,
    /(?:password|secret|token|key|credential)\s*[:=]\s*\S+/i,
];

/**
 * Sanitize an unknown error into a stable `Err` that never leaks internal details.
 *
 * - Known `Err` instances pass through unchanged.
 * - Known error types (e.g. D1 exceptions with sqlite error codes) map to
 *   domain-specific `Err` values.
 * - Everything else becomes a generic `SERVER_ERROR` with the HTTP 500 status.
 */
export function sanitizeError(unknown: unknown): Err {
    if (unknown instanceof Err) {
        return unknown;
    }

    const message = extractMessage(unknown);

    if (isSqliteError(message)) {
        return classifySqliteError(message);
    }

    if (isFetchError(unknown)) {
        return new Err(ErrorCode.SERVICE_UNAVAILABLE, "Upstream service temporarily unavailable", { report: true });
    }

    if (isRateLimitError(unknown)) {
        return new Err(ErrorCode.RATE_LIMITED, "Rate limit exceeded");
    }

    return new Err(ErrorCode.SERVER_ERROR, "An internal error occurred", {
        report: true,
        error: unknown instanceof Error ? unknown : undefined,
    });
}

function extractMessage(unknown: unknown): string {
    if (unknown instanceof Error) return unknown.message;
    if (typeof unknown === "string") return unknown;
    if (
        typeof unknown === "object" &&
        unknown !== null &&
        "message" in unknown &&
        typeof (unknown as { message: unknown }).message === "string"
    ) {
        return (unknown as { message: string }).message;
    }
    return "Unknown error";
}

function isSqliteError(message: string): boolean {
    return (
        message.startsWith("SQLITE_") ||
        /D1_\w+_ERROR/i.test(message) ||
        /(?:UNIQUE|FOREIGN KEY|CHECK|NOT NULL|PRIMARY KEY) constraint failed/i.test(message) ||
        /near\s+"\w+"\s*:\s*syntax error/i.test(message) ||
        /no such table|no such column/i.test(message)
    );
}

function classifySqliteError(message: string): Err {
    if (/UNIQUE constraint failed/i.test(message)) {
        return new Err(ErrorCode.DUPLICATE_OPERATION, "A conflicting record already exists");
    }

    if (/FOREIGN KEY constraint failed/i.test(message) || /NOT NULL constraint failed/i.test(message)) {
        return new Err(ErrorCode.BAD_REQUEST, "Invalid request data");
    }

    if (/no such table|no such column/i.test(message)) {
        return new Err(ErrorCode.SERVER_ERROR, "A database error occurred", { report: true });
    }

    return new Err(ErrorCode.SERVER_ERROR, "A database error occurred", { report: true });
}

function isFetchError(unknown: unknown): boolean {
    if (unknown instanceof Error) {
        return (
            unknown.name === "TypeError" || /fetch|network|connection|econnreset|econnrefused/i.test(unknown.message)
        );
    }
    return false;
}

function isRateLimitError(unknown: unknown): boolean {
    if (unknown instanceof Error) {
        return /rate\s*limit|too\s*many\s*requests|429/i.test(unknown.message);
    }
    if (
        typeof unknown === "object" &&
        unknown !== null &&
        "status" in unknown &&
        (unknown as { status: unknown }).status === 429
    ) {
        return true;
    }
    return false;
}

