//! Test doubles for the metering subsystem.

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;

use async_trait::async_trait;

use crate::domain::{DbError, SubscriptionId};

use super::model::{
    ConsumeOutcome, ConsumeRequest, CounterSnapshot, MeteringError, UsageRollup,
    UsageThresholdEvent, UsageView,
};
use super::redis_counter_adapter::CounterAdapter;
use super::usage_event_adapter::UsageEventAdapter;
use super::usage_meter::UsageMeter;
use super::usage_query::UsageQuery;
use super::usage_rollup_db_adapter::UsageRollupDbAdapter;

// --- Rollup db adapter double ---

pub struct MockUsageRollupDbAdapter {
    upserts: AtomicUsize,
}

impl MockUsageRollupDbAdapter {
    pub fn ok() -> Self {
        Self { upserts: AtomicUsize::new(0) }
    }
    pub fn upsert_calls(&self) -> usize {
        self.upserts.load(Ordering::SeqCst)
    }
}

#[async_trait]
impl UsageRollupDbAdapter for MockUsageRollupDbAdapter {
    async fn load_rollups(
        &self,
        _subscription_id: &SubscriptionId,
    ) -> Result<Vec<UsageRollup>, DbError> {
        Ok(vec![])
    }
    async fn upsert_rollup(&self, _rollup: &UsageRollup) -> Result<(), DbError> {
        self.upserts.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }
}

// --- Counter adapter doubles ---

/// Always allows, reporting a fixed post-call `used` value.
pub struct ScriptedCounterAdapter {
    used_after: i64,
    flags: Mutex<HashSet<String>>,
}

impl ScriptedCounterAdapter {
    pub fn allowing(used_after: i64) -> Self {
        Self { used_after, flags: Mutex::new(HashSet::new()) }
    }
}

#[async_trait]
impl CounterAdapter for ScriptedCounterAdapter {
    async fn check_and_decrement(
        &self,
        _key: String,
        _amount: i64,
        quota: i64,
        _ttl_seconds: i64,
    ) -> Result<ConsumeOutcome, MeteringError> {
        Ok(ConsumeOutcome {
            allowed: true,
            used: self.used_after,
            remaining: (quota - self.used_after).max(0),
        })
    }
    async fn get(&self, _key: String) -> Result<Option<i64>, MeteringError> {
        Ok(None)
    }
    async fn snapshot_all(&self) -> Result<Vec<CounterSnapshot>, MeteringError> {
        Ok(vec![])
    }
    async fn try_mark_threshold(
        &self,
        key: String,
        threshold: i64,
        _ttl_seconds: i64,
    ) -> Result<bool, MeteringError> {
        Ok(self.flags.lock().unwrap().insert(format!("{key}:{threshold}")))
    }
}

/// A faithful in-memory counter for query/reconcile tests.
pub struct InMemoryCounterAdapter {
    map: Mutex<HashMap<String, i64>>,
    flags: Mutex<HashSet<String>>,
}

impl InMemoryCounterAdapter {
    pub fn new() -> Self {
        Self { map: Mutex::new(HashMap::new()), flags: Mutex::new(HashSet::new()) }
    }
    pub fn seed(&self, key: &str, value: i64) {
        self.map.lock().unwrap().insert(key.to_string(), value);
    }
}

impl Default for InMemoryCounterAdapter {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl CounterAdapter for InMemoryCounterAdapter {
    async fn check_and_decrement(
        &self,
        key: String,
        amount: i64,
        quota: i64,
        _ttl_seconds: i64,
    ) -> Result<ConsumeOutcome, MeteringError> {
        let mut map = self.map.lock().unwrap();
        let current = *map.get(&key).unwrap_or(&0);
        let candidate = current + amount;
        if candidate > quota {
            Ok(ConsumeOutcome { allowed: false, used: current, remaining: (quota - current).max(0) })
        } else {
            map.insert(key, candidate);
            Ok(ConsumeOutcome { allowed: true, used: candidate, remaining: (quota - candidate).max(0) })
        }
    }
    async fn get(&self, key: String) -> Result<Option<i64>, MeteringError> {
        Ok(self.map.lock().unwrap().get(&key).copied())
    }
    async fn snapshot_all(&self) -> Result<Vec<CounterSnapshot>, MeteringError> {
        Ok(self
            .map
            .lock()
            .unwrap()
            .iter()
            .filter_map(|(key, used)| {
                let parts: Vec<&str> = key.split(':').collect();
                if parts.len() != 3 {
                    return None;
                }
                Some(CounterSnapshot {
                    subscription_id: SubscriptionId::new(parts[0]),
                    resource: parts[1].to_string(),
                    window: parts[2].to_string(),
                    used: *used,
                })
            })
            .collect())
    }
    async fn try_mark_threshold(
        &self,
        key: String,
        threshold: i64,
        _ttl_seconds: i64,
    ) -> Result<bool, MeteringError> {
        Ok(self.flags.lock().unwrap().insert(format!("{key}:{threshold}")))
    }
}

// --- Usage event adapter double ---

pub struct MockUsageEventAdapter {
    published: AtomicUsize,
}

impl MockUsageEventAdapter {
    pub fn new() -> Self {
        Self { published: AtomicUsize::new(0) }
    }
    pub fn published(&self) -> usize {
        self.published.load(Ordering::SeqCst)
    }
}

impl Default for MockUsageEventAdapter {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl UsageEventAdapter for MockUsageEventAdapter {
    async fn publish_threshold(
        &self,
        _event: UsageThresholdEvent,
    ) -> Result<(), MeteringError> {
        self.published.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }
}

// --- Usage meter double (for portal tests) ---

/// Always-allows usage meter; the metering Portal's read tests never invoke it,
/// it only needs to satisfy the Portal constructor.
#[derive(Default)]
pub struct MockUsageMeter;

#[async_trait]
impl UsageMeter for MockUsageMeter {
    async fn consume(&self, _req: ConsumeRequest) -> Result<ConsumeOutcome, MeteringError> {
        Ok(ConsumeOutcome { allowed: true, used: 0, remaining: 0 })
    }
}

// --- Usage query double (for portal tests) ---

#[derive(Default)]
pub struct MockUsageQuery;

#[async_trait]
impl UsageQuery for MockUsageQuery {
    async fn get_usage(
        &self,
        _subscription_id: SubscriptionId,
        resource: String,
    ) -> Result<UsageView, MeteringError> {
        Err(MeteringError::NotFound(resource))
    }
    async fn list_usage(
        &self,
        _subscription_id: SubscriptionId,
    ) -> Result<Vec<UsageView>, MeteringError> {
        Ok(vec![])
    }
}
