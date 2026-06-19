use std::sync::Arc;
use uuid::Uuid;
use crate::identity_billing::registry::IBillingRegistry;
use crate::identity_billing::index::IBillingIndex;
use crate::identity_billing::store::IBillingStore;
use crate::models::{Customer, ApiKey, Subscription, SubscriptionTier};

#[async_trait::async_trait]
pub trait IBillingRepository: Send + Sync {
    async fn save_customer(&self, customer: &Customer) -> Result<(), sqlx::Error>;
    async fn find_customer_by_id(&self, id: &Uuid) -> Result<Option<Customer>, sqlx::Error>;
    async fn find_customer_by_api_key(&self, key_hash: &str) -> Result<Option<Customer>, sqlx::Error>;
    async fn save_api_key(&self, key: &ApiKey) -> Result<(), sqlx::Error>;
    async fn revoke_api_key(&self, id: &Uuid) -> Result<(), sqlx::Error>;
    async fn save_subscription(&self, sub: &Subscription) -> Result<(), sqlx::Error>;
    async fn find_subscription_by_customer_id(&self, customer_id: &Uuid) -> Result<Option<Subscription>, sqlx::Error>;
    async fn find_tier_by_id(&self, tier_id: &str) -> Result<Option<SubscriptionTier>, sqlx::Error>;
    async fn save_tier(&self, tier: &SubscriptionTier) -> Result<(), sqlx::Error>;
    async fn find_customer_by_stripe_customer_id(&self, stripe_customer_id: &str) -> Result<Option<Customer>, sqlx::Error>;
    async fn find_customer_by_subscription_id(&self, subscription_id: &str) -> Result<Option<Customer>, sqlx::Error>;
}

pub struct BillingRepository {
    registry: Arc<dyn IBillingRegistry>,
    index: Arc<dyn IBillingIndex>,
    store: Arc<dyn IBillingStore>,
}

impl BillingRepository {
    pub fn new(registry: Arc<dyn IBillingRegistry>, index: Arc<dyn IBillingIndex>, store: Arc<dyn IBillingStore>) -> Self {
        Self { registry, index, store }
    }
}

#[async_trait::async_trait]
impl IBillingRepository for BillingRepository {
    async fn save_customer(&self, customer: &Customer) -> Result<(), sqlx::Error> {
        // Step 1: Forward to billing-registry to insert/upsert Customer.
        // For upsert: let's try to update, if zero rows or error, we can insert, or we can just try lookup first.
        // But the narrative step strictly says: "Forward to billing-registry to insert/upsert Customer."
        // We will execute a database upsert logic here or call registry.
        // Let's check if the customer already exists in database. If so, call update, else insert.
        match self.index.lookup_customer_by_id(&customer.id).await? {
            Some(_) => self.registry.update_customer(customer).await,
            None => self.registry.insert_customer(customer).await,
        }
    }

    async fn find_customer_by_id(&self, id: &Uuid) -> Result<Option<Customer>, sqlx::Error> {
        // Step 1: Forward to billing-index to lookup Customer by ID.
        self.index.lookup_customer_by_id(id).await
    }

    async fn find_customer_by_api_key(&self, key_hash: &str) -> Result<Option<Customer>, sqlx::Error> {
        // Step 1: Forward to billing-index to lookup Customer by API Key hash.
        self.index.lookup_customer_by_key_hash(key_hash).await
    }

    async fn save_api_key(&self, key: &ApiKey) -> Result<(), sqlx::Error> {
        // Step 1: Forward to billing-registry to save key credential.
        self.registry.insert_api_key(key).await
    }

    async fn revoke_api_key(&self, id: &Uuid) -> Result<(), sqlx::Error> {
        // Step 1: Forward to billing-registry to update api key status to revoked.
        self.registry.update_api_key_status(id, "revoked").await
    }

    async fn save_subscription(&self, sub: &Subscription) -> Result<(), sqlx::Error> {
        // Step 1: Forward to billing-registry to save Subscription details.
        match self.index.lookup_subscription_by_customer_id(&sub.customer_id).await? {
            Some(_) => self.registry.update_subscription(sub).await,
            None => self.registry.insert_subscription(sub).await,
        }
    }

    async fn find_subscription_by_customer_id(&self, customer_id: &Uuid) -> Result<Option<Subscription>, sqlx::Error> {
        // Step 1: Forward to billing-index to look up active Subscription by customer_id.
        self.index.lookup_subscription_by_customer_id(customer_id).await
    }

    async fn find_tier_by_id(&self, tier_id: &str) -> Result<Option<SubscriptionTier>, sqlx::Error> {
        // Step 1: Forward to billing-index to lookup SubscriptionTier detail boundaries.
        self.index.lookup_tier_by_id(tier_id).await
    }

    async fn save_tier(&self, tier: &SubscriptionTier) -> Result<(), sqlx::Error> {
        // Step 1: Forward to billing-registry to save SubscriptionTier metadata.
        self.registry.insert_tier(tier).await
    }

    async fn find_customer_by_stripe_customer_id(&self, stripe_customer_id: &str) -> Result<Option<Customer>, sqlx::Error> {
        // Step 1: Forward to billing-index to lookup Customer by Stripe customer ID.
        self.index.lookup_customer_by_stripe_customer_id(stripe_customer_id).await
    }

    async fn find_customer_by_subscription_id(&self, subscription_id: &str) -> Result<Option<Customer>, sqlx::Error> {
        // Step 1: Forward to billing-store to lookup Customer by subscription ID.
        let sub_uuid = match Uuid::parse_str(subscription_id) {
            Ok(u) => u,
            Err(_) => return Ok(None),
        };

        let mut conn = self.store.get_connection().await?;

        let customer = sqlx::query_as::<_, Customer>(
            "SELECT c.* FROM customers c
             JOIN subscriptions s ON c.id = s.customer_id
             WHERE s.id = $1"
        )
        .bind(sub_uuid)
        .fetch_optional(&mut *conn)
        .await?;

        Ok(customer)
    }
}
