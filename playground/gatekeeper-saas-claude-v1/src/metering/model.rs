//! Metering subsystem domain model: the hot-path consume request/outcome, Redis
//! counter snapshots, authoritative usage rollups, the published usage-threshold
//! event, and the reported usage view.

use serde::{Deserialize, Serialize};

use crate::domain::{BillingAccountId, DbError, SubscriptionId};

/// Hot-path request to consume usage.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ConsumeRequest {
    pub subscription_id: SubscriptionId,
    pub billing_account_id: BillingAccountId,
    pub resource: String,
    pub quota: i64,
    /// Reset window: minute | day | month.
    pub window: String,
    pub amount: i64,
}

/// Result of a consume attempt.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct ConsumeOutcome {
    pub allowed: bool,
    pub used: i64,
    pub remaining: i64,
}

/// A point-in-time read of a single Redis usage counter.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CounterSnapshot {
    pub subscription_id: SubscriptionId,
    pub resource: String,
    pub window: String,
    pub used: i64,
}

/// Authoritative historical usage total for a subscription/resource within a period.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct UsageRollup {
    pub subscription_id: SubscriptionId,
    pub resource: String,
    /// Period key, e.g. 2026-06.
    pub period: String,
    pub total: i64,
}

/// Published when a subscription crosses a usage threshold. Carries enough
/// context for notifications to resolve the billing email without calling back.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct UsageThresholdEvent {
    pub subscription_id: SubscriptionId,
    pub billing_account_id: BillingAccountId,
    pub resource: String,
    pub used: i64,
    pub quota: i64,
    /// used/quota at crossing time.
    pub ratio: f64,
    pub window: String,
}

/// Reported usage for a subscription/resource: live window usage plus historical
/// period total.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct UsageView {
    pub subscription_id: SubscriptionId,
    pub resource: String,
    pub window: String,
    pub used: i64,
    pub period_total: i64,
}

/// Domain error for the metering subsystem.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum MeteringError {
    #[error("not found: {0}")]
    NotFound(String),
    #[error("counter failure: {0}")]
    CounterFailure(String),
    #[error("publish failure: {0}")]
    PublishFailure(String),
    #[error("persistence failure: {0}")]
    Persistence(String),
}

impl From<DbError> for MeteringError {
    fn from(err: DbError) -> Self {
        match err {
            DbError::NotFound(msg) => MeteringError::NotFound(msg),
            other => MeteringError::Persistence(other.to_string()),
        }
    }
}

/// TTL in seconds implied by a counter window.
pub fn window_ttl_seconds(window: &str) -> i64 {
    match window {
        "minute" => 60,
        "day" => 86_400,
        "month" => 2_592_000,
        _ => 86_400,
    }
}

/// The current period key (year-month) used for rollups.
pub fn current_period() -> String {
    chrono::Utc::now().format("%Y-%m").to_string()
}
