use crate::models::CachedMeter;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use arc_swap::ArcSwap;

pub trait MeterStore {
    fn get_cached_meter(&self, subscription_id: &str) -> Option<CachedMeter>;
    fn update_cached_meter(&self, subscription_id: String, meter: CachedMeter);
}

pub struct InMemoryMeterStore {
    cache: ArcSwap<HashMap<String, CachedMeter>>,
    write_lock: Mutex<()>,
}

impl InMemoryMeterStore {
    pub fn new() -> Self {
        Self {
            cache: ArcSwap::from_pointee(HashMap::new()),
            write_lock: Mutex::new(()),
        }
    }
}

impl Default for InMemoryMeterStore {
    fn default() -> Self {
        Self::new()
    }
}

impl MeterStore for InMemoryMeterStore {
    fn get_cached_meter(&self, subscription_id: &str) -> Option<CachedMeter> {
        // Step 1: Read the local memory map utilizing lock-free read swaps
        let map = self.cache.load();

        // Step 2: Return the CachedMeter if found, otherwise return None
        map.get(subscription_id).cloned()
    }

    fn update_cached_meter(&self, subscription_id: String, meter: CachedMeter) {
        // Step 1: Acquire the write lock for the local memory map safely
        let _guard = self.write_lock.lock().unwrap();

        // Step 2: Insert or replace the subscription meter data in the active memory storage
        let current_map = self.cache.load();
        let mut new_map = (**current_map).clone();
        new_map.insert(subscription_id, meter);
        self.cache.store(Arc::new(new_map));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_in_memory_meter_store() {
        let store = InMemoryMeterStore::default();
        assert!(store.get_cached_meter("sub_123").is_none());

        let meter = CachedMeter {
            subscription_id: "sub_123".to_string(),
            rate_limit_count: 5,
            monthly_usage_count: 100,
            last_request_time: 123456,
        };

        store.update_cached_meter("sub_123".to_string(), meter.clone());
        let cached = store.get_cached_meter("sub_123");
        assert!(cached.is_some());
        let cached = cached.unwrap();
        assert_eq!(cached.rate_limit_count, 5);
        assert_eq!(cached.monthly_usage_count, 100);

        let updated_meter = CachedMeter {
            subscription_id: "sub_123".to_string(),
            rate_limit_count: 6,
            monthly_usage_count: 101,
            last_request_time: 123457,
        };
        store.update_cached_meter("sub_123".to_string(), updated_meter);
        let cached = store.get_cached_meter("sub_123").unwrap();
        assert_eq!(cached.rate_limit_count, 6);
        assert_eq!(cached.monthly_usage_count, 101);
    }
}
