use gatekeeper_saas::models::*;
use gatekeeper_saas::gatekeeper::portal::{GatekeeperPortal, GatekeeperPortalImpl};
use gatekeeper_saas::gatekeeper::orchestrator::GatekeeperOrchestratorImpl;
use gatekeeper_saas::gatekeeper::meter_store::InMemoryMeterStore;
use gatekeeper_saas::gatekeeper::meter_repository::MeterRepositoryImpl;
use gatekeeper_saas::gatekeeper::redis_adapter::RedisAdapter;
use gatekeeper_saas::billing::customer_store::InMemoryCustomerStore;
use gatekeeper_saas::billing::subscription_store::{SubscriptionStore, InMemorySubscriptionStore};
use gatekeeper_saas::billing::customer_registry::CustomerRegistryImpl;
use gatekeeper_saas::billing::customer_repository::CustomerRepositoryImpl;
use gatekeeper_saas::billing::subscription_repository::{SubscriptionRepository, SubscriptionRepositoryImpl};
use gatekeeper_saas::billing::stripe_adapter::StripeAdapter;
use gatekeeper_saas::billing::billing_orchestrator::{BillingOrchestrator, BillingOrchestratorImpl};
use gatekeeper_saas::billing::stripe_webhook_portal::{StripeWebhookPortal, StripeWebhookPortalImpl};
use gatekeeper_saas::billing::database_adapter::DatabaseAdapter;
use gatekeeper_saas::notification::orchestrator::NotificationOrchestratorImpl;
use gatekeeper_saas::notification::email_adapter::EmailAdapter;
use gatekeeper_saas::notification::push_adapter::PushAdapter;

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use async_trait::async_trait;
use uuid::Uuid;
use chrono::Utc;

struct MockRedisAdapter {
    state: Arc<Mutex<HashMap<String, String>>>,
}

#[async_trait]
impl RedisAdapter for MockRedisAdapter {
    async fn incr_rate_limit(&self, key: String, _window_seconds: u64) -> Result<u32, AdapterError> {
        let mut state = self.state.lock().unwrap();
        let val = state.entry(key).or_insert_with(|| "0".to_string());
        let count = val.parse::<u32>().unwrap_or(0) + 1;
        *val = count.to_string();
        Ok(count)
    }

    async fn incr_monthly_usage(&self, key: String) -> Result<u32, AdapterError> {
        let mut state = self.state.lock().unwrap();
        let val = state.entry(key).or_insert_with(|| "0".to_string());
        let count = val.parse::<u32>().unwrap_or(0) + 1;
        *val = count.to_string();
        Ok(count)
    }

    async fn get_string(&self, key: String) -> Result<Option<String>, AdapterError> {
        let state = self.state.lock().unwrap();
        Ok(state.get(&key).cloned())
    }
}

struct DatabaseState {
    customers: HashMap<String, CustomerDetails>,
    subscriptions: HashMap<String, (SubscriptionDetails, String)>, // stripe_subscription_id -> (details, api_key)
}

struct MockDatabaseAdapter {
    state: Arc<Mutex<DatabaseState>>,
}

#[async_trait]
impl DatabaseAdapter for MockDatabaseAdapter {
    async fn execute_query(&self, query: String, params: Vec<String>) -> Result<u64, DbError> {
        let mut state = self.state.lock().unwrap();
        if query.contains("INSERT INTO customers") {
            let id = Uuid::parse_str(&params[0]).unwrap();
            let email = params[1].clone();
            let stripe_customer_id = if params[2].is_empty() { None } else { Some(params[2].clone()) };
            let customer = CustomerDetails {
                id,
                email,
                stripe_customer_id,
            };
            state.customers.insert(id.to_string(), customer);
            Ok(1)
        } else if query.contains("UPDATE subscriptions") {
            let status = params[0].clone();
            let plan_id = params[1].clone();
            let api_limit = params[2].parse::<u32>().unwrap();
            let stripe_subscription_id = params[3].clone();

            if let Some((sub, _api_key)) = state.subscriptions.get_mut(&stripe_subscription_id) {
                sub.status = status;
                sub.tier_id = plan_id;
                sub.api_limit = api_limit;
            }
            Ok(1)
        } else {
            Ok(0)
        }
    }

    async fn fetch_row(&self, query: String, params: Vec<String>) -> Result<Option<String>, DbError> {
        let state = self.state.lock().unwrap();
        if query.contains("FROM customers") && query.contains("stripe_customer_id = $1") {
            let stripe_cust_id = &params[0];
            for customer in state.customers.values() {
                if customer.stripe_customer_id.as_ref() == Some(stripe_cust_id) {
                    let json = serde_json::to_string(customer).unwrap();
                    return Ok(Some(json));
                }
            }
            Ok(None)
        } else if query.contains("FROM customers") && query.contains("id = $1") {
            let id = &params[0];
            if let Some(customer) = state.customers.get(id) {
                let json = serde_json::to_string(customer).unwrap();
                return Ok(Some(json));
            }
            Ok(None)
        } else if query.contains("FROM subscriptions") && query.contains("stripe_subscription_id = $1") {
            let stripe_sub_id = &params[0];
            if let Some((sub, api_key)) = state.subscriptions.get(stripe_sub_id) {
                let mut map = serde_json::to_value(sub).unwrap();
                map.as_object_mut().unwrap().insert("api_key".to_string(), serde_json::Value::String(api_key.clone()));
                let json = serde_json::to_string(&map).unwrap();
                return Ok(Some(json));
            }
            Ok(None)
        } else if query.contains("FROM subscriptions") && query.contains("api_key = $1") {
            let api_key_val = &params[0];
            for (sub, api_key) in state.subscriptions.values() {
                if api_key == api_key_val {
                    let json = serde_json::to_value(sub).unwrap();
                    let json_str = serde_json::to_string(&json).unwrap();
                    return Ok(Some(json_str));
                }
            }
            Ok(None)
        } else {
            Ok(None)
        }
    }
}

struct MockStripeAdapter {
    plan_id: String,
    status: String,
}

#[async_trait]
impl StripeAdapter for MockStripeAdapter {
    async fn retrieve_subscription(&self, stripe_sub_id: String) -> Result<StripeSubscriptionDetails, StripeError> {
        Ok(StripeSubscriptionDetails {
            stripe_subscription_id: stripe_sub_id,
            status: self.status.clone(),
            plan_id: self.plan_id.clone(),
        })
    }
}

struct MockEmailAdapter {
    sent_emails: Arc<Mutex<Vec<(String, String, String)>>>,
}

#[async_trait]
impl EmailAdapter for MockEmailAdapter {
    async fn send_email(&self, to: String, subject: String, body: String) -> Result<(), AdapterError> {
        self.sent_emails.lock().unwrap().push((to, subject, body));
        Ok(())
    }
}

struct MockPushAdapter {
    sent_pushes: Arc<Mutex<Vec<(String, String, String)>>>,
}

#[async_trait]
impl PushAdapter for MockPushAdapter {
    async fn send_push(&self, recipient: String, title: String, message: String) -> Result<(), AdapterError> {
        self.sent_pushes.lock().unwrap().push((recipient, title, message));
        Ok(())
    }
}

#[tokio::test]
async fn test_full_system_cohesive_simulation() {
    // -------------------------------------------------------------
    // Set up shared DB and Cache state
    // -------------------------------------------------------------
    let db_state = Arc::new(Mutex::new(DatabaseState {
        customers: HashMap::new(),
        subscriptions: HashMap::new(),
    }));

    let redis_state = Arc::new(Mutex::new(HashMap::new()));

    // -------------------------------------------------------------
    // Setup Subsystems & Components
    // -------------------------------------------------------------
    let database_adapter = Arc::new(MockDatabaseAdapter { state: db_state.clone() });
    let redis_adapter = Arc::new(MockRedisAdapter { state: redis_state });
    let stripe_adapter = Arc::new(MockStripeAdapter {
        plan_id: "pro".to_string(), // Pro Plan tier initially
        status: "active".to_string(),
    });

    let sent_emails = Arc::new(Mutex::new(Vec::new()));
    let sent_pushes = Arc::new(Mutex::new(Vec::new()));
    let email_adapter = Arc::new(MockEmailAdapter { sent_emails: sent_emails.clone() });
    let push_adapter = Arc::new(MockPushAdapter { sent_pushes: sent_pushes.clone() });

    // In-memory Stores
    let meter_store = Arc::new(InMemoryMeterStore::new());
    let customer_store = Arc::new(InMemoryCustomerStore::new());
    let subscription_store = Arc::new(InMemorySubscriptionStore::new());

    // Registries & Repositories
    let customer_registry = Arc::new(CustomerRegistryImpl::new(database_adapter.clone()));
    let customer_repo = Arc::new(CustomerRepositoryImpl::new(
        customer_store.clone(),
        customer_registry,
        database_adapter.clone(),
    ));

    let subscription_repo = Arc::new(SubscriptionRepositoryImpl::new(
        subscription_store.clone(),
        database_adapter.clone(),
    ));

    let meter_repo = Arc::new(MeterRepositoryImpl::new(
        redis_adapter,
        meter_store,
    ));

    // Orchestrators
    let notification_orchestrator = Arc::new(NotificationOrchestratorImpl::new(
        email_adapter,
        push_adapter,
    ));

    let gatekeeper_orchestrator = Arc::new(GatekeeperOrchestratorImpl::new(
        subscription_repo.clone(),
        meter_repo,
        notification_orchestrator,
    ));

    let billing_orchestrator = Arc::new(BillingOrchestratorImpl::new(
        stripe_adapter,
        customer_repo,
        subscription_repo,
        database_adapter,
    ));

    // Portals (Entrypoints)
    let gatekeeper_portal = GatekeeperPortalImpl::new(gatekeeper_orchestrator);
    let stripe_webhook_portal = StripeWebhookPortalImpl::new(billing_orchestrator, "whsec_123".to_string());

    // -------------------------------------------------------------
    // Scenario Step 1: Pre-populate subscription data in DB
    // -------------------------------------------------------------
    let cust_id = Uuid::new_v4();
    let sub_id = Uuid::new_v4();
    let customer = CustomerDetails {
        id: cust_id,
        email: "subscriber@waffle.ai".to_string(),
        stripe_customer_id: Some("cus_subscriber".to_string()),
    };
    let sub_details = SubscriptionDetails {
        id: sub_id,
        customer_id: cust_id,
        customer_email: "subscriber@waffle.ai".to_string(),
        stripe_subscription_id: "sub_subscriber".to_string(),
        status: "active".to_string(),
        tier_id: "free".to_string(), // initially Free
        api_limit: 10,               // Free limit is 10 requests (small limit for test)
        current_period_start: Utc::now().naive_utc(),
        current_period_end: Utc::now().naive_utc(),
    };

    {
        let mut state = db_state.lock().unwrap();
        state.customers.insert(cust_id.to_string(), customer);
        state.subscriptions.insert("sub_subscriber".to_string(), (sub_details, "api_key_123".to_string()));
    }

    // -------------------------------------------------------------
    // Scenario Step 2: Receive Webhook Event to upgrade to Pro
    // -------------------------------------------------------------
    let webhook_body = r#"{
        "type": "customer.subscription.updated",
        "data": {
            "object": {
                "customer": "cus_subscriber",
                "id": "sub_subscriber"
            }
        }
    }"#;

    let webhook_result = stripe_webhook_portal
        .receive_webhook(webhook_body.to_string(), "t=1,v1=abc".to_string())
        .await;
    assert!(webhook_result.is_ok());

    // Verify limit updated in DB: Pro plan is 500,000 requests
    {
        let state = db_state.lock().unwrap();
        let (sub, _) = state.subscriptions.get("sub_subscriber").unwrap();
        assert_eq!(sub.tier_id, "pro");
        assert_eq!(sub.api_limit, 500000);
    }

    // -------------------------------------------------------------
    // Scenario Step 3: Hot-path middleware API call (Success)
    // -------------------------------------------------------------
    let mut req_headers = HashMap::new();
    req_headers.insert("X-API-Key".to_string(), "api_key_123".to_string());

    let decision = gatekeeper_portal
        .handle_request(req_headers.clone(), "/v1/data".to_string())
        .await;

    assert!(decision.is_ok());
    let decision = decision.unwrap();
    assert!(decision.allowed);
    assert_eq!(decision.remaining_requests, 99); // Pro rate limit: 100/min, remaining: 99

    // -------------------------------------------------------------
    // Scenario Step 4: Simulate reaching 80% and 100% threshold alerts
    // -------------------------------------------------------------
    // Let's modify subscription in DB to have a monthly limit of 10 requests for easier alert triggering.
    {
        let mut state = db_state.lock().unwrap();
        let (sub, _) = state.subscriptions.get_mut("sub_subscriber").unwrap();
        sub.api_limit = 10;
    }
    // Evict cache by updating cache store with limit 10
    subscription_store.update_cached_subscription("api_key_123".to_string(), SubscriptionDetails {
        id: sub_id,
        customer_id: cust_id,
        customer_email: "subscriber@waffle.ai".to_string(),
        stripe_subscription_id: "sub_subscriber".to_string(),
        status: "active".to_string(),
        tier_id: "pro".to_string(),
        api_limit: 10,
        current_period_start: Utc::now().naive_utc(),
        current_period_end: Utc::now().naive_utc(),
    });

    // Make requests to reach 8 requests (80% of 10)
    // The previous request already counted as 1 (so we make 7 more)
    for _ in 0..6 {
        let decision = gatekeeper_portal
            .handle_request(req_headers.clone(), "/v1/data".to_string())
            .await;
        assert!(decision.unwrap().allowed);
    }

    // Currently at 7 requests. Make request #8.
    let decision_8 = gatekeeper_portal
        .handle_request(req_headers.clone(), "/v1/data".to_string())
        .await;
    assert!(decision_8.unwrap().allowed);

    // Wait slightly to allow async notification task to spawn and run
    tokio::time::sleep(tokio::time::Duration::from_millis(50)).await;

    // Verify 80% Warning alert was dispatched
    {
        let emails = sent_emails.lock().unwrap();
        assert_eq!(emails.len(), 1);
        assert_eq!(emails[0].0, "subscriber@waffle.ai");
        assert!(emails[0].1.contains("WARNING_80"));

        let pushes = sent_pushes.lock().unwrap();
        assert_eq!(pushes.len(), 1);
        assert_eq!(pushes[0].0, "subscriber@waffle.ai");
        assert!(pushes[0].2.contains("8"));
    }

    // Make request #9
    let decision_9 = gatekeeper_portal
        .handle_request(req_headers.clone(), "/v1/data".to_string())
        .await;
    assert!(decision_9.unwrap().allowed);

    // Make request #10 (limits reached!)
    let decision_10 = gatekeeper_portal
        .handle_request(req_headers.clone(), "/v1/data".to_string())
        .await;
    assert!(decision_10.unwrap().allowed);

    tokio::time::sleep(tokio::time::Duration::from_millis(50)).await;

    // Verify 100% Exceeded alert was dispatched
    {
        let emails = sent_emails.lock().unwrap();
        assert_eq!(emails.len(), 2);
        assert_eq!(emails[1].0, "subscriber@waffle.ai");
        assert!(emails[1].1.contains("LIMIT_EXCEEDED"));
    }

    // Make request #11 (Should be rejected)
    let decision_11 = gatekeeper_portal
        .handle_request(req_headers.clone(), "/v1/data".to_string())
        .await;
    assert!(decision_11.is_ok());
    let decision = decision_11.unwrap();
    assert!(!decision.allowed);
    assert_eq!(decision.error_message, Some("Monthly quota exceeded".to_string()));
}
