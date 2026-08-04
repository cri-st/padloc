export interface Env {
    DB?: D1Database;
    ATTACHMENTS?: R2Bucket;
    HINTS?: KVNamespace;
    ACCOUNT_LOCK?: DurableObjectNamespace;
    ALLOW_ORIGIN?: string;
    CLIENT_URL?: string;
    APP_NAME?: string;
    VERSION?: string;
    RESEND_API_KEY?: string;
    EMAIL_BACKEND?: string;
    EMAIL_KV?: KVNamespace;
    EMAIL_FROM_ADDRESS?: string;
    EMAIL_VERIFY_ON_SIGNUP?: string;
    SIGNUP_RESTRICT?: string;
    SIGNUP_ALLOW_DOMAINS?: string;
    SIGNUP_ALLOWED_DOMAINS?: string;
    RATE_LIMIT_MAX_REQUESTS?: string;
    RATE_LIMIT_WINDOW_MS?: string;
    HQ_SENTRY_DSN?: string;
    HQ_OTLP_ENDPOINT?: string;
    HQ_ENVIRONMENT?: string;
    HQ_RELEASE?: string;
    HQ_SERVICE_NAME?: string;
    HQ_ALLOW_LOCAL_ENDPOINTS?: string;
}
