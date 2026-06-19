//! Credential Registry (Registry stereotype): write path for credentials.
//! Applies mutations to the store and persists via the Postgres adapter.

use std::sync::Arc;

use async_trait::async_trait;

use crate::domain::ApiKeyId;

use super::credential_db_adapter::CredentialDbAdapter;
use super::credential_store::CredentialStore;
use super::model::{ApiKey, ApiKeyStatus, GateError};

#[async_trait]
pub trait CredentialRegistry: Send + Sync {
    async fn create_key(&self, key: ApiKey) -> Result<(), GateError>;
    async fn set_status(&self, key_id: &ApiKeyId, status: ApiKeyStatus) -> Result<(), GateError>;
}

pub struct CredentialRegistryImpl {
    store: Arc<dyn CredentialStore>,
    db: Arc<dyn CredentialDbAdapter>,
}

impl CredentialRegistryImpl {
    pub fn new(store: Arc<dyn CredentialStore>, db: Arc<dyn CredentialDbAdapter>) -> Self {
        Self { store, db }
    }
}

#[async_trait]
impl CredentialRegistry for CredentialRegistryImpl {
    async fn create_key(&self, key: ApiKey) -> Result<(), GateError> {
        // Step 1: Insert the credential into the in-memory store.
        self.store.insert(key.clone());
        // Step 2: Persist the credential row to Postgres.
        self.db.upsert_key(&key).await?;
        // Step 3: Return Ok(()).
        Ok(())
    }

    async fn set_status(&self, key_id: &ApiKeyId, status: ApiKeyStatus) -> Result<(), GateError> {
        // Step 1: Apply the status change in the store; if absent, return Persistence error.
        if !self.store.set_status(key_id, status) {
            return Err(GateError::Persistence(format!("credential {key_id} not found")));
        }
        // Step 2: Read back the updated credential.
        let key = self
            .store
            .get(key_id)
            .ok_or_else(|| GateError::Persistence(key_id.to_string()))?;
        // Step 3: Persist the updated credential row to Postgres.
        self.db.upsert_key(&key).await?;
        // Step 4: Return Ok(()).
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::SubscriptionId;
    use crate::gatekeeping::credential_store::InMemoryCredentialStore;
    use crate::gatekeeping::test_support::MockCredentialDbAdapter;

    fn key() -> ApiKey {
        ApiKey {
            id: ApiKeyId::new("k1"),
            subscription_id: SubscriptionId::new("sub-1"),
            key_hash: "hash1".into(),
            status: ApiKeyStatus::Active,
            created_at: "2026-01-01T00:00:00Z".into(),
        }
    }

    #[tokio::test]
    async fn create_then_persist() {
        let store = Arc::new(InMemoryCredentialStore::new());
        let db = Arc::new(MockCredentialDbAdapter::ok());
        let registry = CredentialRegistryImpl::new(store.clone(), db.clone());
        registry.create_key(key()).await.unwrap();
        assert!(store.get(&ApiKeyId::new("k1")).is_some());
        assert_eq!(db.upsert_calls(), 1);
    }

    #[tokio::test]
    async fn set_status_absent_is_persistence_error() {
        let store = Arc::new(InMemoryCredentialStore::new());
        let db = Arc::new(MockCredentialDbAdapter::ok());
        let registry = CredentialRegistryImpl::new(store, db);
        let err = registry
            .set_status(&ApiKeyId::new("missing"), ApiKeyStatus::Revoked)
            .await
            .unwrap_err();
        assert!(matches!(err, GateError::Persistence(_)));
    }
}
