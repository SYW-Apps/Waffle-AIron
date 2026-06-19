-- Subscriptions subsystem schema: plans, tiers, per-tier limits, subscriptions,
-- and the processed-event idempotency log for Stripe webhooks. All Stripe state
-- lives here (the accounts subsystem is free of Stripe concerns).

CREATE TABLE IF NOT EXISTS plans (
    id     TEXT PRIMARY KEY,
    name   TEXT NOT NULL,
    active BOOLEAN NOT NULL
);

CREATE TABLE IF NOT EXISTS tiers (
    id              TEXT PRIMARY KEY,
    plan_id         TEXT NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
    name            TEXT NOT NULL,
    stripe_price_id TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tier_limits (
    tier_id  TEXT NOT NULL REFERENCES tiers(id) ON DELETE CASCADE,
    resource TEXT NOT NULL,
    quota    BIGINT NOT NULL,
    window   TEXT NOT NULL,
    PRIMARY KEY (tier_id, resource)
);

CREATE TABLE IF NOT EXISTS subscriptions (
    id                     TEXT PRIMARY KEY,
    billing_account_id     TEXT NOT NULL,
    plan_id                TEXT NOT NULL,
    tier_id                TEXT NOT NULL,
    stripe_customer_id     TEXT,
    stripe_subscription_id TEXT,
    status                 TEXT NOT NULL,
    current_period_end     TEXT NOT NULL,
    overrides              JSONB NOT NULL DEFAULT '[]'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_subscriptions_account ON subscriptions(billing_account_id);

CREATE TABLE IF NOT EXISTS processed_stripe_events (
    event_id        TEXT PRIMARY KEY,
    subscription_id TEXT NOT NULL,
    processed_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
