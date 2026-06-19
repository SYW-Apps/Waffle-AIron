//! API Key Authenticator (Specialist stereotype): verifies a presented API key
//! by hashing it and resolving the active credential to its subscription.
//! Performs no I/O beyond the credential repository.

use std::sync::Arc;

use async_trait::async_trait;

use super::credential_repository::CredentialRepository;
use super::model::{hash_key, AuthResult, GateError};

#[async_trait]
pub trait ApiKeyAuthenticator: Send + Sync {
    async fn authenticate(&self, api_key: String) -> Result<AuthResult, GateError>;
}

pub struct ApiKeyAuthenticatorImpl {
    credentials: Arc<dyn CredentialRepository>,
}

impl ApiKeyAuthenticatorImpl {
    pub fn new(credentials: Arc<dyn CredentialRepository>) -> Self {
        Self { credentials }
    }
}

#[async_trait]
impl ApiKeyAuthenticator for ApiKeyAuthenticatorImpl {
    async fn authenticate(&self, api_key: String) -> Result<AuthResult, GateError> {
        // Step 1: Hash the presented api_key with the same algorithm used at issue time.
        let key_hash = hash_key(&api_key);
        // Step 2: Look up an active credential by key hash.
        let credential = self.credentials.find_by_hash(&key_hash).await?;
        // Step 3: If absent (or inactive), Unauthenticated; otherwise return the AuthResult.
        match credential {
            Some(key) => Ok(AuthResult { subscription_id: key.subscription_id }),
            None => Err(GateError::Unauthenticated("unknown or revoked api key".into())),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::{ApiKeyId, SubscriptionId};
    use crate::gatekeeping::credential_repository::CredentialRepositoryImpl;
    use crate::gatekeeping::credential_store::{CredentialStore, InMemoryCredentialStore};
    use crate::gatekeeping::credential_index::CredentialIndexImpl;
    use crate::gatekeeping::credential_registry::CredentialRegistryImpl;
    use crate::gatekeeping::model::{ApiKey, ApiKeyStatus};
    use crate::gatekeeping::test_support::MockCredentialDbAdapter;

    fn repo_with_key(plaintext: &str) -> Arc<dyn CredentialRepository> {
        let store: Arc<dyn CredentialStore> = Arc::new(InMemoryCredentialStore::new());
        store.insert(ApiKey {
            id: ApiKeyId::new("k1"),
            subscription_id: SubscriptionId::new("sub-1"),
            key_hash: hash_key(plaintext),
            status: ApiKeyStatus::Active,
            created_at: "2026-01-01T00:00:00Z".into(),
        });
        let db = Arc::new(MockCredentialDbAdapter::ok());
        let registry = Arc::new(CredentialRegistryImpl::new(store.clone(), db));
        let index = Arc::new(CredentialIndexImpl::new(store));
        Arc::new(CredentialRepositoryImpl::new(registry, index))
    }

    #[tokio::test]
    async fn authenticates_known_key() {
        let auth = ApiKeyAuthenticatorImpl::new(repo_with_key("gk_secret"));
        let result = auth.authenticate("gk_secret".into()).await.unwrap();
        assert_eq!(result.subscription_id, SubscriptionId::new("sub-1"));
    }

    #[tokio::test]
    async fn rejects_unknown_key() {
        let auth = ApiKeyAuthenticatorImpl::new(repo_with_key("gk_secret"));
        let err = auth.authenticate("wrong".into()).await.unwrap_err();
        assert!(matches!(err, GateError::Unauthenticated(_)));
    }
}
