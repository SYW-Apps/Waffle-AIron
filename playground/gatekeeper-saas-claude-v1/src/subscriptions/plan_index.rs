//! Plan Index (Index stereotype): read path projecting the plan store. Never
//! mutates.

use std::sync::Arc;

use crate::domain::{PlanId, TierId};

use super::model::{LimitSet, Plan};
use super::plan_store::PlanStore;

pub trait PlanIndex: Send + Sync {
    fn find_plan(&self, id: &PlanId) -> Option<Plan>;
    fn list_plans(&self) -> Vec<Plan>;
    fn find_tier_limits(&self, plan_id: &PlanId, tier_id: &TierId) -> Option<LimitSet>;
}

pub struct PlanIndexImpl {
    store: Arc<dyn PlanStore>,
}

impl PlanIndexImpl {
    pub fn new(store: Arc<dyn PlanStore>) -> Self {
        Self { store }
    }
}

impl PlanIndex for PlanIndexImpl {
    fn find_plan(&self, id: &PlanId) -> Option<Plan> {
        // Step 1: Read the plan from the store by id.
        let plan = self.store.get(id);
        // Step 2: Return the result.
        plan
    }

    fn list_plans(&self) -> Vec<Plan> {
        // Step 1: Read all plans from the store.
        let plans = self.store.list();
        // Step 2: Return the list.
        plans
    }

    fn find_tier_limits(&self, plan_id: &PlanId, tier_id: &TierId) -> Option<LimitSet> {
        // Step 1: Read the plan from the store.
        let plan = self.store.get(plan_id)?;
        // Step 2: Locate the tier by id and return its LimitSet, or None.
        plan.tier(tier_id).map(|t| LimitSet {
            limits: t.limits.clone(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::subscriptions::model::{Limit, Tier};
    use crate::subscriptions::plan_store::InMemoryPlanStore;

    fn store_with_plan() -> Arc<dyn PlanStore> {
        let store = InMemoryPlanStore::new();
        store.insert(Plan {
            id: PlanId::new("plan-1"),
            name: "Standard".into(),
            active: true,
            tiers: vec![Tier {
                id: TierId::new("tier-pro"),
                name: "Pro".into(),
                stripe_price_id: "price_1".into(),
                limits: vec![Limit { resource: "api_calls".into(), quota: 100, window: "day".into() }],
            }],
        });
        Arc::new(store)
    }

    #[test]
    fn finds_plan_and_tier_limits() {
        let index = PlanIndexImpl::new(store_with_plan());
        assert!(index.find_plan(&PlanId::new("plan-1")).is_some());
        assert_eq!(index.list_plans().len(), 1);
        let limits = index
            .find_tier_limits(&PlanId::new("plan-1"), &TierId::new("tier-pro"))
            .unwrap();
        assert_eq!(limits.limits[0].quota, 100);
        assert!(index
            .find_tier_limits(&PlanId::new("plan-1"), &TierId::new("missing"))
            .is_none());
    }
}
