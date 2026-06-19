//! Plan Postgres Adapter (Adapter stereotype): the only block doing Postgres
//! I/O for the plan aggregate (sqlx). No domain logic.

use async_trait::async_trait;
use sqlx::{PgPool, Row};

use crate::domain::{DbError, PlanId, TierId};

use super::model::{Limit, Plan, Tier};

#[async_trait]
pub trait PlanDbAdapter: Send + Sync {
    async fn load_plan(&self, id: &PlanId) -> Result<Option<Plan>, DbError>;
    async fn load_all_plans(&self) -> Result<Vec<Plan>, DbError>;
    async fn upsert_plan(&self, plan: &Plan) -> Result<(), DbError>;
}

pub struct PostgresPlanDbAdapter {
    pool: PgPool,
}

impl PostgresPlanDbAdapter {
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
    }

    /// Load the tiers (with their limits) for a plan id.
    async fn load_tiers(&self, plan_id: &str) -> Result<Vec<Tier>, DbError> {
        let tier_rows = sqlx::query(
            "SELECT id, name, stripe_price_id FROM tiers WHERE plan_id = $1 ORDER BY id",
        )
        .bind(plan_id)
        .fetch_all(&self.pool)
        .await?;

        let mut tiers = Vec::with_capacity(tier_rows.len());
        for row in tier_rows {
            let tier_id: String = row.try_get("id")?;
            let limit_rows = sqlx::query(
                "SELECT resource, quota, window FROM tier_limits WHERE tier_id = $1",
            )
            .bind(&tier_id)
            .fetch_all(&self.pool)
            .await?;
            let limits = limit_rows
                .into_iter()
                .map(|r| {
                    Ok(Limit {
                        resource: r.try_get("resource")?,
                        quota: r.try_get("quota")?,
                        window: r.try_get("window")?,
                    })
                })
                .collect::<Result<Vec<_>, DbError>>()?;
            tiers.push(Tier {
                id: TierId::new(tier_id),
                name: row.try_get("name")?,
                stripe_price_id: row.try_get("stripe_price_id")?,
                limits,
            });
        }
        Ok(tiers)
    }
}

#[async_trait]
impl PlanDbAdapter for PostgresPlanDbAdapter {
    async fn load_plan(&self, id: &PlanId) -> Result<Option<Plan>, DbError> {
        // Step 1: SELECT the plan with its tiers and limits (joins) and assemble a Plan.
        let row = sqlx::query("SELECT id, name, active FROM plans WHERE id = $1")
            .bind(&id.0)
            .fetch_optional(&self.pool)
            .await?;
        let Some(row) = row else { return Ok(None) };
        let tiers = self.load_tiers(&id.0).await?;
        Ok(Some(Plan {
            id: PlanId::new(row.try_get::<String, _>("id")?),
            name: row.try_get("name")?,
            active: row.try_get("active")?,
            tiers,
        }))
    }

    async fn load_all_plans(&self) -> Result<Vec<Plan>, DbError> {
        // Step 1: SELECT all plans with tiers and limits for store hydration.
        let rows = sqlx::query("SELECT id, name, active FROM plans ORDER BY id")
            .fetch_all(&self.pool)
            .await?;
        let mut plans = Vec::with_capacity(rows.len());
        for row in rows {
            let id: String = row.try_get("id")?;
            let tiers = self.load_tiers(&id).await?;
            plans.push(Plan {
                id: PlanId::new(id),
                name: row.try_get("name")?,
                active: row.try_get("active")?,
                tiers,
            });
        }
        Ok(plans)
    }

    async fn upsert_plan(&self, plan: &Plan) -> Result<(), DbError> {
        // Step 1: In a transaction, upsert the plan row, its tier rows, and their limit rows.
        let mut tx = self.pool.begin().await?;
        sqlx::query(
            "INSERT INTO plans (id, name, active) VALUES ($1, $2, $3) \
             ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, active = EXCLUDED.active",
        )
        .bind(&plan.id.0)
        .bind(&plan.name)
        .bind(plan.active)
        .execute(&mut *tx)
        .await?;

        for tier in &plan.tiers {
            sqlx::query(
                "INSERT INTO tiers (id, plan_id, name, stripe_price_id) VALUES ($1, $2, $3, $4) \
                 ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, \
                 stripe_price_id = EXCLUDED.stripe_price_id",
            )
            .bind(&tier.id.0)
            .bind(&plan.id.0)
            .bind(&tier.name)
            .bind(&tier.stripe_price_id)
            .execute(&mut *tx)
            .await?;

            sqlx::query("DELETE FROM tier_limits WHERE tier_id = $1")
                .bind(&tier.id.0)
                .execute(&mut *tx)
                .await?;
            for limit in &tier.limits {
                sqlx::query(
                    "INSERT INTO tier_limits (tier_id, resource, quota, window) \
                     VALUES ($1, $2, $3, $4)",
                )
                .bind(&tier.id.0)
                .bind(&limit.resource)
                .bind(limit.quota)
                .bind(&limit.window)
                .execute(&mut *tx)
                .await?;
            }
        }

        tx.commit().await?;
        Ok(())
    }
}
