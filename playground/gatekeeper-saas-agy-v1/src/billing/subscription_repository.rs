use crate::models::{SubscriptionDetails, RepositoryError};
use crate::billing::subscription_store::SubscriptionStore;
use crate::billing::database_adapter::DatabaseAdapter;
use async_trait::async_trait;
use std::sync::Arc;

#[async_trait]
pub trait SubscriptionRepository {
    async fn get_subscription_by_key(&self, api_key: String) -> Result<Option<SubscriptionDetails>, RepositoryError>;
    async fn update_subscription_status(&self, stripe_sub_id: String, status: String, plan_id: String) -> Result<(), RepositoryError>;
}

pub struct SubscriptionRepositoryImpl {
    subscription_store: Arc<dyn SubscriptionStore + Send + Sync>,
    database_adapter: Arc<dyn DatabaseAdapter + Send + Sync>,
}

impl SubscriptionRepositoryImpl {
    pub fn new(
        subscription_store: Arc<dyn SubscriptionStore + Send + Sync>,
        database_adapter: Arc<dyn DatabaseAdapter + Send + Sync>,
    ) -> Self {
        Self {
            subscription_store,
            database_adapter,
        }
    }
}

#[async_trait]
impl SubscriptionRepository for SubscriptionRepositoryImpl {
    async fn get_subscription_by_key(&self, api_key: String) -> Result<Option<SubscriptionDetails>, RepositoryError> {
        // Step 1: Call the subscription store to check for cached subscription details
        if let Some(cached) = self.subscription_store.get_cached_subscription(&api_key) {
            return Ok(Some(cached));
        }

        // Step 2: If cache missed, call the database adapter to fetch subscription from PostgreSQL
        let query = "
            SELECT s.id, s.customer_id, c.email AS customer_email, s.stripe_subscription_id, s.status, s.tier_id, s.api_limit, s.current_period_start, s.current_period_end
            FROM subscriptions s
            JOIN customers c ON s.customer_id = c.id
            WHERE s.api_key = $1
        ".to_string();

        let row_opt = self.database_adapter
            .fetch_row(query, vec![api_key.clone()])
            .await
            .map_err(|e| RepositoryError::DatabaseError(e.to_string()))?;

        match row_opt {
            Some(row_str) => {
                let sub: SubscriptionDetails = serde_json::from_str(&row_str)
                    .map_err(|e| RepositoryError::DatabaseError(e.to_string()))?;

                // Step 3: If found, call the subscription store to cache the subscription details
                self.subscription_store.update_cached_subscription(api_key, sub.clone());

                // Step 4: Return subscription details
                Ok(Some(sub))
            }
            None => Ok(None),
        }
    }

    async fn update_subscription_status(&self, stripe_sub_id: String, status: String, plan_id: String) -> Result<(), RepositoryError> {
        let api_limit = match plan_id.as_str() {
            "free" => 10000,
            "pro" => 500000,
            "enterprise" => 10000000,
            _ => 10000,
        };

        // Step 1: Call the database adapter to update the subscription status and limits in PostgreSQL
        let update_query = "
            UPDATE subscriptions
            SET status = $1, tier_id = $2, api_limit = $3
            WHERE stripe_subscription_id = $4
        ".to_string();

        self.database_adapter
            .execute_query(update_query, vec![
                status.clone(),
                plan_id.clone(),
                api_limit.to_string(),
                stripe_sub_id.clone(),
            ])
            .await
            .map_err(|e| RepositoryError::DatabaseError(e.to_string()))?;

        // Step 2: Call the subscription store to update the cached subscription status
        // To update the cache, we look up the updated subscription details from DB to get the api_key.
        let fetch_query = "
            SELECT s.id, s.customer_id, c.email as customer_email, s.stripe_subscription_id, s.status, s.tier_id, s.api_limit, s.current_period_start, s.current_period_end, s.api_key
            FROM subscriptions s
            JOIN customers c ON s.customer_id = c.id
            WHERE s.stripe_subscription_id = $1
        ".to_string();

        let row_opt = self.database_adapter
            .fetch_row(fetch_query, vec![stripe_sub_id.clone()])
            .await
            .map_err(|e| RepositoryError::DatabaseError(e.to_string()))?;

        if let Some(row_str) = row_opt {
            let val: serde_json::Value = serde_json::from_str(&row_str)
                .map_err(|e| RepositoryError::DatabaseError(e.to_string()))?;

            let sub: SubscriptionDetails = serde_json::from_value(val.clone())
                .map_err(|e| RepositoryError::DatabaseError(e.to_string()))?;

            if let Some(api_key) = val.get("api_key").and_then(|k| k.as_str()) {
                self.subscription_store.update_cached_subscription(api_key.to_string(), sub);
            }
        }

        // Step 3: Return success
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::DbError;
    use std::sync::Mutex;
    use uuid::Uuid;
    use chrono::Utc;

    struct MockSubscriptionStore {
        cached: Mutex<Option<SubscriptionDetails>>,
    }

    impl SubscriptionStore for MockSubscriptionStore {
        fn get_cached_subscription(&self, _api_key: &str) -> Option<SubscriptionDetails> {
            self.cached.lock().unwrap().clone()
        }

        fn update_cached_subscription(&self, _api_key: String, sub: SubscriptionDetails) {
            *self.cached.lock().unwrap() = Some(sub);
        }
    }

    struct MockDatabaseAdapter {
        row_val: Mutex<Option<String>>,
        executed_queries: Arc<Mutex<Vec<(String, Vec<String>)>>>,
        should_fail_execute: bool,
        should_fail_fetch: bool,
    }

    #[async_trait]
    impl DatabaseAdapter for MockDatabaseAdapter {
        async fn execute_query(&self, query: String, params: Vec<String>) -> Result<u64, DbError> {
            if self.should_fail_execute {
                return Err(DbError::QueryError("DB execute failed".to_string()));
            }
            self.executed_queries.lock().unwrap().push((query, params));
            Ok(1)
        }

        async fn fetch_row(&self, _query: String, _params: Vec<String>) -> Result<Option<String>, DbError> {
            if self.should_fail_fetch {
                return Err(DbError::QueryError("DB fetch failed".to_string()));
            }
            Ok(self.row_val.lock().unwrap().clone())
        }
    }

    #[tokio::test]
    async fn test_get_subscription_by_key_cache_hit() {
        let sub = SubscriptionDetails {
            id: Uuid::new_v4(),
            customer_id: Uuid::new_v4(),
            customer_email: "bob@example.com".to_string(),
            stripe_subscription_id: "sub_1".to_string(),
            status: "active".to_string(),
            tier_id: "free".to_string(),
            api_limit: 1000,
            current_period_start: Utc::now().naive_utc(),
            current_period_end: Utc::now().naive_utc(),
        };

        let store = Arc::new(MockSubscriptionStore {
            cached: Mutex::new(Some(sub.clone())),
        });
        let db = Arc::new(MockDatabaseAdapter {
            row_val: Mutex::new(None),
            executed_queries: Arc::new(Mutex::new(Vec::new())),
            should_fail_execute: false,
            should_fail_fetch: false,
        });

        let repository = SubscriptionRepositoryImpl::new(store, db);
        let result = repository.get_subscription_by_key("key_123".to_string()).await;
        assert!(result.is_ok());
        assert!(result.unwrap().is_some());
    }

    #[tokio::test]
    async fn test_get_subscription_by_key_cache_miss() {
        let sub = SubscriptionDetails {
            id: Uuid::new_v4(),
            customer_id: Uuid::new_v4(),
            customer_email: "bob@example.com".to_string(),
            stripe_subscription_id: "sub_1".to_string(),
            status: "active".to_string(),
            tier_id: "free".to_string(),
            api_limit: 1000,
            current_period_start: Utc::now().naive_utc(),
            current_period_end: Utc::now().naive_utc(),
        };
        let row_json = serde_json::to_string(&sub).unwrap();

        let store = Arc::new(MockSubscriptionStore {
            cached: Mutex::new(None),
        });
        let db = Arc::new(MockDatabaseAdapter {
            row_val: Mutex::new(Some(row_json)),
            executed_queries: Arc::new(Mutex::new(Vec::new())),
            should_fail_execute: false,
            should_fail_fetch: false,
        });

        let repository = SubscriptionRepositoryImpl::new(store.clone(), db);
        let result = repository.get_subscription_by_key("key_123".to_string()).await;
        assert!(result.is_ok());
        let opt = result.unwrap();
        assert!(opt.is_some());

        // Check cache filled
        assert!(store.get_cached_subscription("key_123").is_some());
    }

    #[tokio::test]
    async fn test_update_subscription_status() {
        let store = Arc::new(MockSubscriptionStore {
            cached: Mutex::new(None),
        });

        // We mock database responses:
        // first, update will call execute_query (we log it).
        // then, fetch_row will be called to get subscription details for caching.
        let sub = SubscriptionDetails {
            id: Uuid::new_v4(),
            customer_id: Uuid::new_v4(),
            customer_email: "alice@example.com".to_string(),
            stripe_subscription_id: "sub_pro".to_string(),
            status: "active".to_string(),
            tier_id: "pro".to_string(),
            api_limit: 500000,
            current_period_start: Utc::now().naive_utc(),
            current_period_end: Utc::now().naive_utc(),
        };
        let mut sub_val = serde_json::to_value(&sub).unwrap();
        sub_val.as_object_mut().unwrap().insert("api_key".to_string(), serde_json::Value::String("key_pro".to_string()));
        let row_json = serde_json::to_string(&sub_val).unwrap();

        let executed_queries = Arc::new(Mutex::new(Vec::new()));
        let db = Arc::new(MockDatabaseAdapter {
            row_val: Mutex::new(Some(row_json)),
            executed_queries: Arc::clone(&executed_queries),
            should_fail_execute: false,
            should_fail_fetch: false,
        });

        let repository = SubscriptionRepositoryImpl::new(store.clone(), db);
        let result = repository.update_subscription_status("sub_pro".to_string(), "active".to_string(), "pro".to_string()).await;
        assert!(result.is_ok());

        // Verify UPDATE query executed
        let queries = executed_queries.lock().unwrap();
        assert_eq!(queries.len(), 1);
        assert!(queries[0].0.contains("UPDATE subscriptions"));
        assert_eq!(queries[0].1[0], "active");
        assert_eq!(queries[0].1[1], "pro");
        assert_eq!(queries[0].1[2], "500000"); // Pro limit is 500,000

        // Verify cache updated
        let cached = store.get_cached_subscription("key_pro");
        assert!(cached.is_some());
        assert_eq!(cached.unwrap().tier_id, "pro");
    }

    #[tokio::test]
    async fn test_get_subscription_by_key_db_error() {
        let store = Arc::new(MockSubscriptionStore { cached: Mutex::new(None) });
        let db = Arc::new(MockDatabaseAdapter {
            row_val: Mutex::new(None),
            executed_queries: Arc::new(Mutex::new(Vec::new())),
            should_fail_execute: false,
            should_fail_fetch: true,
        });
        let repository = SubscriptionRepositoryImpl::new(store, db);
        let result = repository.get_subscription_by_key("key_123".to_string()).await;
        assert!(result.is_err());
        assert!(matches!(result.unwrap_err(), RepositoryError::DatabaseError(_)));
    }

    #[tokio::test]
    async fn test_get_subscription_by_key_invalid_json() {
        let store = Arc::new(MockSubscriptionStore { cached: Mutex::new(None) });
        let db = Arc::new(MockDatabaseAdapter {
            row_val: Mutex::new(Some("invalid_json".to_string())),
            executed_queries: Arc::new(Mutex::new(Vec::new())),
            should_fail_execute: false,
            should_fail_fetch: false,
        });
        let repository = SubscriptionRepositoryImpl::new(store, db);
        let result = repository.get_subscription_by_key("key_123".to_string()).await;
        assert!(result.is_err());
        assert!(matches!(result.unwrap_err(), RepositoryError::DatabaseError(_)));
    }

    #[tokio::test]
    async fn test_update_subscription_status_update_db_error() {
        let store = Arc::new(MockSubscriptionStore { cached: Mutex::new(None) });
        let db = Arc::new(MockDatabaseAdapter {
            row_val: Mutex::new(None),
            executed_queries: Arc::new(Mutex::new(Vec::new())),
            should_fail_execute: true,
            should_fail_fetch: false,
        });
        let repository = SubscriptionRepositoryImpl::new(store, db);
        let result = repository.update_subscription_status("sub_pro".to_string(), "active".to_string(), "pro".to_string()).await;
        assert!(result.is_err());
        assert!(matches!(result.unwrap_err(), RepositoryError::DatabaseError(_)));
    }

    #[tokio::test]
    async fn test_update_subscription_status_fetch_db_error() {
        let store = Arc::new(MockSubscriptionStore { cached: Mutex::new(None) });
        let db = Arc::new(MockDatabaseAdapter {
            row_val: Mutex::new(None),
            executed_queries: Arc::new(Mutex::new(Vec::new())),
            should_fail_execute: false,
            should_fail_fetch: true,
        });
        let repository = SubscriptionRepositoryImpl::new(store, db);
        let result = repository.update_subscription_status("sub_pro".to_string(), "active".to_string(), "pro".to_string()).await;
        assert!(result.is_err());
        assert!(matches!(result.unwrap_err(), RepositoryError::DatabaseError(_)));
    }

    #[tokio::test]
    async fn test_update_subscription_status_invalid_json() {
        let store = Arc::new(MockSubscriptionStore { cached: Mutex::new(None) });
        let db = Arc::new(MockDatabaseAdapter {
            row_val: Mutex::new(Some("invalid_json".to_string())),
            executed_queries: Arc::new(Mutex::new(Vec::new())),
            should_fail_execute: false,
            should_fail_fetch: false,
        });
        let repository = SubscriptionRepositoryImpl::new(store, db);
        let result = repository.update_subscription_status("sub_pro".to_string(), "active".to_string(), "pro".to_string()).await;
        assert!(result.is_err());
        assert!(matches!(result.unwrap_err(), RepositoryError::DatabaseError(_)));
    }

    #[tokio::test]
    async fn test_update_subscription_status_invalid_details_json() {
        let store = Arc::new(MockSubscriptionStore { cached: Mutex::new(None) });
        // Valid JSON value structure but doesn't conform to SubscriptionDetails struct
        let db = Arc::new(MockDatabaseAdapter {
            row_val: Mutex::new(Some("{\"api_key\": \"some_key\"}".to_string())),
            executed_queries: Arc::new(Mutex::new(Vec::new())),
            should_fail_execute: false,
            should_fail_fetch: false,
        });
        let repository = SubscriptionRepositoryImpl::new(store, db);
        let result = repository.update_subscription_status("sub_pro".to_string(), "active".to_string(), "pro".to_string()).await;
        assert!(result.is_err());
        assert!(matches!(result.unwrap_err(), RepositoryError::DatabaseError(_)));
    }
}
