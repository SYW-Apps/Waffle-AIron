//! Credential Store (Store stereotype): authoritative in-memory state for
//! API-key credentials with a key_hash secondary index. Wait-free snapshot
//! reads; mutex-serialized copy-on-write writes.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use arc_swap::ArcSwap;

use crate::domain::ApiKeyId;

use super::model::{ApiKey, ApiKeyStatus};

pub trait CredentialStore: Send + Sync {
    fn insert(&self, key: ApiKey);
    fn get_by_hash(&self, key_hash: &str) -> Option<ApiKey>;
    fn get(&self, key_id: &ApiKeyId) -> Option<ApiKey>;
    fn set_status(&self, key_id: &ApiKeyId, status: ApiKeyStatus) -> bool;
}

#[derive(Default, Clone)]
struct State {
    by_id: HashMap<String, ApiKey>,
    hash_to_id: HashMap<String, String>,
}

pub struct InMemoryCredentialStore {
    snapshot: ArcSwap<State>,
    write_lock: Mutex<()>,
}

impl Default for InMemoryCredentialStore {
    fn default() -> Self {
        Self {
            snapshot: ArcSwap::from_pointee(State::default()),
            write_lock: Mutex::new(()),
        }
    }
}

impl InMemoryCredentialStore {
    pub fn new() -> Self {
        Self::default()
    }

    fn mutate<R>(&self, f: impl FnOnce(&mut State) -> R) -> R {
        let _guard = self.write_lock.lock().expect("credential store write lock");
        let mut next = (**self.snapshot.load()).clone();
        let result = f(&mut next);
        self.snapshot.store(Arc::new(next));
        result
    }
}

impl CredentialStore for InMemoryCredentialStore {
    fn insert(&self, key: ApiKey) {
        // Step 1: Insert or replace in the id map and update the key_hash secondary index.
        self.mutate(|state| {
            state.hash_to_id.insert(key.key_hash.clone(), key.id.0.clone());
            state.by_id.insert(key.id.0.clone(), key);
        });
    }

    fn get_by_hash(&self, key_hash: &str) -> Option<ApiKey> {
        // Step 1: Resolve the id via the key_hash secondary index, then clone the credential.
        let snapshot = self.snapshot.load();
        let id = snapshot.hash_to_id.get(key_hash)?;
        snapshot.by_id.get(id).cloned()
    }

    fn get(&self, key_id: &ApiKeyId) -> Option<ApiKey> {
        // Step 1: Return a clone of the credential for the id if present.
        self.snapshot.load().by_id.get(&key_id.0).cloned()
    }

    fn set_status(&self, key_id: &ApiKeyId, status: ApiKeyStatus) -> bool {
        // Step 1: If the credential exists, mutate its status and return true, else false.
        self.mutate(|state| match state.by_id.get_mut(&key_id.0) {
            Some(key) => {
                key.status = status;
                true
            }
            None => false,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::SubscriptionId;

    fn key() -> ApiKey {
        ApiKey {
            id: ApiKeyId::new("k1"),
            subscription_id: SubscriptionId::new("sub-1"),
            key_hash: "hash1".into(),
            status: ApiKeyStatus::Active,
            created_at: "2026-01-01T00:00:00Z".into(),
        }
    }

    #[test]
    fn insert_lookup_and_status() {
        let store = InMemoryCredentialStore::new();
        store.insert(key());
        assert!(store.get_by_hash("hash1").is_some());
        assert!(store.get(&ApiKeyId::new("k1")).is_some());
        assert!(store.set_status(&ApiKeyId::new("k1"), ApiKeyStatus::Revoked));
        assert_eq!(store.get(&ApiKeyId::new("k1")).unwrap().status, ApiKeyStatus::Revoked);
        assert!(!store.set_status(&ApiKeyId::new("missing"), ApiKeyStatus::Revoked));
    }
}
