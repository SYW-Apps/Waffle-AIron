//! Plan Orchestrator (Orchestrator stereotype): coordinates plan catalog
//! workflows — create/update plans, tiers, and per-tier limits. Delegates
//! persistence to the plan repository facade.

use std::sync::Arc;

use async_trait::async_trait;

use crate::domain::{PlanId, TierId};

use super::model::{LimitSet, Plan, SubscriptionError};
use super::plan_repository::PlanRepository;

#[async_trait]
pub trait PlanOrchestrator: Send + Sync {
    async fn create_plan(&self, plan: Plan) -> Result<Plan, SubscriptionError>;
    async fn get_plan(&self, id: &PlanId) -> Result<Plan, SubscriptionError>;
    async fn list_plans(&self) -> Result<Vec<Plan>, SubscriptionError>;
    async fn update_tier_limits(
        &self,
        plan_id: &PlanId,
        tier_id: &TierId,
        limits: LimitSet,
    ) -> Result<Plan, SubscriptionError>;
}

pub struct PlanOrchestratorImpl {
    repository: Arc<dyn PlanRepository>,
}

impl PlanOrchestratorImpl {
    pub fn new(repository: Arc<dyn PlanRepository>) -> Self {
        Self { repository }
    }

    /// Validate a plan: non-empty tiers, each tier carrying a stripe_price_id.
    fn validate(plan: &Plan) -> Result<(), SubscriptionError> {
        if plan.tiers.is_empty() {
            return Err(SubscriptionError::InvalidTier("plan has no tiers".into()));
        }
        if plan.tiers.iter().any(|t| t.stripe_price_id.trim().is_empty()) {
            return Err(SubscriptionError::InvalidTier(
                "every tier needs a stripe_price_id".into(),
            ));
        }
        Ok(())
    }
}

#[async_trait]
impl PlanOrchestrator for PlanOrchestratorImpl {
    async fn create_plan(&self, plan: Plan) -> Result<Plan, SubscriptionError> {
        // Step 1: Validate the plan (non-empty tiers, each tier has a stripe_price_id).
        Self::validate(&plan)?;
        // Step 2: Persist the plan.
        self.repository.save_plan(plan.clone()).await?;
        // Step 3: Return the created plan.
        Ok(plan)
    }

    async fn get_plan(&self, id: &PlanId) -> Result<Plan, SubscriptionError> {
        // Step 1: Find the plan by id.
        let plan = self.repository.find_plan(id).await?;
        // Step 2: Return it or SubscriptionError::NotFound.
        plan.ok_or_else(|| SubscriptionError::NotFound(id.to_string()))
    }

    async fn list_plans(&self) -> Result<Vec<Plan>, SubscriptionError> {
        // Step 1: List all plans.
        let plans = self.repository.list_plans().await?;
        // Step 2: Return the list.
        Ok(plans)
    }

    async fn update_tier_limits(
        &self,
        plan_id: &PlanId,
        tier_id: &TierId,
        limits: LimitSet,
    ) -> Result<Plan, SubscriptionError> {
        // Step 1: Apply the tier limit update.
        self.repository
            .update_tier_limits(plan_id, tier_id, limits)
            .await?;
        // Step 2: Re-read the plan to return the refreshed view.
        let plan = self.repository.find_plan(plan_id).await?;
        // Step 3: Return the refreshed plan or NotFound.
        plan.ok_or_else(|| SubscriptionError::NotFound(plan_id.to_string()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::subscriptions::model::Tier;
    use crate::subscriptions::test_support::MockPlanRepository;

    fn tier() -> Tier {
        Tier {
            id: TierId::new("tier-pro"),
            name: "Pro".into(),
            stripe_price_id: "price_1".into(),
            limits: vec![],
        }
    }

    #[tokio::test]
    async fn create_plan_rejects_empty_tiers() {
        let repo = Arc::new(MockPlanRepository::empty());
        let orch = PlanOrchestratorImpl::new(repo);
        let plan = Plan { id: PlanId::new("p1"), name: "X".into(), active: true, tiers: vec![] };
        assert!(matches!(
            orch.create_plan(plan).await.unwrap_err(),
            SubscriptionError::InvalidTier(_)
        ));
    }

    #[tokio::test]
    async fn create_plan_persists_valid_plan() {
        let repo = Arc::new(MockPlanRepository::empty());
        let orch = PlanOrchestratorImpl::new(repo.clone());
        let plan = Plan { id: PlanId::new("p1"), name: "X".into(), active: true, tiers: vec![tier()] };
        orch.create_plan(plan).await.unwrap();
        assert_eq!(repo.saved_count(), 1);
    }

    #[tokio::test]
    async fn get_unknown_plan_is_not_found() {
        let repo = Arc::new(MockPlanRepository::empty());
        let orch = PlanOrchestratorImpl::new(repo);
        assert!(matches!(
            orch.get_plan(&PlanId::new("nope")).await.unwrap_err(),
            SubscriptionError::NotFound(_)
        ));
    }
}
