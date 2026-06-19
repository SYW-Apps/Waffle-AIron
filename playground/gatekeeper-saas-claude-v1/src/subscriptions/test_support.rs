//! Test doubles for the subscriptions subsystem.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;

use async_trait::async_trait;

use crate::domain::{BillingAccountId, DbError, Email, PlanId, SubscriptionId, TierId};

use super::billing_account_client::BillingAccountClient;
use super::entitlement_resolver::EntitlementResolver;
use super::model::{
    CreateSubscriptionCommand, Entitlements, LimitSet, Plan, StripeCustomerRef, StripeEvent,
    StripeSubscriptionRef, Subscription, SubscriptionError, SubscriptionStatus,
};
use super::plan_db_adapter::PlanDbAdapter;
use super::plan_orchestrator::PlanOrchestrator;
use super::plan_repository::PlanRepository;
use super::stripe_adapter::StripeAdapter;
use super::subscription_db_adapter::SubscriptionDbAdapter;
use super::subscription_orchestrator::SubscriptionOrchestrator;
use super::subscription_repository::SubscriptionRepository;

// --- Plan db adapter double ---

pub struct MockPlanDbAdapter {
    upserts: AtomicUsize,
}

impl MockPlanDbAdapter {
    pub fn ok() -> Self {
        Self { upserts: AtomicUsize::new(0) }
    }
    pub fn upsert_calls(&self) -> usize {
        self.upserts.load(Ordering::SeqCst)
    }
}

#[async_trait]
impl PlanDbAdapter for MockPlanDbAdapter {
    async fn load_plan(&self, _id: &PlanId) -> Result<Option<Plan>, DbError> {
        Ok(None)
    }
    async fn load_all_plans(&self) -> Result<Vec<Plan>, DbError> {
        Ok(vec![])
    }
    async fn upsert_plan(&self, _plan: &Plan) -> Result<(), DbError> {
        self.upserts.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }
}

// --- Subscription db adapter double ---

pub struct MockSubscriptionDbAdapter {
    duplicate_event: bool,
    upserts: AtomicUsize,
}

impl MockSubscriptionDbAdapter {
    pub fn ok() -> Self {
        Self { duplicate_event: false, upserts: AtomicUsize::new(0) }
    }
    pub fn with_duplicate_event() -> Self {
        Self { duplicate_event: true, upserts: AtomicUsize::new(0) }
    }
    pub fn upsert_calls(&self) -> usize {
        self.upserts.load(Ordering::SeqCst)
    }
}

#[async_trait]
impl SubscriptionDbAdapter for MockSubscriptionDbAdapter {
    async fn load_subscription(
        &self,
        _id: &SubscriptionId,
    ) -> Result<Option<Subscription>, DbError> {
        Ok(None)
    }
    async fn load_by_account(
        &self,
        _id: &BillingAccountId,
    ) -> Result<Option<Subscription>, DbError> {
        Ok(None)
    }
    async fn upsert_subscription(&self, _sub: &Subscription) -> Result<(), DbError> {
        self.upserts.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }
    async fn insert_processed_event(
        &self,
        _event_id: String,
        _subscription_id: SubscriptionId,
    ) -> Result<bool, DbError> {
        Ok(!self.duplicate_event)
    }
}

// --- Plan repository double ---

pub struct MockPlanRepository {
    saved: AtomicUsize,
}

impl MockPlanRepository {
    pub fn empty() -> Self {
        Self { saved: AtomicUsize::new(0) }
    }
    pub fn saved_count(&self) -> usize {
        self.saved.load(Ordering::SeqCst)
    }
}

#[async_trait]
impl PlanRepository for MockPlanRepository {
    async fn save_plan(&self, _plan: Plan) -> Result<(), SubscriptionError> {
        self.saved.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }
    async fn update_tier_limits(
        &self,
        _plan_id: &PlanId,
        _tier_id: &TierId,
        _limits: LimitSet,
    ) -> Result<(), SubscriptionError> {
        Ok(())
    }
    async fn find_plan(&self, _id: &PlanId) -> Result<Option<Plan>, SubscriptionError> {
        Ok(None)
    }
    async fn list_plans(&self) -> Result<Vec<Plan>, SubscriptionError> {
        Ok(vec![])
    }
    async fn find_tier_limits(
        &self,
        _plan_id: &PlanId,
        _tier_id: &TierId,
    ) -> Result<Option<LimitSet>, SubscriptionError> {
        Ok(None)
    }
}

// --- Subscription repository double seeded with one subscription ---

pub struct StaticSubscriptionRepository {
    subscription: Mutex<Option<Subscription>>,
}

impl StaticSubscriptionRepository {
    pub fn with_subscription(sub: Subscription) -> Self {
        Self { subscription: Mutex::new(Some(sub)) }
    }
}

#[async_trait]
impl SubscriptionRepository for StaticSubscriptionRepository {
    async fn save_subscription(&self, sub: Subscription) -> Result<(), SubscriptionError> {
        *self.subscription.lock().unwrap() = Some(sub);
        Ok(())
    }
    async fn set_tier(&self, _id: &SubscriptionId, _tier_id: TierId) -> Result<(), SubscriptionError> {
        Ok(())
    }
    async fn set_status(
        &self,
        _id: &SubscriptionId,
        _status: SubscriptionStatus,
        _current_period_end: String,
    ) -> Result<(), SubscriptionError> {
        Ok(())
    }
    async fn mark_event_processed(
        &self,
        _id: &SubscriptionId,
        _event_id: String,
        _status: SubscriptionStatus,
        _current_period_end: String,
    ) -> Result<bool, SubscriptionError> {
        Ok(true)
    }
    async fn find_subscription(
        &self,
        id: &SubscriptionId,
    ) -> Result<Option<Subscription>, SubscriptionError> {
        Ok(self
            .subscription
            .lock()
            .unwrap()
            .clone()
            .filter(|s| &s.id == id))
    }
    async fn find_by_account(
        &self,
        id: &BillingAccountId,
    ) -> Result<Option<Subscription>, SubscriptionError> {
        Ok(self
            .subscription
            .lock()
            .unwrap()
            .clone()
            .filter(|s| &s.billing_account_id == id))
    }
    async fn is_event_processed(&self, _event_id: &str) -> Result<bool, SubscriptionError> {
        Ok(false)
    }
}

// --- Billing account client double ---

pub struct MockBillingAccountClient {
    email: Option<Email>,
}

impl MockBillingAccountClient {
    pub fn with_email(addr: &str) -> Self {
        Self { email: Some(Email::parse(addr).unwrap()) }
    }
    pub fn without_email() -> Self {
        Self { email: None }
    }
}

#[async_trait]
impl BillingAccountClient for MockBillingAccountClient {
    async fn resolve_billing_email(
        &self,
        _id: &BillingAccountId,
    ) -> Result<Option<Email>, SubscriptionError> {
        Ok(self.email.clone())
    }
}

// --- Stripe adapter double ---

pub struct MockStripeAdapter;

impl MockStripeAdapter {
    pub fn ok() -> Self {
        Self
    }
    pub fn with_event(_payload: &str) -> Self {
        Self
    }
}

#[async_trait]
impl StripeAdapter for MockStripeAdapter {
    async fn create_customer(&self, _email: Email) -> Result<StripeCustomerRef, crate::domain::StripeError> {
        Ok(StripeCustomerRef { stripe_customer_id: "cus_mock".into() })
    }
    async fn create_subscription(
        &self,
        _stripe_customer_id: String,
        _price_id: String,
    ) -> Result<StripeSubscriptionRef, crate::domain::StripeError> {
        Ok(StripeSubscriptionRef {
            stripe_subscription_id: "ss_mock".into(),
            status: SubscriptionStatus::Active,
            current_period_end: "2026-07-01T00:00:00Z".into(),
        })
    }
    async fn update_subscription(
        &self,
        _stripe_subscription_id: String,
        _price_id: String,
    ) -> Result<StripeSubscriptionRef, crate::domain::StripeError> {
        Ok(StripeSubscriptionRef {
            stripe_subscription_id: "ss_mock".into(),
            status: SubscriptionStatus::Active,
            current_period_end: "2026-08-01T00:00:00Z".into(),
        })
    }
    async fn cancel_subscription(
        &self,
        _stripe_subscription_id: String,
    ) -> Result<(), crate::domain::StripeError> {
        Ok(())
    }
    fn verify_and_parse_event(
        &self,
        raw_body: Vec<u8>,
        _signature: String,
    ) -> Result<StripeEvent, crate::domain::StripeError> {
        let body = String::from_utf8(raw_body)
            .map_err(|e| crate::domain::StripeError::Parse(e.to_string()))?;
        let value: serde_json::Value = serde_json::from_str(&body)
            .map_err(|e| crate::domain::StripeError::Parse(e.to_string()))?;
        Ok(StripeEvent {
            id: value.get("id").and_then(|v| v.as_str()).unwrap_or("evt").to_string(),
            kind: value.get("type").and_then(|v| v.as_str()).unwrap_or("").to_string(),
            payload: body,
        })
    }
}

// --- Entitlement resolver double (for portal tests) ---

#[derive(Default)]
pub struct MockEntitlementResolver;

#[async_trait]
impl EntitlementResolver for MockEntitlementResolver {
    async fn resolve(&self, id: &SubscriptionId) -> Result<Entitlements, SubscriptionError> {
        Err(SubscriptionError::NotFound(id.to_string()))
    }
    async fn resolve_for_account(
        &self,
        id: &BillingAccountId,
    ) -> Result<Entitlements, SubscriptionError> {
        Err(SubscriptionError::NotFound(id.to_string()))
    }
}

// --- Orchestrator doubles (for portal tests) ---

#[derive(Default)]
pub struct MockPlanOrchestrator;

#[async_trait]
impl PlanOrchestrator for MockPlanOrchestrator {
    async fn create_plan(&self, plan: Plan) -> Result<Plan, SubscriptionError> {
        Ok(plan)
    }
    async fn get_plan(&self, id: &PlanId) -> Result<Plan, SubscriptionError> {
        Err(SubscriptionError::NotFound(id.to_string()))
    }
    async fn list_plans(&self) -> Result<Vec<Plan>, SubscriptionError> {
        Ok(vec![])
    }
    async fn update_tier_limits(
        &self,
        plan_id: &PlanId,
        _tier_id: &TierId,
        _limits: LimitSet,
    ) -> Result<Plan, SubscriptionError> {
        Err(SubscriptionError::NotFound(plan_id.to_string()))
    }
}

#[derive(Default)]
pub struct MockSubscriptionOrchestrator;

#[async_trait]
impl SubscriptionOrchestrator for MockSubscriptionOrchestrator {
    async fn create_subscription(
        &self,
        cmd: CreateSubscriptionCommand,
    ) -> Result<Subscription, SubscriptionError> {
        Ok(Subscription {
            id: SubscriptionId::new("sub-mock"),
            billing_account_id: cmd.billing_account_id,
            plan_id: cmd.plan_id,
            tier_id: cmd.tier_id,
            stripe_customer_id: Some("cus_mock".into()),
            stripe_subscription_id: Some("ss_mock".into()),
            status: SubscriptionStatus::Active,
            current_period_end: "2026-07-01T00:00:00Z".into(),
            overrides: vec![],
        })
    }
    async fn get_subscription(
        &self,
        id: &SubscriptionId,
    ) -> Result<Subscription, SubscriptionError> {
        Err(SubscriptionError::NotFound(id.to_string()))
    }
    async fn change_tier(
        &self,
        id: &SubscriptionId,
        _tier_id: TierId,
    ) -> Result<Subscription, SubscriptionError> {
        Err(SubscriptionError::NotFound(id.to_string()))
    }
    async fn cancel_subscription(&self, _id: &SubscriptionId) -> Result<(), SubscriptionError> {
        Ok(())
    }
}
