use std::sync::Arc;
use uuid::Uuid;
use chrono::Utc;
use sha2::{Sha256, Digest};
use crate::models::{Customer, ApiKey, Subscription};
use crate::identity_billing::repository::IBillingRepository;
use crate::identity_billing::stripe_adapter::IStripeAdapter;

#[async_trait::async_trait]
pub trait IBillingOrchestrator: Send + Sync {
    async fn register_customer(&self, email: String) -> Result<Customer, String>;
    async fn generate_api_key(&self, customer_id: String) -> Result<ApiKey, String>;
    async fn revoke_api_key(&self, key_id: String) -> Result<(), String>;
    async fn handle_stripe_event(&self, event_type: String, payload: String) -> Result<(), String>;
}

pub struct BillingOrchestrator {
    repository: Arc<dyn IBillingRepository>,
    stripe_adapter: Arc<dyn IStripeAdapter>,
}

impl BillingOrchestrator {
    pub fn new(repository: Arc<dyn IBillingRepository>, stripe_adapter: Arc<dyn IStripeAdapter>) -> Self {
        Self { repository, stripe_adapter }
    }
}

#[async_trait::async_trait]
impl IBillingOrchestrator for BillingOrchestrator {
    async fn register_customer(&self, email: String) -> Result<Customer, String> {
        // Step 1: Provision Stripe Customer.
        let stripe_customer_id = self.stripe_adapter.create_stripe_customer(email.clone())
            .await
            .map_err(|e| format!("Stripe API error: {}", e))?;

        // Step 2: Save newly created Customer entity into database.
        let customer = Customer {
            id: Uuid::new_v4(),
            email,
            stripe_customer_id: Some(stripe_customer_id),
            created_at: Utc::now(),
            updated_at: Utc::now(),
        };

        self.repository.save_customer(&customer)
            .await
            .map_err(|e| format!("Database save error: {}", e))?;

        Ok(customer)
    }

    async fn generate_api_key(&self, customer_id: String) -> Result<ApiKey, String> {
        // Step 1: Generate random key bytes and prefix.
        let customer_uuid = Uuid::parse_str(&customer_id)
            .map_err(|e| format!("Invalid customer ID UUID: {}", e))?;

        let prefix_rand = &Uuid::new_v4().to_string().replace("-", "")[..8];
        let prefix = format!("gkp_{}", prefix_rand);
        let secret = Uuid::new_v4().to_string().replace("-", "");
        let plain_key = format!("{}_{}", prefix, secret);

        // Step 2: Compute key hash using SHA-256 algorithm.
        let mut hasher = Sha256::new();
        hasher.update(plain_key.as_bytes());
        let key_hash = format!("{:x}", hasher.finalize());

        // Step 3: Persist generated ApiKey details in database.
        let api_key = ApiKey {
            id: Uuid::new_v4(),
            customer_id: customer_uuid,
            key_hash,
            prefix,
            status: "active".to_string(),
            created_at: Utc::now(),
            updated_at: Utc::now(),
            plain_key: Some(plain_key),
        };

        self.repository.save_api_key(&api_key)
            .await
            .map_err(|e| format!("Database error: {}", e))?;

        Ok(api_key)
    }

    async fn revoke_api_key(&self, key_id: String) -> Result<(), String> {
        // Step 1: Revoke api key status in database.
        let key_uuid = Uuid::parse_str(&key_id)
            .map_err(|e| format!("Invalid key ID UUID: {}", e))?;

        self.repository.revoke_api_key(&key_uuid)
            .await
            .map_err(|e| format!("Database error: {}", e))?;

        Ok(())
    }

    async fn handle_stripe_event(&self, event_type: String, payload: String) -> Result<(), String> {
        // Step 1: Parse Stripe Webhook event fields.
        let parsed_event: serde_json::Value = serde_json::from_str(&payload)
            .map_err(|e| format!("Invalid JSON payload: {}", e))?;

        let data_obj = parsed_event.get("data")
            .and_then(|d| d.get("object"))
            .ok_or_else(|| "Missing subscription object in payload".to_string())?;

        let stripe_sub_id = data_obj.get("id")
            .and_then(|id| id.as_str())
            .ok_or_else(|| "Missing subscription id".to_string())?;

        let stripe_customer_id = data_obj.get("customer")
            .and_then(|c| c.as_str())
            .ok_or_else(|| "Missing customer id".to_string())?;

        let status = data_obj.get("status")
            .and_then(|s| s.as_str())
            .unwrap_or("active");

        let current_period_start_sec = data_obj.get("current_period_start")
            .and_then(|t| t.as_i64())
            .unwrap_or_else(|| Utc::now().timestamp());

        let current_period_end_sec = data_obj.get("current_period_end")
            .and_then(|t| t.as_i64())
            .unwrap_or_else(|| Utc::now().timestamp());

        let tier_id = data_obj.get("items")
            .and_then(|items| items.get("data"))
            .and_then(|data| data.as_array())
            .and_then(|arr| arr.first())
            .and_then(|first| first.get("price"))
            .and_then(|price| {
                price.get("lookup_key")
                    .and_then(|lk| lk.as_str().map(|s| s.to_string()))
                    .or_else(|| price.get("product").and_then(|p| p.as_str().map(|s| s.to_string())))
            })
            .unwrap_or_else(|| "free".to_string());

        // Step 2: Save or update active Subscription limits records.
        let customer = self.repository.find_customer_by_stripe_customer_id(stripe_customer_id)
            .await
            .map_err(|e| format!("Database query error: {}", e))?
            .ok_or_else(|| format!("Customer with Stripe ID {} not found", stripe_customer_id))?;

        let existing_sub = self.repository.find_subscription_by_customer_id(&customer.id)
            .await
            .map_err(|e| format!("Database query error: {}", e))?;

        let sub_id = match existing_sub {
            Some(ref existing) => existing.id,
            None => Uuid::new_v4(),
        };

        let current_period_start = chrono::DateTime::from_timestamp(current_period_start_sec, 0)
            .unwrap_or_else(|| Utc::now());
        let current_period_end = chrono::DateTime::from_timestamp(current_period_end_sec, 0)
            .unwrap_or_else(|| Utc::now());

        let sub_status = if event_type == "customer.subscription.deleted" {
            "canceled".to_string()
        } else {
            status.to_string()
        };

        let sub = Subscription {
            id: sub_id,
            customer_id: customer.id,
            stripe_subscription_id: Some(stripe_sub_id.to_string()),
            tier_id,
            status: sub_status,
            current_period_start,
            current_period_end,
            created_at: existing_sub.map(|s| s.created_at).unwrap_or_else(Utc::now),
            updated_at: Utc::now(),
        };

        self.repository.save_subscription(&sub)
            .await
            .map_err(|e| format!("Failed to save subscription: {}", e))?;

        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{Customer, ApiKey, Subscription, SubscriptionTier, StripeSubscriptionDetails};
    use std::sync::Mutex;

    struct MockStripeAdapter {
        customer_id: String,
    }

    #[async_trait::async_trait]
    impl IStripeAdapter for MockStripeAdapter {
        async fn create_stripe_customer(&self, _email: String) -> Result<String, reqwest::Error> {
            Ok(self.customer_id.clone())
        }

        async fn fetch_subscription(&self, stripe_sub_id: String) -> Result<StripeSubscriptionDetails, reqwest::Error> {
            Ok(StripeSubscriptionDetails {
                stripe_subscription_id: stripe_sub_id,
                stripe_customer_id: "cus_test".to_string(),
                tier_id: "pro".to_string(),
                status: "active".to_string(),
                current_period_start: Utc::now(),
                current_period_end: Utc::now(),
            })
        }
    }

    struct MockBillingRepository {
        customers: Mutex<Vec<Customer>>,
        subscriptions: Mutex<Vec<Subscription>>,
        keys: Mutex<Vec<ApiKey>>,
    }

    #[async_trait::async_trait]
    impl IBillingRepository for MockBillingRepository {
        async fn save_customer(&self, customer: &Customer) -> Result<(), sqlx::Error> {
            let mut guard = self.customers.lock().unwrap();
            guard.push(customer.clone());
            Ok(())
        }

        async fn find_customer_by_id(&self, id: &Uuid) -> Result<Option<Customer>, sqlx::Error> {
            let guard = self.customers.lock().unwrap();
            Ok(guard.iter().find(|c| c.id == *id).cloned())
        }

        async fn find_customer_by_api_key(&self, _key_hash: &str) -> Result<Option<Customer>, sqlx::Error> {
            Ok(None)
        }

        async fn save_api_key(&self, key: &ApiKey) -> Result<(), sqlx::Error> {
            let mut guard = self.keys.lock().unwrap();
            guard.push(key.clone());
            Ok(())
        }

        async fn revoke_api_key(&self, id: &Uuid) -> Result<(), sqlx::Error> {
            let mut guard = self.keys.lock().unwrap();
            if let Some(key) = guard.iter_mut().find(|k| k.id == *id) {
                key.status = "revoked".to_string();
            }
            Ok(())
        }

        async fn save_subscription(&self, sub: &Subscription) -> Result<(), sqlx::Error> {
            let mut guard = self.subscriptions.lock().unwrap();
            guard.push(sub.clone());
            Ok(())
        }

        async fn find_subscription_by_customer_id(&self, customer_id: &Uuid) -> Result<Option<Subscription>, sqlx::Error> {
            let guard = self.subscriptions.lock().unwrap();
            Ok(guard.iter().find(|s| s.customer_id == *customer_id).cloned())
        }

        async fn find_tier_by_id(&self, _tier_id: &str) -> Result<Option<SubscriptionTier>, sqlx::Error> {
            Ok(None)
        }

        async fn save_tier(&self, _tier: &SubscriptionTier) -> Result<(), sqlx::Error> {
            Ok(())
        }

        async fn find_customer_by_stripe_customer_id(&self, stripe_customer_id: &str) -> Result<Option<Customer>, sqlx::Error> {
            let guard = self.customers.lock().unwrap();
            Ok(guard.iter().find(|c| c.stripe_customer_id.as_deref() == Some(stripe_customer_id)).cloned())
        }

        async fn find_customer_by_subscription_id(&self, subscription_id: &str) -> Result<Option<Customer>, sqlx::Error> {
            let sub_guard = self.subscriptions.lock().unwrap();
            let sub = sub_guard.iter().find(|s| {
                s.stripe_subscription_id.as_deref() == Some(subscription_id) || s.id.to_string() == subscription_id
            });
            if let Some(s) = sub {
                let cust_guard = self.customers.lock().unwrap();
                Ok(cust_guard.iter().find(|c| c.id == s.customer_id).cloned())
            } else {
                Ok(None)
            }
        }
    }

    #[tokio::test]
    async fn test_register_customer() {
        let repo = Arc::new(MockBillingRepository {
            customers: Mutex::new(Vec::new()),
            subscriptions: Mutex::new(Vec::new()),
            keys: Mutex::new(Vec::new()),
        });
        let stripe = Arc::new(MockStripeAdapter {
            customer_id: "cus_test_123".to_string(),
        });
        let orchestrator = BillingOrchestrator::new(repo.clone(), stripe);

        let customer = orchestrator.register_customer("test@example.com".to_string()).await.unwrap();
        assert_eq!(customer.email, "test@example.com");
        assert_eq!(customer.stripe_customer_id, Some("cus_test_123".to_string()));

        let customers_guard = repo.customers.lock().unwrap();
        assert_eq!(customers_guard.len(), 1);
        assert_eq!(customers_guard[0].id, customer.id);
    }

    #[tokio::test]
    async fn test_generate_and_revoke_api_key() {
        let repo = Arc::new(MockBillingRepository {
            customers: Mutex::new(Vec::new()),
            subscriptions: Mutex::new(Vec::new()),
            keys: Mutex::new(Vec::new()),
        });
        let stripe = Arc::new(MockStripeAdapter {
            customer_id: "cus_test_123".to_string(),
        });
        let orchestrator = BillingOrchestrator::new(repo.clone(), stripe);

        let cust_id = Uuid::new_v4();
        let api_key = orchestrator.generate_api_key(cust_id.to_string()).await.unwrap();
        assert_eq!(api_key.customer_id, cust_id);
        assert_eq!(api_key.status, "active");
        assert!(api_key.plain_key.is_some());
        
        let keys_guard = repo.keys.lock().unwrap();
        assert_eq!(keys_guard.len(), 1);
        assert_eq!(keys_guard[0].id, api_key.id);
        drop(keys_guard);

        orchestrator.revoke_api_key(api_key.id.to_string()).await.unwrap();
        let keys_guard = repo.keys.lock().unwrap();
        assert_eq!(keys_guard[0].status, "revoked");
    }

    #[tokio::test]
    async fn test_handle_stripe_event() {
        let repo = Arc::new(MockBillingRepository {
            customers: Mutex::new(Vec::new()),
            subscriptions: Mutex::new(Vec::new()),
            keys: Mutex::new(Vec::new()),
        });
        let stripe = Arc::new(MockStripeAdapter {
            customer_id: "cus_test_123".to_string(),
        });
        
        // Register customer first
        let customer = Customer {
            id: Uuid::new_v4(),
            email: "test@example.com".to_string(),
            stripe_customer_id: Some("cus_test_123".to_string()),
            created_at: Utc::now(),
            updated_at: Utc::now(),
        };
        repo.customers.lock().unwrap().push(customer.clone());

        let orchestrator = BillingOrchestrator::new(repo.clone(), stripe);

        let event_payload = r#"{
            "type": "customer.subscription.created",
            "data": {
                "object": {
                    "id": "sub_test_123",
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
                }
            }
        }"#;

        orchestrator.handle_stripe_event("customer.subscription.created".to_string(), event_payload.to_string()).await.unwrap();

        let subs_guard = repo.subscriptions.lock().unwrap();
        assert_eq!(subs_guard.len(), 1);
        assert_eq!(subs_guard[0].stripe_subscription_id, Some("sub_test_123".to_string()));
        assert_eq!(subs_guard[0].customer_id, customer.id);
        assert_eq!(subs_guard[0].tier_id, "pro");
    }
}
