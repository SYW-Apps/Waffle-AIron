//! Metering subsystem: owns usage state per subscription. Hot per-window
//! counters live in Redis (check-and-decrement on the gate hot path) and
//! authoritative rollups in Postgres, reconciled between them. Publishes
//! usage.threshold events consumed by notifications.

pub mod model;
pub mod portal;
pub mod redis_counter_adapter;
pub mod usage_event_adapter;
pub mod usage_meter;
pub mod usage_query;
pub mod usage_reconciler;
pub mod usage_rollup_db_adapter;
pub mod usage_rollup_index;
pub mod usage_rollup_registry;
pub mod usage_rollup_repository;
pub mod usage_rollup_store;

#[cfg(test)]
pub mod test_support;

use std::sync::Arc;
use std::time::Duration;

use redis_counter_adapter::{CounterAdapter, RedisCounterAdapter};
use usage_event_adapter::{BroadcastUsageEventAdapter, UsageEventBus};
use usage_meter::{UsageMeter, UsageMeterImpl};
use usage_query::UsageQueryImpl;
use usage_reconciler::{UsageReconciler, UsageReconcilerImpl};
use usage_rollup_repository::{UsageRollupRepository, UsageRollupRepositoryImpl};

use portal::{MeteringPortal, MeteringPortalApi};

/// Wired metering subsystem: the HTTP router, the published Portal surface (the
/// front door, consumed by gatekeeping), and the background reconciler to spawn.
pub struct MeteringSubsystem {
    pub router: axum::Router,
    pub portal: Arc<dyn MeteringPortalApi>,
    pub reconciler: Arc<dyn UsageReconciler>,
}

impl MeteringSubsystem {
    pub fn new(pool: sqlx::PgPool, redis_pool: deadpool_redis::Pool, bus: UsageEventBus) -> Self {
        let counters: Arc<dyn CounterAdapter> = Arc::new(RedisCounterAdapter::new(redis_pool));
        let events = Arc::new(BroadcastUsageEventAdapter::new(bus));
        let rollups: Arc<dyn UsageRollupRepository> =
            Arc::new(UsageRollupRepositoryImpl::from_pool(pool));

        let usage_meter: Arc<dyn UsageMeter> =
            Arc::new(UsageMeterImpl::new(counters.clone(), events));
        let usage_query = Arc::new(UsageQueryImpl::new(counters.clone(), rollups.clone()));
        let reconciler: Arc<dyn UsageReconciler> = Arc::new(UsageReconcilerImpl::new(
            counters,
            rollups,
            Duration::from_secs(60),
        ));

        let portal = MeteringPortal::new(usage_query, usage_meter);
        let portal_api: Arc<dyn MeteringPortalApi> = Arc::new(portal.clone());
        let router = portal.router();

        Self { router, portal: portal_api, reconciler }
    }
}
