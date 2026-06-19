//! Subscription Repository (Repository pattern): persistence facade for the
//! Subscription aggregate (incl. the processed-event idempotency log). Owns the
//! store, registry, index, and Postgres adapter; each method forwards 1:1 to the
//! owned registry (writes) or index (reads).

use std::sync::Arc;

use async_trait::async_trait;

use crate::domain::{BillingAccountId, SubscriptionId, TierId};

use super::model::{Subscription, SubscriptionError, SubscriptionStatus};
use super::subscription_db_adapter::{PostgresSubscriptionDbAdapter, SubscriptionDbAdapter};
use super::subscription_index::{SubscriptionIndex, SubscriptionIndexImpl};
use super::subscription_registry::{SubscriptionRegistry, SubscriptionRegistryImpl};
use super::subscription_store::{InMemorySubscriptionStore, SubscriptionStore};

#[async_trait]
pub trait SubscriptionRepository: Send + Sync {
    async fn save_subscription(&self, sub: Subscription) -> Result<(), SubscriptionError>;
    async fn set_tier(
        &self,
        id: &SubscriptionId,
        tier_id: TierId,
    ) -> Result<(), SubscriptionError>;
    async fn set_status(
        &self,
        id: &SubscriptionId,
        status: SubscriptionStatus,
        current_period_end: String,
    ) -> Result<(), SubscriptionError>;
    async fn mark_event_processed(
        &self,
        id: &SubscriptionId,
        event_id: String,
        status: SubscriptionStatus,
        current_period_end: String,
    ) -> Result<bool, SubscriptionError>;
    async fn find_subscription(
        &self,
        id: &SubscriptionId,
    ) -> Result<Option<Subscription>, SubscriptionError>;
    async fn find_by_account(
        &self,
        id: &BillingAccountId,
    ) -> Result<Option<Subscription>, SubscriptionError>;
    async fn is_event_processed(&self, event_id: &str) -> Result<bool, SubscriptionError>;
}

pub struct SubscriptionRepositoryImpl {
    registry: Arc<dyn SubscriptionRegistry>,
    index: Arc<dyn SubscriptionIndex>,
}

impl SubscriptionRepositoryImpl {
    pub fn new(
        registry: Arc<dyn SubscriptionRegistry>,
        index: Arc<dyn SubscriptionIndex>,
    ) -> Self {
        Self { registry, index }
    }

    pub fn with_db(db: Arc<dyn SubscriptionDbAdapter>) -> Self {
        let store: Arc<dyn SubscriptionStore> = Arc::new(InMemorySubscriptionStore::new());
        let registry = Arc::new(SubscriptionRegistryImpl::new(store.clone(), db));
        let index = Arc::new(SubscriptionIndexImpl::new(store));
        Self::new(registry, index)
    }

    pub fn from_pool(pool: sqlx::PgPool) -> Self {
        let db: Arc<dyn SubscriptionDbAdapter> =
            Arc::new(PostgresSubscriptionDbAdapter::new(pool));
        Self::with_db(db)
    }
}

#[async_trait]
impl SubscriptionRepository for SubscriptionRepositoryImpl {
    async fn save_subscription(&self, sub: Subscription) -> Result<(), SubscriptionError> {
        // Step 1: Forward to the registry.
        self.registry.create_subscription(sub).await
    }

    async fn set_tier(
        &self,
        id: &SubscriptionId,
        tier_id: TierId,
    ) -> Result<(), SubscriptionError> {
        // Step 1: Forward to the registry.
        self.registry.set_tier(id, tier_id).await
    }

    async fn set_status(
        &self,
        id: &SubscriptionId,
        status: SubscriptionStatus,
        current_period_end: String,
    ) -> Result<(), SubscriptionError> {
        // Step 1: Forward to the registry.
        self.registry.set_status(id, status, current_period_end).await
    }

    async fn mark_event_processed(
        &self,
        id: &SubscriptionId,
        event_id: String,
        status: SubscriptionStatus,
        current_period_end: String,
    ) -> Result<bool, SubscriptionError> {
        // Step 1: Forward to the registry.
        self.registry
            .mark_event_processed(id, event_id, status, current_period_end)
            .await
    }

    async fn find_subscription(
        &self,
        id: &SubscriptionId,
    ) -> Result<Option<Subscription>, SubscriptionError> {
        // Step 1: Forward to the index.
        Ok(self.index.find_subscription(id))
    }

    async fn find_by_account(
        &self,
        id: &BillingAccountId,
    ) -> Result<Option<Subscription>, SubscriptionError> {
        // Step 1: Forward to the index.
        Ok(self.index.find_by_account(id))
    }

    async fn is_event_processed(&self, event_id: &str) -> Result<bool, SubscriptionError> {
        // Step 1: Forward to the index.
        Ok(self.index.is_event_processed(event_id))
    }
}
