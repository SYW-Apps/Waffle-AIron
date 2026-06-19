use crate::models::{MeterResult, MeterError, CachedMeter};
use crate::gatekeeper::redis_adapter::RedisAdapter;
use crate::gatekeeper::meter_store::MeterStore;
use async_trait::async_trait;
use std::sync::Arc;

#[async_trait]
pub trait MeterRepository {
    async fn check_and_increment(&self, subscription_id: String, rate_limit: u32, monthly_limit: u32) -> Result<MeterResult, MeterError>;
    async fn get_current_usage(&self, subscription_id: String) -> Result<u32, MeterError>;
}

pub struct MeterRepositoryImpl {
    redis_adapter: Arc<dyn RedisAdapter + Send + Sync>,
    meter_store: Arc<dyn MeterStore + Send + Sync>,
}

impl MeterRepositoryImpl {
    pub fn new(
        redis_adapter: Arc<dyn RedisAdapter + Send + Sync>,
        meter_store: Arc<dyn MeterStore + Send + Sync>,
    ) -> Self {
        Self {
            redis_adapter,
            meter_store,
        }
    }
}

#[async_trait]
impl MeterRepository for MeterRepositoryImpl {
    async fn check_and_increment(&self, subscription_id: String, rate_limit: u32, monthly_limit: u32) -> Result<MeterResult, MeterError> {
        // Step 1: Call the Redis adapter to increment the sliding window rate limit counter
        let rate_key = format!("rate:{}", subscription_id);
        let current_rate_count = self.redis_adapter
            .incr_rate_limit(rate_key, 60)
            .await
            .map_err(|e| MeterError::RedisError(e.to_string()))?;

        // Step 2: Verify if the rate limit count exceeds the allowed threshold
        let rate_limit_allowed = current_rate_count <= rate_limit;

        // Step 3: Call the Redis adapter to increment the monthly usage counter
        let monthly_key = format!("usage:{}", subscription_id);
        let current_monthly_count = self.redis_adapter
            .incr_monthly_usage(monthly_key)
            .await
            .map_err(|e| MeterError::RedisError(e.to_string()))?;

        let monthly_limit_allowed = current_monthly_count <= monthly_limit;

        // Step 4: Call the meter store to cache the newly updated metrics in memory
        let cached = CachedMeter {
            subscription_id: subscription_id.clone(),
            rate_limit_count: current_rate_count,
            monthly_usage_count: current_monthly_count,
            last_request_time: chrono::Utc::now().timestamp() as u64,
        };
        self.meter_store.update_cached_meter(subscription_id, cached);

        // Step 5: Return the merged result of rate limits and monthly usage status
        Ok(MeterResult {
            rate_limit_allowed,
            monthly_limit_allowed,
            current_rate_count,
            current_monthly_count,
        })
    }

    async fn get_current_usage(&self, subscription_id: String) -> Result<u32, MeterError> {
        // Step 1: Call the meter store to check for locally cached monthly usage
        let cached = self.meter_store.get_cached_meter(&subscription_id);

        if let Some(cached_meter) = cached {
            // Step 4: Return the current monthly usage count
            return Ok(cached_meter.monthly_usage_count);
        }

        // Step 2: If cache missed, call the Redis adapter to fetch monthly usage
        let monthly_key = format!("usage:{}", subscription_id);
        let val_str = self.redis_adapter
            .get_string(monthly_key)
            .await
            .map_err(|e| MeterError::RedisError(e.to_string()))?;

        let count = match val_str {
            Some(s) => s.parse::<u32>().unwrap_or(0),
            None => 0,
        };

        // Step 3: Cache the value back into the local meter store
        let cached_meter = CachedMeter {
            subscription_id: subscription_id.clone(),
            rate_limit_count: 0,
            monthly_usage_count: count,
            last_request_time: chrono::Utc::now().timestamp() as u64,
        };
        self.meter_store.update_cached_meter(subscription_id, cached_meter);

        // Step 4: Return the current monthly usage count
        Ok(count)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::AdapterError;
    use std::sync::Mutex;

    struct MockRedisAdapter {
        rate_count: Mutex<u32>,
        monthly_count: Mutex<u32>,
        get_string_val: Option<String>,
        should_fail_rate: bool,
        should_fail_monthly: bool,
        should_fail_get: bool,
    }

    #[async_trait]
    impl RedisAdapter for MockRedisAdapter {
        async fn incr_rate_limit(&self, _key: String, _window_seconds: u64) -> Result<u32, AdapterError> {
            if self.should_fail_rate {
                return Err(AdapterError::NetworkError("Rate fail".to_string()));
            }
            let mut count = self.rate_count.lock().unwrap();
            *count += 1;
            Ok(*count)
        }

        async fn incr_monthly_usage(&self, _key: String) -> Result<u32, AdapterError> {
            if self.should_fail_monthly {
                return Err(AdapterError::NetworkError("Monthly fail".to_string()));
            }
            let mut count = self.monthly_count.lock().unwrap();
            *count += 1;
            Ok(*count)
        }

        async fn get_string(&self, _key: String) -> Result<Option<String>, AdapterError> {
            if self.should_fail_get {
                return Err(AdapterError::NetworkError("Get fail".to_string()));
            }
            Ok(self.get_string_val.clone())
        }
    }

    struct MockMeterStore {
        cached: Mutex<Option<CachedMeter>>,
    }

    impl MeterStore for MockMeterStore {
        fn get_cached_meter(&self, _subscription_id: &str) -> Option<CachedMeter> {
            self.cached.lock().unwrap().clone()
        }

        fn update_cached_meter(&self, _subscription_id: String, meter: CachedMeter) {
            *self.cached.lock().unwrap() = Some(meter);
        }
    }

    #[tokio::test]
    async fn test_check_and_increment() {
        let redis_adapter = Arc::new(MockRedisAdapter {
            rate_count: Mutex::new(0),
            monthly_count: Mutex::new(50),
            get_string_val: None,
            should_fail_rate: false,
            should_fail_monthly: false,
            should_fail_get: false,
        });

        let meter_store = Arc::new(MockMeterStore {
            cached: Mutex::new(None),
        });

        let repository = MeterRepositoryImpl::new(redis_adapter.clone(), meter_store.clone());

        // Test first request: rate limit 10, monthly limit 100
        let result = repository.check_and_increment("sub_123".to_string(), 10, 100).await;
        assert!(result.is_ok());
        let res = result.unwrap();
        assert!(res.rate_limit_allowed);
        assert!(res.monthly_limit_allowed);
        assert_eq!(res.current_rate_count, 1);
        assert_eq!(res.current_monthly_count, 51);

        // Check it cached in store
        let cached = meter_store.get_cached_meter("sub_123");
        assert!(cached.is_some());
        let cached = cached.unwrap();
        assert_eq!(cached.rate_limit_count, 1);
        assert_eq!(cached.monthly_usage_count, 51);
    }

    #[tokio::test]
    async fn test_get_current_usage_cache_hit() {
        let redis_adapter = Arc::new(MockRedisAdapter {
            rate_count: Mutex::new(0),
            monthly_count: Mutex::new(0),
            get_string_val: None,
            should_fail_rate: false,
            should_fail_monthly: false,
            should_fail_get: false,
        });

        let cached_meter = CachedMeter {
            subscription_id: "sub_123".to_string(),
            rate_limit_count: 0,
            monthly_usage_count: 75,
            last_request_time: 123456,
        };

        let meter_store = Arc::new(MockMeterStore {
            cached: Mutex::new(Some(cached_meter)),
        });

        let repository = MeterRepositoryImpl::new(redis_adapter, meter_store);

        let usage = repository.get_current_usage("sub_123".to_string()).await;
        assert!(usage.is_ok());
        assert_eq!(usage.unwrap(), 75);
    }

    #[tokio::test]
    async fn test_get_current_usage_cache_miss() {
        let redis_adapter = Arc::new(MockRedisAdapter {
            rate_count: Mutex::new(0),
            monthly_count: Mutex::new(0),
            get_string_val: Some("150".to_string()),
            should_fail_rate: false,
            should_fail_monthly: false,
            should_fail_get: false,
        });

        let meter_store = Arc::new(MockMeterStore {
            cached: Mutex::new(None),
        });

        let repository = MeterRepositoryImpl::new(redis_adapter, meter_store.clone());

        let usage = repository.get_current_usage("sub_123".to_string()).await;
        assert!(usage.is_ok());
        assert_eq!(usage.unwrap(), 150);

        // Verify it was cached
        let cached = meter_store.get_cached_meter("sub_123").unwrap();
        assert_eq!(cached.monthly_usage_count, 150);
    }

    #[tokio::test]
    async fn test_check_and_increment_rate_limit_failure() {
        let redis_adapter = Arc::new(MockRedisAdapter {
            rate_count: Mutex::new(0),
            monthly_count: Mutex::new(0),
            get_string_val: None,
            should_fail_rate: true,
            should_fail_monthly: false,
            should_fail_get: false,
        });
        let meter_store = Arc::new(MockMeterStore { cached: Mutex::new(None) });
        let repository = MeterRepositoryImpl::new(redis_adapter, meter_store);
        let result = repository.check_and_increment("sub_123".to_string(), 10, 100).await;
        assert!(result.is_err());
        assert!(matches!(result.unwrap_err(), MeterError::RedisError(_)));
    }

    #[tokio::test]
    async fn test_check_and_increment_monthly_usage_failure() {
        let redis_adapter = Arc::new(MockRedisAdapter {
            rate_count: Mutex::new(0),
            monthly_count: Mutex::new(0),
            get_string_val: None,
            should_fail_rate: false,
            should_fail_monthly: true,
            should_fail_get: false,
        });
        let meter_store = Arc::new(MockMeterStore { cached: Mutex::new(None) });
        let repository = MeterRepositoryImpl::new(redis_adapter, meter_store);
        let result = repository.check_and_increment("sub_123".to_string(), 10, 100).await;
        assert!(result.is_err());
        assert!(matches!(result.unwrap_err(), MeterError::RedisError(_)));
    }

    #[tokio::test]
    async fn test_get_current_usage_failure() {
        let redis_adapter = Arc::new(MockRedisAdapter {
            rate_count: Mutex::new(0),
            monthly_count: Mutex::new(0),
            get_string_val: None,
            should_fail_rate: false,
            should_fail_monthly: false,
            should_fail_get: true,
        });
        let meter_store = Arc::new(MockMeterStore { cached: Mutex::new(None) });
        let repository = MeterRepositoryImpl::new(redis_adapter, meter_store);
        let result = repository.get_current_usage("sub_123".to_string()).await;
        assert!(result.is_err());
        assert!(matches!(result.unwrap_err(), MeterError::RedisError(_)));
    }
}
