//! Usage Rollup Repository (Repository pattern): persistence facade for
//! authoritative usage rollups. Owns the store, registry, index, and Postgres
//! adapter; each method forwards 1:1 to the owned registry (writes) or index
//! (reads).

use std::sync::Arc;

use async_trait::async_trait;

use crate::domain::SubscriptionId;

use super::model::{MeteringError, UsageRollup};
use super::usage_rollup_db_adapter::{PostgresUsageRollupDbAdapter, UsageRollupDbAdapter};
use super::usage_rollup_index::{UsageRollupIndex, UsageRollupIndexImpl};
use super::usage_rollup_registry::{UsageRollupRegistry, UsageRollupRegistryImpl};
use super::usage_rollup_store::{InMemoryUsageRollupStore, UsageRollupStore};

#[async_trait]
pub trait UsageRollupRepository: Send + Sync {
    async fn record_usage(
        &self,
        subscription_id: SubscriptionId,
        resource: String,
        period: String,
        used: i64,
    ) -> Result<(), MeteringError>;
    async fn get_rollup(
        &self,
        subscription_id: &SubscriptionId,
        resource: &str,
        period: &str,
    ) -> Result<Option<UsageRollup>, MeteringError>;
    async fn list_rollups(
        &self,
        subscription_id: &SubscriptionId,
    ) -> Result<Vec<UsageRollup>, MeteringError>;
}

pub struct UsageRollupRepositoryImpl {
    registry: Arc<dyn UsageRollupRegistry>,
    index: Arc<dyn UsageRollupIndex>,
}

impl UsageRollupRepositoryImpl {
    pub fn new(
        registry: Arc<dyn UsageRollupRegistry>,
        index: Arc<dyn UsageRollupIndex>,
    ) -> Self {
        Self { registry, index }
    }

    pub fn with_db(db: Arc<dyn UsageRollupDbAdapter>) -> Self {
        let store: Arc<dyn UsageRollupStore> = Arc::new(InMemoryUsageRollupStore::new());
        let registry = Arc::new(UsageRollupRegistryImpl::new(store.clone(), db));
        let index = Arc::new(UsageRollupIndexImpl::new(store));
        Self::new(registry, index)
    }

    pub fn from_pool(pool: sqlx::PgPool) -> Self {
        let db: Arc<dyn UsageRollupDbAdapter> =
            Arc::new(PostgresUsageRollupDbAdapter::new(pool));
        Self::with_db(db)
    }
}

#[async_trait]
impl UsageRollupRepository for UsageRollupRepositoryImpl {
    async fn record_usage(
        &self,
        subscription_id: SubscriptionId,
        resource: String,
        period: String,
        used: i64,
    ) -> Result<(), MeteringError> {
        // Step 1: Forward to the registry (idempotent set-style write).
        self.registry.set_usage(subscription_id, resource, period, used).await
    }

    async fn get_rollup(
        &self,
        subscription_id: &SubscriptionId,
        resource: &str,
        period: &str,
    ) -> Result<Option<UsageRollup>, MeteringError> {
        // Step 1: Forward to the index.
        Ok(self.index.get(subscription_id, resource, period))
    }

    async fn list_rollups(
        &self,
        subscription_id: &SubscriptionId,
    ) -> Result<Vec<UsageRollup>, MeteringError> {
        // Step 1: Forward to the index.
        Ok(self.index.list_for_subscription(subscription_id))
    }
}
