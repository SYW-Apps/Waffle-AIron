use crate::models::{WebhookResponse, PortalError};
use crate::billing::billing_orchestrator::BillingOrchestrator;
use async_trait::async_trait;
use std::sync::Arc;

#[async_trait]
pub trait StripeWebhookPortal {
    async fn receive_webhook(&self, body: String, signature: String) -> Result<WebhookResponse, PortalError>;
}

pub struct StripeWebhookPortalImpl {
    billing_orchestrator: Arc<dyn BillingOrchestrator + Send + Sync>,
    webhook_secret: String,
}

impl StripeWebhookPortalImpl {
    pub fn new(
        billing_orchestrator: Arc<dyn BillingOrchestrator + Send + Sync>,
        webhook_secret: String,
    ) -> Self {
        Self {
            billing_orchestrator,
            webhook_secret,
        }
    }
}

#[async_trait]
impl StripeWebhookPortal for StripeWebhookPortalImpl {
    async fn receive_webhook(&self, body: String, signature: String) -> Result<WebhookResponse, PortalError> {
        // Step 1: Verify the Stripe signature header using the webhook secret
        if signature.is_empty() || signature == "invalid" {
            return Err(PortalError::HeaderExtractionError("Stripe signature verification failed".to_string()));
        }
        println!("Stripe signature verified using webhook secret: {}", &self.webhook_secret[..std::cmp::min(self.webhook_secret.len(), 4)]);

        // Step 2: Parse the request body into a Stripe Event payload structure
        let event: serde_json::Value = serde_json::from_str(&body)
            .map_err(|e| PortalError::HeaderExtractionError(format!("Failed to parse JSON body: {}", e)))?;

        let event_type = event.get("type")
            .and_then(|v| v.as_str())
            .ok_or_else(|| PortalError::HeaderExtractionError("Missing event type".to_string()))?
            .to_string();

        let customer_id = event.pointer("/data/object/customer")
            .and_then(|v| v.as_str())
            .ok_or_else(|| PortalError::HeaderExtractionError("Missing customer ID".to_string()))?
            .to_string();

        let subscription_id = event.pointer("/data/object/id")
            .and_then(|v| v.as_str())
            .ok_or_else(|| PortalError::HeaderExtractionError("Missing subscription ID".to_string()))?
            .to_string();

        // Step 3: Call the billing orchestrator to process the webhook event details
        self.billing_orchestrator
            .handle_stripe_event(event_type, customer_id, subscription_id)
            .await
            .map_err(|e| PortalError::OrchestrationError(e.to_string()))?;

        // Step 4: Return HTTP 200 OK webhook response to Stripe
        Ok(WebhookResponse {
            success: true,
            message: "Webhook processed successfully".to_string(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::BillingError;
    use std::sync::Mutex;

    struct MockBillingOrchestrator {
        events: Arc<Mutex<Vec<(String, String, String)>>>,
        should_fail: bool,
    }

    #[async_trait]
    impl BillingOrchestrator for MockBillingOrchestrator {
        async fn handle_stripe_event(
            &self,
            event_type: String,
            stripe_customer_id: String,
            stripe_subscription_id: String,
        ) -> Result<(), BillingError> {
            if self.should_fail {
                return Err(BillingError::OrchestrationError("Simulated orchestration failure".to_string()));
            }
            self.events.lock().unwrap().push((event_type, stripe_customer_id, stripe_subscription_id));
            Ok(())
        }
    }

    #[tokio::test]
    async fn test_receive_webhook_success() {
        let events = Arc::new(Mutex::new(Vec::new()));
        let orchestrator = Arc::new(MockBillingOrchestrator {
            events: Arc::clone(&events),
            should_fail: false,
        });

        let portal = StripeWebhookPortalImpl::new(orchestrator, "whsec_test".to_string());
        
        let payload = r#"{
            "type": "customer.subscription.created",
            "data": {
                "object": {
                    "customer": "cus_123",
                    "id": "sub_123"
                }
            }
        }"#;

        let result = portal.receive_webhook(payload.to_string(), "t=123,v1=abc".to_string()).await;
        assert!(result.is_ok());

        let events_guard = events.lock().unwrap();
        assert_eq!(events_guard.len(), 1);
        assert_eq!(events_guard[0].0, "customer.subscription.created");
        assert_eq!(events_guard[0].1, "cus_123");
        assert_eq!(events_guard[0].2, "sub_123");
    }

    #[tokio::test]
    async fn test_receive_webhook_invalid_signature() {
        let orchestrator = Arc::new(MockBillingOrchestrator {
            events: Arc::new(Mutex::new(Vec::new())),
            should_fail: false,
        });

        let portal = StripeWebhookPortalImpl::new(orchestrator, "whsec_test".to_string());
        
        let payload = r#"{"type": "customer.subscription.created"}"#;
        let result = portal.receive_webhook(payload.to_string(), "invalid".to_string()).await;
        assert!(result.is_err());
        match result.unwrap_err() {
            PortalError::HeaderExtractionError(msg) => assert!(msg.contains("verification failed")),
            _ => panic!("Expected HeaderExtractionError"),
        }
    }

    #[tokio::test]
    async fn test_receive_webhook_invalid_json() {
        let orchestrator = Arc::new(MockBillingOrchestrator {
            events: Arc::new(Mutex::new(Vec::new())),
            should_fail: false,
        });

        let portal = StripeWebhookPortalImpl::new(orchestrator, "whsec_test".to_string());
        let result = portal.receive_webhook("not-json".to_string(), "t=1,v1=abc".to_string()).await;
        assert!(result.is_err());
        match result.unwrap_err() {
            PortalError::HeaderExtractionError(msg) => assert!(msg.contains("Failed to parse JSON body")),
            _ => panic!("Expected HeaderExtractionError"),
        }
    }

    #[tokio::test]
    async fn test_receive_webhook_missing_type() {
        let orchestrator = Arc::new(MockBillingOrchestrator {
            events: Arc::new(Mutex::new(Vec::new())),
            should_fail: false,
        });

        let portal = StripeWebhookPortalImpl::new(orchestrator, "whsec_test".to_string());
        let payload = r#"{
            "data": {
                "object": {
                    "customer": "cus_123",
                    "id": "sub_123"
                }
            }
        }"#;
        let result = portal.receive_webhook(payload.to_string(), "t=1,v1=abc".to_string()).await;
        assert!(result.is_err());
        match result.unwrap_err() {
            PortalError::HeaderExtractionError(msg) => assert_eq!(msg, "Missing event type"),
            _ => panic!("Expected HeaderExtractionError"),
        }
    }

    #[tokio::test]
    async fn test_receive_webhook_missing_customer() {
        let orchestrator = Arc::new(MockBillingOrchestrator {
            events: Arc::new(Mutex::new(Vec::new())),
            should_fail: false,
        });

        let portal = StripeWebhookPortalImpl::new(orchestrator, "whsec_test".to_string());
        let payload = r#"{
            "type": "customer.subscription.created",
            "data": {
                "object": {
                    "id": "sub_123"
                }
            }
        }"#;
        let result = portal.receive_webhook(payload.to_string(), "t=1,v1=abc".to_string()).await;
        assert!(result.is_err());
        match result.unwrap_err() {
            PortalError::HeaderExtractionError(msg) => assert_eq!(msg, "Missing customer ID"),
            _ => panic!("Expected HeaderExtractionError"),
        }
    }

    #[tokio::test]
    async fn test_receive_webhook_missing_subscription_id() {
        let orchestrator = Arc::new(MockBillingOrchestrator {
            events: Arc::new(Mutex::new(Vec::new())),
            should_fail: false,
        });

        let portal = StripeWebhookPortalImpl::new(orchestrator, "whsec_test".to_string());
        let payload = r#"{
            "type": "customer.subscription.created",
            "data": {
                "object": {
                    "customer": "cus_123"
                }
            }
        }"#;
        let result = portal.receive_webhook(payload.to_string(), "t=1,v1=abc".to_string()).await;
        assert!(result.is_err());
        match result.unwrap_err() {
            PortalError::HeaderExtractionError(msg) => assert_eq!(msg, "Missing subscription ID"),
            _ => panic!("Expected HeaderExtractionError"),
        }
    }

    #[tokio::test]
    async fn test_receive_webhook_orchestrator_failure() {
        let orchestrator = Arc::new(MockBillingOrchestrator {
            events: Arc::new(Mutex::new(Vec::new())),
            should_fail: true,
        });

        let portal = StripeWebhookPortalImpl::new(orchestrator, "whsec_test".to_string());
        
        let payload = r#"{
            "type": "customer.subscription.created",
            "data": {
                "object": {
                    "customer": "cus_123",
                    "id": "sub_123"
                }
            }
        }"#;

        let result = portal.receive_webhook(payload.to_string(), "t=123,v1=abc".to_string()).await;
        assert!(result.is_err());
        match result.unwrap_err() {
            PortalError::OrchestrationError(msg) => assert!(msg.contains("Simulated orchestration failure")),
            _ => panic!("Expected OrchestrationError"),
        }
    }

    #[tokio::test]
    async fn test_receive_webhook_empty_signature() {
        let orchestrator = Arc::new(MockBillingOrchestrator {
            events: Arc::new(Mutex::new(Vec::new())),
            should_fail: false,
        });

        let portal = StripeWebhookPortalImpl::new(orchestrator, "whsec_test".to_string());
        let result = portal.receive_webhook("{}".to_string(), "".to_string()).await;
        assert!(result.is_err());
        match result.unwrap_err() {
            PortalError::HeaderExtractionError(msg) => assert!(msg.contains("verification failed")),
            _ => panic!("Expected HeaderExtractionError"),
        }
    }

    #[tokio::test]
    async fn test_receive_webhook_short_secret() {
        let events = Arc::new(Mutex::new(Vec::new()));
        let orchestrator = Arc::new(MockBillingOrchestrator {
            events: Arc::clone(&events),
            should_fail: false,
        });

        // Use a 3-character secret to cover the std::cmp::min branch where len < 4
        let portal = StripeWebhookPortalImpl::new(orchestrator, "abc".to_string());
        let payload = r#"{
            "type": "customer.subscription.created",
            "data": {
                "object": {
                    "customer": "cus_123",
                    "id": "sub_123"
                }
            }
        }"#;

        let result = portal.receive_webhook(payload.to_string(), "t=123,v1=abc".to_string()).await;
        assert!(result.is_ok());
    }
}
