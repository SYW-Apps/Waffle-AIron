//! Subscription Postgres Adapter (Adapter stereotype): the only block doing
//! Postgres I/O for the subscription aggregate and the processed-event log
//! (sqlx). No domain logic.

use async_trait::async_trait;
use sqlx::{PgPool, Row};

use crate::domain::{BillingAccountId, DbError, PlanId, SubscriptionId, TierId};

use super::model::{Limit, Subscription, SubscriptionStatus};

#[async_trait]
pub trait SubscriptionDbAdapter: Send + Sync {
    async fn load_subscription(
        &self,
        id: &SubscriptionId,
    ) -> Result<Option<Subscription>, DbError>;
    async fn load_by_account(
        &self,
        id: &BillingAccountId,
    ) -> Result<Option<Subscription>, DbError>;
    async fn upsert_subscription(&self, sub: &Subscription) -> Result<(), DbError>;
    async fn insert_processed_event(
        &self,
        event_id: String,
        subscription_id: SubscriptionId,
    ) -> Result<bool, DbError>;
}

pub struct PostgresSubscriptionDbAdapter {
    pool: PgPool,
}

impl PostgresSubscriptionDbAdapter {
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
    }
}

const SELECT_COLS: &str = "id, billing_account_id, plan_id, tier_id, stripe_customer_id, \
    stripe_subscription_id, status, current_period_end, overrides::text AS overrides";

fn map_subscription(row: &sqlx::postgres::PgRow) -> Result<Subscription, DbError> {
    let overrides_text: String = row.try_get("overrides")?;
    let overrides: Vec<Limit> =
        serde_json::from_str(&overrides_text).map_err(|e| DbError::Mapping(e.to_string()))?;
    Ok(Subscription {
        id: SubscriptionId::new(row.try_get::<String, _>("id")?),
        billing_account_id: BillingAccountId::new(row.try_get::<String, _>("billing_account_id")?),
        plan_id: PlanId::new(row.try_get::<String, _>("plan_id")?),
        tier_id: TierId::new(row.try_get::<String, _>("tier_id")?),
        stripe_customer_id: row.try_get("stripe_customer_id")?,
        stripe_subscription_id: row.try_get("stripe_subscription_id")?,
        status: SubscriptionStatus::parse(row.try_get::<String, _>("status")?.as_str())?,
        current_period_end: row.try_get("current_period_end")?,
        overrides,
    })
}

#[async_trait]
impl SubscriptionDbAdapter for PostgresSubscriptionDbAdapter {
    async fn load_subscription(
        &self,
        id: &SubscriptionId,
    ) -> Result<Option<Subscription>, DbError> {
        // Step 1: SELECT the subscription row by id and map into a Subscription.
        let row = sqlx::query(&format!("SELECT {SELECT_COLS} FROM subscriptions WHERE id = $1"))
            .bind(&id.0)
            .fetch_optional(&self.pool)
            .await?;
        row.as_ref().map(map_subscription).transpose()
    }

    async fn load_by_account(
        &self,
        id: &BillingAccountId,
    ) -> Result<Option<Subscription>, DbError> {
        // Step 1: SELECT the subscription row by billing_account_id and map into a Subscription.
        let row = sqlx::query(&format!(
            "SELECT {SELECT_COLS} FROM subscriptions WHERE billing_account_id = $1"
        ))
        .bind(&id.0)
        .fetch_optional(&self.pool)
        .await?;
        row.as_ref().map(map_subscription).transpose()
    }

    async fn upsert_subscription(&self, sub: &Subscription) -> Result<(), DbError> {
        // Step 1: INSERT ... ON CONFLICT (id) DO UPDATE binding the Subscription fields.
        let overrides_json =
            serde_json::to_string(&sub.overrides).map_err(|e| DbError::Mapping(e.to_string()))?;
        sqlx::query(
            "INSERT INTO subscriptions (id, billing_account_id, plan_id, tier_id, \
             stripe_customer_id, stripe_subscription_id, status, current_period_end, overrides) \
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb) \
             ON CONFLICT (id) DO UPDATE SET tier_id = EXCLUDED.tier_id, \
             stripe_customer_id = EXCLUDED.stripe_customer_id, \
             stripe_subscription_id = EXCLUDED.stripe_subscription_id, \
             status = EXCLUDED.status, current_period_end = EXCLUDED.current_period_end, \
             overrides = EXCLUDED.overrides",
        )
        .bind(&sub.id.0)
        .bind(&sub.billing_account_id.0)
        .bind(&sub.plan_id.0)
        .bind(&sub.tier_id.0)
        .bind(&sub.stripe_customer_id)
        .bind(&sub.stripe_subscription_id)
        .bind(sub.status.as_str())
        .bind(&sub.current_period_end)
        .bind(overrides_json)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    async fn insert_processed_event(
        &self,
        event_id: String,
        subscription_id: SubscriptionId,
    ) -> Result<bool, DbError> {
        // Step 1: INSERT ... ON CONFLICT (event_id) DO NOTHING; true if a row was inserted.
        let result = sqlx::query(
            "INSERT INTO processed_stripe_events (event_id, subscription_id) VALUES ($1, $2) \
             ON CONFLICT (event_id) DO NOTHING",
        )
        .bind(&event_id)
        .bind(&subscription_id.0)
        .execute(&self.pool)
        .await?;
        Ok(result.rows_affected() == 1)
    }
}
