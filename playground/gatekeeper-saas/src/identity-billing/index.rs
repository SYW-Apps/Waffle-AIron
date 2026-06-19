use std::sync::Arc;
use sqlx::Postgres;
use uuid::Uuid;
use crate::identity_billing::store::IBillingStore;
use crate::models::{Customer, Subscription, SubscriptionTier};

#[async_trait::async_trait]
pub trait IBillingIndex: Send + Sync {
    async fn lookup_customer_by_key_hash(&self, key_hash: &str) -> Result<Option<Customer>, sqlx::Error>;
    async fn lookup_customer_by_id(&self, id: &Uuid) -> Result<Option<Customer>, sqlx::Error>;
    async fn lookup_subscription_by_customer_id(&self, customer_id: &Uuid) -> Result<Option<Subscription>, sqlx::Error>;
    async fn lookup_tier_by_id(&self, tier_id: &str) -> Result<Option<SubscriptionTier>, sqlx::Error>;
    async fn lookup_customer_by_stripe_customer_id(&self, stripe_customer_id: &str) -> Result<Option<Customer>, sqlx::Error>;
}

pub struct BillingIndex {
    store: Arc<dyn IBillingStore>,
}

impl BillingIndex {
    pub fn new(store: Arc<dyn IBillingStore>) -> Self {
        Self { store }
    }
}

#[async_trait::async_trait]
impl IBillingIndex for BillingIndex {
    async fn lookup_customer_by_key_hash(&self, key_hash: &str) -> Result<Option<Customer>, sqlx::Error> {
        // Step 1: Acquire DB client connection.
        let mut conn = self.store.get_connection().await?;

        // Step 2: Execute SELECT query resolving Customer record linked to active key_hash.
        let customer = sqlx::query_as::<_, Customer>(
            "SELECT c.* FROM customers c
             JOIN api_keys k ON c.id = k.customer_id
             WHERE k.key_hash = $1 AND k.status = 'active'"
        )
        .bind(key_hash)
        .fetch_optional(&mut *conn)
        .await?;

        Ok(customer)
    }

    async fn lookup_customer_by_id(&self, id: &Uuid) -> Result<Option<Customer>, sqlx::Error> {
        // Step 1: Acquire DB client connection.
        let mut conn = self.store.get_connection().await?;

        // Step 2: Execute SELECT query retrieving Customer record matching ID.
        let customer = sqlx::query_as::<_, Customer>(
            "SELECT * FROM customers WHERE id = $1"
        )
        .bind(id)
        .fetch_optional(&mut *conn)
        .await?;

        Ok(customer)
    }

    async fn lookup_subscription_by_customer_id(&self, customer_id: &Uuid) -> Result<Option<Subscription>, sqlx::Error> {
        // Step 1: Acquire DB client connection.
        let mut conn = self.store.get_connection().await?;

        // Step 2: Execute SELECT query resolving active Subscription record for customer.
        let subscription = sqlx::query_as::<_, Subscription>(
            "SELECT * FROM subscriptions WHERE customer_id = $1 AND status = 'active'"
        )
        .bind(customer_id)
        .fetch_optional(&mut *conn)
        .await?;

        Ok(subscription)
    }

    async fn lookup_tier_by_id(&self, tier_id: &str) -> Result<Option<SubscriptionTier>, sqlx::Error> {
        // Step 1: Acquire DB client connection.
        let mut conn = self.store.get_connection().await?;

        // Step 2: Execute SELECT query resolving SubscriptionTier bounds matching tier ID.
        let tier = sqlx::query_as::<_, SubscriptionTier>(
            "SELECT * FROM subscription_tiers WHERE id = $1"
        )
        .bind(tier_id)
        .fetch_optional(&mut *conn)
        .await?;

        Ok(tier)
    }

    async fn lookup_customer_by_stripe_customer_id(&self, stripe_customer_id: &str) -> Result<Option<Customer>, sqlx::Error> {
        // Step 1: Acquire DB client connection.
        let mut conn = self.store.get_connection().await?;

        // Step 2: Execute SELECT query resolving Customer matching Stripe customer ID.
        let customer = sqlx::query_as::<_, Customer>(
            "SELECT * FROM customers WHERE stripe_customer_id = $1"
        )
        .bind(stripe_customer_id)
        .fetch_optional(&mut *conn)
        .await?;

        Ok(customer)
    }
}
