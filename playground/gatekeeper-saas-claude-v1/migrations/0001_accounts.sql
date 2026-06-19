-- Accounts subsystem schema.
-- The Account aggregate is one consistency boundary: a Customer root with its
-- BillingAccount and Contacts. Stripe state is intentionally NOT here — it is
-- owned by the subscriptions subsystem.

CREATE TABLE IF NOT EXISTS customers (
    id                  TEXT PRIMARY KEY,
    name                TEXT NOT NULL,
    status              TEXT NOT NULL,
    billing_account_id  TEXT NOT NULL,
    created_at          TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS billing_accounts (
    id            TEXT PRIMARY KEY,
    customer_id   TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    billing_email TEXT NOT NULL,
    status        TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS contacts (
    id          TEXT PRIMARY KEY,
    customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    email       TEXT NOT NULL,
    name        TEXT NOT NULL,
    role        TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_billing_accounts_customer ON billing_accounts(customer_id);
CREATE INDEX IF NOT EXISTS idx_contacts_customer ON contacts(customer_id);
