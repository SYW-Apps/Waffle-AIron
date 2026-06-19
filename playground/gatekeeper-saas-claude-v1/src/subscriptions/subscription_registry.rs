//! Subscription Registry (Registry stereotype): write path for the Subscription
//! aggregate. Applies mutations to the store and persists transactionally via
//! the Postgres adapter, including idempotent Stripe-event application.

use std::sync::Arc;

use async_trait::async_trait;

use crate::domain::{SubscriptionId, TierId};

use super::model::{Subscription, SubscriptionError, SubscriptionStatus};
use super::subscription_db_adapter::SubscriptionDbAdapter;
use super::subscription_store::SubscriptionStore;

#[async_trait]
pub trait SubscriptionRegistry: Send + Sync {
    async fn create_subscription(&self, sub: Subscription) -> Result<(), SubscriptionError>;
    async fn set_tier(
        &self,
        id: &SubscriptionId,
        tier_id: TierId,
    ) -> Result<(), SubscriptionError>;
    async fn set_status(
        &self,
        id: &SubscriptionId,
        status: SubscriptionStatus,
        current_period_end: String,
    ) -> Result<(), SubscriptionError>;
    async fn mark_event_processed(
        &self,
        id: &SubscriptionId,
        event_id: String,
        status: SubscriptionStatus,
        current_period_end: String,
    ) -> Result<bool, SubscriptionError>;
}

pub struct SubscriptionRegistryImpl {
    store: Arc<dyn SubscriptionStore>,
    db: Arc<dyn SubscriptionDbAdapter>,
}

impl SubscriptionRegistryImpl {
    pub fn new(store: Arc<dyn SubscriptionStore>, db: Arc<dyn SubscriptionDbAdapter>) -> Self {
        Self { store, db }
    }

    /// Mutate status in the store, read back, and persist (shared by set_status
    /// and the event-application path).
    async fn apply_status_and_persist(
        &self,
        id: &SubscriptionId,
        status: SubscriptionStatus,
        current_period_end: String,
    ) -> Result<(), SubscriptionError> {
        if !self.store.set_status(id, status, current_period_end) {
            return Err(SubscriptionError::NotFound(id.to_string()));
        }
        let sub = self
            .store
            .get(id)
            .ok_or_else(|| SubscriptionError::NotFound(id.to_string()))?;
        self.db.upsert_subscription(&sub).await?;
        Ok(())
    }
}

#[async_trait]
impl SubscriptionRegistry for SubscriptionRegistryImpl {
    async fn create_subscription(&self, sub: Subscription) -> Result<(), SubscriptionError> {
        // Step 1: Insert the subscription into the store.
        self.store.insert(sub.clone());
        // Step 2: Persist the subscription row to Postgres.
        self.db.upsert_subscription(&sub).await?;
        // Step 3: Return Ok(()).
        Ok(())
    }

    async fn set_tier(
        &self,
        id: &SubscriptionId,
        tier_id: TierId,
    ) -> Result<(), SubscriptionError> {
        // Step 1: Apply the tier change in the store (NotFound if absent).
        if !self.store.set_tier(id, tier_id) {
            return Err(SubscriptionError::NotFound(id.to_string()));
        }
        // Step 2: Read back the updated subscription.
        let sub = self
            .store
            .get(id)
            .ok_or_else(|| SubscriptionError::NotFound(id.to_string()))?;
        // Step 3: Persist the updated row.
        self.db.upsert_subscription(&sub).await?;
        // Step 4: Return Ok(()).
        Ok(())
    }

    async fn set_status(
        &self,
        id: &SubscriptionId,
        status: SubscriptionStatus,
        current_period_end: String,
    ) -> Result<(), SubscriptionError> {
        // Steps 1-3: Apply the status/period change in the store, read back, persist.
        self.apply_status_and_persist(id, status, current_period_end).await?;
        // Step 4: Return Ok(()).
        Ok(())
    }

    async fn mark_event_processed(
        &self,
        id: &SubscriptionId,
        event_id: String,
        status: SubscriptionStatus,
        current_period_end: String,
    ) -> Result<bool, SubscriptionError> {
        // Step 1: Insert the processed event id (unique constraint); false if it already exists.
        let inserted = self.db.insert_processed_event(event_id, id.clone()).await?;
        // Step 2: If already processed, return Ok(false) without applying any change.
        if !inserted {
            return Ok(false);
        }
        // Steps 3-5: Apply the new status/period to the store, read back, and persist the row.
        self.apply_status_and_persist(id, status, current_period_end).await?;
        // Step 6: Return Ok(true).
        Ok(true)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::{BillingAccountId, PlanId};
    use crate::subscriptions::subscription_store::{InMemorySubscriptionStore, SubscriptionStore};
    use crate::subscriptions::test_support::MockSubscriptionDbAdapter;

    fn sub() -> Subscription {
        Subscription {
            id: SubscriptionId::new("sub-1"),
            billing_account_id: BillingAccountId::new("ba-1"),
            plan_id: PlanId::new("plan-1"),
            tier_id: TierId::new("tier-1"),
            stripe_customer_id: Some("cus_1".into()),
            stripe_subscription_id: Some("ss_1".into()),
            status: SubscriptionStatus::Active,
            current_period_end: "2026-07-01T00:00:00Z".into(),
            overrides: vec![],
        }
    }

    #[tokio::test]
    async fn duplicate_event_is_noop() {
        let store = Arc::new(InMemorySubscriptionStore::new());
        store.insert(sub());
        let db = Arc::new(MockSubscriptionDbAdapter::with_duplicate_event());
        let registry = SubscriptionRegistryImpl::new(store.clone(), db.clone());
        let applied = registry
            .mark_event_processed(
                &SubscriptionId::new("sub-1"),
                "evt_1".into(),
                SubscriptionStatus::Canceled,
                "2026-09-01T00:00:00Z".into(),
            )
            .await
            .unwrap();
        assert!(!applied);
        // status unchanged, no upsert performed
        assert_eq!(store.get(&SubscriptionId::new("sub-1")).unwrap().status, SubscriptionStatus::Active);
        assert_eq!(db.upsert_calls(), 0);
    }

    #[tokio::test]
    async fn fresh_event_applies_status() {
        let store = Arc::new(InMemorySubscriptionStore::new());
        store.insert(sub());
        let db = Arc::new(MockSubscriptionDbAdapter::ok());
        let registry = SubscriptionRegistryImpl::new(store.clone(), db);
        let applied = registry
            .mark_event_processed(
                &SubscriptionId::new("sub-1"),
                "evt_2".into(),
                SubscriptionStatus::PastDue,
                "2026-09-01T00:00:00Z".into(),
            )
            .await
            .unwrap();
        assert!(applied);
        assert_eq!(store.get(&SubscriptionId::new("sub-1")).unwrap().status, SubscriptionStatus::PastDue);
    }
}
