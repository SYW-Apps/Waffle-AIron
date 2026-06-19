//! Notification Log Adapter (Adapter stereotype): the only block writing
//! notification delivery records to Postgres (append-only). Write-only, no domain
//! logic.

use async_trait::async_trait;
use sqlx::PgPool;

use super::model::{NotificationError, NotificationRecord};

#[async_trait]
pub trait NotificationLogAdapter: Send + Sync {
    async fn record_sent(&self, record: NotificationRecord) -> Result<(), NotificationError>;
}

pub struct PostgresNotificationLogAdapter {
    pool: PgPool,
}

impl PostgresNotificationLogAdapter {
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
    }
}

#[async_trait]
impl NotificationLogAdapter for PostgresNotificationLogAdapter {
    async fn record_sent(&self, record: NotificationRecord) -> Result<(), NotificationError> {
        // Step 1: INSERT the NotificationRecord into the notification_log table.
        sqlx::query(
            "INSERT INTO notification_log (billing_account_id, to_email, subject, sent_at, status) \
             VALUES ($1, $2, $3, $4, $5)",
        )
        .bind(&record.billing_account_id.0)
        .bind(record.to.as_str())
        .bind(&record.subject)
        .bind(&record.sent_at)
        .bind(&record.status)
        .execute(&self.pool)
        .await
        .map_err(|e| NotificationError::Persistence(e.to_string()))?;
        Ok(())
    }
}
