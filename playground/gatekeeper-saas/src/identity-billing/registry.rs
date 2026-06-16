use std::sync::Arc;
use sqlx::{Executor, Postgres};
use uuid::Uuid;
use crate::identity_billing::store::IBillingStore;
use crate::models::{Customer, ApiKey, Subscription, SubscriptionTier};

#[async_trait::async_trait]
pub trait IBillingRegistry: Send + Sync {
    async fn insert_customer(&self, customer: &Customer) -> Result<(), sqlx::Error>;
    async fn update_customer(&self, customer: &Customer) -> Result<(), sqlx::Error>;
    async fn insert_api_key(&self, key: &ApiKey) -> Result<(), sqlx::Error>;
    async fn update_api_key_status(&self, key_id: &Uuid, status: &str) -> Result<(), sqlx::Error>;
    async fn insert_subscription(&self, sub: &Subscription) -> Result<(), sqlx::Error>;
    async fn update_subscription(&self, sub: &Subscription) -> Result<(), sqlx::Error>;
    async fn insert_tier(&self, tier: &SubscriptionTier) -> Result<(), sqlx::Error>;
}

pub struct BillingRegistry {
    store: Arc<dyn IBillingStore>,
}

impl BillingRegistry {
    pub fn new(store: Arc<dyn IBillingStore>) -> Self {
        Self { store }
    }
}

#[async_trait::async_trait]
impl IBillingRegistry for BillingRegistry {
    async fn insert_customer(&self, customer: &Customer) -> Result<(), sqlx::Error> {
        // Step 1: Acquire DB client connection.
        let mut conn = self.store.get_connection().await?;

        // Step 2: Execute INSERT query to persist customer record.
        sqlx::query(
            "INSERT INTO customers (id, email, stripe_customer_id, created_at, updated_at) VALUES ($1, $2, $3, $4, $5)"
        )
        .bind(customer.id)
        .bind(&customer.email)
        .bind(&customer.stripe_customer_id)
        .bind(customer.created_at)
        .bind(customer.updated_at)
        .execute(&mut *conn)
        .await?;

        Ok(())
    }

    async fn update_customer(&self, customer: &Customer) -> Result<(), sqlx::Error> {
        // Step 1: Acquire DB client connection.
        let mut conn = self.store.get_connection().await?;

        // Step 2: Execute UPDATE query to refresh customer details.
        sqlx::query(
            "UPDATE customers SET email = $2, stripe_customer_id = $3, updated_at = $4 WHERE id = $1"
        )
        .bind(customer.id)
        .bind(&customer.email)
        .bind(&customer.stripe_customer_id)
        .bind(customer.updated_at)
        .execute(&mut *conn)
        .await?;

        Ok(())
    }

    async fn insert_api_key(&self, key: &ApiKey) -> Result<(), sqlx::Error> {
        // Step 1: Acquire DB client connection.
        let mut conn = self.store.get_connection().await?;

        // Step 2: Execute INSERT query to save API key.
        sqlx::query(
            "INSERT INTO api_keys (id, customer_id, key_hash, prefix, status, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7)"
        )
        .bind(key.id)
        .bind(key.customer_id)
        .bind(&key.key_hash)
        .bind(&key.prefix)
        .bind(&key.status)
        .bind(key.created_at)
        .bind(key.updated_at)
        .execute(&mut *conn)
        .await?;

        Ok(())
    }

    async fn update_api_key_status(&self, key_id: &Uuid, status: &str) -> Result<(), sqlx::Error> {
        // Step 1: Acquire DB client connection.
        let mut conn = self.store.get_connection().await?;

        // Step 2: Execute UPDATE query to set API key status (active/revoked).
        sqlx::query(
            "UPDATE api_keys SET status = $2, updated_at = NOW() WHERE id = $1"
        )
        .bind(key_id)
        .bind(status)
        .execute(&mut *conn)
        .await?;

        Ok(())
    }

    async fn insert_subscription(&self, sub: &Subscription) -> Result<(), sqlx::Error> {
        // Step 1: Acquire DB client connection.
        let mut conn = self.store.get_connection().await?;

        // Step 2: Execute INSERT query to save subscription record.
        sqlx::query(
            "INSERT INTO subscriptions (id, customer_id, stripe_subscription_id, tier_id, status, current_period_start, current_period_end, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)"
        )
        .bind(sub.id)
        .bind(sub.customer_id)
        .bind(&sub.stripe_subscription_id)
        .bind(&sub.tier_id)
        .bind(&sub.status)
        .bind(sub.current_period_start)
        .bind(sub.current_period_end)
        .bind(sub.created_at)
        .bind(sub.updated_at)
        .execute(&mut *conn)
        .await?;

        Ok(())
    }

    async fn update_subscription(&self, sub: &Subscription) -> Result<(), sqlx::Error> {
        // Step 1: Acquire DB client connection.
        let mut conn = self.store.get_connection().await?;

        // Step 2: Execute UPDATE query to modify active subscription tier or period.
        sqlx::query(
            "UPDATE subscriptions SET stripe_subscription_id = $2, tier_id = $3, status = $4, current_period_start = $5, current_period_end = $6, updated_at = $7 WHERE id = $1"
        )
        .bind(sub.id)
        .bind(&sub.stripe_subscription_id)
        .bind(&sub.tier_id)
        .bind(&sub.status)
        .bind(sub.current_period_start)
        .bind(sub.current_period_end)
        .bind(sub.updated_at)
        .execute(&mut *conn)
        .await?;

        Ok(())
    }

    async fn insert_tier(&self, tier: &SubscriptionTier) -> Result<(), sqlx::Error> {
        // Step 1: Acquire DB client connection.
        let mut conn = self.store.get_connection().await?;

        // Step 2: Execute INSERT query to save tier metadata.
        sqlx::query(
            "INSERT INTO subscription_tiers (id, name, request_limit, rate_limit_per_minute, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6)"
        )
        .bind(&tier.id)
        .bind(&tier.name)
        .bind(tier.request_limit)
        .bind(tier.rate_limit_per_minute)
        .bind(tier.created_at)
        .bind(tier.updated_at)
        .execute(&mut *conn)
        .await?;

        Ok(())
    }
}
