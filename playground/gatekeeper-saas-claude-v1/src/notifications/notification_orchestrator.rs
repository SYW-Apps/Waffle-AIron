//! Notification Orchestrator (Orchestrator stereotype): workflow triggered by a
//! usage.threshold event — resolve the billing email via the accounts client,
//! compose the alert, send it via the email adapter, and record the delivery via
//! the notification log adapter.

use std::sync::Arc;

use async_trait::async_trait;

use crate::metering::model::UsageThresholdEvent;

use super::accounts_client::AccountsClient;
use super::email_adapter::EmailAdapter;
use super::model::{NotificationError, NotificationMessage, NotificationRecord};
use super::notification_log_adapter::NotificationLogAdapter;

#[async_trait]
pub trait NotificationOrchestrator: Send + Sync {
    async fn handle_threshold(
        &self,
        event: UsageThresholdEvent,
    ) -> Result<(), NotificationError>;
}

pub struct NotificationOrchestratorImpl {
    accounts: Arc<dyn AccountsClient>,
    email: Arc<dyn EmailAdapter>,
    log: Arc<dyn NotificationLogAdapter>,
}

impl NotificationOrchestratorImpl {
    pub fn new(
        accounts: Arc<dyn AccountsClient>,
        email: Arc<dyn EmailAdapter>,
        log: Arc<dyn NotificationLogAdapter>,
    ) -> Self {
        Self { accounts, email, log }
    }
}

/// Compose the alert subject + body from a usage-threshold event.
fn compose(event: &UsageThresholdEvent, to: crate::domain::Email) -> NotificationMessage {
    let percent = (event.ratio * 100.0).round() as i64;
    NotificationMessage {
        to,
        subject: format!("Usage alert: {} at {}% of quota", event.resource, percent),
        body: format!(
            "Your subscription has used {} of {} {} for resource '{}' (window: {}).",
            event.used, event.quota, percent, event.resource, event.window
        ),
    }
}

#[async_trait]
impl NotificationOrchestrator for NotificationOrchestratorImpl {
    async fn handle_threshold(
        &self,
        event: UsageThresholdEvent,
    ) -> Result<(), NotificationError> {
        // Step 1: Resolve the billing email (NoBillingEmail if absent).
        let to = self
            .accounts
            .resolve_billing_email(&event.billing_account_id)
            .await?
            .ok_or_else(|| {
                NotificationError::NoBillingEmail(event.billing_account_id.to_string())
            })?;
        // Step 2: Compose a NotificationMessage from the event.
        let message = compose(&event, to.clone());
        let subject = message.subject.clone();
        // Step 3: Send the email.
        let send_result = self.email.send(message).await;
        // Step 4: Build a NotificationRecord with the delivery status.
        let status = if send_result.is_ok() { "sent" } else { "failed" };
        let record = NotificationRecord {
            billing_account_id: event.billing_account_id.clone(),
            to,
            subject,
            sent_at: chrono::Utc::now().to_rfc3339(),
            status: status.to_string(),
        };
        // Step 5: Append the delivery record.
        self.log.record_sent(record).await?;
        // Step 6: Return Ok(()).
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::{BillingAccountId, SubscriptionId};
    use crate::notifications::test_support::{
        MockAccountsClient, MockEmailAdapter, MockNotificationLogAdapter,
    };

    fn event() -> UsageThresholdEvent {
        UsageThresholdEvent {
            subscription_id: SubscriptionId::new("sub-1"),
            billing_account_id: BillingAccountId::new("ba-1"),
            resource: "api_calls".into(),
            used: 80,
            quota: 100,
            ratio: 0.8,
            window: "day".into(),
        }
    }

    #[tokio::test]
    async fn sends_and_records_when_email_present() {
        let email = Arc::new(MockEmailAdapter::ok());
        let log = Arc::new(MockNotificationLogAdapter::new());
        let orch = NotificationOrchestratorImpl::new(
            Arc::new(MockAccountsClient::with_email("billing@acme.com")),
            email.clone(),
            log.clone(),
        );
        orch.handle_threshold(event()).await.unwrap();
        assert_eq!(email.sent(), 1);
        assert_eq!(log.last_status().as_deref(), Some("sent"));
    }

    #[tokio::test]
    async fn missing_email_is_no_billing_email() {
        let orch = NotificationOrchestratorImpl::new(
            Arc::new(MockAccountsClient::without_email()),
            Arc::new(MockEmailAdapter::ok()),
            Arc::new(MockNotificationLogAdapter::new()),
        );
        let err = orch.handle_threshold(event()).await.unwrap_err();
        assert!(matches!(err, NotificationError::NoBillingEmail(_)));
    }

    #[tokio::test]
    async fn send_failure_is_recorded_as_failed() {
        let log = Arc::new(MockNotificationLogAdapter::new());
        let orch = NotificationOrchestratorImpl::new(
            Arc::new(MockAccountsClient::with_email("billing@acme.com")),
            Arc::new(MockEmailAdapter::failing()),
            log.clone(),
        );
        // Delivery failure is logged (status=failed) and the handler still completes Ok.
        orch.handle_threshold(event()).await.unwrap();
        assert_eq!(log.last_status().as_deref(), Some("failed"));
    }
}
