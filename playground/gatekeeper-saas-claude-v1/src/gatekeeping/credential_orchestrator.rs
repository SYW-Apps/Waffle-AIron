//! Credential Orchestrator (Orchestrator stereotype): issues and revokes API
//! keys for a subscription. Generates a key, stores its hash mapped to the
//! subscription, and returns the plaintext once. Delegates persistence to the
//! credential repository.

use std::sync::Arc;

use async_trait::async_trait;
use uuid::Uuid;

use crate::domain::{ApiKeyId, SubscriptionId};

use super::credential_repository::CredentialRepository;
use super::model::{hash_key, ApiKey, ApiKeyStatus, GateError, IssuedKey};

#[async_trait]
pub trait CredentialOrchestrator: Send + Sync {
    async fn issue_key(&self, subscription_id: SubscriptionId) -> Result<IssuedKey, GateError>;
    async fn revoke_key(&self, key_id: ApiKeyId) -> Result<(), GateError>;
}

pub struct CredentialOrchestratorImpl {
    credentials: Arc<dyn CredentialRepository>,
}

impl CredentialOrchestratorImpl {
    pub fn new(credentials: Arc<dyn CredentialRepository>) -> Self {
        Self { credentials }
    }
}

#[async_trait]
impl CredentialOrchestrator for CredentialOrchestratorImpl {
    async fn issue_key(&self, subscription_id: SubscriptionId) -> Result<IssuedKey, GateError> {
        // Step 1: Generate a cryptographically random API key (plaintext) and a new ApiKeyId.
        let plaintext = format!(
            "gk_{}{}",
            Uuid::new_v4().simple(),
            Uuid::new_v4().simple()
        );
        let id = ApiKeyId::new(Uuid::new_v4().to_string());
        // Step 2: Hash the plaintext key (SHA-256).
        let key_hash = hash_key(&plaintext);
        // Step 3: Build an ApiKey { id, subscription_id, key_hash, status: Active, created_at }.
        let key = ApiKey {
            id: id.clone(),
            subscription_id: subscription_id.clone(),
            key_hash,
            status: ApiKeyStatus::Active,
            created_at: chrono::Utc::now().to_rfc3339(),
        };
        // Step 4: Persist the credential.
        self.credentials.save_key(key).await?;
        // Step 5: Return IssuedKey (plaintext exposed only here).
        Ok(IssuedKey { id, plaintext, subscription_id })
    }

    async fn revoke_key(&self, key_id: ApiKeyId) -> Result<(), GateError> {
        // Step 1: Revoke the credential by id.
        self.credentials.revoke(&key_id).await?;
        // Step 2: Return Ok(()).
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::gatekeeping::credential_repository::CredentialRepositoryImpl;
    use crate::gatekeeping::test_support::MockCredentialDbAdapter;

    #[tokio::test]
    async fn issue_key_returns_plaintext_once() {
        let repo = Arc::new(CredentialRepositoryImpl::with_db(Arc::new(
            MockCredentialDbAdapter::ok(),
        )));
        let orch = CredentialOrchestratorImpl::new(repo);
        let issued = orch.issue_key(SubscriptionId::new("sub-1")).await.unwrap();
        assert!(issued.plaintext.starts_with("gk_"));
        assert_eq!(issued.subscription_id, SubscriptionId::new("sub-1"));
    }
}
