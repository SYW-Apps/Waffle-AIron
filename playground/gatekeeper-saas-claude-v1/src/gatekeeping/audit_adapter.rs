//! Decision Audit Adapter (Adapter stereotype): the only block writing
//! decision-audit records to Postgres (append-only). No domain logic; write-only.

use async_trait::async_trait;
use sqlx::PgPool;

use super::model::{DecisionAuditRecord, GateError};

#[async_trait]
pub trait AuditAdapter: Send + Sync {
    async fn record_decision(&self, record: DecisionAuditRecord) -> Result<(), GateError>;
}

pub struct PostgresAuditAdapter {
    pool: PgPool,
}

impl PostgresAuditAdapter {
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
    }
}

#[async_trait]
impl AuditAdapter for PostgresAuditAdapter {
    async fn record_decision(&self, record: DecisionAuditRecord) -> Result<(), GateError> {
        // Step 1: INSERT the DecisionAuditRecord into the decision_audit_log table.
        sqlx::query(
            "INSERT INTO decision_audit_log \
             (subscription_id, billing_account_id, resource, allowed, reason, timestamp) \
             VALUES ($1, $2, $3, $4, $5, $6)",
        )
        .bind(&record.subscription_id.0)
        .bind(&record.billing_account_id.0)
        .bind(&record.resource)
        .bind(record.allowed)
        .bind(&record.reason)
        .bind(&record.timestamp)
        .execute(&self.pool)
        .await
        .map_err(|e| GateError::Persistence(e.to_string()))?;
        Ok(())
    }
}
