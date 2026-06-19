//! Subscription Index (Index stereotype): read path projecting the subscription
//! store. Never mutates.

use std::sync::Arc;

use crate::domain::{BillingAccountId, SubscriptionId};

use super::model::Subscription;
use super::subscription_store::SubscriptionStore;

pub trait SubscriptionIndex: Send + Sync {
    fn find_subscription(&self, id: &SubscriptionId) -> Option<Subscription>;
    fn find_by_account(&self, id: &BillingAccountId) -> Option<Subscription>;
    fn is_event_processed(&self, event_id: &str) -> bool;
}

pub struct SubscriptionIndexImpl {
    store: Arc<dyn SubscriptionStore>,
}

impl SubscriptionIndexImpl {
    pub fn new(store: Arc<dyn SubscriptionStore>) -> Self {
        Self { store }
    }
}

impl SubscriptionIndex for SubscriptionIndexImpl {
    fn find_subscription(&self, id: &SubscriptionId) -> Option<Subscription> {
        // Step 1: Read the subscription from the store by id.
        let sub = self.store.get(id);
        // Step 2: Return the result.
        sub
    }

    fn find_by_account(&self, id: &BillingAccountId) -> Option<Subscription> {
        // Step 1: Read the subscription from the store by billing account id.
        let sub = self.store.get_by_account(id);
        // Step 2: Return the result.
        sub
    }

    fn is_event_processed(&self, event_id: &str) -> bool {
        // Step 1: Check whether the event id is recorded in the store.
        let processed = self.store.has_event(event_id);
        // Step 2: Return the boolean.
        processed
    }
}
