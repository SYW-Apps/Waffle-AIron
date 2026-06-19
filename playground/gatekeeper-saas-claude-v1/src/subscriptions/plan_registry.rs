//! Plan Registry (Registry stereotype): write path for the Plan aggregate.
//! Applies mutations to the store and persists via the Postgres adapter.

use std::sync::Arc;

use async_trait::async_trait;

use crate::domain::{PlanId, TierId};

use super::model::{LimitSet, Plan, SubscriptionError};
use super::plan_db_adapter::PlanDbAdapter;
use super::plan_store::PlanStore;

#[async_trait]
pub trait PlanRegistry: Send + Sync {
    async fn create_plan(&self, plan: Plan) -> Result<(), SubscriptionError>;
    async fn update_tier_limits(
        &self,
        plan_id: &PlanId,
        tier_id: &TierId,
        limits: LimitSet,
    ) -> Result<(), SubscriptionError>;
}

pub struct PlanRegistryImpl {
    store: Arc<dyn PlanStore>,
    db: Arc<dyn PlanDbAdapter>,
}

impl PlanRegistryImpl {
    pub fn new(store: Arc<dyn PlanStore>, db: Arc<dyn PlanDbAdapter>) -> Self {
        Self { store, db }
    }
}

#[async_trait]
impl PlanRegistry for PlanRegistryImpl {
    async fn create_plan(&self, plan: Plan) -> Result<(), SubscriptionError> {
        // Step 1: Insert the plan into the store.
        self.store.insert(plan.clone());
        // Step 2: Persist the plan (tiers + limits) to Postgres.
        self.db.upsert_plan(&plan).await?;
        // Step 3: Return Ok(()).
        Ok(())
    }

    async fn update_tier_limits(
        &self,
        plan_id: &PlanId,
        tier_id: &TierId,
        limits: LimitSet,
    ) -> Result<(), SubscriptionError> {
        // Step 1: Apply the tier limits change in the store (NotFound if plan/tier absent).
        if !self.store.apply_tier_limits(plan_id, tier_id, limits) {
            return Err(SubscriptionError::NotFound(format!(
                "plan {plan_id} tier {tier_id}"
            )));
        }
        // Step 2: Read back the updated plan.
        let plan = self
            .store
            .get(plan_id)
            .ok_or_else(|| SubscriptionError::NotFound(plan_id.to_string()))?;
        // Step 3: Persist the updated plan.
        self.db.upsert_plan(&plan).await?;
        // Step 4: Return Ok(()).
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::subscriptions::model::{Limit, Tier};
    use crate::subscriptions::plan_store::InMemoryPlanStore;
    use crate::subscriptions::test_support::MockPlanDbAdapter;

    fn plan() -> Plan {
        Plan {
            id: PlanId::new("plan-1"),
            name: "Standard".into(),
            active: true,
            tiers: vec![Tier {
                id: TierId::new("tier-pro"),
                name: "Pro".into(),
                stripe_price_id: "price_1".into(),
                limits: vec![Limit { resource: "api_calls".into(), quota: 100, window: "day".into() }],
            }],
        }
    }

    #[tokio::test]
    async fn create_plan_inserts_then_persists() {
        let store = Arc::new(InMemoryPlanStore::new());
        let db = Arc::new(MockPlanDbAdapter::ok());
        let registry = PlanRegistryImpl::new(store.clone(), db.clone());
        registry.create_plan(plan()).await.unwrap();
        assert!(store.get(&PlanId::new("plan-1")).is_some());
        assert_eq!(db.upsert_calls(), 1);
    }

    #[tokio::test]
    async fn update_missing_tier_is_not_found_and_skips_persist() {
        let store = Arc::new(InMemoryPlanStore::new());
        store.insert(plan());
        let db = Arc::new(MockPlanDbAdapter::ok());
        let registry = PlanRegistryImpl::new(store, db.clone());
        let set = LimitSet { limits: vec![] };
        let err = registry
            .update_tier_limits(&PlanId::new("plan-1"), &TierId::new("ghost"), set)
            .await
            .unwrap_err();
        assert!(matches!(err, SubscriptionError::NotFound(_)));
        assert_eq!(db.upsert_calls(), 0);
    }
}
