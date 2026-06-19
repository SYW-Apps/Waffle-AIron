//! Infrastructure-backed integration tests against real Postgres and Redis,
//! exercising the actual sqlx / deadpool-redis adapters.
//!
//! These auto-skip (printing a notice and passing) when `DATABASE_URL` /
//! `REDIS_URL` are not set, so the default `cargo nextest run` stays green
//! without infrastructure. Bring up the services with `docker compose up -d` and
//! export the env vars to exercise them. The schema is applied idempotently from
//! the migration files at the start of each Postgres test.

use uuid::Uuid;

use gatekeeper_saas::accounts::account_db_adapter::{AccountDbAdapter, PostgresAccountDbAdapter};
use gatekeeper_saas::accounts::model::{Account, AccountStatus, BillingAccount, Contact, Customer};
use gatekeeper_saas::domain::{BillingAccountId, ContactId, CustomerId, Email, SubscriptionId};
use gatekeeper_saas::subscriptions::subscription_db_adapter::{
    PostgresSubscriptionDbAdapter, SubscriptionDbAdapter,
};

const MIGRATIONS: [&str; 5] = [
    include_str!("../migrations/0001_accounts.sql"),
    include_str!("../migrations/0002_subscriptions.sql"),
    include_str!("../migrations/0003_metering.sql"),
    include_str!("../migrations/0004_gatekeeping.sql"),
    include_str!("../migrations/0005_notifications.sql"),
];

fn pg_url() -> Option<String> {
    std::env::var("DATABASE_URL").ok().filter(|s| !s.is_empty())
}

fn redis_url() -> Option<String> {
    std::env::var("REDIS_URL").ok().filter(|s| !s.is_empty())
}

async fn pg_pool() -> Option<sqlx::PgPool> {
    let url = pg_url()?;
    let pool = sqlx::postgres::PgPoolOptions::new()
        .max_connections(4)
        .connect(&url)
        .await
        .expect("connect to DATABASE_URL");
    for migration in MIGRATIONS {
        sqlx::raw_sql(migration)
            .execute(&pool)
            .await
            .expect("apply migration");
    }
    Some(pool)
}

fn sample_account(billing_id: &str, customer_id: &str) -> Account {
    Account {
        customer: Customer {
            id: CustomerId::new(customer_id),
            name: "Acme".into(),
            status: AccountStatus::Active,
            billing_account_id: BillingAccountId::new(billing_id),
            created_at: "2026-01-01T00:00:00Z".into(),
        },
        billing_account: BillingAccount {
            id: BillingAccountId::new(billing_id),
            customer_id: CustomerId::new(customer_id),
            billing_email: Email::parse("billing@acme.com").unwrap(),
            status: AccountStatus::Active,
        },
        contacts: vec![Contact {
            id: ContactId::new(format!("c-{customer_id}")),
            customer_id: CustomerId::new(customer_id),
            email: Email::parse("admin@acme.com").unwrap(),
            name: "Admin".into(),
            role: "Admin".into(),
        }],
    }
}

#[tokio::test]
async fn account_aggregate_round_trips_through_postgres() {
    let Some(pool) = pg_pool().await else {
        eprintln!("skipping account_aggregate_round_trips_through_postgres: DATABASE_URL unset");
        return;
    };
    let adapter = PostgresAccountDbAdapter::new(pool);
    let billing_id = format!("ba-{}", Uuid::new_v4());
    let customer_id = format!("cust-{}", Uuid::new_v4());
    let account = sample_account(&billing_id, &customer_id);

    adapter.upsert_account(&account).await.expect("upsert");
    let loaded = adapter
        .load_account(&BillingAccountId::new(&billing_id))
        .await
        .expect("load")
        .expect("present");

    assert_eq!(loaded.customer.name, "Acme");
    assert_eq!(loaded.billing_account.billing_email.as_str(), "billing@acme.com");
    assert_eq!(loaded.contacts.len(), 1);

    // Idempotent re-upsert updates rather than duplicating.
    let mut updated = account.clone();
    updated.billing_account.status = AccountStatus::Deactivated;
    adapter.upsert_account(&updated).await.expect("re-upsert");
    let reloaded = adapter
        .load_account(&BillingAccountId::new(&billing_id))
        .await
        .expect("reload")
        .expect("present");
    assert_eq!(reloaded.billing_account.status, AccountStatus::Deactivated);

    adapter
        .delete_account(&BillingAccountId::new(&billing_id))
        .await
        .expect("delete");
    assert!(adapter
        .load_account(&BillingAccountId::new(&billing_id))
        .await
        .expect("load after delete")
        .is_none());
}

#[tokio::test]
async fn processed_stripe_event_is_idempotent_in_postgres() {
    let Some(pool) = pg_pool().await else {
        eprintln!("skipping processed_stripe_event_is_idempotent_in_postgres: DATABASE_URL unset");
        return;
    };
    let adapter = PostgresSubscriptionDbAdapter::new(pool);
    let event_id = format!("evt-{}", Uuid::new_v4());
    let sub_id = SubscriptionId::new(format!("sub-{}", Uuid::new_v4()));

    let first = adapter
        .insert_processed_event(event_id.clone(), sub_id.clone())
        .await
        .expect("first insert");
    let second = adapter
        .insert_processed_event(event_id.clone(), sub_id)
        .await
        .expect("second insert");

    assert!(first, "first insert of an event id should report inserted");
    assert!(!second, "duplicate event id must be reported as not inserted (idempotent)");
}

#[tokio::test]
async fn redis_counter_seeds_increments_and_enforces_floor() {
    let Some(url) = redis_url() else {
        eprintln!("skipping redis_counter_seeds_increments_and_enforces_floor: REDIS_URL unset");
        return;
    };
    use gatekeeper_saas::metering::redis_counter_adapter::{CounterAdapter, RedisCounterAdapter};

    let pool = deadpool_redis::Config::from_url(url)
        .create_pool(Some(deadpool_redis::Runtime::Tokio1))
        .expect("redis pool");
    let adapter = RedisCounterAdapter::new(pool);

    let key = format!("itest-sub-{}:api_calls:minute", Uuid::new_v4());
    let quota = 2;

    let o1 = adapter.check_and_decrement(key.clone(), 1, quota, 60).await.expect("c1");
    let o2 = adapter.check_and_decrement(key.clone(), 1, quota, 60).await.expect("c2");
    let o3 = adapter.check_and_decrement(key.clone(), 1, quota, 60).await.expect("c3");

    assert!(o1.allowed && o1.used == 1);
    assert!(o2.allowed && o2.used == 2 && o2.remaining == 0);
    assert!(!o3.allowed, "third consume exceeds quota and must be denied");
    assert_eq!(o3.used, 2, "denied consume leaves usage at the quota ceiling");

    // First crossing of the 100% threshold flag returns true; the second returns false.
    let flag_key = key.clone();
    assert!(adapter.try_mark_threshold(flag_key.clone(), 100, 60).await.expect("flag1"));
    assert!(!adapter.try_mark_threshold(flag_key, 100, 60).await.expect("flag2"));
}
