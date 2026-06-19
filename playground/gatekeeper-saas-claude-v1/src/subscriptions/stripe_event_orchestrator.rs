//! Stripe Event Orchestrator (Orchestrator stereotype): processes incoming
//! Stripe webhook events. Verifies and parses the event via the Stripe adapter,
//! dedupes by event id (idempotency), and reconciles local subscription state
//! via the subscription repository.

use std::sync::Arc;

use async_trait::async_trait;

use crate::domain::SubscriptionId;

use super::model::{SubscriptionError, SubscriptionStatus};
use super::stripe_adapter::StripeAdapter;
use super::subscription_repository::SubscriptionRepository;

#[async_trait]
pub trait StripeEventOrchestrator: Send + Sync {
    async fn process_event(
        &self,
        raw_body: Vec<u8>,
        signature: String,
    ) -> Result<(), SubscriptionError>;
}

pub struct StripeEventOrchestratorImpl {
    subscriptions: Arc<dyn SubscriptionRepository>,
    stripe: Arc<dyn StripeAdapter>,
}

impl StripeEventOrchestratorImpl {
    pub fn new(
        subscriptions: Arc<dyn SubscriptionRepository>,
        stripe: Arc<dyn StripeAdapter>,
    ) -> Self {
        Self { subscriptions, stripe }
    }
}

/// The reconciled facts extracted from a Stripe event payload.
struct Reconciliation {
    subscription_id: SubscriptionId,
    status: SubscriptionStatus,
    current_period_end: String,
}

/// Derive our subscription id, new status, and period end from the event kind
/// and its `data.object` payload (subscription id carried in Stripe metadata).
fn reconcile(kind: &str, payload: &str) -> Result<Reconciliation, SubscriptionError> {
    let value: serde_json::Value =
        serde_json::from_str(payload).map_err(|e| SubscriptionError::StripeFailure(e.to_string()))?;
    let object = value.pointer("/data/object");
    let subscription_id = object
        .and_then(|o| o.pointer("/metadata/subscription_id"))
        .and_then(|v| v.as_str())
        .ok_or_else(|| SubscriptionError::Conflict("event missing subscription_id metadata".into()))?
        .to_string();
    let status = if kind.contains("deleted") {
        SubscriptionStatus::Canceled
    } else {
        let raw = object
            .and_then(|o| o.get("status"))
            .and_then(|v| v.as_str())
            .unwrap_or("incomplete");
        SubscriptionStatus::from_stripe(raw)
    };
    let period_end = object
        .and_then(|o| o.get("current_period_end"))
        .and_then(|v| v.as_i64())
        .map(|secs| {
            chrono::DateTime::from_timestamp(secs, 0)
                .unwrap_or_else(|| chrono::DateTime::from_timestamp(0, 0).unwrap())
                .to_rfc3339()
        })
        .unwrap_or_default();
    Ok(Reconciliation {
        subscription_id: SubscriptionId::new(subscription_id),
        status,
        current_period_end: period_end,
    })
}

#[async_trait]
impl StripeEventOrchestrator for StripeEventOrchestratorImpl {
    async fn process_event(
        &self,
        raw_body: Vec<u8>,
        signature: String,
    ) -> Result<(), SubscriptionError> {
        // Step 1: Verify the signature and parse the raw body into a typed StripeEvent.
        let event = self.stripe.verify_and_parse_event(raw_body, signature)?;
        // Step 2: Extract our subscription_id and derive the new status + period end.
        let r = reconcile(&event.kind, &event.payload)?;
        // Step 3: Idempotently record the event id and apply the status change in one transaction.
        let _applied = self
            .subscriptions
            .mark_event_processed(&r.subscription_id, event.id, r.status, r.current_period_end)
            .await?;
        // Step 4: Return Ok(()) (skipping silently if the event was a duplicate).
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::{BillingAccountId, PlanId, TierId};
    use crate::subscriptions::model::Subscription;
    use crate::subscriptions::subscription_repository::SubscriptionRepositoryImpl;
    use crate::subscriptions::subscription_store::{InMemorySubscriptionStore, SubscriptionStore};
    use crate::subscriptions::subscription_index::SubscriptionIndexImpl;
    use crate::subscriptions::subscription_registry::SubscriptionRegistryImpl;
    use crate::subscriptions::test_support::{MockStripeAdapter, MockSubscriptionDbAdapter};

    #[test]
    fn reconcile_extracts_metadata_and_status() {
        let payload = r#"{"data":{"object":{"status":"past_due","current_period_end":1718000000,"metadata":{"subscription_id":"sub-1"}}}}"#;
        let r = reconcile("customer.subscription.updated", payload).unwrap();
        assert_eq!(r.subscription_id, SubscriptionId::new("sub-1"));
        assert_eq!(r.status, SubscriptionStatus::PastDue);
    }

    #[test]
    fn reconcile_deleted_event_is_canceled() {
        let payload = r#"{"data":{"object":{"status":"active","metadata":{"subscription_id":"sub-1"}}}}"#;
        let r = reconcile("customer.subscription.deleted", payload).unwrap();
        assert_eq!(r.status, SubscriptionStatus::Canceled);
    }

    #[tokio::test]
    async fn process_event_applies_status() {
        // Build a subscription repository sharing one store so we can observe the change.
        let store = Arc::new(InMemorySubscriptionStore::new());
        store.insert(Subscription {
            id: SubscriptionId::new("sub-1"),
            billing_account_id: BillingAccountId::new("ba-1"),
            plan_id: PlanId::new("plan-1"),
            tier_id: TierId::new("tier-1"),
            stripe_customer_id: Some("cus_1".into()),
            stripe_subscription_id: Some("ss_1".into()),
            status: SubscriptionStatus::Active,
            current_period_end: "2026-07-01T00:00:00Z".into(),
            overrides: vec![],
        });
        let db = Arc::new(MockSubscriptionDbAdapter::ok());
        let registry = Arc::new(SubscriptionRegistryImpl::new(store.clone(), db));
        let index = Arc::new(SubscriptionIndexImpl::new(store.clone()));
        let subs: Arc<dyn SubscriptionRepository> =
            Arc::new(SubscriptionRepositoryImpl::new(registry, index));

        let payload = r#"{"id":"evt_9","type":"customer.subscription.updated","data":{"object":{"status":"past_due","current_period_end":1718000000,"metadata":{"subscription_id":"sub-1"}}}}"#;
        let stripe = Arc::new(MockStripeAdapter::with_event(payload));
        let orch = StripeEventOrchestratorImpl::new(subs, stripe);
        orch.process_event(payload.as_bytes().to_vec(), "sig".into()).await.unwrap();
        assert_eq!(store.get(&SubscriptionId::new("sub-1")).unwrap().status, SubscriptionStatus::PastDue);
    }
}
