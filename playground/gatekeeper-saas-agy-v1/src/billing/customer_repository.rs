use crate::models::{CustomerDetails, RepositoryError};
use crate::billing::customer_store::CustomerStore;
use crate::billing::customer_registry::CustomerRegistry;
use crate::billing::database_adapter::DatabaseAdapter;
use async_trait::async_trait;
use std::sync::Arc;
use uuid::Uuid;

#[async_trait]
pub trait CustomerRepository {
    async fn get_customer(&self, customer_id: String) -> Result<Option<CustomerDetails>, RepositoryError>;
    async fn register_customer(&self, email: String, stripe_cust_id: String) -> Result<CustomerDetails, RepositoryError>;
}

pub struct CustomerRepositoryImpl {
    customer_store: Arc<dyn CustomerStore + Send + Sync>,
    customer_registry: Arc<dyn CustomerRegistry + Send + Sync>,
    database_adapter: Arc<dyn DatabaseAdapter + Send + Sync>,
}

impl CustomerRepositoryImpl {
    pub fn new(
        customer_store: Arc<dyn CustomerStore + Send + Sync>,
        customer_registry: Arc<dyn CustomerRegistry + Send + Sync>,
        database_adapter: Arc<dyn DatabaseAdapter + Send + Sync>,
    ) -> Self {
        Self {
            customer_store,
            customer_registry,
            database_adapter,
        }
    }
}

#[async_trait]
impl CustomerRepository for CustomerRepositoryImpl {
    async fn get_customer(&self, customer_id: String) -> Result<Option<CustomerDetails>, RepositoryError> {
        // Step 1: Call the customer store to check for cached customer details
        if let Some(cached) = self.customer_store.get_cached_customer(&customer_id) {
            return Ok(Some(cached));
        }

        // Step 2: If cache missed, call the database adapter to fetch customer from PostgreSQL
        let query = "SELECT id, email, stripe_customer_id FROM customers WHERE id = $1".to_string();
        let params = vec![customer_id.clone()];
        let row_opt = self.database_adapter
            .fetch_row(query, params)
            .await
            .map_err(|e| RepositoryError::DatabaseError(e.to_string()))?;

        match row_opt {
            Some(row_str) => {
                let customer: CustomerDetails = serde_json::from_str(&row_str)
                    .map_err(|e| RepositoryError::DatabaseError(e.to_string()))?;

                // Step 3: If found, call the customer store to cache the customer details
                self.customer_store.update_cached_customer(customer.clone());

                // Step 4: Return customer details
                Ok(Some(customer))
            }
            None => Ok(None)
        }
    }

    async fn register_customer(&self, email: String, stripe_cust_id: String) -> Result<CustomerDetails, RepositoryError> {
        // Step 1: Call the customer registry to save the new customer details in PostgreSQL
        let customer = CustomerDetails {
            id: Uuid::new_v4(),
            email,
            stripe_customer_id: Some(stripe_cust_id),
        };

        self.customer_registry
            .save_customer(customer.clone())
            .await
            .map_err(|e| RepositoryError::DatabaseError(e.to_string()))?;

        // Step 2: Call the customer store to cache the new customer details
        self.customer_store.update_cached_customer(customer.clone());

        // Step 3: Return registered customer details
        Ok(customer)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{CustomerDetails, DbError, RegistryError};
    use std::sync::Mutex;

    struct MockCustomerStore {
        cached: Mutex<Option<CustomerDetails>>,
    }

    impl CustomerStore for MockCustomerStore {
        fn get_cached_customer(&self, _customer_id: &str) -> Option<CustomerDetails> {
            self.cached.lock().unwrap().clone()
        }

        fn update_cached_customer(&self, customer: CustomerDetails) {
            *self.cached.lock().unwrap() = Some(customer);
        }
    }

    struct MockCustomerRegistry {
        saved: Mutex<Option<CustomerDetails>>,
        should_fail: bool,
    }

    #[async_trait]
    impl CustomerRegistry for MockCustomerRegistry {
        async fn save_customer(&self, customer: CustomerDetails) -> Result<(), RegistryError> {
            if self.should_fail {
                return Err(RegistryError::DatabaseError("Registry save failed".to_string()));
            }
            *self.saved.lock().unwrap() = Some(customer);
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
                return Err(DbError::QueryError("DB fetch failed".to_string()));
            }
            Ok(self.row_val.clone())
        }
    }

    #[tokio::test]
    async fn test_get_customer_cache_hit() {
        let customer = CustomerDetails {
            id: Uuid::new_v4(),
            email: "bob@example.com".to_string(),
            stripe_customer_id: Some("cus_1".to_string()),
        };

        let store = Arc::new(MockCustomerStore {
            cached: Mutex::new(Some(customer.clone())),
        });
        let registry = Arc::new(MockCustomerRegistry {
            saved: Mutex::new(None),
            should_fail: false,
        });
        let db = Arc::new(MockDatabaseAdapter { row_val: None, should_fail: false });

        let repository = CustomerRepositoryImpl::new(store, registry, db);
        let result = repository.get_customer(customer.id.to_string()).await;
        assert!(result.is_ok());
        let opt = result.unwrap();
        assert!(opt.is_some());
        assert_eq!(opt.unwrap().email, "bob@example.com");
    }

    #[tokio::test]
    async fn test_get_customer_cache_miss() {
        let customer = CustomerDetails {
            id: Uuid::new_v4(),
            email: "bob@example.com".to_string(),
            stripe_customer_id: Some("cus_1".to_string()),
        };
        let row_json = serde_json::to_string(&customer).unwrap();

        let store = Arc::new(MockCustomerStore {
            cached: Mutex::new(None),
        });
        let registry = Arc::new(MockCustomerRegistry {
            saved: Mutex::new(None),
            should_fail: false,
        });
        let db = Arc::new(MockDatabaseAdapter { row_val: Some(row_json), should_fail: false });

        let repository = CustomerRepositoryImpl::new(store.clone(), registry, db);
        let result = repository.get_customer(customer.id.to_string()).await;
        assert!(result.is_ok());
        let opt = result.unwrap();
        assert!(opt.is_some());
        assert_eq!(opt.unwrap().email, "bob@example.com");

        // Verify it was cached
        let cached = store.get_cached_customer(&customer.id.to_string());
        assert!(cached.is_some());
        assert_eq!(cached.unwrap().email, "bob@example.com");
    }

    #[tokio::test]
    async fn test_register_customer() {
        let store = Arc::new(MockCustomerStore {
            cached: Mutex::new(None),
        });
        let registry = Arc::new(MockCustomerRegistry {
            saved: Mutex::new(None),
            should_fail: false,
        });
        let db = Arc::new(MockDatabaseAdapter { row_val: None, should_fail: false });

        let repository = CustomerRepositoryImpl::new(store.clone(), registry.clone(), db);
        let result = repository.register_customer("new@example.com".to_string(), "cus_new".to_string()).await;
        assert!(result.is_ok());
        let customer = result.unwrap();
        assert_eq!(customer.email, "new@example.com");

        // Verify registry and store updated
        let registered = registry.saved.lock().unwrap().clone().unwrap();
        assert_eq!(registered.email, "new@example.com");
        let cached = store.get_cached_customer(&customer.id.to_string()).unwrap();
        assert_eq!(cached.email, "new@example.com");
    }

    #[tokio::test]
    async fn test_get_customer_db_error() {
        let store = Arc::new(MockCustomerStore { cached: Mutex::new(None) });
        let registry = Arc::new(MockCustomerRegistry { saved: Mutex::new(None), should_fail: false });
        let db = Arc::new(MockDatabaseAdapter { row_val: None, should_fail: true });

        // Cover execute_query in MockDatabaseAdapter
        let _ = db.execute_query("".to_string(), vec![]).await;

        let repository = CustomerRepositoryImpl::new(store, registry, db);
        let result = repository.get_customer(Uuid::new_v4().to_string()).await;
        assert!(result.is_err());
        assert!(matches!(result.unwrap_err(), RepositoryError::DatabaseError(_)));
    }

    #[tokio::test]
    async fn test_get_customer_invalid_json() {
        let store = Arc::new(MockCustomerStore { cached: Mutex::new(None) });
        let registry = Arc::new(MockCustomerRegistry { saved: Mutex::new(None), should_fail: false });
        let db = Arc::new(MockDatabaseAdapter { row_val: Some("invalid_json".to_string()), should_fail: false });

        let repository = CustomerRepositoryImpl::new(store, registry, db);
        let result = repository.get_customer(Uuid::new_v4().to_string()).await;
        assert!(result.is_err());
        assert!(matches!(result.unwrap_err(), RepositoryError::DatabaseError(_)));
    }

    #[tokio::test]
    async fn test_register_customer_registry_error() {
        let store = Arc::new(MockCustomerStore { cached: Mutex::new(None) });
        let registry = Arc::new(MockCustomerRegistry { saved: Mutex::new(None), should_fail: true });
        let db = Arc::new(MockDatabaseAdapter { row_val: None, should_fail: false });

        let repository = CustomerRepositoryImpl::new(store, registry, db);
        let result = repository.register_customer("error@example.com".to_string(), "cus_err".to_string()).await;
        assert!(result.is_err());
        assert!(matches!(result.unwrap_err(), RepositoryError::DatabaseError(_)));
    }
}
