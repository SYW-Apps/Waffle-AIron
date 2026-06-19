use crate::models::NotificationError;
use crate::notification::email_adapter::EmailAdapter;
use crate::notification::push_adapter::PushAdapter;
use async_trait::async_trait;
use std::sync::Arc;

#[async_trait]
pub trait NotificationOrchestrator {
    async fn dispatch_alert(&self, customer_email: String, alert_type: String, current_usage: u32, limit: u32) -> Result<(), NotificationError>;
}

pub struct NotificationOrchestratorImpl {
    email_adapter: Arc<dyn EmailAdapter + Send + Sync>,
    push_adapter: Arc<dyn PushAdapter + Send + Sync>,
}

impl NotificationOrchestratorImpl {
    pub fn new(
        email_adapter: Arc<dyn EmailAdapter + Send + Sync>,
        push_adapter: Arc<dyn PushAdapter + Send + Sync>,
    ) -> Self {
        Self {
            email_adapter,
            push_adapter,
        }
    }
}

#[async_trait]
impl NotificationOrchestrator for NotificationOrchestratorImpl {
    async fn dispatch_alert(&self, customer_email: String, alert_type: String, current_usage: u32, limit: u32) -> Result<(), NotificationError> {
        // Step 1: Format the alert subject and HTML email body template based on the current usage and limit details
        let subject = format!("Usage alert: {} limit reached", alert_type);
        let email_body = format!(
            "<html><body><h1>Usage Alert</h1><p>Your subscription usage has reached {} which is {} of your monthly limit of {}.</p></body></html>",
            current_usage, alert_type, limit
        );

        // Step 2: Call the email adapter to send the warning email to the customer's billing email address
        self.email_adapter
            .send_email(customer_email.clone(), subject, email_body)
            .await
            .map_err(|e| NotificationError::SmtpError(e.to_string()))?;

        // Step 3: Format the push notification payload message
        let push_title = format!("Usage warning: {}", alert_type);
        let push_message = format!("You have used {} requests of your {} monthly limit.", current_usage, limit);

        // Step 4: Call the push adapter to dispatch the push notification alert
        self.push_adapter
            .send_push(customer_email, push_title, push_message)
            .await
            .map_err(|e| NotificationError::PushServiceError(e.to_string()))?;

        // Step 5: Return success
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::AdapterError;
    use std::sync::Mutex;

    struct MockEmailAdapter {
        sent_emails: Arc<Mutex<Vec<(String, String, String)>>>,
        should_fail: bool,
    }

    #[async_trait]
    impl EmailAdapter for MockEmailAdapter {
        async fn send_email(&self, to: String, subject: String, body: String) -> Result<(), AdapterError> {
            if self.should_fail {
                return Err(AdapterError::NetworkError("SMTP error".to_string()));
            }
            self.sent_emails.lock().unwrap().push((to, subject, body));
            Ok(())
        }
    }

    struct MockPushAdapter {
        sent_pushes: Arc<Mutex<Vec<(String, String, String)>>>,
        should_fail: bool,
    }

    #[async_trait]
    impl PushAdapter for MockPushAdapter {
        async fn send_push(&self, recipient: String, title: String, message: String) -> Result<(), AdapterError> {
            if self.should_fail {
                return Err(AdapterError::NetworkError("Push error".to_string()));
            }
            self.sent_pushes.lock().unwrap().push((recipient, title, message));
            Ok(())
        }
    }

    #[tokio::test]
    async fn test_dispatch_alert_success() {
        let emails = Arc::new(Mutex::new(Vec::new()));
        let pushes = Arc::new(Mutex::new(Vec::new()));

        let email_adapter = Arc::new(MockEmailAdapter {
            sent_emails: Arc::clone(&emails),
            should_fail: false,
        });

        let push_adapter = Arc::new(MockPushAdapter {
            sent_pushes: Arc::clone(&pushes),
            should_fail: false,
        });

        let orchestrator = NotificationOrchestratorImpl::new(email_adapter, push_adapter);

        let result = orchestrator.dispatch_alert(
            "client@example.com".to_string(),
            "WARNING_80".to_string(),
            8000,
            10000,
        ).await;

        assert!(result.is_ok());

        let emails_guard = emails.lock().unwrap();
        assert_eq!(emails_guard.len(), 1);
        assert_eq!(emails_guard[0].0, "client@example.com");
        assert!(emails_guard[0].1.contains("WARNING_80"));

        let pushes_guard = pushes.lock().unwrap();
        assert_eq!(pushes_guard.len(), 1);
        assert_eq!(pushes_guard[0].0, "client@example.com");
        assert!(pushes_guard[0].2.contains("8000"));
    }

    #[tokio::test]
    async fn test_dispatch_alert_email_failure() {
        let emails = Arc::new(Mutex::new(Vec::new()));
        let pushes = Arc::new(Mutex::new(Vec::new()));

        let email_adapter = Arc::new(MockEmailAdapter {
            sent_emails: Arc::clone(&emails),
            should_fail: true,
        });

        let push_adapter = Arc::new(MockPushAdapter {
            sent_pushes: Arc::clone(&pushes),
            should_fail: false,
        });

        let orchestrator = NotificationOrchestratorImpl::new(email_adapter, push_adapter);

        let result = orchestrator.dispatch_alert(
            "client@example.com".to_string(),
            "WARNING_80".to_string(),
            8000,
            10000,
        ).await;

        assert!(result.is_err());
        match result.unwrap_err() {
            NotificationError::SmtpError(msg) => assert!(msg.contains("SMTP error")),
            _ => panic!("Expected SmtpError"),
        }
    }

    #[tokio::test]
    async fn test_dispatch_alert_push_failure() {
        let emails = Arc::new(Mutex::new(Vec::new()));
        let pushes = Arc::new(Mutex::new(Vec::new()));

        let email_adapter = Arc::new(MockEmailAdapter {
            sent_emails: Arc::clone(&emails),
            should_fail: false,
        });

        let push_adapter = Arc::new(MockPushAdapter {
            sent_pushes: Arc::clone(&pushes),
            should_fail: true,
        });

        let orchestrator = NotificationOrchestratorImpl::new(email_adapter, push_adapter);

        let result = orchestrator.dispatch_alert(
            "client@example.com".to_string(),
            "WARNING_80".to_string(),
            8000,
            10000,
        ).await;

        assert!(result.is_err());
        match result.unwrap_err() {
            NotificationError::PushServiceError(msg) => assert!(msg.contains("Push error")),
            _ => panic!("Expected PushServiceError"),
        }
    }
}
