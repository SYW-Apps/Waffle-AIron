//! Credential Index (Index stereotype): read path over the credential store.
//! Never mutates.

use std::sync::Arc;

use crate::domain::ApiKeyId;

use super::credential_store::CredentialStore;
use super::model::{ApiKey, ApiKeyStatus};

pub trait CredentialIndex: Send + Sync {
    fn find_by_hash(&self, key_hash: &str) -> Option<ApiKey>;
    fn find_by_id(&self, key_id: &ApiKeyId) -> Option<ApiKey>;
}

pub struct CredentialIndexImpl {
    store: Arc<dyn CredentialStore>,
}

impl CredentialIndexImpl {
    pub fn new(store: Arc<dyn CredentialStore>) -> Self {
        Self { store }
    }
}

impl CredentialIndex for CredentialIndexImpl {
    fn find_by_hash(&self, key_hash: &str) -> Option<ApiKey> {
        // Step 1: Read the credential from the store by key hash.
        let key = self.store.get_by_hash(key_hash);
        // Step 2: Return the credential if Active, else None.
        key.filter(|k| k.status == ApiKeyStatus::Active)
    }

    fn find_by_id(&self, key_id: &ApiKeyId) -> Option<ApiKey> {
        // Step 1: Read the credential from the store by id.
        let key = self.store.get(key_id);
        // Step 2: Return the result.
        key
    }
}
