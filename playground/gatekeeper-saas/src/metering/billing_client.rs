use std::sync::Arc;
use crate::models::CustomerLimits;
use crate::identity_billing::repository::IBillingRepository;

#[async_trait::async_trait]
pub trait IBillingClientAdapter: Send + Sync {
    async fn fetch_customer_limits_by_key(&self, key_hash: &str) -> Result<Option<CustomerLimits>, sqlx::Error>;
}

pub struct BillingClientAdapter {
    repository: Arc<dyn IBillingRepository>,
}

impl BillingClientAdapter {
    pub fn new(repository: Arc<dyn IBillingRepository>) -> Self {
        Self { repository }
    }
}

#[async_trait::async_trait]
impl IBillingClientAdapter for BillingClientAdapter {
    async fn fetch_customer_limits_by_key(&self, key_hash: &str) -> Result<Option<CustomerLimits>, sqlx::Error> {
        // Step 1: Query database for Customer matching API key hash.
        let customer = match self.repository.find_customer_by_api_key(key_hash).await? {
            Some(c) => c,
            None => return Ok(None),
        };

        // Step 2: Query database for active Subscription mapped to Customer ID.
        let subscription = match self.repository.find_subscription_by_customer_id(&customer.id).await? {
            Some(s) => s,
            None => return Ok(None),
        };

        // Step 3: Query database for SubscriptionTier limit bounds matching active Subscription tier.
        let tier = match self.repository.find_tier_by_id(&subscription.tier_id).await? {
            Some(t) => t,
            None => return Ok(None),
        };

        // Step 4: Construct and return mapped CustomerLimits details.
        Ok(Some(CustomerLimits {
            customer_id: customer.id,
            subscription_id: subscription.id,
            tier_id: subscription.tier_id,
            request_limit: tier.request_limit,
            rate_limit_per_minute: tier.rate_limit_per_minute,
            subscription_status: subscription.status,
            current_period_start: subscription.current_period_start,
            current_period_end: subscription.current_period_end,
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{Customer, Subscription, SubscriptionTier, ApiKey};
    use uuid::Uuid;
    use chrono::Utc;
    use std::sync::Mutex;

    struct MockBillingRepository {
        customer: Option<Customer>,
        subscription: Option<Subscription>,
        tier: Option<SubscriptionTier>,
    }

    #[async_trait::async_trait]
    impl IBillingRepository for MockBillingRepository {
        async fn save_customer(&self, _customer: &Customer) -> Result<(), sqlx::Error> { Ok(()) }
        async fn find_customer_by_id(&self, _id: &Uuid) -> Result<Option<Customer>, sqlx::Error> { Ok(None) }
        
        async fn find_customer_by_api_key(&self, _key_hash: &str) -> Result<Option<Customer>, sqlx::Error> {
            Ok(self.customer.clone())
        }
        
        async fn save_api_key(&self, _key: &ApiKey) -> Result<(), sqlx::Error> { Ok(()) }
        async fn revoke_api_key(&self, _id: &Uuid) -> Result<(), sqlx::Error> { Ok(()) }
        async fn save_subscription(&self, _sub: &Subscription) -> Result<(), sqlx::Error> { Ok(()) }
        
        async fn find_subscription_by_customer_id(&self, _customer_id: &Uuid) -> Result<Option<Subscription>, sqlx::Error> {
            Ok(self.subscription.clone())
        }
        
        async fn find_tier_by_id(&self, _tier_id: &str) -> Result<Option<SubscriptionTier>, sqlx::Error> {
            Ok(self.tier.clone())
        }
        
        async fn save_tier(&self, _tier: &SubscriptionTier) -> Result<(), sqlx::Error> { Ok(()) }
        
        async fn find_customer_by_stripe_customer_id(&self, _stripe_customer_id: &str) -> Result<Option<Customer>, sqlx::Error> {
            Ok(None)
        }
    }

    #[tokio::test]
    async fn test_fetch_customer_limits_success() {
        let cust_id = Uuid::new_v4();
        let sub_id = Uuid::new_v4();
        
        let customer = Customer {
            id: cust_id,
            email: "test@example.com".to_string(),
            stripe_customer_id: Some("cus_123".to_string()),
            created_at: Utc::now(),
            updated_at: Utc::now(),
        };

        let subscription = Subscription {
            id: sub_id,
            customer_id: cust_id,
            stripe_subscription_id: Some("sub_123".to_string()),
            tier_id: "pro".to_string(),
            status: "active".to_string(),
            current_period_start: Utc::now(),
            current_period_end: Utc::now(),
            created_at: Utc::now(),
            updated_at: Utc::now(),
        };

        let tier = SubscriptionTier {
            id: "pro".to_string(),
            name: "Pro Tier".to_string(),
            request_limit: 10000,
            rate_limit_per_minute: 60,
            created_at: Utc::now(),
            updated_at: Utc::now(),
        };

        let repo = Arc::new(MockBillingRepository {
            customer: Some(customer),
            subscription: Some(subscription),
            tier: Some(tier),
        });

        let adapter = BillingClientAdapter::new(repo);
        let limits = adapter.fetch_customer_limits_by_key("hash123").await.unwrap().unwrap();

        assert_eq!(limits.customer_id, cust_id);
        assert_eq!(limits.subscription_id, sub_id);
        assert_eq!(limits.tier_id, "pro");
        assert_eq!(limits.request_limit, 10000);
        assert_eq!(limits.rate_limit_per_minute, 60);
    }
}
