//! Shared composition harness for system-level tests.
//!
//! Wires all five real subsystems together using their public constructors, with
//! fake implementations standing in only for the *external* I/O boundaries
//! (Postgres, Redis, Stripe, email). Every cross-subsystem client adapter,
//! orchestrator, store, index, registry, repository, the gate spine, and the
//! event bus are the real production types — so these tests validate the actual
//! topology and contracts, not mocks of them.

#![allow(dead_code)]

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use tokio::sync::broadcast;

use gatekeeper_saas::accounts::account_db_adapter::AccountDbAdapter;
use gatekeeper_saas::accounts::account_directory::{AccountDirectory, AccountDirectoryImpl};
use gatekeeper_saas::accounts::account_orchestrator::{AccountOrchestrator, AccountOrchestratorImpl};
use gatekeeper_saas::accounts::account_repository::AccountRepositoryImpl;
use gatekeeper_saas::accounts::model::Account;
use gatekeeper_saas::accounts::portal::{AccountsPortal, AccountsPortalApi};

use gatekeeper_saas::subscriptions::billing_account_client::BillingAccountClientAdapter;
use gatekeeper_saas::subscriptions::entitlement_resolver::{
    EntitlementResolver, EntitlementResolverImpl,
};
use gatekeeper_saas::subscriptions::model::{
    Plan, StripeCustomerRef, StripeEvent, StripeSubscriptionRef, SubscriptionStatus,
};
use gatekeeper_saas::subscriptions::plan_db_adapter::PlanDbAdapter;
use gatekeeper_saas::subscriptions::plan_orchestrator::{PlanOrchestrator, PlanOrchestratorImpl};
use gatekeeper_saas::subscriptions::plan_repository::PlanRepositoryImpl;
use gatekeeper_saas::subscriptions::portal::{SubscriptionsPortal, SubscriptionsPortalApi};
use gatekeeper_saas::subscriptions::stripe_adapter::StripeAdapter;
use gatekeeper_saas::subscriptions::subscription_db_adapter::SubscriptionDbAdapter;
use gatekeeper_saas::subscriptions::subscription_orchestrator::{
    SubscriptionOrchestrator, SubscriptionOrchestratorImpl,
};
use gatekeeper_saas::subscriptions::subscription_repository::SubscriptionRepositoryImpl;

use gatekeeper_saas::metering::model::{
    ConsumeOutcome, CounterSnapshot, MeteringError, UsageRollup,
};
use gatekeeper_saas::metering::portal::{MeteringPortal, MeteringPortalApi};
use gatekeeper_saas::metering::redis_counter_adapter::CounterAdapter;
use gatekeeper_saas::metering::usage_event_adapter::{BroadcastUsageEventAdapter, UsageEventBus};
use gatekeeper_saas::metering::usage_meter::{UsageMeter, UsageMeterImpl};
use gatekeeper_saas::metering::usage_query::UsageQueryImpl;
use gatekeeper_saas::metering::usage_rollup_db_adapter::UsageRollupDbAdapter;
use gatekeeper_saas::metering::usage_rollup_repository::UsageRollupRepositoryImpl;

use gatekeeper_saas::gatekeeping::api_key_authenticator::ApiKeyAuthenticatorImpl;
use gatekeeper_saas::gatekeeping::audit_adapter::AuditAdapter;
use gatekeeper_saas::gatekeeping::credential_db_adapter::CredentialDbAdapter;
use gatekeeper_saas::gatekeeping::credential_orchestrator::{
    CredentialOrchestrator, CredentialOrchestratorImpl,
};
use gatekeeper_saas::gatekeeping::credential_repository::CredentialRepositoryImpl;
use gatekeeper_saas::gatekeeping::gate_orchestrator::{GateOrchestrator, GateOrchestratorImpl};
use gatekeeper_saas::gatekeeping::metering_client::MeteringClientAdapter;
use gatekeeper_saas::gatekeeping::model::{ApiKey, DecisionAuditRecord, GateError};
use gatekeeper_saas::gatekeeping::portal::GatekeepingPortal;
use gatekeeper_saas::gatekeeping::subscriptions_client::SubscriptionsClientAdapter;

use gatekeeper_saas::notifications::accounts_client::AccountsClientAdapter;
use gatekeeper_saas::notifications::email_adapter::EmailAdapter;
use gatekeeper_saas::notifications::model::{NotificationError, NotificationMessage, NotificationRecord};
use gatekeeper_saas::notifications::notification_log_adapter::NotificationLogAdapter;
use gatekeeper_saas::notifications::notification_orchestrator::NotificationOrchestratorImpl;
use gatekeeper_saas::notifications::usage_event_observer::{
    UsageEventObserver, UsageEventObserverImpl,
};

use gatekeeper_saas::domain::{
    ApiKeyId, BillingAccountId, DbError, Email, StripeError, SubscriptionId,
};

// ---------------------------------------------------------------------------
// Fake external-boundary adapters (the only things mocked).
// ---------------------------------------------------------------------------

/// No-op Postgres adapters: the authoritative in-memory stores inside each
/// repository carry state for the test; persistence is a successful no-op.
pub struct NoopAccountDb;
#[async_trait]
impl AccountDbAdapter for NoopAccountDb {
    async fn load_account(&self, _id: &BillingAccountId) -> Result<Option<Account>, DbError> {
        Ok(None)
    }
    async fn upsert_account(&self, _account: &Account) -> Result<(), DbError> {
        Ok(())
    }
    async fn delete_account(&self, _id: &BillingAccountId) -> Result<(), DbError> {
        Ok(())
    }
}

pub struct NoopPlanDb;
#[async_trait]
impl PlanDbAdapter for NoopPlanDb {
    async fn load_plan(&self, _id: &gatekeeper_saas::domain::PlanId) -> Result<Option<Plan>, DbError> {
        Ok(None)
    }
    async fn load_all_plans(&self) -> Result<Vec<Plan>, DbError> {
        Ok(vec![])
    }
    async fn upsert_plan(&self, _plan: &Plan) -> Result<(), DbError> {
        Ok(())
    }
}

pub struct NoopSubscriptionDb;
#[async_trait]
impl SubscriptionDbAdapter for NoopSubscriptionDb {
    async fn load_subscription(
        &self,
        _id: &SubscriptionId,
    ) -> Result<Option<gatekeeper_saas::subscriptions::model::Subscription>, DbError> {
        Ok(None)
    }
    async fn load_by_account(
        &self,
        _id: &BillingAccountId,
    ) -> Result<Option<gatekeeper_saas::subscriptions::model::Subscription>, DbError> {
        Ok(None)
    }
    async fn upsert_subscription(
        &self,
        _sub: &gatekeeper_saas::subscriptions::model::Subscription,
    ) -> Result<(), DbError> {
        Ok(())
    }
    async fn insert_processed_event(
        &self,
        _event_id: String,
        _subscription_id: SubscriptionId,
    ) -> Result<bool, DbError> {
        Ok(true)
    }
}

pub struct NoopUsageRollupDb;
#[async_trait]
impl UsageRollupDbAdapter for NoopUsageRollupDb {
    async fn load_rollups(&self, _id: &SubscriptionId) -> Result<Vec<UsageRollup>, DbError> {
        Ok(vec![])
    }
    async fn upsert_rollup(&self, _rollup: &UsageRollup) -> Result<(), DbError> {
        Ok(())
    }
}

pub struct NoopCredentialDb;
#[async_trait]
impl CredentialDbAdapter for NoopCredentialDb {
    async fn load_all(&self) -> Result<Vec<ApiKey>, DbError> {
        Ok(vec![])
    }
    async fn upsert_key(&self, _key: &ApiKey) -> Result<(), DbError> {
        Ok(())
    }
}

/// Fake Stripe: always succeeds, returns Active subscriptions.
pub struct FakeStripe;
#[async_trait]
impl StripeAdapter for FakeStripe {
    async fn create_customer(&self, _email: Email) -> Result<StripeCustomerRef, StripeError> {
        Ok(StripeCustomerRef { stripe_customer_id: "cus_fake".into() })
    }
    async fn create_subscription(
        &self,
        _stripe_customer_id: String,
        _price_id: String,
    ) -> Result<StripeSubscriptionRef, StripeError> {
        Ok(StripeSubscriptionRef {
            stripe_subscription_id: "ss_fake".into(),
            status: SubscriptionStatus::Active,
            current_period_end: "2099-01-01T00:00:00Z".into(),
        })
    }
    async fn update_subscription(
        &self,
        _stripe_subscription_id: String,
        _price_id: String,
    ) -> Result<StripeSubscriptionRef, StripeError> {
        Ok(StripeSubscriptionRef {
            stripe_subscription_id: "ss_fake".into(),
            status: SubscriptionStatus::Active,
            current_period_end: "2099-01-01T00:00:00Z".into(),
        })
    }
    async fn cancel_subscription(&self, _stripe_subscription_id: String) -> Result<(), StripeError> {
        Ok(())
    }
    fn verify_and_parse_event(
        &self,
        raw_body: Vec<u8>,
        _signature: String,
    ) -> Result<StripeEvent, StripeError> {
        let body = String::from_utf8(raw_body).map_err(|e| StripeError::Parse(e.to_string()))?;
        let v: serde_json::Value =
            serde_json::from_str(&body).map_err(|e| StripeError::Parse(e.to_string()))?;
        Ok(StripeEvent {
            id: v.get("id").and_then(|x| x.as_str()).unwrap_or("evt").to_string(),
            kind: v.get("type").and_then(|x| x.as_str()).unwrap_or("").to_string(),
            payload: body,
        })
    }
}

/// In-memory counter mirroring the production Redis semantics (seed/incr/floor
/// with cumulative used; NX threshold flags).
#[derive(Default)]
pub struct FakeCounter {
    map: Mutex<HashMap<String, i64>>,
    flags: Mutex<HashSet<String>>,
}
#[async_trait]
impl CounterAdapter for FakeCounter {
    async fn check_and_decrement(
        &self,
        key: String,
        amount: i64,
        quota: i64,
        _ttl: i64,
    ) -> Result<ConsumeOutcome, MeteringError> {
        let mut map = self.map.lock().unwrap();
        let current = *map.get(&key).unwrap_or(&0);
        let candidate = current + amount;
        if candidate > quota {
            Ok(ConsumeOutcome { allowed: false, used: current, remaining: (quota - current).max(0) })
        } else {
            map.insert(key, candidate);
            Ok(ConsumeOutcome { allowed: true, used: candidate, remaining: (quota - candidate).max(0) })
        }
    }
    async fn get(&self, key: String) -> Result<Option<i64>, MeteringError> {
        Ok(self.map.lock().unwrap().get(&key).copied())
    }
    async fn snapshot_all(&self) -> Result<Vec<CounterSnapshot>, MeteringError> {
        Ok(vec![])
    }
    async fn try_mark_threshold(
        &self,
        key: String,
        threshold: i64,
        _ttl: i64,
    ) -> Result<bool, MeteringError> {
        Ok(self.flags.lock().unwrap().insert(format!("{key}:{threshold}")))
    }
}

/// Recording email adapter — counts sends and remembers the last message.
#[derive(Default)]
pub struct RecordingEmail {
    sent: AtomicUsize,
    last: Mutex<Option<NotificationMessage>>,
}
impl RecordingEmail {
    pub fn sent(&self) -> usize {
        self.sent.load(Ordering::SeqCst)
    }
    pub fn last_to(&self) -> Option<String> {
        self.last.lock().unwrap().as_ref().map(|m| m.to.as_str().to_string())
    }
}
#[async_trait]
impl EmailAdapter for RecordingEmail {
    async fn send(&self, message: NotificationMessage) -> Result<(), NotificationError> {
        *self.last.lock().unwrap() = Some(message);
        self.sent.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }
}

/// Recording audit adapter — counts decisions.
#[derive(Default)]
pub struct RecordingAudit {
    count: AtomicUsize,
}
impl RecordingAudit {
    pub fn count(&self) -> usize {
        self.count.load(Ordering::SeqCst)
    }
}
#[async_trait]
impl AuditAdapter for RecordingAudit {
    async fn record_decision(&self, _record: DecisionAuditRecord) -> Result<(), GateError> {
        self.count.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }
}

/// Recording notification log — counts records and remembers the last status.
#[derive(Default)]
pub struct RecordingNotifLog {
    count: AtomicUsize,
    last_status: Mutex<Option<String>>,
}
impl RecordingNotifLog {
    pub fn count(&self) -> usize {
        self.count.load(Ordering::SeqCst)
    }
    pub fn last_status(&self) -> Option<String> {
        self.last_status.lock().unwrap().clone()
    }
}
#[async_trait]
impl NotificationLogAdapter for RecordingNotifLog {
    async fn record_sent(&self, record: NotificationRecord) -> Result<(), NotificationError> {
        *self.last_status.lock().unwrap() = Some(record.status);
        self.count.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// The fully-wired system under test.
// ---------------------------------------------------------------------------

pub struct System {
    pub accounts: Arc<dyn AccountOrchestrator>,
    pub directory: Arc<dyn AccountDirectory>,
    pub plans: Arc<dyn PlanOrchestrator>,
    pub subscriptions: Arc<dyn SubscriptionOrchestrator>,
    pub credentials: Arc<dyn CredentialOrchestrator>,
    pub gate: Arc<dyn GateOrchestrator>,
    pub observer: Arc<dyn UsageEventObserver>,
    pub bus: UsageEventBus,
    pub email: Arc<RecordingEmail>,
    pub audit: Arc<RecordingAudit>,
    pub notif_log: Arc<RecordingNotifLog>,
    pub entitlements: Arc<dyn EntitlementResolver>,
    pub usage_meter: Arc<dyn UsageMeter>,
}

impl System {
    /// Build the gatekeeping HTTP router over the wired gate + credential orchestrators.
    pub fn gatekeeping_router(&self) -> axum::Router {
        GatekeepingPortal::new(self.gate.clone(), self.credentials.clone()).router()
    }
}

/// Compose the entire system with fakes only at the external boundaries.
pub fn build_system() -> System {
    // accounts
    let account_repo = Arc::new(AccountRepositoryImpl::with_postgres(Arc::new(NoopAccountDb)));
    let directory: Arc<dyn AccountDirectory> =
        Arc::new(AccountDirectoryImpl::new(account_repo.clone()));
    let accounts: Arc<dyn AccountOrchestrator> =
        Arc::new(AccountOrchestratorImpl::new(account_repo));
    // The accounts subsystem's inbound Portal — the front door other subsystems cross into.
    let accounts_portal: Arc<dyn AccountsPortalApi> =
        Arc::new(AccountsPortal::new(accounts.clone(), directory.clone()));

    // subscriptions
    let plan_repo = Arc::new(PlanRepositoryImpl::with_db(Arc::new(NoopPlanDb)));
    let sub_repo = Arc::new(SubscriptionRepositoryImpl::with_db(Arc::new(NoopSubscriptionDb)));
    let billing_client = Arc::new(BillingAccountClientAdapter::new(accounts_portal.clone()));
    let plans: Arc<dyn PlanOrchestrator> = Arc::new(PlanOrchestratorImpl::new(plan_repo.clone()));
    let subscriptions: Arc<dyn SubscriptionOrchestrator> =
        Arc::new(SubscriptionOrchestratorImpl::new(
            sub_repo.clone(),
            plan_repo.clone(),
            Arc::new(FakeStripe),
            billing_client,
        ));
    let entitlements: Arc<dyn EntitlementResolver> =
        Arc::new(EntitlementResolverImpl::new(plan_repo, sub_repo));
    // The subscriptions subsystem's inbound Portal (front door for gatekeeping).
    let subscriptions_portal: Arc<dyn SubscriptionsPortalApi> = Arc::new(SubscriptionsPortal::new(
        plans.clone(),
        subscriptions.clone(),
        entitlements.clone(),
    ));

    // metering
    let counter: Arc<dyn CounterAdapter> = Arc::new(FakeCounter::default());
    let (bus, _rx) = broadcast::channel(64);
    let events = Arc::new(BroadcastUsageEventAdapter::new(bus.clone()));
    let rollup_repo = Arc::new(UsageRollupRepositoryImpl::with_db(Arc::new(NoopUsageRollupDb)));
    let usage_meter: Arc<dyn UsageMeter> = Arc::new(UsageMeterImpl::new(counter.clone(), events));
    let usage_query = Arc::new(UsageQueryImpl::new(counter, rollup_repo));
    // The metering subsystem's inbound Portal (front door for gatekeeping).
    let metering_portal: Arc<dyn MeteringPortalApi> =
        Arc::new(MeteringPortal::new(usage_query, usage_meter.clone()));

    // gatekeeping
    let cred_repo = Arc::new(CredentialRepositoryImpl::with_db(Arc::new(NoopCredentialDb)));
    let authenticator = Arc::new(ApiKeyAuthenticatorImpl::new(cred_repo.clone()));
    let subs_client = Arc::new(SubscriptionsClientAdapter::new(subscriptions_portal.clone()));
    let met_client = Arc::new(MeteringClientAdapter::new(metering_portal.clone()));
    let audit = Arc::new(RecordingAudit::default());
    let gate: Arc<dyn GateOrchestrator> = Arc::new(GateOrchestratorImpl::new(
        authenticator,
        subs_client,
        met_client,
        audit.clone(),
    ));
    let credentials: Arc<dyn CredentialOrchestrator> =
        Arc::new(CredentialOrchestratorImpl::new(cred_repo));

    // notifications
    let accounts_client = Arc::new(AccountsClientAdapter::new(accounts_portal.clone()));
    let email = Arc::new(RecordingEmail::default());
    let notif_log = Arc::new(RecordingNotifLog::default());
    let notif_orch = Arc::new(NotificationOrchestratorImpl::new(
        accounts_client,
        email.clone(),
        notif_log.clone(),
    ));
    let observer: Arc<dyn UsageEventObserver> =
        Arc::new(UsageEventObserverImpl::new(notif_orch));

    System {
        accounts,
        directory,
        plans,
        subscriptions,
        credentials,
        gate,
        observer,
        bus,
        email,
        audit,
        notif_log,
        entitlements,
        usage_meter,
    }
}

/// Build a single-tier plan with one resource limit (helper for tests).
pub fn single_tier_plan(plan_id: &str, tier_id: &str, resource: &str, quota: i64) -> Plan {
    use gatekeeper_saas::subscriptions::model::{Limit, Tier};
    Plan {
        id: gatekeeper_saas::domain::PlanId::new(plan_id),
        name: "Test Plan".into(),
        active: true,
        tiers: vec![Tier {
            id: gatekeeper_saas::domain::TierId::new(tier_id),
            name: "Pro".into(),
            stripe_price_id: "price_test".into(),
            limits: vec![Limit { resource: resource.into(), quota, window: "day".into() }],
        }],
    }
}

/// Re-exported ids for terse test code.
pub use gatekeeper_saas::domain::{PlanId, TierId};
pub type AnyError = Box<dyn std::error::Error>;
pub use gatekeeper_saas::subscriptions::model::CreateSubscriptionCommand;
pub use gatekeeper_saas::accounts::model::CreateAccountCommand;
pub fn email(addr: &str) -> Email {
    Email::parse(addr).unwrap()
}
pub fn api_key_id(v: &str) -> ApiKeyId {
    ApiKeyId::new(v)
}
