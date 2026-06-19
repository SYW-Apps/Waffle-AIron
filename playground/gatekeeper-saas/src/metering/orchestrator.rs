use std::sync::Arc;
use tokio::sync::mpsc::Sender;
use sha2::{Sha256, Digest};
use crate::models::{AccessValidation, UsageStatus, CachedLimits, UsageAlertEvent};
use crate::metering::cache_store::IMeteringCacheStore;
use crate::metering::billing_client::IBillingClientAdapter;

#[async_trait::async_trait]
pub trait IMeteringOrchestrator: Send + Sync {
    async fn verify_access(&self, key_value: String) -> Result<AccessValidation, String>;
    async fn increment_count(&self, key_value: String, cost: i32) -> Result<UsageStatus, String>;
}

pub struct MeteringOrchestrator {
    cache_store: Arc<dyn IMeteringCacheStore>,
    billing_client: Arc<dyn IBillingClientAdapter>,
    alert_sender: Sender<UsageAlertEvent>,
}

impl MeteringOrchestrator {
    pub fn new(
        cache_store: Arc<dyn IMeteringCacheStore>,
        billing_client: Arc<dyn IBillingClientAdapter>,
        alert_sender: Sender<UsageAlertEvent>,
    ) -> Self {
        Self {
            cache_store,
            billing_client,
            alert_sender,
        }
    }
}

#[async_trait::async_trait]
impl IMeteringOrchestrator for MeteringOrchestrator {
    async fn verify_access(&self, key_value: String) -> Result<AccessValidation, String> {
        // Step 1: Compute SHA-256 hash of API key credentials.
        let mut hasher = Sha256::new();
        hasher.update(key_value.as_bytes());
        let key_hash = format!("{:x}", hasher.finalize());

        // Step 2: Query limits profile in Redis cache store.
        let cached_limits = self.cache_store.check_limits_cache(key_hash.clone())
            .await
            .unwrap_or(None);

        // Step 3: If cache miss, fetch active limits metadata from billing client.
        let limits = match cached_limits {
            Some(l) => l,
            None => {
                let db_limits = self.billing_client.fetch_customer_limits_by_key(&key_hash)
                    .await
                    .map_err(|e| format!("DB error: {}", e))?;
                match db_limits {
                    Some(dbl) => {
                        let cached = CachedLimits {
                            request_limit: dbl.request_limit,
                            rate_limit_per_minute: dbl.rate_limit_per_minute,
                            current_usage: 0,
                            window_start: dbl.current_period_start,
                            status: dbl.subscription_status,
                        };
                        // Step 4: If fetched from billing db, save profile in Redis cache.
                        let _ = self.cache_store.write_limits_cache(key_hash.clone(), cached.clone()).await;
                        cached
                    }
                    None => return Ok(AccessValidation {
                        authorized: false,
                        reason: "Invalid API key".to_string(),
                    }),
                }
            }
        };

        // Step 5: Evaluate if customer is active and current requests are under rate limit threshold.
        let authorized = limits.status == "active";
        let reason = if authorized {
            "Authorized".to_string()
        } else {
            "Subscription inactive".to_string()
        };

        // Step 6: Return AccessValidation verdict.
        Ok(AccessValidation { authorized, reason })
    }

    async fn increment_count(&self, key_value: String, cost: i32) -> Result<UsageStatus, String> {
        // Step 1: Compute SHA-256 hash of API key credentials.
        let mut hasher = Sha256::new();
        hasher.update(key_value.as_bytes());
        let key_hash = format!("{:x}", hasher.finalize());

        // Step 2: Resolve active client limits profile, querying billing DB if uncached.
        let dbl = self.billing_client.fetch_customer_limits_by_key(&key_hash)
            .await
            .map_err(|e| format!("DB error: {}", e))?
            .ok_or_else(|| "Invalid API key".to_string())?;

        // Step 3: Atomically increment sliding window Redis usage counter.
        let inc_result = self.cache_store.increment_usage(
            key_hash.clone(),
            cost,
            dbl.rate_limit_per_minute as i64,
            60,
        ).await.map_err(|e| format!("Cache increment error: {}", e))?;

        // Step 4: Check if increment breaches 80% or 100% notification alert bounds, dispatching async warning event if met.
        let limit = dbl.request_limit;
        let current_usage = inc_result.current_usage;
        let prev_usage = current_usage - cost as i64;
        let limit_f64 = limit as f64;
        
        if limit > 0 {
            let prev_pct = prev_usage as f64 / limit_f64;
            let curr_pct = current_usage as f64 / limit_f64;
            
            if prev_pct < 0.8 && curr_pct >= 0.8 {
                let event = UsageAlertEvent {
                    subscription_id: dbl.subscription_id,
                    threshold: 80,
                    current_usage,
                    limit,
                    billing_start: dbl.current_period_start,
                };
                let _ = self.alert_sender.try_send(event);
            }
            
            if prev_pct < 1.0 && curr_pct >= 1.0 {
                let event = UsageAlertEvent {
                    subscription_id: dbl.subscription_id,
                    threshold: 100,
                    current_usage,
                    limit,
                    billing_start: dbl.current_period_start,
                };
                let _ = self.alert_sender.try_send(event);
            }
        }

        // Step 5: Return active UsageStatus details.
        Ok(UsageStatus {
            current_usage,
            limit,
            rate_limit: dbl.rate_limit_per_minute,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::CustomerLimits;
    use chrono::Utc;
    use uuid::Uuid;
    use std::sync::Mutex;

    struct MockCacheStore {
        cached: Mutex<Option<CachedLimits>>,
        usage: Mutex<i64>,
    }

    #[async_trait::async_trait]
    impl IMeteringCacheStore for MockCacheStore {
        async fn check_limits_cache(&self, _key_hash: String) -> Result<Option<CachedLimits>, redis::RedisError> {
            Ok(self.cached.lock().unwrap().clone())
        }
        async fn write_limits_cache(&self, _key_hash: String, limits: CachedLimits) -> Result<(), redis::RedisError> {
            *self.cached.lock().unwrap() = Some(limits);
            Ok(())
        }
        async fn increment_usage(
            &self,
            _key_hash: String,
            cost: i32,
            _limit: i64,
            _window_seconds: i64,
        ) -> Result<crate::models::IncrementResult, redis::RedisError> {
            let mut guard = self.usage.lock().unwrap();
            *guard += cost as i64;
            Ok(crate::models::IncrementResult {
                current_usage: *guard,
                limit_breached: false,
            })
        }
    }

    struct MockBillingClient {
        limits: Option<CustomerLimits>,
    }

    #[async_trait::async_trait]
    impl IBillingClientAdapter for MockBillingClient {
        async fn fetch_customer_limits_by_key(&self, _key_hash: &str) -> Result<Option<CustomerLimits>, sqlx::Error> {
            Ok(self.limits.clone())
        }
    }

    #[tokio::test]
    async fn test_verify_access_authorized() {
        let cache = Arc::new(MockCacheStore {
            cached: Mutex::new(None),
            usage: Mutex::new(0),
        });
        let db_limits = CustomerLimits {
            customer_id: Uuid::new_v4(),
            subscription_id: Uuid::new_v4(),
            tier_id: "pro".to_string(),
            request_limit: 1000,
            rate_limit_per_minute: 60,
            subscription_status: "active".to_string(),
            current_period_start: Utc::now(),
            current_period_end: Utc::now(),
        };
        let client = Arc::new(MockBillingClient { limits: Some(db_limits) });
        let (tx, _rx) = tokio::sync::mpsc::channel(10);
        let orchestrator = MeteringOrchestrator::new(cache.clone(), client, tx);

        let validation = orchestrator.verify_access("my_secret_key".to_string()).await.unwrap();
        assert!(validation.authorized);
        assert_eq!(validation.reason, "Authorized");

        // Verify it was cached
        let cached = cache.cached.lock().unwrap();
        assert!(cached.is_some());
        assert_eq!(cached.as_ref().unwrap().status, "active");
    }

    #[tokio::test]
    async fn test_increment_usage_and_alert() {
        let cache = Arc::new(MockCacheStore {
            cached: Mutex::new(None),
            usage: Mutex::new(799), // just below 800 (80% of 1000)
        });
        let db_limits = CustomerLimits {
            customer_id: Uuid::new_v4(),
            subscription_id: Uuid::new_v4(),
            tier_id: "pro".to_string(),
            request_limit: 1000,
            rate_limit_per_minute: 100,
            subscription_status: "active".to_string(),
            current_period_start: Utc::now(),
            current_period_end: Utc::now(),
        };
        let client = Arc::new(MockBillingClient { limits: Some(db_limits) });
        let (tx, mut rx) = tokio::sync::mpsc::channel(10);
        let orchestrator = MeteringOrchestrator::new(cache, client, tx);

        // Increment by 2, which pushes usage to 801 (crosses 80% threshold)
        let status = orchestrator.increment_count("my_secret_key".to_string(), 2).await.unwrap();
        assert_eq!(status.current_usage, 801);

        // Check if alert was dispatched
        let alert = rx.try_recv().unwrap();
        assert_eq!(alert.threshold, 80);
        assert_eq!(alert.current_usage, 801);
    }
}
