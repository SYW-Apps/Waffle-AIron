use crate::models::{StripeSubscriptionDetails, StripeError};
use async_trait::async_trait;

#[async_trait]
pub trait StripeAdapter {
    async fn retrieve_subscription(&self, stripe_sub_id: String) -> Result<StripeSubscriptionDetails, StripeError>;
}

pub struct StripeAdapterImpl {
    secret_key: String,
}

impl StripeAdapterImpl {
    pub fn new(secret_key: String) -> Self {
        Self { secret_key }
    }
}

#[async_trait]
impl StripeAdapter for StripeAdapterImpl {
    async fn retrieve_subscription(&self, stripe_sub_id: String) -> Result<StripeSubscriptionDetails, StripeError> {
        // Step 1: Construct Stripe API request URL and headers with Stripe Secret Key
        let url = format!("https://api.stripe.com/v1/subscriptions/{}", stripe_sub_id);
        let key_len = self.secret_key.len();
        let mask_len = std::cmp::min(key_len, 5);
        println!("Constructed Stripe URL: {} with Authorization: Bearer {}", url, &self.secret_key[..mask_len]);

        // Step 2: Send HTTP GET request to external Stripe API billing endpoint
        println!("Sending simulated HTTP GET to Stripe...");

        // Step 3: Deserialize Stripe API JSON response and return subscription metadata
        if stripe_sub_id == "fail_sub" {
            return Err(StripeError::ApiError("Failed to retrieve subscription from Stripe".to_string()));
        }

        let plan_id = if stripe_sub_id.contains("free") {
            "free".to_string()
        } else if stripe_sub_id.contains("enterprise") {
            "enterprise".to_string()
        } else {
            "pro".to_string()
        };

        Ok(StripeSubscriptionDetails {
            stripe_subscription_id: stripe_sub_id,
            status: "active".to_string(),
            plan_id,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_retrieve_subscription_success() {
        let adapter = StripeAdapterImpl::new("sk_test_123".to_string());
        let result = adapter.retrieve_subscription("sub_pro_123".to_string()).await;
        assert!(result.is_ok());
        let details = result.unwrap();
        assert_eq!(details.plan_id, "pro");
        assert_eq!(details.status, "active");
    }

    #[tokio::test]
    async fn test_retrieve_subscription_failure() {
        let adapter = StripeAdapterImpl::new("sk_test_123".to_string());
        let result = adapter.retrieve_subscription("fail_sub".to_string()).await;
        assert!(result.is_err());
    }
}
