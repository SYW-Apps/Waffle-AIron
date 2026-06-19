//! Subscription Store (Store stereotype): authoritative in-memory state for the
//! Subscription aggregate, a billing-account secondary index, and the processed
//! Stripe-event id set. Wait-free reads; mutex-serialized copy-on-write writes.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};

use arc_swap::ArcSwap;

use crate::domain::{BillingAccountId, SubscriptionId, TierId};

use super::model::{Subscription, SubscriptionStatus};

pub trait SubscriptionStore: Send + Sync {
    fn insert(&self, sub: Subscription);
    fn get(&self, id: &SubscriptionId) -> Option<Subscription>;
    fn get_by_account(&self, id: &BillingAccountId) -> Option<Subscription>;
    fn set_tier(&self, id: &SubscriptionId, tier_id: TierId) -> bool;
    fn set_status(
        &self,
        id: &SubscriptionId,
        status: SubscriptionStatus,
        current_period_end: String,
    ) -> bool;
    fn record_event(&self, event_id: String) -> bool;
    fn has_event(&self, event_id: &str) -> bool;
}

#[derive(Default, Clone)]
struct State {
    by_id: HashMap<String, Subscription>,
    account_to_id: HashMap<String, String>,
    processed_events: HashSet<String>,
}

pub struct InMemorySubscriptionStore {
    snapshot: ArcSwap<State>,
    write_lock: Mutex<()>,
}

impl Default for InMemorySubscriptionStore {
    fn default() -> Self {
        Self {
            snapshot: ArcSwap::from_pointee(State::default()),
            write_lock: Mutex::new(()),
        }
    }
}

impl InMemorySubscriptionStore {
    pub fn new() -> Self {
        Self::default()
    }

    fn mutate<R>(&self, f: impl FnOnce(&mut State) -> R) -> R {
        let _guard = self.write_lock.lock().expect("subscription store write lock");
        let mut next = (**self.snapshot.load()).clone();
        let result = f(&mut next);
        self.snapshot.store(Arc::new(next));
        result
    }
}

impl SubscriptionStore for InMemorySubscriptionStore {
    fn insert(&self, sub: Subscription) {
        // Step 1: Insert or replace in the id map and update the billing-account index.
        self.mutate(|state| {
            state
                .account_to_id
                .insert(sub.billing_account_id.0.clone(), sub.id.0.clone());
            state.by_id.insert(sub.id.0.clone(), sub);
        });
    }

    fn get(&self, id: &SubscriptionId) -> Option<Subscription> {
        // Step 1: Return a clone of the subscription for the id if present.
        self.snapshot.load().by_id.get(&id.0).cloned()
    }

    fn get_by_account(&self, id: &BillingAccountId) -> Option<Subscription> {
        // Step 1: Resolve the id via the account secondary index and return a clone if present.
        let snapshot = self.snapshot.load();
        let sub_id = snapshot.account_to_id.get(&id.0)?;
        snapshot.by_id.get(sub_id).cloned()
    }

    fn set_tier(&self, id: &SubscriptionId, tier_id: TierId) -> bool {
        // Step 1: If present, mutate the tier_id and return true, else false.
        self.mutate(|state| match state.by_id.get_mut(&id.0) {
            Some(sub) => {
                sub.tier_id = tier_id;
                true
            }
            None => false,
        })
    }

    fn set_status(
        &self,
        id: &SubscriptionId,
        status: SubscriptionStatus,
        current_period_end: String,
    ) -> bool {
        // Step 1: If present, mutate status and current_period_end and return true, else false.
        self.mutate(|state| match state.by_id.get_mut(&id.0) {
            Some(sub) => {
                sub.status = status;
                sub.current_period_end = current_period_end;
                true
            }
            None => false,
        })
    }

    fn record_event(&self, event_id: String) -> bool {
        // Step 1: Insert into the processed-event set; return false if already present.
        self.mutate(|state| state.processed_events.insert(event_id))
    }

    fn has_event(&self, event_id: &str) -> bool {
        // Step 1: Return whether the event id is in the processed-event set.
        self.snapshot.load().processed_events.contains(event_id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::PlanId;

    fn sub() -> Subscription {
        Subscription {
            id: SubscriptionId::new("sub-1"),
            billing_account_id: BillingAccountId::new("ba-1"),
            plan_id: PlanId::new("plan-1"),
            tier_id: TierId::new("tier-1"),
            stripe_customer_id: Some("cus_1".into()),
            stripe_subscription_id: Some("stripe_sub_1".into()),
            status: SubscriptionStatus::Active,
            current_period_end: "2026-07-01T00:00:00Z".into(),
            overrides: vec![],
        }
    }

    #[test]
    fn insert_get_by_id_and_account() {
        let store = InMemorySubscriptionStore::new();
        store.insert(sub());
        assert!(store.get(&SubscriptionId::new("sub-1")).is_some());
        assert!(store.get_by_account(&BillingAccountId::new("ba-1")).is_some());
    }

    #[test]
    fn set_tier_and_status() {
        let store = InMemorySubscriptionStore::new();
        store.insert(sub());
        assert!(store.set_tier(&SubscriptionId::new("sub-1"), TierId::new("tier-2")));
        assert!(store.set_status(
            &SubscriptionId::new("sub-1"),
            SubscriptionStatus::Canceled,
            "2026-08-01T00:00:00Z".into()
        ));
        let got = store.get(&SubscriptionId::new("sub-1")).unwrap();
        assert_eq!(got.tier_id, TierId::new("tier-2"));
        assert_eq!(got.status, SubscriptionStatus::Canceled);
        assert!(!store.set_tier(&SubscriptionId::new("missing"), TierId::new("x")));
    }

    #[test]
    fn record_event_is_idempotent() {
        let store = InMemorySubscriptionStore::new();
        assert!(store.record_event("evt_1".into()));
        assert!(!store.record_event("evt_1".into()));
        assert!(store.has_event("evt_1"));
        assert!(!store.has_event("evt_2"));
    }
}
