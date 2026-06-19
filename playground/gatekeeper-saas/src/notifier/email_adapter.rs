use std::sync::Arc;
use std::sync::Mutex;
use lettre::{AsyncSmtpTransport, AsyncTransport, Message, Tokio1Executor};

#[async_trait::async_trait]
pub trait IEmailAdapter: Send + Sync {
    async fn send_alert_email(&self, email: String, subject: String, body: String) -> Result<(), String>;
}

pub struct EmailAdapter {
    smtp_url: String,
    dry_run: bool,
    sent_emails: Option<Arc<Mutex<Vec<(String, String, String)>>>>,
}

impl EmailAdapter {
    pub fn new(
        smtp_url: String,
        dry_run: bool,
        sent_emails: Option<Arc<Mutex<Vec<(String, String, String)>>>>,
    ) -> Self {
        Self {
            smtp_url,
            dry_run,
            sent_emails,
        }
    }
}

#[async_trait::async_trait]
impl IEmailAdapter for EmailAdapter {
    async fn send_alert_email(&self, email: String, subject: String, body: String) -> Result<(), String> {
        // Step 1: Initialize SMTP client configuration credentials.
        let email_msg = Message::builder()
            .from("no-reply@gatekeeper.saas".parse().map_err(|e| format!("Invalid from address: {}", e))?)
            .to(email.parse().map_err(|e| format!("Invalid to address: {}", e))?)
            .subject(&subject)
            .body(body.clone())
            .map_err(|e| format!("Email construction error: {}", e))?;

        // Step 2: Send SMTP dispatch request containing email details.
        if self.dry_run {
            if let Some(ref list) = self.sent_emails {
                list.lock().unwrap().push((email, subject, body));
            }
            Ok(())
        } else {
            let transport = AsyncSmtpTransport::<Tokio1Executor>::from_url(&self.smtp_url)
                .map_err(|e| format!("SMTP URL error: {}", e))?
                .build();
            
            transport.send(email_msg)
                .await
                .map_err(|e| format!("SMTP send error: {}", e))?;
            
            Ok(())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_send_alert_email_dry_run() {
        let sent = Arc::new(Mutex::new(Vec::new()));
        let adapter = EmailAdapter::new(
            "smtp://localhost:25".to_string(),
            true,
            Some(sent.clone()),
        );

        adapter.send_alert_email(
            "customer@example.com".to_string(),
            "Limit Warning".to_string(),
            "You have used 80% of your requests.".to_string(),
        ).await.unwrap();

        let list = sent.lock().unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].0, "customer@example.com");
        assert_eq!(list[0].1, "Limit Warning");
        assert_eq!(list[0].2, "You have used 80% of your requests.");
    }
}
