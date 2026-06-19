use crate::models::AdapterError;
use async_trait::async_trait;
use redis::Client;

#[async_trait]
pub trait RedisAdapter {
    async fn incr_rate_limit(&self, key: String, window_seconds: u64) -> Result<u32, AdapterError>;
    async fn incr_monthly_usage(&self, key: String) -> Result<u32, AdapterError>;
    async fn get_string(&self, key: String) -> Result<Option<String>, AdapterError>;
}

pub struct RedisAdapterImpl {
    client: Client,
}

impl RedisAdapterImpl {
    pub fn new(redis_url: &str) -> Result<Self, AdapterError> {
        let client = Client::open(redis_url)
            .map_err(|e| AdapterError::RedisError(e.to_string()))?;
        Ok(Self { client })
    }
}

#[async_trait]
impl RedisAdapter for RedisAdapterImpl {
    async fn incr_rate_limit(&self, key: String, window_seconds: u64) -> Result<u32, AdapterError> {
        // Step 1: Obtain a client connection from the Redis pool
        let mut conn = self.client.get_async_connection()
            .await
            .map_err(|e| AdapterError::RedisError(e.to_string()))?;

        // Step 2: Atomically increment the key counter and set the expiration TTL if counter is 1
        // We use a Redis Lua script to guarantee atomicity of INCR + EXPIRE
        let script = redis::Script::new(r#"
            local val = redis.call('INCR', KEYS[1])
            if val == 1 then
                redis.call('EXPIRE', KEYS[1], ARGV[1])
            end
            return val
        "#);

        // Step 3: Return the current counter value or Redis error
        let val: u32 = script
            .key(key)
            .arg(window_seconds)
            .invoke_async(&mut conn)
            .await
            .map_err(|e| AdapterError::RedisError(e.to_string()))?;

        Ok(val)
    }

    async fn incr_monthly_usage(&self, key: String) -> Result<u32, AdapterError> {
        // Step 1: Obtain a client connection from the Redis pool
        let mut conn = self.client.get_async_connection()
            .await
            .map_err(|e| AdapterError::RedisError(e.to_string()))?;

        // Step 2: Increment the hash field or string value for the billing cycle key
        let val: u32 = redis::cmd("INCR")
            .arg(key)
            .query_async(&mut conn)
            .await
            .map_err(|e| AdapterError::RedisError(e.to_string()))?;

        // Step 3: Return the newly updated count value
        Ok(val)
    }

    async fn get_string(&self, key: String) -> Result<Option<String>, AdapterError> {
        // Step 1: Obtain a client connection from the Redis pool
        let mut conn = self.client.get_async_connection()
            .await
            .map_err(|e| AdapterError::RedisError(e.to_string()))?;

        // Step 2: Execute GET command for the specified key
        let val: Option<String> = redis::cmd("GET")
            .arg(&key)
            .query_async(&mut conn)
            .await
            .map_err(|e| AdapterError::RedisError(e.to_string()))?;

        // Step 3: Return the string value if found, or None
        Ok(val)
    }
}
