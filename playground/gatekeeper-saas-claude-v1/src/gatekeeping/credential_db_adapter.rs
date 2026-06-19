//! Credential Postgres Adapter (Adapter stereotype): the only block doing
//! Postgres I/O for credentials (sqlx). No domain logic.

use async_trait::async_trait;
use sqlx::{PgPool, Row};

use crate::domain::{ApiKeyId, DbError, SubscriptionId};

use super::model::{ApiKey, ApiKeyStatus};

#[async_trait]
pub trait CredentialDbAdapter: Send + Sync {
    async fn load_all(&self) -> Result<Vec<ApiKey>, DbError>;
    async fn upsert_key(&self, key: &ApiKey) -> Result<(), DbError>;
}

pub struct PostgresCredentialDbAdapter {
    pool: PgPool,
}

impl PostgresCredentialDbAdapter {
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
    }
}

#[async_trait]
impl CredentialDbAdapter for PostgresCredentialDbAdapter {
    async fn load_all(&self) -> Result<Vec<ApiKey>, DbError> {
        // Step 1: SELECT all rows from api_key_credentials and map each into an ApiKey.
        let rows = sqlx::query(
            "SELECT id, subscription_id, key_hash, status, created_at FROM api_key_credentials",
        )
        .fetch_all(&self.pool)
        .await?;
        rows.into_iter()
            .map(|row| {
                Ok(ApiKey {
                    id: ApiKeyId::new(row.try_get::<String, _>("id")?),
                    subscription_id: SubscriptionId::new(row.try_get::<String, _>("subscription_id")?),
                    key_hash: row.try_get("key_hash")?,
                    status: ApiKeyStatus::parse(row.try_get::<String, _>("status")?.as_str())?,
                    created_at: row.try_get("created_at")?,
                })
            })
            .collect()
    }

    async fn upsert_key(&self, key: &ApiKey) -> Result<(), DbError> {
        // Step 1: INSERT ... ON CONFLICT (id) DO UPDATE the status, binding the ApiKey.
        sqlx::query(
            "INSERT INTO api_key_credentials (id, subscription_id, key_hash, status, created_at) \
             VALUES ($1, $2, $3, $4, $5) \
             ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status",
        )
        .bind(&key.id.0)
        .bind(&key.subscription_id.0)
        .bind(&key.key_hash)
        .bind(key.status.as_str())
        .bind(&key.created_at)
        .execute(&self.pool)
        .await?;
        Ok(())
    }
}
