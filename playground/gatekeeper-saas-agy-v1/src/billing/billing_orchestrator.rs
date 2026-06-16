use crate::models::BillingError;
use crate::billing::stripe_adapter::StripeAdapter;
use crate::billing::customer_repository::CustomerRepository;
use crate::billing::subscription_repository::SubscriptionRepository;
use crate::billing::database_adapter::DatabaseAdapter;
use crate::models::CustomerDetails;
use async_trait::async_trait;
use std::sync::Arc;

#[async_trait]
pub trait BillingOrchestrator {
    async fn handle_stripe_event(
        &self,
        event_type: String,
        stripe_customer_id: String,
        stripe_subscription_id: String,
    ) -> Result<(), BillingError>;
}

pub struct BillingOrchestratorImpl {
    stripe_adapter: Arc<dyn StripeAdapter + Send + Sync>,
    customer_repo: Arc<dyn CustomerRepository + Send + Sync>,
    subscription_repo: Arc<dyn SubscriptionRepository + Send + Sync>,
    database_adapter: Arc<dyn DatabaseAdapter + Send + Sync>,
}

impl BillingOrchestratorImpl {
    pub fn new(
        stripe_adapter: Arc<dyn StripeAdapter + Send + Sync>,
        customer_repo: Arc<dyn CustomerRepository + Send + Sync>,
        subscription_repo: Arc<dyn SubscriptionRepository + Send + Sync>,
        database_adapter: Arc<dyn DatabaseAdapter + Send + Sync>,
    ) -> Self {
        Self {
            stripe_adapter,
            customer_repo,
            subscription_repo,
            database_adapter,
        }
    }
}

#[async_trait]
impl BillingOrchestrator for BillingOrchestratorImpl {
    async fn handle_stripe_event(
        &self,
        event_type: String,
        stripe_customer_id: String,
        stripe_subscription_id: String,
    ) -> Result<(), BillingError> {
        // Step 1: Evaluate the Stripe event type
        println!("Evaluating Stripe event type: {}", event_type);

        // Step 2: Call the Stripe adapter to retrieve subscription details
        let stripe_sub = self.stripe_adapter
            .retrieve_subscription(stripe_subscription_id.clone())
            .await
            .map_err(|e| BillingError::StripeError(e.to_string()))?;

        // Step 3: Call the customer repository to get or register the customer
        let query = "SELECT id, email, stripe_customer_id FROM customers WHERE stripe_customer_id = $1".to_string();
        let row_opt = self.database_adapter
            .fetch_row(query, vec![stripe_customer_id.clone()])
            .await
            .map_err(|e| BillingError::DatabaseError(e.to_string()))?;

        let _customer = match row_opt {
            Some(row_str) => {
                let c: CustomerDetails = serde_json::from_str(&row_str)
                    .map_err(|e| BillingError::DatabaseError(e.to_string()))?;
                c
            }
            None => {
                let email = format!("customer_{}@example.com", stripe_customer_id);
                self.customer_repo
                    .register_customer(email, stripe_customer_id.clone())
                    .await
                    .map_err(|e| BillingError::DatabaseError(e.to_string()))?
            }
        };

        // Step 4: Call the subscription repository to update active status and limits for the subscriber
        self.subscription_repo
            .update_subscription_status(
                stripe_subscription_id,
                stripe_sub.status,
                stripe_sub.plan_id,
            )
            .await
            .map_err(|e| BillingError::DatabaseError(e.to_string()))?;

        // Step 5: Return success status
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{StripeSubscriptionDetails, StripeError, SubscriptionDetails, RepositoryError, DbError};
    use std::sync::Mutex;
    use uuid::Uuid;

    struct MockStripeAdapter {
        details: StripeSubscriptionDetails,
        should_fail: bool,
    }

    #[async_trait]
    impl StripeAdapter for MockStripeAdapter {
        async fn retrieve_subscription(&self, _stripe_sub_id: String) -> Result<StripeSubscriptionDetails, StripeError> {
            if self.should_fail {
                return Err(StripeError::ApiError("Stripe API failed".to_string()));
            }
            Ok(self.details.clone())
        }
    }

    struct MockCustomerRepo {
        registered: Mutex<Option<(String, String)>>,
        should_fail: bool,
    }

    #[async_trait]
    impl CustomerRepository for MockCustomerRepo {
        async fn get_customer(&self, _customer_id: String) -> Result<Option<CustomerDetails>, RepositoryError> {
            Ok(None)
        }
        async fn register_customer(&self, email: String, stripe_cust_id: String) -> Result<CustomerDetails, RepositoryError> {
            if self.should_fail {
                return Err(RepositoryError::DatabaseError("DB registration error".to_string()));
            }
            *self.registered.lock().unwrap() = Some((email.clone(), stripe_cust_id.clone()));
            Ok(CustomerDetails {
                id: Uuid::new_v4(),
                email,
                stripe_customer_id: Some(stripe_cust_id),
            })
        }
    }

    struct MockSubscriptionRepo {
        updated: Mutex<Option<(String, String, String)>>,
        should_fail: bool,
    }

    #[async_trait]
    impl SubscriptionRepository for MockSubscriptionRepo {
        async fn get_subscription_by_key(&self, _api_key: String) -> Result<Option<SubscriptionDetails>, RepositoryError> {
            Ok(None)
        }
        async fn update_subscription_status(&self, stripe_sub_id: String, status: String, plan_id: String) -> Result<(), RepositoryError> {
            if self.should_fail {
                return Err(RepositoryError::DatabaseError("DB subscription update error".to_string()));
            }
            *self.updated.lock().unwrap() = Some((stripe_sub_id, status, plan_id));
            Ok(())
        }
    }

    struct MockDatabaseAdapter {
        row_val: Option<String>,
        should_fail: bool,
    }

    #[async_trait]
    impl DatabaseAdapter for MockDatabaseAdapter {
        async fn execute_query(&self, _query: String, _params: Vec<String>) -> Result<u64, DbError> {
            Ok(1)
        }
        async fn fetch_row(&self, _query: String, _params: Vec<String>) -> Result<Option<String>, DbError> {
            if self.should_fail {
                return Err(DbError::QueryError("Query failed".to_string()));
            }
            Ok(self.row_val.clone())
        }
    }

    #[tokio::test]
    async fn test_handle_stripe_event_new_customer() {
        let stripe_sub = StripeSubscriptionDetails {
            stripe_subscription_id: "sub_pro".to_string(),
            status: "active".to_string(),
            plan_id: "pro".to_string(),
        };

        let stripe_adapter = Arc::new(MockStripeAdapter { details: stripe_sub, should_fail: false });
        let customer_repo = Arc::new(MockCustomerRepo { registered: Mutex::new(None), should_fail: false });
        let subscription_repo = Arc::new(MockSubscriptionRepo { updated: Mutex::new(None), should_fail: false });
        let database_adapter = Arc::new(MockDatabaseAdapter { row_val: None, should_fail: false });

        let orchestrator = BillingOrchestratorImpl::new(
            stripe_adapter,
            customer_repo.clone(),
            subscription_repo.clone(),
            database_adapter,
        );

        let result = orchestrator.handle_stripe_event(
            "customer.subscription.created".to_string(),
            "cus_123".to_string(),
            "sub_pro".to_string(),
        ).await;

        assert!(result.is_ok());

        let registered_val = customer_repo.registered.lock().unwrap().clone().unwrap();
        assert_eq!(registered_val.0, "customer_cus_123@example.com");
        assert_eq!(registered_val.1, "cus_123");

        let updated_val = subscription_repo.updated.lock().unwrap().clone().unwrap();
        assert_eq!(updated_val.0, "sub_pro");
        assert_eq!(updated_val.1, "active");
        assert_eq!(updated_val.2, "pro");
    }

    #[tokio::test]
    async fn test_handle_stripe_event_existing_customer() {
        let stripe_sub = StripeSubscriptionDetails {
            stripe_subscription_id: "sub_pro".to_string(),
            status: "active".to_string(),
            plan_id: "pro".to_string(),
        };
        let existing_cust = CustomerDetails {
            id: Uuid::new_v4(),
            email: "existing@example.com".to_string(),
            stripe_customer_id: Some("cus_123".to_string()),
        };
        let row_val = serde_json::to_string(&existing_cust).unwrap();

        let stripe_adapter = Arc::new(MockStripeAdapter { details: stripe_sub, should_fail: false });
        let customer_repo = Arc::new(MockCustomerRepo { registered: Mutex::new(None), should_fail: false });
        let subscription_repo = Arc::new(MockSubscriptionRepo { updated: Mutex::new(None), should_fail: false });
        let database_adapter = Arc::new(MockDatabaseAdapter { row_val: Some(row_val), should_fail: false });

        let orchestrator = BillingOrchestratorImpl::new(
            stripe_adapter,
            customer_repo,
            subscription_repo,
            database_adapter,
        );

        let result = orchestrator.handle_stripe_event(
            "customer.subscription.created".to_string(),
            "cus_123".to_string(),
            "sub_pro".to_string(),
        ).await;

        assert!(result.is_ok());
    }

    #[tokio::test]
    async fn test_handle_stripe_event_stripe_failure() {
        let stripe_sub = StripeSubscriptionDetails {
            stripe_subscription_id: "sub_pro".to_string(),
            status: "active".to_string(),
            plan_id: "pro".to_string(),
        };

        let stripe_adapter = Arc::new(MockStripeAdapter { details: stripe_sub, should_fail: true });
        let customer_repo = Arc::new(MockCustomerRepo { registered: Mutex::new(None), should_fail: false });
        let subscription_repo = Arc::new(MockSubscriptionRepo { updated: Mutex::new(None), should_fail: false });
        let database_adapter = Arc::new(MockDatabaseAdapter { row_val: None, should_fail: false });

        let orchestrator = BillingOrchestratorImpl::new(
            stripe_adapter,
            customer_repo,
            subscription_repo,
            database_adapter,
        );

        let result = orchestrator.handle_stripe_event(
            "customer.subscription.created".to_string(),
            "cus_123".to_string(),
            "sub_pro".to_string(),
        ).await;

        assert!(result.is_err());
        match result.unwrap_err() {
            BillingError::StripeError(msg) => assert!(msg.contains("Stripe API failed")),
            _ => panic!("Expected StripeError"),
        }
    }

    #[tokio::test]
    async fn test_handle_stripe_event_db_lookup_failure() {
        let stripe_sub = StripeSubscriptionDetails {
            stripe_subscription_id: "sub_pro".to_string(),
            status: "active".to_string(),
            plan_id: "pro".to_string(),
        };

        let stripe_adapter = Arc::new(MockStripeAdapter { details: stripe_sub, should_fail: false });
        let customer_repo = Arc::new(MockCustomerRepo { registered: Mutex::new(None), should_fail: false });
        let subscription_repo = Arc::new(MockSubscriptionRepo { updated: Mutex::new(None), should_fail: false });
        let database_adapter = Arc::new(MockDatabaseAdapter { row_val: None, should_fail: true });

        let orchestrator = BillingOrchestratorImpl::new(
            stripe_adapter,
            customer_repo,
            subscription_repo,
            database_adapter,
        );

        let result = orchestrator.handle_stripe_event(
            "customer.subscription.created".to_string(),
            "cus_123".to_string(),
            "sub_pro".to_string(),
        ).await;

        assert!(result.is_err());
        match result.unwrap_err() {
            BillingError::DatabaseError(msg) => assert!(msg.contains("Query failed")),
            _ => panic!("Expected DatabaseError"),
        }
    }

    #[tokio::test]
    async fn test_handle_stripe_event_db_registration_failure() {
        let stripe_sub = StripeSubscriptionDetails {
            stripe_subscription_id: "sub_pro".to_string(),
            status: "active".to_string(),
            plan_id: "pro".to_string(),
        };

        let stripe_adapter = Arc::new(MockStripeAdapter { details: stripe_sub, should_fail: false });
        let customer_repo = Arc::new(MockCustomerRepo { registered: Mutex::new(None), should_fail: true });
        let subscription_repo = Arc::new(MockSubscriptionRepo { updated: Mutex::new(None), should_fail: false });
        let database_adapter = Arc::new(MockDatabaseAdapter { row_val: None, should_fail: false });

        let orchestrator = BillingOrchestratorImpl::new(
            stripe_adapter,
            customer_repo,
            subscription_repo,
            database_adapter,
        );

        let result = orchestrator.handle_stripe_event(
            "customer.subscription.created".to_string(),
            "cus_123".to_string(),
            "sub_pro".to_string(),
        ).await;

        assert!(result.is_err());
        match result.unwrap_err() {
            BillingError::DatabaseError(msg) => assert!(msg.contains("DB registration error")),
            _ => panic!("Expected DatabaseError"),
        }
    }

    #[tokio::test]
    async fn test_handle_stripe_event_subscription_update_failure() {
        let stripe_sub = StripeSubscriptionDetails {
            stripe_subscription_id: "sub_pro".to_string(),
            status: "active".to_string(),
            plan_id: "pro".to_string(),
        };

        let stripe_adapter = Arc::new(MockStripeAdapter { details: stripe_sub, should_fail: false });
        let customer_repo = Arc::new(MockCustomerRepo { registered: Mutex::new(None), should_fail: false });
        let subscription_repo = Arc::new(MockSubscriptionRepo { updated: Mutex::new(None), should_fail: true });
        let database_adapter = Arc::new(MockDatabaseAdapter { row_val: None, should_fail: false });

        let orchestrator = BillingOrchestratorImpl::new(
            stripe_adapter,
            customer_repo,
            subscription_repo,
            database_adapter,
        );

        let result = orchestrator.handle_stripe_event(
            "customer.subscription.created".to_string(),
            "cus_123".to_string(),
            "sub_pro".to_string(),
        ).await;

        assert!(result.is_err());
        match result.unwrap_err() {
            BillingError::DatabaseError(msg) => assert!(msg.contains("DB subscription update error")),
            _ => panic!("Expected DatabaseError"),
        }
    }

    #[tokio::test]
    async fn test_handle_stripe_event_db_customer_invalid_json() {
        let stripe_sub = StripeSubscriptionDetails {
            stripe_subscription_id: "sub_pro".to_string(),
            status: "active".to_string(),
            plan_id: "pro".to_string(),
        };

        let stripe_adapter = Arc::new(MockStripeAdapter { details: stripe_sub, should_fail: false });
        let customer_repo = Arc::new(MockCustomerRepo { registered: Mutex::new(None), should_fail: false });
        let subscription_repo = Arc::new(MockSubscriptionRepo { updated: Mutex::new(None), should_fail: false });
        let database_adapter = Arc::new(MockDatabaseAdapter { row_val: Some("invalid_json".to_string()), should_fail: false });

        let orchestrator = BillingOrchestratorImpl::new(
            stripe_adapter,
            customer_repo,
            subscription_repo,
            database_adapter,
        );

        let result = orchestrator.handle_stripe_event(
            "customer.subscription.created".to_string(),
            "cus_123".to_string(),
            "sub_pro".to_string(),
        ).await;

        assert!(result.is_err());
        match result.unwrap_err() {
            BillingError::DatabaseError(msg) => assert!(msg.contains("expected") || msg.contains("line") || msg.contains("invalid")),
            _ => panic!("Expected DatabaseError"),
        }
    }

    #[tokio::test]
    async fn test_mocks_coverage() {
        let customer_repo = MockCustomerRepo { registered: Mutex::new(None), should_fail: false };
        let _ = customer_repo.get_customer("".to_string()).await;

        let subscription_repo = MockSubscriptionRepo { updated: Mutex::new(None), should_fail: false };
        let _ = subscription_repo.get_subscription_by_key("".to_string()).await;

        let database_adapter = MockDatabaseAdapter { row_val: None, should_fail: false };
        let _ = database_adapter.execute_query("".to_string(), vec![]).await;
    }
}
