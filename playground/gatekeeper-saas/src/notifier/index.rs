use std::sync::Arc;
use uuid::Uuid;
use chrono::{DateTime, Utc};
use crate::notifier::store::INotifierStore;
use crate::models::UsageAlertLog;

#[async_trait::async_trait]
pub trait INotifierIndex: Send + Sync {
    async fn lookup_alert_log_by_period(
        &self,
        subscription_id: &Uuid,
        threshold: i32,
        period_start: &DateTime<Utc>,
    ) -> Result<Option<UsageAlertLog>, sqlx::Error>;
}

pub struct NotifierIndex {
    store: Arc<dyn INotifierStore>,
}

impl NotifierIndex {
    pub fn new(store: Arc<dyn INotifierStore>) -> Self {
        Self { store }
    }
}

#[async_trait::async_trait]
impl INotifierIndex for NotifierIndex {
    async fn lookup_alert_log_by_period(
        &self,
        subscription_id: &Uuid,
        threshold: i32,
        period_start: &DateTime<Utc>,
    ) -> Result<Option<UsageAlertLog>, sqlx::Error> {
        // Step 1: Acquire database connection.
        let mut conn = self.store.get_connection().await?;

        // Step 2: Execute SELECT query searching for logged alerts matching parameters.
        let log = sqlx::query_as::<_, UsageAlertLog>(
            "SELECT * FROM usage_alert_logs
             WHERE subscription_id = $1
               AND threshold_percent = $2
               AND billing_period_start = $3
             LIMIT 1"
        )
        .bind(subscription_id)
        .bind(threshold)
        .bind(period_start)
        .fetch_optional(&mut *conn)
        .await?;

        Ok(log)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::{Postgres, pool::PoolConnection};

    struct MockStore;

    #[async_trait::async_trait]
    impl INotifierStore for MockStore {
        async fn get_connection(&self) -> Result<PoolConnection<Postgres>, sqlx::Error> {
            Err(sqlx::Error::RowNotFound)
        }
    }

    #[tokio::test]
    async fn test_lookup_offline() {
        let store = Arc::new(MockStore);
        let index = NotifierIndex::new(store);

        let res = index.lookup_alert_log_by_period(
            &Uuid::new_v4(),
            80,
            &Utc::now(),
        ).await;

        assert!(res.is_err());
    }
}
