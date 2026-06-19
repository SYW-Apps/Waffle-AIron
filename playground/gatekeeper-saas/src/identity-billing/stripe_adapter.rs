use std::sync::Arc;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use chrono::{DateTime, Utc};
use crate::models::StripeSubscriptionDetails;

#[async_trait::async_trait]
pub trait IStripeAdapter: Send + Sync {
    async fn create_stripe_customer(&self, email: String) -> Result<String, reqwest::Error>;
    async fn fetch_subscription(&self, stripe_sub_id: String) -> Result<StripeSubscriptionDetails, reqwest::Error>;
}

pub struct StripeAdapter {
    secret_key: String,
    client: Client,
    base_url: String,
}

impl StripeAdapter {
    pub fn new(secret_key: String, base_url: Option<String>) -> Self {
        Self {
            secret_key,
            client: Client::new(),
            base_url: base_url.unwrap_or_else(|| "https://api.stripe.com".to_string()),
        }
    }
}

#[derive(Deserialize)]
struct StripeCustomerResponse {
    id: String,
}

#[derive(Deserialize)]
struct StripeSubscriptionResponse {
    id: String,
    customer: String,
    status: String,
    current_period_start: i64,
    current_period_end: i64,
    items: StripeSubscriptionItems,
}

#[derive(Deserialize)]
struct StripeSubscriptionItems {
    data: Vec<StripeSubscriptionItem>,
}

#[derive(Deserialize)]
struct StripeSubscriptionItem {
    price: StripePrice,
}

#[derive(Deserialize)]
struct StripePrice {
    lookup_key: Option<String>,
    product: String,
}

#[async_trait::async_trait]
impl IStripeAdapter for StripeAdapter {
    async fn create_stripe_customer(&self, email: String) -> Result<String, reqwest::Error> {
        // Step 1: Initialize Stripe client using secret API key.
        // (Handled by struct initialization, using client and secret_key header)
        
        // Step 2: Send HTTP POST request to Stripe Customer API.
        let url = format!("{}/v1/customers", self.base_url);
        let response = self.client.post(&url)
            .bearer_auth(&self.secret_key)
            .form(&[("email", &email)])
            .send()
            .await?;

        // Step 3: Extract and return stripe_customer_id from response.
        let customer: StripeCustomerResponse = response.error_for_status()?.json().await?;
        Ok(customer.id)
    }

    async fn fetch_subscription(&self, stripe_sub_id: String) -> Result<StripeSubscriptionDetails, reqwest::Error> {
        // Step 1: Initialize Stripe client using secret API key.
        // (Handled by struct initialization, using client and secret_key header)
        
        // Step 2: Send HTTP GET request to Stripe Subscription API.
        let url = format!("{}/v1/subscriptions/{}", self.base_url, stripe_sub_id);
        let response = self.client.get(&url)
            .bearer_auth(&self.secret_key)
            .send()
            .await?;

        // Step 3: Format and return subscription details.
        let sub: StripeSubscriptionResponse = response.error_for_status()?.json().await?;
        
        // Determine tier_id. Let's check lookup_key or fallback to product.
        let tier_id = sub.items.data.first()
            .and_then(|item| item.price.lookup_key.clone())
            .unwrap_or_else(|| {
                sub.items.data.first()
                    .map(|item| item.price.product.clone())
                    .unwrap_or_else(|| "free".to_string())
            });

        let start_time = DateTime::from_timestamp(sub.current_period_start, 0)
            .unwrap_or_else(|| Utc::now());
        let end_time = DateTime::from_timestamp(sub.current_period_end, 0)
            .unwrap_or_else(|| Utc::now());

        Ok(StripeSubscriptionDetails {
            stripe_subscription_id: sub.id,
            stripe_customer_id: sub.customer,
            tier_id,
            status: sub.status,
            current_period_start: start_time,
            current_period_end: end_time,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{Router, routing::{get, post}, Json};
    use serde_json::json;
    use tokio::net::TcpListener;

    #[tokio::test]
    async fn test_create_stripe_customer() {
        let app = Router::new().route("/v1/customers", post(|| async {
            Json(json!({
                "id": "cus_test_123"
            }))
        }));

        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });

        let adapter = StripeAdapter::new("sk_test".to_string(), Some(format!("http://{}", addr)));
        let customer_id = adapter.create_stripe_customer("test@example.com".to_string()).await.unwrap();
        assert_eq!(customer_id, "cus_test_123");
    }

    #[tokio::test]
    async fn test_fetch_subscription() {
        let app = Router::new().route("/v1/subscriptions/sub_test", get(|| async {
            Json(json!({
                "id": "sub_test",
                "customer": "cus_test_123",
                "status": "active",
                "current_period_start": 1609459200,
                "current_period_end": 1612137600,
                "items": {
                    "data": [
                        {
                            "price": {
                                "lookup_key": "pro",
                                "product": "prod_pro_123"
                            }
                        }
                    ]
                }
            }))
        }));

        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });

        let adapter = StripeAdapter::new("sk_test".to_string(), Some(format!("http://{}", addr)));
        let sub = adapter.fetch_subscription("sub_test".to_string()).await.unwrap();
        assert_eq!(sub.stripe_subscription_id, "sub_test");
        assert_eq!(sub.stripe_customer_id, "cus_test_123");
        assert_eq!(sub.tier_id, "pro");
        assert_eq!(sub.status, "active");
    }
}
