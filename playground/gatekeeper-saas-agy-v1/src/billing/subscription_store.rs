use crate::models::SubscriptionDetails;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use arc_swap::ArcSwap;

pub trait SubscriptionStore {
    fn get_cached_subscription(&self, api_key: &str) -> Option<SubscriptionDetails>;
    fn update_cached_subscription(&self, api_key: String, sub: SubscriptionDetails);
}

pub struct InMemorySubscriptionStore {
    cache: ArcSwap<HashMap<String, SubscriptionDetails>>,
    write_lock: Mutex<()>,
}

impl InMemorySubscriptionStore {
    pub fn new() -> Self {
        Self {
            cache: ArcSwap::from_pointee(HashMap::new()),
            write_lock: Mutex::new(()),
        }
    }
}

impl Default for InMemorySubscriptionStore {
    fn default() -> Self {
        Self::new()
    }
}

impl SubscriptionStore for InMemorySubscriptionStore {
    fn get_cached_subscription(&self, api_key: &str) -> Option<SubscriptionDetails> {
        // Step 1: Read the local memory map utilizing lock-free read swaps
        let map = self.cache.load();

        // Step 2: Return the SubscriptionDetails if found, otherwise return None
        map.get(api_key).cloned()
    }

    fn update_cached_subscription(&self, api_key: String, sub: SubscriptionDetails) {
        // Step 1: Acquire the write lock for the local memory map safely
        let _guard = self.write_lock.lock().unwrap();

        // Step 2: Insert or replace the subscription details in the active memory storage
        let current_map = self.cache.load();
        let mut new_map = (**current_map).clone();
        new_map.insert(api_key, sub);
        self.cache.store(Arc::new(new_map));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use uuid::Uuid;
    use chrono::Utc;

    #[test]
    fn test_subscription_store() {
        let store = InMemorySubscriptionStore::default();
        assert!(store.get_cached_subscription("key_123").is_none());

        let sub = SubscriptionDetails {
            id: Uuid::new_v4(),
            customer_id: Uuid::new_v4(),
            customer_email: "test@example.com".to_string(),
            stripe_subscription_id: "sub_123".to_string(),
            status: "active".to_string(),
            tier_id: "pro".to_string(),
            api_limit: 10000,
            current_period_start: Utc::now().naive_utc(),
            current_period_end: Utc::now().naive_utc(),
        };

        store.update_cached_subscription("key_123".to_string(), sub.clone());
        let cached = store.get_cached_subscription("key_123");
        assert!(cached.is_some());
        let cached = cached.unwrap();
        assert_eq!(cached.customer_email, "test@example.com");
        assert_eq!(cached.stripe_subscription_id, "sub_123");
    }
}
