-- Metering subsystem schema: authoritative historical usage rollups per
-- subscription/resource/period. Hot per-window counters live in Redis (not here)
-- and are flushed into these rollups by the usage reconciler.

CREATE TABLE IF NOT EXISTS usage_rollups (
    subscription_id TEXT NOT NULL,
    resource        TEXT NOT NULL,
    period          TEXT NOT NULL,
    total           BIGINT NOT NULL,
    PRIMARY KEY (subscription_id, resource, period)
);

CREATE INDEX IF NOT EXISTS idx_usage_rollups_subscription ON usage_rollups(subscription_id);
