//! Usage Query (Specialist stereotype): read capability combining the live Redis
//! counter with historical Postgres rollups to report current usage and remaining
//! quota for a subscription/resource.

use std::collections::HashMap;
use std::sync::Arc;

use async_trait::async_trait;

use crate::domain::SubscriptionId;

use super::model::{current_period, MeteringError, UsageView};
use super::redis_counter_adapter::CounterAdapter;
use super::usage_rollup_repository::UsageRollupRepository;

/// Reporting window for the live counter dimension.
const REPORT_WINDOW: &str = "month";

#[async_trait]
pub trait UsageQuery: Send + Sync {
    async fn get_usage(
        &self,
        subscription_id: SubscriptionId,
        resource: String,
    ) -> Result<UsageView, MeteringError>;
    async fn list_usage(
        &self,
        subscription_id: SubscriptionId,
    ) -> Result<Vec<UsageView>, MeteringError>;
}

pub struct UsageQueryImpl {
    counters: Arc<dyn CounterAdapter>,
    rollups: Arc<dyn UsageRollupRepository>,
}

impl UsageQueryImpl {
    pub fn new(
        counters: Arc<dyn CounterAdapter>,
        rollups: Arc<dyn UsageRollupRepository>,
    ) -> Self {
        Self { counters, rollups }
    }
}

#[async_trait]
impl UsageQuery for UsageQueryImpl {
    async fn get_usage(
        &self,
        subscription_id: SubscriptionId,
        resource: String,
    ) -> Result<UsageView, MeteringError> {
        // Step 1: Derive the current period/window and build the live counter key.
        let period = current_period();
        let key = format!("{subscription_id}:{resource}:{REPORT_WINDOW}");
        // Step 2: Read the live used counter from Redis.
        let live = self.counters.get(key).await?.unwrap_or(0);
        // Step 3: Read the persisted rollup for the current period.
        let rollup = self.rollups.get_rollup(&subscription_id, &resource, &period).await?;
        // Step 4: Assemble a UsageView (live used + rollup-plus-live period total).
        let rollup_total = rollup.map(|r| r.total).unwrap_or(0);
        Ok(UsageView {
            subscription_id,
            resource,
            window: REPORT_WINDOW.to_string(),
            used: live,
            period_total: rollup_total + live,
        })
    }

    async fn list_usage(
        &self,
        subscription_id: SubscriptionId,
    ) -> Result<Vec<UsageView>, MeteringError> {
        // Step 1: List the subscription's persisted rollups.
        let rollups = self.rollups.list_rollups(&subscription_id).await?;
        // Step 2: Snapshot the live counters.
        let snapshots = self.counters.snapshot_all().await?;

        // Step 3: Filter snapshots to this subscription and merge with rollups per resource.
        let mut live_by_resource: HashMap<String, (String, i64)> = HashMap::new();
        for snap in snapshots.into_iter().filter(|s| s.subscription_id == subscription_id) {
            live_by_resource.insert(snap.resource, (snap.window, snap.used));
        }
        let mut rollup_total_by_resource: HashMap<String, i64> = HashMap::new();
        for rollup in &rollups {
            *rollup_total_by_resource.entry(rollup.resource.clone()).or_insert(0) += rollup.total;
        }

        let mut resources: Vec<String> = rollup_total_by_resource.keys().cloned().collect();
        for resource in live_by_resource.keys() {
            if !rollup_total_by_resource.contains_key(resource) {
                resources.push(resource.clone());
            }
        }

        Ok(resources
            .into_iter()
            .map(|resource| {
                let (window, live) = live_by_resource
                    .get(&resource)
                    .cloned()
                    .unwrap_or_else(|| (REPORT_WINDOW.to_string(), 0));
                let rollup_total = rollup_total_by_resource.get(&resource).copied().unwrap_or(0);
                UsageView {
                    subscription_id: subscription_id.clone(),
                    resource,
                    window,
                    used: live,
                    period_total: rollup_total + live,
                }
            })
            .collect())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::metering::test_support::{InMemoryCounterAdapter, MockUsageRollupDbAdapter};
    use crate::metering::usage_rollup_repository::UsageRollupRepositoryImpl;

    #[tokio::test]
    async fn get_usage_combines_live_and_rollup() {
        let counters = Arc::new(InMemoryCounterAdapter::new());
        let sub = SubscriptionId::new("sub-1");
        counters.seed(&format!("{sub}:api_calls:{REPORT_WINDOW}"), 7);
        let rollups: Arc<dyn UsageRollupRepository> =
            Arc::new(UsageRollupRepositoryImpl::with_db(Arc::new(MockUsageRollupDbAdapter::ok())));
        rollups.record_usage(sub.clone(), "api_calls".into(), current_period(), 100).await.unwrap();
        let query = UsageQueryImpl::new(counters, rollups);
        let view = query.get_usage(sub, "api_calls".into()).await.unwrap();
        assert_eq!(view.used, 7);
        assert_eq!(view.period_total, 107);
    }
}
