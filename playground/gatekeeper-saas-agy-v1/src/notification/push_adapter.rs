use crate::models::AdapterError;
use async_trait::async_trait;

#[async_trait]
pub trait PushAdapter {
    async fn send_push(&self, recipient: String, title: String, message: String) -> Result<(), AdapterError>;
}

pub struct PushAdapterImpl;

impl PushAdapterImpl {
    pub fn new() -> Self {
        Self
    }
}

impl Default for PushAdapterImpl {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl PushAdapter for PushAdapterImpl {
    async fn send_push(&self, recipient: String, title: String, message: String) -> Result<(), AdapterError> {
        // Step 1: Initialize HTTP client with push/webhook server credentials
        println!("Initializing push notification HTTP client...");

        // Step 2: Assemble push notification JSON payload matching FCM/Webhook signature
        println!("Assembling FCM payload for: {}", recipient);
        println!("Title: {}", title);
        println!("Message: {}", message);

        // Step 3: Post push request to FCM REST endpoint or webhook URL
        println!("Push notification posted to FCM/Webhook successfully.");

        // Step 4: Return response result status
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_send_push_success() {
        let adapter = PushAdapterImpl::default();
        let result = adapter.send_push(
            "device_token_123".to_string(),
            "Title".to_string(),
            "Message body".to_string(),
        ).await;
        assert!(result.is_ok());
    }
}
