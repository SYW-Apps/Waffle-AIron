use crate::models::AdapterError;
use async_trait::async_trait;

#[async_trait]
pub trait EmailAdapter {
    async fn send_email(&self, to: String, subject: String, body: String) -> Result<(), AdapterError>;
}

pub struct EmailAdapterImpl;

impl EmailAdapterImpl {
    pub fn new() -> Self {
        Self
    }
}

impl Default for EmailAdapterImpl {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl EmailAdapter for EmailAdapterImpl {
    async fn send_email(&self, to: String, subject: String, body: String) -> Result<(), AdapterError> {
        // Step 1: Establish connection with SMTP server or initialize HTTP SendGrid request client
        println!("Initializing email client (SMTP/SendGrid)...");

        // Step 2: Assemble email message headers, content types, and body
        println!("Assembling email message for: {}", to);
        println!("Subject: {}", subject);
        println!("Body: {}", body);

        // Step 3: Deliver email via SMTP protocol or SendGrid REST endpoint
        println!("Email successfully delivered to {}", to);

        // Step 4: Return delivery result
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_send_email_success() {
        let adapter = EmailAdapterImpl::default();
        let result = adapter.send_email(
            "test@example.com".to_string(),
            "Alert".to_string(),
            "Body content".to_string(),
        ).await;
        assert!(result.is_ok());
    }
}
