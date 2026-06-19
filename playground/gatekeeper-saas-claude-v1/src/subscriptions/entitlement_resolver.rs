//! Entitlement Resolver (Specialist stereotype): resolves the effective limit
//! set for a subscription by merging its plan/tier limits with subscription-level
//! overrides. This is the published read capability the gatekeeping subsystem
//! consumes to learn a subscription's limits.

use std::sync::Arc;

use async_trait::async_trait;

use crate::domain::{BillingAccountId, SubscriptionId};

use super::model::{merge_limits, Entitlements, Subscription, SubscriptionError};
use super::plan_repository::PlanRepository;
use super::subscription_repository::SubscriptionRepository;

#[async_trait]
pub trait EntitlementResolver: Send + Sync {
    async fn resolve(&self, id: &SubscriptionId) -> Result<Entitlements, SubscriptionError>;
    async fn resolve_for_account(
        &self,
        id: &BillingAccountId,
    ) -> Result<Entitlements, SubscriptionError>;
}

pub struct EntitlementResolverImpl {
    plans: Arc<dyn PlanRepository>,
    subscriptions: Arc<dyn SubscriptionRepository>,
}

impl EntitlementResolverImpl {
    pub fn new(
        plans: Arc<dyn PlanRepository>,
        subscriptions: Arc<dyn SubscriptionRepository>,
    ) -> Self {
        Self { plans, subscriptions }
    }

    /// Read the subscription's tier limits and merge with its overrides into the
    /// effective Entitlements (shared by both resolve entrypoints).
    async fn build_entitlements(
        &self,
        sub: Subscription,
    ) -> Result<Entitlements, SubscriptionError> {
        let tier_limits = self
            .plans
            .find_tier_limits(&sub.plan_id, &sub.tier_id)
            .await?
            .ok_or_else(|| {
                SubscriptionError::InvalidTier(format!("{} / {}", sub.plan_id, sub.tier_id))
            })?;
        let limits = merge_limits(&tier_limits.limits, &sub.overrides);
        Ok(Entitlements {
            subscription_id: sub.id,
            billing_account_id: sub.billing_account_id,
            status: sub.status,
            limits,
        })
    }
}

#[async_trait]
impl EntitlementResolver for EntitlementResolverImpl {
    async fn resolve(&self, id: &SubscriptionId) -> Result<Entitlements, SubscriptionError> {
        // Step 1: Load the subscription by id (NotFound if absent).
        let sub = self
            .subscriptions
            .find_subscription(id)
            .await?
            .ok_or_else(|| SubscriptionError::NotFound(id.to_string()))?;
        // Steps 2-4: Read the tier's limit set, merge with overrides, build Entitlements.
        self.build_entitlements(sub).await
    }

    async fn resolve_for_account(
        &self,
        id: &BillingAccountId,
    ) -> Result<Entitlements, SubscriptionError> {
        // Step 1: Find the billing account's subscription (NotFound if absent).
        let sub = self
            .subscriptions
            .find_by_account(id)
            .await?
            .ok_or_else(|| SubscriptionError::NotFound(id.to_string()))?;
        // Steps 2-4: Read the tier's limit set, merge with overrides, build Entitlements.
        self.build_entitlements(sub).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::{PlanId, TierId};
    use crate::subscriptions::model::{Limit, Plan, SubscriptionStatus, Tier};
    use crate::subscriptions::plan_repository::PlanRepositoryImpl;
    use crate::subscriptions::plan_store::{InMemoryPlanStore, PlanStore};
    use crate::subscriptions::test_support::{MockPlanDbAdapter, StaticSubscriptionRepository};

    #[tokio::test]
    async fn merges_tier_limits_with_overrides() {
        // Plan repo seeded with a tier carrying a base limit.
        let store = Arc::new(InMemoryPlanStore::new());
        store.insert(Plan {
            id: PlanId::new("plan-1"),
            name: "Std".into(),
            active: true,
            tiers: vec![Tier {
                id: TierId::new("tier-1"),
                name: "Pro".into(),
                stripe_price_id: "price_1".into(),
                limits: vec![Limit { resource: "api_calls".into(), quota: 100, window: "day".into() }],
            }],
        });
        let plans: Arc<dyn PlanRepository> = {
            // Build a repository whose index reads the seeded store.
            let db = Arc::new(MockPlanDbAdapter::ok());
            let repo = PlanRepositoryImpl::with_db(db);
            // with_db builds its own empty store, so instead seed via save:
            repo.save_plan(store.get(&PlanId::new("plan-1")).unwrap()).await.unwrap();
            Arc::new(repo)
        };
        let sub = Subscription {
            id: SubscriptionId::new("sub-1"),
            billing_account_id: BillingAccountId::new("ba-1"),
            plan_id: PlanId::new("plan-1"),
            tier_id: TierId::new("tier-1"),
            stripe_customer_id: None,
            stripe_subscription_id: None,
            status: SubscriptionStatus::Active,
            current_period_end: "2026-07-01T00:00:00Z".into(),
            overrides: vec![Limit { resource: "api_calls".into(), quota: 5000, window: "day".into() }],
        };
        let subs: Arc<dyn SubscriptionRepository> =
            Arc::new(StaticSubscriptionRepository::with_subscription(sub));
        let resolver = EntitlementResolverImpl::new(plans, subs);
        let ent = resolver.resolve(&SubscriptionId::new("sub-1")).await.unwrap();
        assert_eq!(ent.limits.iter().find(|l| l.resource == "api_calls").unwrap().quota, 5000);
    }
}
