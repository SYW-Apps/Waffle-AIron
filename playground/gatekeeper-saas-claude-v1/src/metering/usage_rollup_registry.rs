//! Usage Rollup Registry (Registry stereotype): write path for usage rollups.
//! Sets period totals (absolute cumulative used) in the store and persists via
//! the Postgres adapter. Set-style writes make reconciliation re-flushes idempotent.

use std::sync::Arc;

use async_trait::async_trait;

use crate::domain::SubscriptionId;

use super::model::MeteringError;
use super::usage_rollup_db_adapter::UsageRollupDbAdapter;
use super::usage_rollup_store::UsageRollupStore;

#[async_trait]
pub trait UsageRollupRegistry: Send + Sync {
    async fn set_usage(
        &self,
        subscription_id: SubscriptionId,
        resource: String,
        period: String,
        used: i64,
    ) -> Result<(), MeteringError>;
}

pub struct UsageRollupRegistryImpl {
    store: Arc<dyn UsageRollupStore>,
    db: Arc<dyn UsageRollupDbAdapter>,
}

impl UsageRollupRegistryImpl {
    pub fn new(store: Arc<dyn UsageRollupStore>, db: Arc<dyn UsageRollupDbAdapter>) -> Self {
        Self { store, db }
    }
}

#[async_trait]
impl UsageRollupRegistry for UsageRollupRegistryImpl {
    async fn set_usage(
        &self,
        subscription_id: SubscriptionId,
        resource: String,
        period: String,
        used: i64,
    ) -> Result<(), MeteringError> {
        // Step 1: Set the period rollup's cumulative used in the store (creating it if absent).
        self.store
            .set_used(subscription_id.clone(), resource.clone(), period.clone(), used);
        // Step 2: Read back the updated rollup.
        let rollup = self
            .store
            .get(&subscription_id, &resource, &period)
            .ok_or_else(|| MeteringError::Persistence("rollup vanished after set".into()))?;
        // Step 3: Persist the rollup total to Postgres (upsert).
        self.db.upsert_rollup(&rollup).await?;
        // Step 4: Return Ok(()).
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::metering::test_support::MockUsageRollupDbAdapter;
    use crate::metering::usage_rollup_store::InMemoryUsageRollupStore;

    #[tokio::test]
    async fn set_usage_sets_absolute_and_persists() {
        let store = Arc::new(InMemoryUsageRollupStore::new());
        let db = Arc::new(MockUsageRollupDbAdapter::ok());
        let registry = UsageRollupRegistryImpl::new(store.clone(), db.clone());
        let sub = SubscriptionId::new("sub-1");
        // Set-style: the latest absolute value wins (no accumulation), so the
        // reconciler can re-flush the same snapshot without double-counting.
        registry.set_usage(sub.clone(), "api_calls".into(), "2026-06".into(), 4).await.unwrap();
        registry.set_usage(sub.clone(), "api_calls".into(), "2026-06".into(), 6).await.unwrap();
        assert_eq!(store.get(&sub, "api_calls", "2026-06").unwrap().total, 6);
        assert_eq!(db.upsert_calls(), 2);
    }
}
