use std::sync::Arc;
use uuid::Uuid;
use chrono::{DateTime, Utc};
use crate::models::UsageAlertLog;
use crate::notifier::registry::INotifierRegistry;
use crate::notifier::index::INotifierIndex;

#[async_trait::async_trait]
pub trait INotifierRepository: Send + Sync {
    async fn save_alert_log(&self, log: &UsageAlertLog) -> Result<(), sqlx::Error>;
    async fn has_notified_in_period(
        &self,
        subscription_id: Uuid,
        threshold: i32,
        period_start: DateTime<Utc>,
    ) -> Result<bool, sqlx::Error>;
}

pub struct NotifierRepository {
    registry: Arc<dyn INotifierRegistry>,
    index: Arc<dyn INotifierIndex>,
}

impl NotifierRepository {
    pub fn new(registry: Arc<dyn INotifierRegistry>, index: Arc<dyn INotifierIndex>) -> Self {
        Self { registry, index }
    }
}

#[async_trait::async_trait]
impl INotifierRepository for NotifierRepository {
    async fn save_alert_log(&self, log: &UsageAlertLog) -> Result<(), sqlx::Error> {
        // Step 1: Forward to registry to write log details.
        self.registry.insert_alert_log(log).await
    }

    async fn has_notified_in_period(
        &self,
        subscription_id: Uuid,
        threshold: i32,
        period_start: DateTime<Utc>,
    ) -> Result<bool, sqlx::Error> {
        // Step 1: Forward lookup query parameters to index.
        let log = self.index.lookup_alert_log_by_period(&subscription_id, threshold, &period_start).await?;

        // Step 2: Return boolean flag based on query lookup outcomes.
        Ok(log.is_some())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct MockRegistry;

    #[async_trait::async_trait]
    impl INotifierRegistry for MockRegistry {
        async fn insert_alert_log(&self, _log: &UsageAlertLog) -> Result<(), sqlx::Error> {
            Ok(())
        }
    }

    struct MockIndex {
        found: bool,
    }

    #[async_trait::async_trait]
    impl INotifierIndex for MockIndex {
        async fn lookup_alert_log_by_period(
            &self,
            subscription_id: &Uuid,
            threshold: i32,
            period_start: &DateTime<Utc>,
        ) -> Result<Option<UsageAlertLog>, sqlx::Error> {
            if self.found {
                Ok(Some(UsageAlertLog {
                    id: Uuid::new_v4(),
                    subscription_id: *subscription_id,
                    billing_period_start: *period_start,
                    threshold_percent: threshold,
                    sent_at: Utc::now(),
                }))
            } else {
                Ok(None)
            }
        }
    }

    #[tokio::test]
    async fn test_has_notified_true() {
        let registry = Arc::new(MockRegistry);
        let index = Arc::new(MockIndex { found: true });
        let repo = NotifierRepository::new(registry, index);

        let res = repo.has_notified_in_period(Uuid::new_v4(), 80, Utc::now()).await.unwrap();
        assert!(res);
    }

    #[tokio::test]
    async fn test_has_notified_false() {
        let registry = Arc::new(MockRegistry);
        let index = Arc::new(MockIndex { found: false });
        let repo = NotifierRepository::new(registry, index);

        let res = repo.has_notified_in_period(Uuid::new_v4(), 80, Utc::now()).await.unwrap();
        assert!(!res);
    }
}
