//! Subscription Orchestrator (Orchestrator stereotype): coordinates subscription
//! lifecycle — create, change tier, cancel. Validates the target tier against the
//! plan catalog, provisions/reuses the Stripe customer (reading the billing email
//! from accounts via the billing-account client adapter), syncs to Stripe, and
//! persists local state via the subscription repository.

use std::sync::Arc;

use async_trait::async_trait;
use uuid::Uuid;

use crate::domain::{SubscriptionId, TierId};

use super::billing_account_client::BillingAccountClient;
use super::model::{CreateSubscriptionCommand, Subscription, SubscriptionError, SubscriptionStatus};
use super::plan_repository::PlanRepository;
use super::stripe_adapter::StripeAdapter;
use super::subscription_repository::SubscriptionRepository;

#[async_trait]
pub trait SubscriptionOrchestrator: Send + Sync {
    async fn create_subscription(
        &self,
        cmd: CreateSubscriptionCommand,
    ) -> Result<Subscription, SubscriptionError>;
    async fn get_subscription(
        &self,
        id: &SubscriptionId,
    ) -> Result<Subscription, SubscriptionError>;
    async fn change_tier(
        &self,
        id: &SubscriptionId,
        tier_id: TierId,
    ) -> Result<Subscription, SubscriptionError>;
    async fn cancel_subscription(&self, id: &SubscriptionId) -> Result<(), SubscriptionError>;
}

pub struct SubscriptionOrchestratorImpl {
    subscriptions: Arc<dyn SubscriptionRepository>,
    plans: Arc<dyn PlanRepository>,
    stripe: Arc<dyn StripeAdapter>,
    billing_accounts: Arc<dyn BillingAccountClient>,
}

impl SubscriptionOrchestratorImpl {
    pub fn new(
        subscriptions: Arc<dyn SubscriptionRepository>,
        plans: Arc<dyn PlanRepository>,
        stripe: Arc<dyn StripeAdapter>,
        billing_accounts: Arc<dyn BillingAccountClient>,
    ) -> Self {
        Self { subscriptions, plans, stripe, billing_accounts }
    }

    /// Resolve a tier's Stripe price within a plan, or InvalidTier.
    async fn tier_price(
        &self,
        plan_id: &crate::domain::PlanId,
        tier_id: &TierId,
    ) -> Result<String, SubscriptionError> {
        let plan = self
            .plans
            .find_plan(plan_id)
            .await?
            .ok_or_else(|| SubscriptionError::InvalidTier(plan_id.to_string()))?;
        plan.tier(tier_id)
            .map(|t| t.stripe_price_id.clone())
            .ok_or_else(|| SubscriptionError::InvalidTier(tier_id.to_string()))
    }
}

#[async_trait]
impl SubscriptionOrchestrator for SubscriptionOrchestratorImpl {
    async fn create_subscription(
        &self,
        cmd: CreateSubscriptionCommand,
    ) -> Result<Subscription, SubscriptionError> {
        // Steps 1-2: Load the plan, validate the target tier, read its stripe_price_id.
        let price_id = self.tier_price(&cmd.plan_id, &cmd.tier_id).await?;
        // Step 3: Reuse an existing subscription's Stripe customer id if the account already has one.
        let existing = self.subscriptions.find_by_account(&cmd.billing_account_id).await?;
        let stripe_customer_id = match existing.and_then(|s| s.stripe_customer_id) {
            Some(id) => id,
            None => {
                // Step 4: Read the billing email from accounts (Conflict if absent).
                let email = self
                    .billing_accounts
                    .resolve_billing_email(&cmd.billing_account_id)
                    .await?
                    .ok_or_else(|| {
                        SubscriptionError::Conflict("billing account has no billing email".into())
                    })?;
                // Step 5: Create a Stripe customer for that email.
                self.stripe.create_customer(email).await?.stripe_customer_id
            }
        };
        // Step 6: Create the subscription in Stripe for the customer at the tier's price.
        let stripe_sub = self
            .stripe
            .create_subscription(stripe_customer_id.clone(), price_id)
            .await?;
        // Step 7: Assemble the local Subscription.
        let subscription = Subscription {
            id: SubscriptionId::new(Uuid::new_v4().to_string()),
            billing_account_id: cmd.billing_account_id,
            plan_id: cmd.plan_id,
            tier_id: cmd.tier_id,
            stripe_customer_id: Some(stripe_customer_id),
            stripe_subscription_id: Some(stripe_sub.stripe_subscription_id),
            status: stripe_sub.status,
            current_period_end: stripe_sub.current_period_end,
            overrides: vec![],
        };
        // Step 8: Persist the subscription.
        self.subscriptions.save_subscription(subscription.clone()).await?;
        // Step 9: Return the created subscription.
        Ok(subscription)
    }

    async fn get_subscription(
        &self,
        id: &SubscriptionId,
    ) -> Result<Subscription, SubscriptionError> {
        // Step 1: Find the subscription by id.
        let sub = self.subscriptions.find_subscription(id).await?;
        // Step 2: Return it or NotFound.
        sub.ok_or_else(|| SubscriptionError::NotFound(id.to_string()))
    }

    async fn change_tier(
        &self,
        id: &SubscriptionId,
        tier_id: TierId,
    ) -> Result<Subscription, SubscriptionError> {
        // Step 1: Load the current subscription (NotFound if absent).
        let sub = self
            .subscriptions
            .find_subscription(id)
            .await?
            .ok_or_else(|| SubscriptionError::NotFound(id.to_string()))?;
        // Step 2: Resolve the new tier's stripe_price_id (InvalidTier if missing).
        let price_id = self.tier_price(&sub.plan_id, &tier_id).await?;
        let stripe_sub_id = sub
            .stripe_subscription_id
            .clone()
            .ok_or_else(|| SubscriptionError::Conflict("no Stripe subscription linked".into()))?;
        // Step 3: Update the subscription's price in Stripe.
        let stripe_ref = self.stripe.update_subscription(stripe_sub_id, price_id).await?;
        // Step 4: Persist the new tier locally.
        self.subscriptions.set_tier(id, tier_id).await?;
        // Step 5: Persist the status/period returned by Stripe.
        self.subscriptions
            .set_status(id, stripe_ref.status, stripe_ref.current_period_end)
            .await?;
        // Step 6: Re-read and return the updated subscription.
        self.subscriptions
            .find_subscription(id)
            .await?
            .ok_or_else(|| SubscriptionError::NotFound(id.to_string()))
    }

    async fn cancel_subscription(&self, id: &SubscriptionId) -> Result<(), SubscriptionError> {
        // Step 1: Load the subscription (NotFound if absent).
        let sub = self
            .subscriptions
            .find_subscription(id)
            .await?
            .ok_or_else(|| SubscriptionError::NotFound(id.to_string()))?;
        // Step 2: Cancel it in Stripe.
        if let Some(stripe_sub_id) = sub.stripe_subscription_id.clone() {
            self.stripe.cancel_subscription(stripe_sub_id).await?;
        }
        // Step 3: Mark the local subscription Canceled (retaining its period end).
        self.subscriptions
            .set_status(id, SubscriptionStatus::Canceled, sub.current_period_end)
            .await?;
        // Step 4: Return Ok(()).
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::{BillingAccountId, PlanId};
    use crate::subscriptions::model::{Limit, Plan, Tier};
    use crate::subscriptions::plan_repository::PlanRepositoryImpl;
    use crate::subscriptions::subscription_repository::SubscriptionRepositoryImpl;
    use crate::subscriptions::test_support::{
        MockBillingAccountClient, MockPlanDbAdapter, MockStripeAdapter, MockSubscriptionDbAdapter,
    };

    async fn plan_repo() -> Arc<dyn PlanRepository> {
        let repo = PlanRepositoryImpl::with_db(Arc::new(MockPlanDbAdapter::ok()));
        repo.save_plan(Plan {
            id: PlanId::new("plan-1"),
            name: "Std".into(),
            active: true,
            tiers: vec![Tier {
                id: TierId::new("tier-1"),
                name: "Pro".into(),
                stripe_price_id: "price_1".into(),
                limits: vec![Limit { resource: "api_calls".into(), quota: 100, window: "day".into() }],
            }],
        })
        .await
        .unwrap();
        Arc::new(repo)
    }

    #[tokio::test]
    async fn create_subscription_happy_path() {
        let subs: Arc<dyn SubscriptionRepository> =
            Arc::new(SubscriptionRepositoryImpl::with_db(Arc::new(MockSubscriptionDbAdapter::ok())));
        let orch = SubscriptionOrchestratorImpl::new(
            subs.clone(),
            plan_repo().await,
            Arc::new(MockStripeAdapter::ok()),
            Arc::new(MockBillingAccountClient::with_email("billing@acme.com")),
        );
        let cmd = CreateSubscriptionCommand {
            billing_account_id: BillingAccountId::new("ba-1"),
            plan_id: PlanId::new("plan-1"),
            tier_id: TierId::new("tier-1"),
        };
        let sub = orch.create_subscription(cmd).await.unwrap();
        assert_eq!(sub.stripe_customer_id.as_deref(), Some("cus_mock"));
        assert!(sub.stripe_subscription_id.is_some());
    }

    #[tokio::test]
    async fn create_subscription_invalid_tier() {
        let subs: Arc<dyn SubscriptionRepository> =
            Arc::new(SubscriptionRepositoryImpl::with_db(Arc::new(MockSubscriptionDbAdapter::ok())));
        let orch = SubscriptionOrchestratorImpl::new(
            subs,
            plan_repo().await,
            Arc::new(MockStripeAdapter::ok()),
            Arc::new(MockBillingAccountClient::with_email("billing@acme.com")),
        );
        let cmd = CreateSubscriptionCommand {
            billing_account_id: BillingAccountId::new("ba-1"),
            plan_id: PlanId::new("plan-1"),
            tier_id: TierId::new("ghost"),
        };
        assert!(matches!(
            orch.create_subscription(cmd).await.unwrap_err(),
            SubscriptionError::InvalidTier(_)
        ));
    }
}
