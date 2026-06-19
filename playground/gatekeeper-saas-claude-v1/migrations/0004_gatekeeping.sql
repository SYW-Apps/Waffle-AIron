-- Gatekeeping subsystem schema: API-key credentials (hashed) and the append-only
-- decision audit log. The billing account is sourced from entitlements at
-- authorize time, so it is not stored on the credential.

CREATE TABLE IF NOT EXISTS api_key_credentials (
    id              TEXT PRIMARY KEY,
    subscription_id TEXT NOT NULL,
    key_hash        TEXT NOT NULL UNIQUE,
    status          TEXT NOT NULL,
    created_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_api_key_credentials_hash ON api_key_credentials(key_hash);

CREATE TABLE IF NOT EXISTS decision_audit_log (
    id                 BIGSERIAL PRIMARY KEY,
    subscription_id    TEXT NOT NULL,
    billing_account_id TEXT NOT NULL,
    resource           TEXT NOT NULL,
    allowed            BOOLEAN NOT NULL,
    reason             TEXT NOT NULL,
    timestamp          TEXT NOT NULL
);
