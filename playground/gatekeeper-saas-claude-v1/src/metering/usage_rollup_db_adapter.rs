//! Usage Rollup Postgres Adapter (Adapter stereotype): the only block doing
//! Postgres I/O for usage rollups (sqlx). No domain logic.

use async_trait::async_trait;
use sqlx::{PgPool, Row};

use crate::domain::{DbError, SubscriptionId};

use super::model::UsageRollup;

#[async_trait]
pub trait UsageRollupDbAdapter: Send + Sync {
    async fn load_rollups(
        &self,
        subscription_id: &SubscriptionId,
    ) -> Result<Vec<UsageRollup>, DbError>;
    async fn upsert_rollup(&self, rollup: &UsageRollup) -> Result<(), DbError>;
}

pub struct PostgresUsageRollupDbAdapter {
    pool: PgPool,
}

impl PostgresUsageRollupDbAdapter {
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
    }
}

#[async_trait]
impl UsageRollupDbAdapter for PostgresUsageRollupDbAdapter {
    async fn load_rollups(
        &self,
        subscription_id: &SubscriptionId,
    ) -> Result<Vec<UsageRollup>, DbError> {
        // Step 1: SELECT all rollup rows for the subscription and map into UsageRollups.
        let rows = sqlx::query(
            "SELECT subscription_id, resource, period, total FROM usage_rollups \
             WHERE subscription_id = $1",
        )
        .bind(&subscription_id.0)
        .fetch_all(&self.pool)
        .await?;
        rows.into_iter()
            .map(|row| {
                Ok(UsageRollup {
                    subscription_id: SubscriptionId::new(row.try_get::<String, _>("subscription_id")?),
                    resource: row.try_get("resource")?,
                    period: row.try_get("period")?,
                    total: row.try_get("total")?,
                })
            })
            .collect()
    }

    async fn upsert_rollup(&self, rollup: &UsageRollup) -> Result<(), DbError> {
        // Step 1: INSERT ... ON CONFLICT (subscription_id, resource, period) DO UPDATE total.
        sqlx::query(
            "INSERT INTO usage_rollups (subscription_id, resource, period, total) \
             VALUES ($1, $2, $3, $4) \
             ON CONFLICT (subscription_id, resource, period) DO UPDATE SET total = EXCLUDED.total",
        )
        .bind(&rollup.subscription_id.0)
        .bind(&rollup.resource)
        .bind(&rollup.period)
        .bind(rollup.total)
        .execute(&self.pool)
        .await?;
        Ok(())
    }
}
