use std::collections::HashMap;
use std::sync::Arc;
use crate::models::{AuthDecision, PortalError};
use crate::gatekeeper::orchestrator::GatekeeperOrchestrator;
use async_trait::async_trait;

#[async_trait]
pub trait GatekeeperPortal {
    async fn handle_request(
        &self,
        req_headers: HashMap<String, String>,
        path: String,
    ) -> Result<AuthDecision, PortalError>;
}

pub struct GatekeeperPortalImpl {
    orchestrator: Arc<dyn GatekeeperOrchestrator + Send + Sync>,
}

impl GatekeeperPortalImpl {
    pub fn new(orchestrator: Arc<dyn GatekeeperOrchestrator + Send + Sync>) -> Self {
        Self { orchestrator }
    }
}

#[async_trait]
impl GatekeeperPortal for GatekeeperPortalImpl {
    async fn handle_request(
        &self,
        req_headers: HashMap<String, String>,
        _path: String,
    ) -> Result<AuthDecision, PortalError> {
        // Step 1: Extract the API key from the request headers map ('X-API-Key')
        let api_key = req_headers
            .iter()
            .find(|(k, _)| k.to_lowercase() == "x-api-key")
            .map(|(_, v)| v.clone())
            .ok_or_else(|| PortalError::HeaderExtractionError("Missing X-API-Key header".to_string()))?;

        // Step 2: Call the gatekeeper orchestrator to authorize the key and evaluate rate/volume limits
        let decision = self.orchestrator
            .authorize_request(api_key)
            .await
            .map_err(|e| PortalError::OrchestrationError(e.to_string()))?;

        // Step 3: Return the authorization status decision to the client with appropriate headers
        Ok(decision)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::GatekeeperError;

    struct MockOrchestrator {
        should_fail: bool,
        allowed: bool,
        remaining: u32,
    }

    #[async_trait]
    impl GatekeeperOrchestrator for MockOrchestrator {
        async fn authorize_request(
            &self,
            api_key: String,
        ) -> Result<AuthDecision, GatekeeperError> {
            if self.should_fail {
                return Err(GatekeeperError::DatabaseError("Simulated DB error".to_string()));
            }
            if api_key == "invalid-key" {
                return Ok(AuthDecision {
                    allowed: false,
                    remaining_requests: 0,
                    reset_seconds: 0,
                    error_message: Some("Invalid API Key".to_string()),
                });
            }
            Ok(AuthDecision {
                allowed: self.allowed,
                remaining_requests: self.remaining,
                reset_seconds: 60,
                error_message: None,
            })
        }
    }

    #[tokio::test]
    async fn test_handle_request_success() {
        let mock_orch = Arc::new(MockOrchestrator {
            should_fail: false,
            allowed: true,
            remaining: 99,
        });
        let portal = GatekeeperPortalImpl::new(mock_orch);

        let mut headers = HashMap::new();
        headers.insert("X-API-Key".to_string(), "valid-key-123".to_string());

        let result = portal.handle_request(headers, "/api/v1/test".to_string()).await;
        assert!(result.is_ok());
        let decision = result.unwrap();
        assert!(decision.allowed);
        assert_eq!(decision.remaining_requests, 99);
    }

    #[tokio::test]
    async fn test_handle_request_missing_header() {
        let mock_orch = Arc::new(MockOrchestrator {
            should_fail: false,
            allowed: true,
            remaining: 100,
        });
        let portal = GatekeeperPortalImpl::new(mock_orch);

        let headers = HashMap::new();

        let result = portal.handle_request(headers, "/api/v1/test".to_string()).await;
        assert!(result.is_err());
        match result.unwrap_err() {
            PortalError::HeaderExtractionError(msg) => {
                assert_eq!(msg, "Missing X-API-Key header");
            }
            _ => panic!("Expected HeaderExtractionError"),
        }
    }

    #[tokio::test]
    async fn test_handle_request_orchestrator_failure() {
        let mock_orch = Arc::new(MockOrchestrator {
            should_fail: true,
            allowed: false,
            remaining: 0,
        });
        let portal = GatekeeperPortalImpl::new(mock_orch);

        let mut headers = HashMap::new();
        headers.insert("x-api-key".to_string(), "valid-key-123".to_string());

        let result = portal.handle_request(headers, "/api/v1/test".to_string()).await;
        assert!(result.is_err());
        match result.unwrap_err() {
            PortalError::OrchestrationError(msg) => {
                assert!(msg.contains("Database error"));
            }
            _ => panic!("Expected OrchestrationError"),
        }
    }

    #[tokio::test]
    async fn test_handle_request_invalid_key() {
        let mock_orch = Arc::new(MockOrchestrator {
            should_fail: false,
            allowed: false,
            remaining: 0,
        });
        let portal = GatekeeperPortalImpl::new(mock_orch);

        let mut headers = HashMap::new();
        headers.insert("X-API-Key".to_string(), "invalid-key".to_string());

        let result = portal.handle_request(headers, "/api/v1/test".to_string()).await;
        assert!(result.is_ok());
        let decision = result.unwrap();
        assert!(!decision.allowed);
        assert_eq!(decision.error_message, Some("Invalid API Key".to_string()));
    }
}
