//! Email Adapter (Adapter stereotype): the only block doing email I/O. Sends
//! transactional email through an HTTP email provider (e.g. SendGrid/Postmark).
//! No domain logic.

use async_trait::async_trait;
use serde::Serialize;

use super::model::{NotificationError, NotificationMessage};

#[async_trait]
pub trait EmailAdapter: Send + Sync {
    async fn send(&self, message: NotificationMessage) -> Result<(), NotificationError>;
}

/// Configuration for the HTTP email provider.
pub struct EmailProviderConfig {
    pub endpoint: String,
    pub api_key: String,
}

pub struct HttpEmailAdapter {
    config: EmailProviderConfig,
    http: reqwest::Client,
}

impl HttpEmailAdapter {
    pub fn new(config: EmailProviderConfig) -> Self {
        Self { config, http: reqwest::Client::new() }
    }
}

#[derive(Serialize)]
struct ProviderPayload<'a> {
    to: &'a str,
    subject: &'a str,
    body: &'a str,
}

#[async_trait]
impl EmailAdapter for HttpEmailAdapter {
    async fn send(&self, message: NotificationMessage) -> Result<(), NotificationError> {
        // Step 1: POST the message to the provider; map a non-2xx response into SendFailure.
        let payload = ProviderPayload {
            to: message.to.as_str(),
            subject: &message.subject,
            body: &message.body,
        };
        let response = self
            .http
            .post(&self.config.endpoint)
            .bearer_auth(&self.config.api_key)
            .json(&payload)
            .send()
            .await
            .map_err(|e| NotificationError::SendFailure(e.to_string()))?;
        if response.status().is_success() {
            Ok(())
        } else {
            Err(NotificationError::SendFailure(format!(
                "provider returned {}",
                response.status()
            )))
        }
    }
}
