//! Usage Reconciler (Actor stereotype): owns a periodic background loop that
//! flushes Redis usage counters into authoritative Postgres rollups. Delegates
//! Redis reads to the counter adapter and persistence to the rollup repository.

use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;

use super::model::{current_period, MeteringError};
use super::redis_counter_adapter::CounterAdapter;
use super::usage_rollup_repository::UsageRollupRepository;

#[async_trait]
pub trait UsageReconciler: Send + Sync {
    async fn run(&self);
    async fn reconcile_once(&self) -> Result<u64, MeteringError>;
}

pub struct UsageReconcilerImpl {
    counters: Arc<dyn CounterAdapter>,
    rollups: Arc<dyn UsageRollupRepository>,
    interval: Duration,
}

impl UsageReconcilerImpl {
    pub fn new(
        counters: Arc<dyn CounterAdapter>,
        rollups: Arc<dyn UsageRollupRepository>,
        interval: Duration,
    ) -> Self {
        Self { counters, rollups, interval }
    }
}

#[async_trait]
impl UsageReconciler for UsageReconcilerImpl {
    async fn run(&self) {
        // Step 1: Enter the live loop, waiting for the configured reconcile interval.
        let mut ticker = tokio::time::interval(self.interval);
        loop {
            ticker.tick().await;
            // Step 2: On each tick, perform one reconcile pass and continue until shutdown.
            if let Err(err) = self.reconcile_once().await {
                tracing::warn!(error = %err, "usage reconcile pass failed");
            }
        }
    }

    async fn reconcile_once(&self) -> Result<u64, MeteringError> {
        // Step 1: Snapshot all live usage counters from Redis.
        let snapshots = self.counters.snapshot_all().await?;
        let mut flushed = 0u64;
        for snapshot in snapshots {
            // Step 2: Derive its period from the window.
            let period = current_period();
            // Step 3: Set its cumulative used value into the authoritative period
            // rollup; the set-style write is idempotent, so overlapping or retried
            // passes never double-count.
            self.rollups
                .record_usage(snapshot.subscription_id, snapshot.resource, period, snapshot.used)
                .await?;
            flushed += 1;
        }
        // Step 4: Return the number of counters flushed.
        Ok(flushed)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::SubscriptionId;
    use crate::metering::test_support::{InMemoryCounterAdapter, MockUsageRollupDbAdapter};
    use crate::metering::usage_rollup_repository::UsageRollupRepositoryImpl;

    #[tokio::test]
    async fn reconcile_once_flushes_counters_into_rollups() {
        let counters = Arc::new(InMemoryCounterAdapter::new());
        counters.seed("sub-1:api_calls:day", 12);
        let rollups: Arc<dyn UsageRollupRepository> =
            Arc::new(UsageRollupRepositoryImpl::with_db(Arc::new(MockUsageRollupDbAdapter::ok())));
        let reconciler =
            UsageReconcilerImpl::new(counters, rollups.clone(), Duration::from_secs(60));
        let flushed = reconciler.reconcile_once().await.unwrap();
        assert_eq!(flushed, 1);
        let rollup = rollups
            .get_rollup(&SubscriptionId::new("sub-1"), "api_calls", &current_period())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(rollup.total, 12);
    }
}
