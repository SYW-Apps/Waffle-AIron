use crate::models::{CustomerDetails, RegistryError};
use crate::billing::database_adapter::DatabaseAdapter;
use async_trait::async_trait;
use std::sync::Arc;

#[async_trait]
pub trait CustomerRegistry {
    async fn save_customer(&self, customer: CustomerDetails) -> Result<(), RegistryError>;
}

pub struct CustomerRegistryImpl {
    database_adapter: Arc<dyn DatabaseAdapter + Send + Sync>,
}

impl CustomerRegistryImpl {
    pub fn new(database_adapter: Arc<dyn DatabaseAdapter + Send + Sync>) -> Self {
        Self { database_adapter }
    }
}

#[async_trait]
impl CustomerRegistry for CustomerRegistryImpl {
    async fn save_customer(&self, customer: CustomerDetails) -> Result<(), RegistryError> {
        // Step 1: Call the database adapter to execute INSERT or UPDATE on the PostgreSQL customers table
        let query = "
            INSERT INTO customers (id, email, stripe_customer_id)
            VALUES ($1, $2, $3)
            ON CONFLICT (id) DO UPDATE
            SET email = EXCLUDED.email, stripe_customer_id = EXCLUDED.stripe_customer_id
        ".to_string();

        let params = vec![
            customer.id.to_string(),
            customer.email,
            customer.stripe_customer_id.unwrap_or_default(),
        ];

        self.database_adapter
            .execute_query(query, params)
            .await
            .map_err(|e| RegistryError::DatabaseError(e.to_string()))?;

        // Step 2: Return registry success
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::DbError;
    use std::sync::Mutex;
    use uuid::Uuid;

    struct MockDatabaseAdapter {
        queries: Arc<Mutex<Vec<(String, Vec<String>)>>>,
        should_fail: bool,
    }

    #[async_trait]
    impl DatabaseAdapter for MockDatabaseAdapter {
        async fn execute_query(&self, query: String, params: Vec<String>) -> Result<u64, DbError> {
            if self.should_fail {
                return Err(DbError::QueryError("DB error".to_string()));
            }
            self.queries.lock().unwrap().push((query, params));
            Ok(1)
        }

        async fn fetch_row(&self, _query: String, _params: Vec<String>) -> Result<Option<String>, DbError> {
            Ok(None)
        }
    }

    #[tokio::test]
    async fn test_save_customer_success() {
        let queries = Arc::new(Mutex::new(Vec::new()));
        let adapter = Arc::new(MockDatabaseAdapter {
            queries: Arc::clone(&queries),
            should_fail: false,
        });

        let registry = CustomerRegistryImpl::new(adapter);
        let customer_id = Uuid::new_v4();
        let customer = CustomerDetails {
            id: customer_id,
            email: "alice@example.com".to_string(),
            stripe_customer_id: Some("cus_999".to_string()),
        };

        let result = registry.save_customer(customer).await;
        assert!(result.is_ok());

        let queries_guard = queries.lock().unwrap();
        assert_eq!(queries_guard.len(), 1);
        let (_, ref params) = queries_guard[0];
        assert_eq!(params[0], customer_id.to_string());
        assert_eq!(params[1], "alice@example.com");
        assert_eq!(params[2], "cus_999");
    }

    #[tokio::test]
    async fn test_save_customer_failure() {
        let queries = Arc::new(Mutex::new(Vec::new()));
        let adapter = Arc::new(MockDatabaseAdapter {
            queries: Arc::clone(&queries),
            should_fail: true,
        });

        // Cover fetch_row on MockDatabaseAdapter
        let _ = adapter.fetch_row("".to_string(), vec![]).await;

        let registry = CustomerRegistryImpl::new(adapter);
        let customer = CustomerDetails {
            id: Uuid::new_v4(),
            email: "error@example.com".to_string(),
            stripe_customer_id: None,
        };

        let result = registry.save_customer(customer).await;
        assert!(result.is_err());
        assert!(matches!(result.unwrap_err(), RegistryError::DatabaseError(_)));
    }
}
