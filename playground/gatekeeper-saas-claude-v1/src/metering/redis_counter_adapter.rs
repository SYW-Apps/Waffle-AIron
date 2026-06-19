//! Redis Counter Adapter (Adapter stereotype): the only block doing Redis I/O
//! for metering (deadpool-redis). Atomic counter operations and edge-trigger
//! threshold flags keyed per subscription/resource/window. No domain logic.
//!
//! The counter stores the cumulative USED value for a window (so it is directly
//! queryable); `remaining` is derived from the caller-supplied quota.

use async_trait::async_trait;
use deadpool_redis::Pool;

use crate::domain::SubscriptionId;

use super::model::{ConsumeOutcome, CounterSnapshot, MeteringError};

#[async_trait]
pub trait CounterAdapter: Send + Sync {
    async fn check_and_decrement(
        &self,
        key: String,
        amount: i64,
        quota: i64,
        ttl_seconds: i64,
    ) -> Result<ConsumeOutcome, MeteringError>;
    async fn get(&self, key: String) -> Result<Option<i64>, MeteringError>;
    async fn snapshot_all(&self) -> Result<Vec<CounterSnapshot>, MeteringError>;
    async fn try_mark_threshold(
        &self,
        key: String,
        threshold: i64,
        ttl_seconds: i64,
    ) -> Result<bool, MeteringError>;
}

/// Lua: seed-on-miss to 0 with TTL, INCRBY amount, and if the new value exceeds
/// quota, DECRBY back and report denied. Returns {allowed(0|1), used}.
const CHECK_AND_DECREMENT: &str = r#"
if redis.call('EXISTS', KEYS[1]) == 0 then
  redis.call('SET', KEYS[1], 0, 'EX', ARGV[3])
end
local newv = redis.call('INCRBY', KEYS[1], ARGV[1])
if newv > tonumber(ARGV[2]) then
  redis.call('DECRBY', KEYS[1], ARGV[1])
  return {0, tonumber(redis.call('GET', KEYS[1]))}
else
  return {1, newv}
end
"#;

pub struct RedisCounterAdapter {
    pool: Pool,
}

impl RedisCounterAdapter {
    pub fn new(pool: Pool) -> Self {
        Self { pool }
    }

    async fn conn(&self) -> Result<deadpool_redis::Connection, MeteringError> {
        self.pool
            .get()
            .await
            .map_err(|e| MeteringError::CounterFailure(e.to_string()))
    }
}

fn fail(e: redis::RedisError) -> MeteringError {
    MeteringError::CounterFailure(e.to_string())
}

#[async_trait]
impl CounterAdapter for RedisCounterAdapter {
    async fn check_and_decrement(
        &self,
        key: String,
        amount: i64,
        quota: i64,
        ttl_seconds: i64,
    ) -> Result<ConsumeOutcome, MeteringError> {
        // Step 1: Run the atomic seed/incr/floor Lua script.
        let mut conn = self.conn().await?;
        let (allowed_flag, used): (i64, i64) = redis::Script::new(CHECK_AND_DECREMENT)
            .key(&key)
            .arg(amount)
            .arg(quota)
            .arg(ttl_seconds)
            .invoke_async(&mut conn)
            .await
            .map_err(fail)?;
        // Step 2: Compute used and remaining and build the ConsumeOutcome.
        Ok(ConsumeOutcome {
            allowed: allowed_flag == 1,
            used,
            remaining: (quota - used).max(0),
        })
    }

    async fn get(&self, key: String) -> Result<Option<i64>, MeteringError> {
        // Step 1: GET the counter value for the key and return it as Option<i64>.
        let mut conn = self.conn().await?;
        redis::cmd("GET")
            .arg(&key)
            .query_async::<Option<i64>>(&mut conn)
            .await
            .map_err(fail)
    }

    async fn snapshot_all(&self) -> Result<Vec<CounterSnapshot>, MeteringError> {
        // Step 1: SCAN counter keys, parse subscription/resource/window, read values.
        let mut conn = self.conn().await?;
        let mut cursor: u64 = 0;
        let mut snapshots = Vec::new();
        loop {
            let (next, keys): (u64, Vec<String>) = redis::cmd("SCAN")
                .arg(cursor)
                .arg("COUNT")
                .arg(200)
                .query_async(&mut conn)
                .await
                .map_err(fail)?;
            for key in keys {
                // Counter keys are "sub:resource:window"; flag keys have more parts — skip.
                let parts: Vec<&str> = key.split(':').collect();
                if parts.len() != 3 {
                    continue;
                }
                let used: Option<i64> = redis::cmd("GET")
                    .arg(&key)
                    .query_async(&mut conn)
                    .await
                    .map_err(fail)?;
                if let Some(used) = used {
                    snapshots.push(CounterSnapshot {
                        subscription_id: SubscriptionId::new(parts[0]),
                        resource: parts[1].to_string(),
                        window: parts[2].to_string(),
                        used,
                    });
                }
            }
            cursor = next;
            if cursor == 0 {
                break;
            }
        }
        Ok(snapshots)
    }

    async fn try_mark_threshold(
        &self,
        key: String,
        threshold: i64,
        ttl_seconds: i64,
    ) -> Result<bool, MeteringError> {
        // Step 1: SET a threshold-flag key with NX and the TTL; true only if newly set.
        let mut conn = self.conn().await?;
        let flag_key = format!("{key}:thr:{threshold}");
        let set: Option<String> = redis::cmd("SET")
            .arg(&flag_key)
            .arg(1)
            .arg("NX")
            .arg("EX")
            .arg(ttl_seconds)
            .query_async(&mut conn)
            .await
            .map_err(fail)?;
        Ok(set.is_some())
    }
}
