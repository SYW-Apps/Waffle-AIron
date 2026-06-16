use std::sync::Arc;
use crate::identity_billing::repository::IBillingRepository;

#[async_trait::async_trait]
pub trait INotifierBillingClient: Send + Sync {
    async fn get_customer_email(&self, subscription_id: String) -> Result<Option<String>, sqlx::Error>;
}

pub struct NotifierBillingClient {
    billing_repository: Arc<dyn IBillingRepository>,
}

impl NotifierBillingClient {
    pub fn new(billing_repository: Arc<dyn IBillingRepository>) -> Self {
        Self { billing_repository }
    }
}

#[async_trait::async_trait]
impl INotifierBillingClient for NotifierBillingClient {
    async fn get_customer_email(&self, subscription_id: String) -> Result<Option<String>, sqlx::Error> {
        // Step 1: Resolve customer profile from billing repository database context.
        let customer = self.billing_repository.find_customer_by_subscription_id(&subscription_id).await?;

        // Step 2: Return parsed email address.
        Ok(customer.map(|c| c.email))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{Customer, ApiKey, Subscription, SubscriptionTier};
    use uuid::Uuid;
    use chrono::Utc;

    struct MockBillingRepository {
        customer: Option<Customer>,
    }

    #[async_trait::async_trait]
    impl IBillingRepository for MockBillingRepository {
        async fn save_customer(&self, _customer: &Customer) -> Result<(), sqlx::Error> { Ok(()) }
        async fn find_customer_by_id(&self, _id: &Uuid) -> Result<Option<Customer>, sqlx::Error> { Ok(None) }
        async fn find_customer_by_api_key(&self, _key_hash: &str) -> Result<Option<Customer>, sqlx::Error> { Ok(None) }
        async fn save_api_key(&self, _key: &ApiKey) -> Result<(), sqlx::Error> { Ok(()) }
        async fn revoke_api_key(&self, _id: &Uuid) -> Result<(), sqlx::Error> { Ok(()) }
        async fn save_subscription(&self, _sub: &Subscription) -> Result<(), sqlx::Error> { Ok(()) }
        async fn find_subscription_by_customer_id(&self, _customer_id: &Uuid) -> Result<Option<Subscription>, sqlx::Error> { Ok(None) }
        async fn find_tier_by_id(&self, _tier_id: &str) -> Result<Option<SubscriptionTier>, sqlx::Error> { Ok(None) }
        async fn save_tier(&self, _tier: &SubscriptionTier) -> Result<(), sqlx::Error> { Ok(()) }
        async fn find_customer_by_stripe_customer_id(&self, _stripe_customer_id: &str) -> Result<Option<Customer>, sqlx::Error> { Ok(None) }
        async fn find_customer_by_subscription_id(&self, _subscription_id: &str) -> Result<Option<Customer>, sqlx::Error> {
            Ok(self.customer.clone())
        }
    }

    #[tokio::test]
    async fn test_get_customer_email_success() {
        let customer = Customer {
            id: Uuid::new_v4(),
            email: "client@example.com".to_string(),
            stripe_customer_id: Some("cus_abc".to_string()),
            created_at: Utc::now(),
            updated_at: Utc::now(),
        };

        let repo = Arc::new(MockBillingRepository { customer: Some(customer) });
        let client = NotifierBillingClient::new(repo);

        let email = client.get_customer_email(Uuid::new_v4().to_string()).await.unwrap();
        assert_eq!(email, Some("client@example.com".to_string()));
    }
}
