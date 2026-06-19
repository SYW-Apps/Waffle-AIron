-- Notifications subsystem schema: append-only log of sent usage/billing alerts.

CREATE TABLE IF NOT EXISTS notification_log (
    id                 BIGSERIAL PRIMARY KEY,
    billing_account_id TEXT NOT NULL,
    to_email           TEXT NOT NULL,
    subject            TEXT NOT NULL,
    sent_at            TEXT NOT NULL,
    status             TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_notification_log_account ON notification_log(billing_account_id);
