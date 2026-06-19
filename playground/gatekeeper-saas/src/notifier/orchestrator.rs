use std::sync::Arc;
use uuid::Uuid;
use chrono::{DateTime, Utc};
use crate::models::UsageAlertLog;
use crate::notifier::repository::INotifierRepository;
use crate::notifier::email_adapter::IEmailAdapter;
use crate::notifier::billing_client::INotifierBillingClient;

#[async_trait::async_trait]
pub trait INotifierOrchestrator: Send + Sync {
    async fn notify_threshold_reached(
        &self,
        subscription_id: Uuid,
        threshold: i32,
        current_usage: i64,
        limit: i64,
        billing_start: DateTime<Utc>,
    ) -> Result<(), String>;
}

pub struct NotifierOrchestrator {
    repository: Arc<dyn INotifierRepository>,
    email_adapter: Arc<dyn IEmailAdapter>,
    billing_client: Arc<dyn INotifierBillingClient>,
}

impl NotifierOrchestrator {
    pub fn new(
        repository: Arc<dyn INotifierRepository>,
        email_adapter: Arc<dyn IEmailAdapter>,
        billing_client: Arc<dyn INotifierBillingClient>,
    ) -> Self {
        Self {
            repository,
            email_adapter,
            billing_client,
        }
    }
}

#[async_trait::async_trait]
impl INotifierOrchestrator for NotifierOrchestrator {
    async fn notify_threshold_reached(
        &self,
        subscription_id: Uuid,
        threshold: i32,
        current_usage: i64,
        limit: i64,
        billing_start: DateTime<Utc>,
    ) -> Result<(), String> {
        // Step 1: Query alerts database index verifying duplicate state.
        let already_notified = self.repository.has_notified_in_period(subscription_id, threshold, billing_start)
            .await
            .map_err(|e| format!("DB error: {}", e))?;

        // Step 2: If alert has already been sent, return early.
        if already_notified {
            return Ok(());
        }

        // Step 3: Lookup customer email address contact details.
        let email = self.billing_client.get_customer_email(subscription_id.to_string())
            .await
            .map_err(|e| format!("Billing client error: {}", e))?
            .ok_or_else(|| "Customer email not found".to_string())?;

        // Step 4: Format alert message body details.
        let subject = format!("Usage Warning: {}% threshold reached", threshold);
        let body = format!(
            "Your subscription has crossed the {}% usage warning threshold.\n\
             Current Usage: {} / {}\n\
             Billing period started at: {}",
            threshold, current_usage, limit, billing_start
        );

        // Step 5: Send alert email to customer.
        self.email_adapter.send_alert_email(email, subject, body)
            .await
            .map_err(|e| format!("Email send error: {}", e))?;

        // Step 6: Save generated log detail record.
        let log = UsageAlertLog {
            id: Uuid::new_v4(),
            subscription_id,
            billing_period_start: billing_start,
            threshold_percent: threshold,
            sent_at: Utc::now(),
        };
        self.repository.save_alert_log(&log)
            .await
            .map_err(|e| format!("DB log save error: {}", e))?;

        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    struct MockRepository {
        notified: bool,
        saved_logs: Mutex<Vec<UsageAlertLog>>,
    }

    #[async_trait::async_trait]
    impl INotifierRepository for MockRepository {
        async fn save_alert_log(&self, log: &UsageAlertLog) -> Result<(), sqlx::Error> {
            self.saved_logs.lock().unwrap().push(log.clone());
            Ok(())
        }
        async fn has_notified_in_period(
            &self,
            _subscription_id: Uuid,
            _threshold: i32,
            _period_start: DateTime<Utc>,
        ) -> Result<bool, sqlx::Error> {
            Ok(self.notified)
        }
    }

    struct MockEmailAdapter {
        sent: Mutex<Vec<(String, String, String)>>,
    }

    #[async_trait::async_trait]
    impl IEmailAdapter for MockEmailAdapter {
        async fn send_alert_email(&self, email: String, subject: String, body: String) -> Result<(), String> {
            self.sent.lock().unwrap().push((email, subject, body));
            Ok(())
        }
    }

    struct MockBillingClient {
        email: Option<String>,
    }

    #[async_trait::async_trait]
    impl INotifierBillingClient for MockBillingClient {
        async fn get_customer_email(&self, _subscription_id: String) -> Result<Option<String>, sqlx::Error> {
            Ok(self.email.clone())
        }
    }

    #[tokio::test]
    async fn test_notify_threshold_reached_success() {
        let repo = Arc::new(MockRepository {
            notified: false,
            saved_logs: Mutex::new(Vec::new()),
        });
        let email = Arc::new(MockEmailAdapter {
            sent: Mutex::new(Vec::new()),
        });
        let client = Arc::new(MockBillingClient {
            email: Some("client@example.com".to_string()),
        });

        let orchestrator = NotifierOrchestrator::new(repo.clone(), email.clone(), client);
        let sub_id = Uuid::new_v4();
        let now = Utc::now();

        orchestrator.notify_threshold_reached(sub_id, 80, 850, 1000, now).await.unwrap();

        // Check email sent
        let sent_list = email.sent.lock().unwrap();
        assert_eq!(sent_list.len(), 1);
        assert_eq!(sent_list[0].0, "client@example.com");

        // Check log saved
        let logs_list = repo.saved_logs.lock().unwrap();
        assert_eq!(logs_list.len(), 1);
        assert_eq!(logs_list[0].subscription_id, sub_id);
        assert_eq!(logs_list[0].threshold_percent, 80);
    }

    #[tokio::test]
    async fn test_notify_threshold_reached_duplicate_noop() {
        let repo = Arc::new(MockRepository {
            notified: true,
            saved_logs: Mutex::new(Vec::new()),
        });
        let email = Arc::new(MockEmailAdapter {
            sent: Mutex::new(Vec::new()),
        });
        let client = Arc::new(MockBillingClient {
            email: Some("client@example.com".to_string()),
        });

        let orchestrator = NotifierOrchestrator::new(repo, email.clone(), client);
        let sub_id = Uuid::new_v4();
        let now = Utc::now();

        orchestrator.notify_threshold_reached(sub_id, 80, 850, 1000, now).await.unwrap();

        // Should return early and not send email
        let sent_list = email.sent.lock().unwrap();
        assert_eq!(sent_list.len(), 0);
    }
}
