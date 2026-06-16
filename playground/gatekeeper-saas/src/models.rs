use serde::{Serialize, Deserialize};
use chrono::{DateTime, Utc};
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct Customer {
    pub id: Uuid,
    pub email: String,
    pub stripe_customer_id: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct ApiKey {
    pub id: Uuid,
    pub customer_id: Uuid,
    pub key_hash: String,
    pub prefix: String,
    pub status: String, // "active" | "revoked"
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    #[sqlx(default)]
    pub plain_key: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct SubscriptionTier {
    pub id: String, // "free", "pro", "enterprise"
    pub name: String,
    pub request_limit: i64,
    pub rate_limit_per_minute: i32,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct Subscription {
    pub id: Uuid,
    pub customer_id: Uuid,
    pub stripe_subscription_id: Option<String>,
    pub tier_id: String,
    pub status: String, // "active", "past_due", "canceled", "trialing"
    pub current_period_start: DateTime<Utc>,
    pub current_period_end: DateTime<Utc>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct UsageAlertLog {
    pub id: Uuid,
    pub subscription_id: Uuid,
    pub billing_period_start: DateTime<Utc>,
    pub threshold_percent: i32, // 80 or 100
    pub sent_at: DateTime<Utc>,
}

// Structs for API transfer (L3/L4 inputs/outputs)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CachedLimits {
    pub request_limit: i64,
    pub rate_limit_per_minute: i32,
    pub current_usage: i64,
    pub window_start: DateTime<Utc>,
    pub status: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CustomerLimits {
    pub customer_id: Uuid,
    pub subscription_id: Uuid,
    pub tier_id: String,
    pub request_limit: i64,
    pub rate_limit_per_minute: i32,
    pub subscription_status: String,
    pub current_period_start: DateTime<Utc>,
    pub current_period_end: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AccessValidation {
    pub authorized: bool,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UsageStatus {
    pub current_usage: i64,
    pub limit: i64,
    pub rate_limit: i32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IncrementResult {
    pub current_usage: i64,
    pub limit_breached: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UsageAlertEvent {
    pub subscription_id: Uuid,
    pub threshold: i32,
    pub current_usage: i64,
    pub limit: i64,
    pub billing_start: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StripeSubscriptionDetails {
    pub stripe_subscription_id: String,
    pub stripe_customer_id: String,
    pub tier_id: String,
    pub status: String,
    pub current_period_start: DateTime<Utc>,
    pub current_period_end: DateTime<Utc>,
}

