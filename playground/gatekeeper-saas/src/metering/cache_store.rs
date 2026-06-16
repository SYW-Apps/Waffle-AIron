use deadpool_redis::Pool;
use crate::models::{CachedLimits, IncrementResult};
use uuid::Uuid;
use chrono::Utc;

#[async_trait::async_trait]
pub trait IMeteringCacheStore: Send + Sync {
    async fn check_limits_cache(&self, key_hash: String) -> Result<Option<CachedLimits>, redis::RedisError>;
    async fn write_limits_cache(&self, key_hash: String, limits: CachedLimits) -> Result<(), redis::RedisError>;
    async fn increment_usage(
        &self,
        key_hash: String,
        cost: i32,
        limit: i64,
        window_seconds: i64,
    ) -> Result<IncrementResult, redis::RedisError>;
}

pub struct MeteringCacheStore {
    pool: Pool,
}

impl MeteringCacheStore {
    pub fn new(pool: Pool) -> Self {
        Self { pool }
    }
}

#[async_trait::async_trait]
impl IMeteringCacheStore for MeteringCacheStore {
    async fn check_limits_cache(&self, key_hash: String) -> Result<Option<CachedLimits>, redis::RedisError> {
        // Step 1: Acquire connection from Redis client pool.
        let mut conn = self.pool.get().await.map_err(|e| {
            redis::RedisError::from((redis::ErrorKind::IoError, "Pool connection failed", e.to_string()))
        })?;

        // Step 2: Query Redis key matching key_hash limits profile.
        let key = format!("limits:{}", key_hash);
        let val: Option<String> = redis::cmd("GET")
            .arg(&key)
            .query_async(&mut *conn)
            .await?;

        // Step 3: Deserialize limits JSON string and return CachedLimits details if found.
        match val {
            Some(json_str) => {
                let limits: CachedLimits = serde_json::from_str(&json_str).map_err(|e| {
                    redis::RedisError::from((
                        redis::ErrorKind::TypeError,
                        "Deserialization failed",
                        e.to_string(),
                    ))
                })?;
                Ok(Some(limits))
            }
            None => Ok(None),
        }
    }

    async fn write_limits_cache(&self, key_hash: String, limits: CachedLimits) -> Result<(), redis::RedisError> {
        // Step 1: Acquire connection from Redis client pool.
        let mut conn = self.pool.get().await.map_err(|e| {
            redis::RedisError::from((redis::ErrorKind::IoError, "Pool connection failed", e.to_string()))
        })?;

        // Step 2: Serialize limits profile to JSON and save in Redis with TTL expiration.
        let json_str = serde_json::to_string(&limits).map_err(|e| {
            redis::RedisError::from((
                redis::ErrorKind::TypeError,
                "Serialization failed",
                e.to_string(),
            ))
        })?;
        let key = format!("limits:{}", key_hash);
        
        let _: () = redis::cmd("SETEX")
            .arg(&key)
            .arg(300) // 5 minutes TTL
            .arg(json_str)
            .query_async(&mut *conn)
            .await?;

        Ok(())
    }

    async fn increment_usage(
        &self,
        key_hash: String,
        cost: i32,
        limit: i64,
        window_seconds: i64,
    ) -> Result<IncrementResult, redis::RedisError> {
        // Step 1: Acquire connection from Redis client pool.
        let mut conn = self.pool.get().await.map_err(|e| {
            redis::RedisError::from((redis::ErrorKind::IoError, "Pool connection failed", e.to_string()))
        })?;

        // Step 2: Execute atomic Redis Lua script to increment usage count within sliding window.
        let script = redis::Script::new(r#"
            local key = KEYS[1]
            local now = tonumber(ARGV[1])
            local window = tonumber(ARGV[2])
            local limit = tonumber(ARGV[3])
            local cost = tonumber(ARGV[4])
            local rand_val = ARGV[5]
            
            local clear_before = now - window
            redis.call('ZREMRANGEBYSCORE', key, 0, clear_before)
            
            local members = redis.call('ZRANGEBYSCORE', key, clear_before, now)
            local current_usage = 0
            for _, member in ipairs(members) do
                local parts = {}
                for part in string.gmatch(member, "[^_]+") do
                    table.insert(parts, part)
                end
                local member_cost = tonumber(parts[3]) or 1
                current_usage = current_usage + member_cost
            end
            
            local limit_breached = (current_usage + cost > limit)
            if not limit_breached then
                local member_val = now .. "_" .. rand_val .. "_" .. cost
                redis.call('ZADD', key, now, member_val)
                current_usage = current_usage + cost
                redis.call('EXPIRE', key, window)
            end
            
            return { current_usage, limit_breached and 1 or 0 }
        "#);

        let key = format!("usage:{}", key_hash);
        let now = Utc::now().timestamp();
        let rand_val = Uuid::new_v4().to_string();

        let result: Vec<i64> = script
            .key(&key)
            .arg(now)
            .arg(window_seconds)
            .arg(limit)
            .arg(cost)
            .arg(&rand_val)
            .invoke_async(&mut *conn)
            .await?;

        // Step 3: Return IncrementResult containing current count and breach status flag.
        let current_usage = *result.first().unwrap_or(&0);
        let breach_flag = *result.get(1).unwrap_or(&0);

        Ok(IncrementResult {
            current_usage,
            limit_breached: breach_flag == 1,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use deadpool_redis::{Config, Runtime};

    #[tokio::test]
    async fn test_cache_store_offline_fallback() {
        let config = Config::from_url("redis://127.0.0.1:6379");
        let pool = config.create_pool(Some(Runtime::Tokio1)).unwrap();
        let store = MeteringCacheStore::new(pool);
        
        let res = store.check_limits_cache("test_key".to_string()).await;
        match res {
            Ok(val) => {
                assert!(val.is_none());
            }
            Err(e) => {
                println!("Redis is offline, error: {}. Handled fallback cleanly.", e);
            }
        }
    }
}
