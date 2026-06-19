//! Usage Rollup Store (Store stereotype): authoritative in-memory state for
//! usage rollups keyed by (subscription, resource, period). Wait-free snapshot
//! reads; mutex-serialized copy-on-write writes.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use arc_swap::ArcSwap;

use crate::domain::SubscriptionId;

use super::model::UsageRollup;

pub trait UsageRollupStore: Send + Sync {
    fn set_used(&self, subscription_id: SubscriptionId, resource: String, period: String, used: i64);
    fn get(&self, subscription_id: &SubscriptionId, resource: &str, period: &str) -> Option<UsageRollup>;
    fn list(&self, subscription_id: &SubscriptionId) -> Vec<UsageRollup>;
}

fn key(subscription_id: &str, resource: &str, period: &str) -> String {
    format!("{subscription_id}:{resource}:{period}")
}

pub struct InMemoryUsageRollupStore {
    snapshot: ArcSwap<HashMap<String, UsageRollup>>,
    write_lock: Mutex<()>,
}

impl Default for InMemoryUsageRollupStore {
    fn default() -> Self {
        Self {
            snapshot: ArcSwap::from_pointee(HashMap::new()),
            write_lock: Mutex::new(()),
        }
    }
}

impl InMemoryUsageRollupStore {
    pub fn new() -> Self {
        Self::default()
    }
}

impl UsageRollupStore for InMemoryUsageRollupStore {
    fn set_used(&self, subscription_id: SubscriptionId, resource: String, period: String, used: i64) {
        // Step 1: Set the rollup's used for (subscription, resource, period) to the
        // given absolute value, creating the entry at that value if absent. Set-style
        // (not additive), so re-applying the same snapshot is idempotent.
        let _guard = self.write_lock.lock().expect("rollup store write lock");
        let mut next = (**self.snapshot.load()).clone();
        let map_key = key(&subscription_id.0, &resource, &period);
        next.insert(
            map_key,
            UsageRollup {
                subscription_id,
                resource,
                period,
                total: used,
            },
        );
        self.snapshot.store(Arc::new(next));
    }

    fn get(&self, subscription_id: &SubscriptionId, resource: &str, period: &str) -> Option<UsageRollup> {
        // Step 1: Return a clone of the rollup for the key if present.
        self.snapshot
            .load()
            .get(&key(&subscription_id.0, resource, period))
            .cloned()
    }

    fn list(&self, subscription_id: &SubscriptionId) -> Vec<UsageRollup> {
        // Step 1: Return clones of all rollups for the subscription.
        self.snapshot
            .load()
            .values()
            .filter(|r| &r.subscription_id == subscription_id)
            .cloned()
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn set_used_is_idempotent() {
        let store = InMemoryUsageRollupStore::new();
        let sub = SubscriptionId::new("sub-1");
        // Re-applying the same value is a no-op; later values overwrite (no accumulation).
        store.set_used(sub.clone(), "api_calls".into(), "2026-06".into(), 8);
        store.set_used(sub.clone(), "api_calls".into(), "2026-06".into(), 8);
        assert_eq!(store.get(&sub, "api_calls", "2026-06").unwrap().total, 8);
        store.set_used(sub.clone(), "api_calls".into(), "2026-06".into(), 12);
        assert_eq!(store.get(&sub, "api_calls", "2026-06").unwrap().total, 12);
        assert_eq!(store.list(&sub).len(), 1);
    }
}
