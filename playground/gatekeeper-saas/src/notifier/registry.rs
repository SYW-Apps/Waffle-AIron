use std::sync::Arc;
use crate::notifier::store::INotifierStore;
use crate::models::UsageAlertLog;

#[async_trait::async_trait]
pub trait INotifierRegistry: Send + Sync {
    async fn insert_alert_log(&self, log: &UsageAlertLog) -> Result<(), sqlx::Error>;
}

pub struct NotifierRegistry {
    store: Arc<dyn INotifierStore>,
}

impl NotifierRegistry {
    pub fn new(store: Arc<dyn INotifierStore>) -> Self {
        Self { store }
    }
}

#[async_trait::async_trait]
impl INotifierRegistry for NotifierRegistry {
    async fn insert_alert_log(&self, log: &UsageAlertLog) -> Result<(), sqlx::Error> {
        // Step 1: Acquire database connection.
        let mut conn = self.store.get_connection().await?;

        // Step 2: Execute INSERT query writing alert log details.
        sqlx::query(
            "INSERT INTO usage_alert_logs (id, subscription_id, billing_period_start, threshold_percent, sent_at)
             VALUES ($1, $2, $3, $4, $5)"
        )
        .bind(log.id)
        .bind(log.subscription_id)
        .bind(log.billing_period_start)
        .bind(log.threshold_percent)
        .bind(log.sent_at)
        .execute(&mut *conn)
        .await?;

        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use uuid::Uuid;
    use chrono::Utc;
    use sqlx::{Postgres, pool::PoolConnection};

    struct MockStore;

    #[async_trait::async_trait]
    impl INotifierStore for MockStore {
        async fn get_connection(&self) -> Result<PoolConnection<Postgres>, sqlx::Error> {
            Err(sqlx::Error::RowNotFound)
        }
    }

    #[tokio::test]
    async fn test_insert_alert_log_offline() {
        let store = Arc::new(MockStore);
        let registry = NotifierRegistry::new(store);

        let log = UsageAlertLog {
            id: Uuid::new_v4(),
            subscription_id: Uuid::new_v4(),
            billing_period_start: Utc::now(),
            threshold_percent: 80,
            sent_at: Utc::now(),
        };

        let res = registry.insert_alert_log(&log).await;
        assert!(res.is_err());
    }
}
