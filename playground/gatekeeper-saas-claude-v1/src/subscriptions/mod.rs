//! Subscriptions subsystem: owns plans, tiers, per-tier limits/entitlements,
//! and all Stripe state. Syncs subscriptions with Stripe, ingests webhooks, and
//! publishes resolved entitlements to the gatekeeping subsystem.

pub mod billing_account_client;
pub mod entitlement_resolver;
pub mod model;
pub mod plan_db_adapter;
pub mod plan_index;
pub mod plan_orchestrator;
pub mod plan_registry;
pub mod plan_repository;
pub mod plan_store;
pub mod portal;
pub mod stripe_adapter;
pub mod stripe_event_orchestrator;
pub mod stripe_webhook_portal;
pub mod subscription_db_adapter;
pub mod subscription_index;
pub mod subscription_orchestrator;
pub mod subscription_registry;
pub mod subscription_repository;
pub mod subscription_store;

#[cfg(test)]
pub mod test_support;

use std::sync::Arc;

use crate::accounts::portal::AccountsPortalApi;

use billing_account_client::BillingAccountClientAdapter;
use entitlement_resolver::EntitlementResolverImpl;
use plan_orchestrator::PlanOrchestratorImpl;
use plan_repository::{PlanRepository, PlanRepositoryImpl};
use portal::{SubscriptionsPortal, SubscriptionsPortalApi};
use stripe_adapter::{StripeAdapter, StripeHttpAdapter};
use stripe_event_orchestrator::StripeEventOrchestratorImpl;
use stripe_webhook_portal::StripeWebhookPortal;
use subscription_orchestrator::SubscriptionOrchestratorImpl;
use subscription_repository::{SubscriptionRepository, SubscriptionRepositoryImpl};

/// Configuration for the Stripe integration.
pub struct StripeConfig {
    pub api_key: String,
    pub signing_secret: String,
}

/// Wired subscriptions subsystem: the HTTP router (management + webhook) plus the
/// published Portal surface (the front door) consumed by gatekeeping.
pub struct SubscriptionsSubsystem {
    pub router: axum::Router,
    pub portal: Arc<dyn SubscriptionsPortalApi>,
}

impl SubscriptionsSubsystem {
    pub fn new(
        pool: sqlx::PgPool,
        accounts_portal: Arc<dyn AccountsPortalApi>,
        stripe: StripeConfig,
    ) -> Self {
        let plans: Arc<dyn PlanRepository> = Arc::new(PlanRepositoryImpl::from_pool(pool.clone()));
        let subscriptions: Arc<dyn SubscriptionRepository> =
            Arc::new(SubscriptionRepositoryImpl::from_pool(pool));
        let stripe_adapter: Arc<dyn StripeAdapter> =
            Arc::new(StripeHttpAdapter::new(stripe.api_key, stripe.signing_secret));
        let billing_client = Arc::new(BillingAccountClientAdapter::new(accounts_portal));

        let plan_orch = Arc::new(PlanOrchestratorImpl::new(plans.clone()));
        let sub_orch = Arc::new(SubscriptionOrchestratorImpl::new(
            subscriptions.clone(),
            plans.clone(),
            stripe_adapter.clone(),
            billing_client,
        ));
        let event_orch = Arc::new(StripeEventOrchestratorImpl::new(
            subscriptions.clone(),
            stripe_adapter,
        ));
        let entitlements = Arc::new(EntitlementResolverImpl::new(plans, subscriptions));

        let portal = SubscriptionsPortal::new(plan_orch, sub_orch, entitlements);
        let portal_api: Arc<dyn SubscriptionsPortalApi> = Arc::new(portal.clone());
        let router = portal
            .router()
            .merge(StripeWebhookPortal::new(event_orch).router());

        Self { router, portal: portal_api }
    }
}
