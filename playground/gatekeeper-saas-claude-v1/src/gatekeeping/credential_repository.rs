//! Credential Repository (Repository pattern): persistence facade for API-key
//! credentials. Owns the store, registry, index, and Postgres adapter; each
//! method forwards 1:1 to the owned registry (writes) or index (reads).

use std::sync::Arc;

use async_trait::async_trait;

use crate::domain::ApiKeyId;

use super::credential_db_adapter::{CredentialDbAdapter, PostgresCredentialDbAdapter};
use super::credential_index::{CredentialIndex, CredentialIndexImpl};
use super::credential_registry::{CredentialRegistry, CredentialRegistryImpl};
use super::credential_store::{CredentialStore, InMemoryCredentialStore};
use super::model::{ApiKey, ApiKeyStatus, GateError};

#[async_trait]
pub trait CredentialRepository: Send + Sync {
    async fn save_key(&self, key: ApiKey) -> Result<(), GateError>;
    async fn revoke(&self, key_id: &ApiKeyId) -> Result<(), GateError>;
    async fn find_by_hash(&self, key_hash: &str) -> Result<Option<ApiKey>, GateError>;
}

pub struct CredentialRepositoryImpl {
    registry: Arc<dyn CredentialRegistry>,
    index: Arc<dyn CredentialIndex>,
}

impl CredentialRepositoryImpl {
    pub fn new(registry: Arc<dyn CredentialRegistry>, index: Arc<dyn CredentialIndex>) -> Self {
        Self { registry, index }
    }

    pub fn with_db(db: Arc<dyn CredentialDbAdapter>) -> Self {
        let store: Arc<dyn CredentialStore> = Arc::new(InMemoryCredentialStore::new());
        let registry = Arc::new(CredentialRegistryImpl::new(store.clone(), db));
        let index = Arc::new(CredentialIndexImpl::new(store));
        Self::new(registry, index)
    }

    pub fn from_pool(pool: sqlx::PgPool) -> Self {
        let db: Arc<dyn CredentialDbAdapter> = Arc::new(PostgresCredentialDbAdapter::new(pool));
        Self::with_db(db)
    }
}

#[async_trait]
impl CredentialRepository for CredentialRepositoryImpl {
    async fn save_key(&self, key: ApiKey) -> Result<(), GateError> {
        // Step 1: Forward to the registry to create the credential.
        self.registry.create_key(key).await
    }

    async fn revoke(&self, key_id: &ApiKeyId) -> Result<(), GateError> {
        // Step 1: Forward to the registry to set the credential status to Revoked.
        self.registry.set_status(key_id, ApiKeyStatus::Revoked).await
    }

    async fn find_by_hash(&self, key_hash: &str) -> Result<Option<ApiKey>, GateError> {
        // Step 1: Forward to the index to resolve the active credential by key hash.
        Ok(self.index.find_by_hash(key_hash))
    }
}
