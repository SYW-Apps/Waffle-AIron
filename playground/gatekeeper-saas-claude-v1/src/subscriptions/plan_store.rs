//! Plan Store (Store stereotype): authoritative in-memory state for the Plan
//! aggregate. Wait-free snapshot reads; mutex-serialized copy-on-write writes.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use arc_swap::ArcSwap;

use crate::domain::{PlanId, TierId};

use super::model::{LimitSet, Plan};

/// Authoritative in-process state boundary for the Plan aggregate.
pub trait PlanStore: Send + Sync {
    fn insert(&self, plan: Plan);
    fn get(&self, id: &PlanId) -> Option<Plan>;
    fn list(&self) -> Vec<Plan>;
    fn apply_tier_limits(&self, plan_id: &PlanId, tier_id: &TierId, limits: LimitSet) -> bool;
}

pub struct InMemoryPlanStore {
    snapshot: ArcSwap<HashMap<String, Plan>>,
    write_lock: Mutex<()>,
}

impl Default for InMemoryPlanStore {
    fn default() -> Self {
        Self {
            snapshot: ArcSwap::from_pointee(HashMap::new()),
            write_lock: Mutex::new(()),
        }
    }
}

impl InMemoryPlanStore {
    pub fn new() -> Self {
        Self::default()
    }

    fn mutate<R>(&self, f: impl FnOnce(&mut HashMap<String, Plan>) -> R) -> R {
        let _guard = self.write_lock.lock().expect("plan store write lock");
        let mut next = (**self.snapshot.load()).clone();
        let result = f(&mut next);
        self.snapshot.store(Arc::new(next));
        result
    }
}

impl PlanStore for InMemoryPlanStore {
    fn insert(&self, plan: Plan) {
        // Step 1: Insert or replace the plan in the id-keyed map.
        self.mutate(|plans| {
            plans.insert(plan.id.0.clone(), plan);
        });
    }

    fn get(&self, id: &PlanId) -> Option<Plan> {
        // Step 1: Return a clone of the plan for the id if present.
        self.snapshot.load().get(&id.0).cloned()
    }

    fn list(&self) -> Vec<Plan> {
        // Step 1: Return clones of all plans.
        self.snapshot.load().values().cloned().collect()
    }

    fn apply_tier_limits(&self, plan_id: &PlanId, tier_id: &TierId, limits: LimitSet) -> bool {
        // Step 1: Locate the plan and tier; if found, replace the tier's limits
        // and return true, else return false.
        self.mutate(|plans| match plans.get_mut(&plan_id.0) {
            Some(plan) => match plan.tiers.iter_mut().find(|t| &t.id == tier_id) {
                Some(tier) => {
                    tier.limits = limits.limits;
                    true
                }
                None => false,
            },
            None => false,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::subscriptions::model::{Limit, Tier};

    fn plan() -> Plan {
        Plan {
            id: PlanId::new("plan-1"),
            name: "Standard".into(),
            active: true,
            tiers: vec![Tier {
                id: TierId::new("tier-pro"),
                name: "Pro".into(),
                stripe_price_id: "price_123".into(),
                limits: vec![Limit { resource: "api_calls".into(), quota: 100, window: "day".into() }],
            }],
        }
    }

    #[test]
    fn insert_get_list() {
        let store = InMemoryPlanStore::new();
        store.insert(plan());
        assert!(store.get(&PlanId::new("plan-1")).is_some());
        assert_eq!(store.list().len(), 1);
    }

    #[test]
    fn apply_tier_limits_updates_or_reports_absent() {
        let store = InMemoryPlanStore::new();
        store.insert(plan());
        let set = LimitSet { limits: vec![Limit { resource: "api_calls".into(), quota: 999, window: "day".into() }] };
        assert!(store.apply_tier_limits(&PlanId::new("plan-1"), &TierId::new("tier-pro"), set.clone()));
        assert_eq!(store.get(&PlanId::new("plan-1")).unwrap().tiers[0].limits[0].quota, 999);
        assert!(!store.apply_tier_limits(&PlanId::new("plan-1"), &TierId::new("missing"), set.clone()));
        assert!(!store.apply_tier_limits(&PlanId::new("nope"), &TierId::new("tier-pro"), set));
    }
}
