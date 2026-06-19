//! Usage Rollup Index (Index stereotype): read path over the rollup store.
//! Never mutates.

use std::sync::Arc;

use crate::domain::SubscriptionId;

use super::model::UsageRollup;
use super::usage_rollup_store::UsageRollupStore;

pub trait UsageRollupIndex: Send + Sync {
    fn get(&self, subscription_id: &SubscriptionId, resource: &str, period: &str) -> Option<UsageRollup>;
    fn list_for_subscription(&self, subscription_id: &SubscriptionId) -> Vec<UsageRollup>;
}

pub struct UsageRollupIndexImpl {
    store: Arc<dyn UsageRollupStore>,
}

impl UsageRollupIndexImpl {
    pub fn new(store: Arc<dyn UsageRollupStore>) -> Self {
        Self { store }
    }
}

impl UsageRollupIndex for UsageRollupIndexImpl {
    fn get(&self, subscription_id: &SubscriptionId, resource: &str, period: &str) -> Option<UsageRollup> {
        // Step 1: Read the rollup from the store.
        let rollup = self.store.get(subscription_id, resource, period);
        // Step 2: Return the result.
        rollup
    }

    fn list_for_subscription(&self, subscription_id: &SubscriptionId) -> Vec<UsageRollup> {
        // Step 1: Read all rollups for the subscription from the store.
        let rollups = self.store.list(subscription_id);
        // Step 2: Return the list.
        rollups
    }
}
