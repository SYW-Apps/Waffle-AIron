use crate::models::CustomerDetails;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use arc_swap::ArcSwap;

pub trait CustomerStore {
    fn get_cached_customer(&self, customer_id: &str) -> Option<CustomerDetails>;
    fn update_cached_customer(&self, customer: CustomerDetails);
}

pub struct InMemoryCustomerStore {
    cache: ArcSwap<HashMap<String, CustomerDetails>>,
    write_lock: Mutex<()>,
}

impl InMemoryCustomerStore {
    pub fn new() -> Self {
        Self {
            cache: ArcSwap::from_pointee(HashMap::new()),
            write_lock: Mutex::new(()),
        }
    }
}

impl Default for InMemoryCustomerStore {
    fn default() -> Self {
        Self::new()
    }
}

impl CustomerStore for InMemoryCustomerStore {
    fn get_cached_customer(&self, customer_id: &str) -> Option<CustomerDetails> {
        // Step 1: Read the local customer memory map using lock-free read swaps
        let map = self.cache.load();

        // Step 2: Return the CustomerDetails if found, otherwise return None
        map.get(customer_id).cloned()
    }

    fn update_cached_customer(&self, customer: CustomerDetails) {
        // Step 1: Acquire the write lock for the customer memory map safely
        let _guard = self.write_lock.lock().unwrap();

        // Step 2: Insert or update the customer details in active memory storage
        let current_map = self.cache.load();
        let mut new_map = (**current_map).clone();
        new_map.insert(customer.id.to_string(), customer);
        self.cache.store(Arc::new(new_map));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use uuid::Uuid;

    #[test]
    fn test_customer_store() {
        let store = InMemoryCustomerStore::default();
        let customer_id = Uuid::new_v4();
        assert!(store.get_cached_customer(&customer_id.to_string()).is_none());

        let customer = CustomerDetails {
            id: customer_id,
            email: "user@example.com".to_string(),
            stripe_customer_id: Some("cus_123".to_string()),
        };

        store.update_cached_customer(customer.clone());
        let cached = store.get_cached_customer(&customer_id.to_string());
        assert!(cached.is_some());
        let cached = cached.unwrap();
        assert_eq!(cached.email, "user@example.com");
        assert_eq!(cached.stripe_customer_id, Some("cus_123".to_string()));
    }
}
