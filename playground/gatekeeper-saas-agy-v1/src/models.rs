use serde::{Serialize, Deserialize};
use uuid::Uuid;
use chrono::NaiveDateTime;
use std::fmt;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AuthDecision {
    pub allowed: bool,
    pub remaining_requests: u32,
    pub reset_seconds: u64,
    pub error_message: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SubscriptionDetails {
    pub id: Uuid,
    pub customer_id: Uuid,
    pub customer_email: String,
    pub stripe_subscription_id: String,
    pub status: String,
    pub tier_id: String,
    pub api_limit: u32,
    pub current_period_start: NaiveDateTime,
    pub current_period_end: NaiveDateTime,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CustomerDetails {
    pub id: Uuid,
    pub email: String,
    pub stripe_customer_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CachedMeter {
    pub subscription_id: String,
    pub rate_limit_count: u32,
    pub monthly_usage_count: u32,
    pub last_request_time: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MeterResult {
    pub rate_limit_allowed: bool,
    pub monthly_limit_allowed: bool,
    pub current_rate_count: u32,
    pub current_monthly_count: u32,
}

#[derive(Debug, Clone)]
pub enum PortalError {
    HeaderExtractionError(String),
    OrchestrationError(String),
}

impl fmt::Display for PortalError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::HeaderExtractionError(msg) => write!(f, "Header extraction error: {}", msg),
            Self::OrchestrationError(msg) => write!(f, "Orchestration error: {}", msg),
        }
    }
}

impl std::error::Error for PortalError {}

#[derive(Debug, Clone)]
pub enum GatekeeperError {
    SubscriptionNotFound,
    SubscriptionInactive,
    RateLimitExceeded,
    MonthlyLimitExceeded,
    DatabaseError(String),
    CacheError(String),
}

impl fmt::Display for GatekeeperError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::SubscriptionNotFound => write!(f, "Subscription not found"),
            Self::SubscriptionInactive => write!(f, "Subscription is inactive"),
            Self::RateLimitExceeded => write!(f, "Rate limit exceeded"),
            Self::MonthlyLimitExceeded => write!(f, "Monthly limit exceeded"),
            Self::DatabaseError(msg) => write!(f, "Database error: {}", msg),
            Self::CacheError(msg) => write!(f, "Cache error: {}", msg),
        }
    }
}

impl std::error::Error for GatekeeperError {}

#[derive(Debug, Clone)]
pub enum RepositoryError {
    DatabaseError(String),
    CacheError(String),
    NotFound,
}

impl fmt::Display for RepositoryError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::DatabaseError(msg) => write!(f, "Database error: {}", msg),
            Self::CacheError(msg) => write!(f, "Cache error: {}", msg),
            Self::NotFound => write!(f, "Not found"),
        }
    }
}

impl std::error::Error for RepositoryError {}

#[derive(Debug, Clone)]
pub enum RegistryError {
    DatabaseError(String),
}

impl fmt::Display for RegistryError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::DatabaseError(msg) => write!(f, "Database error: {}", msg),
        }
    }
}

impl std::error::Error for RegistryError {}

#[derive(Debug, Clone)]
pub enum DbError {
    ConnectionError(String),
    QueryError(String),
}

impl fmt::Display for DbError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::ConnectionError(msg) => write!(f, "Connection error: {}", msg),
            Self::QueryError(msg) => write!(f, "Query error: {}", msg),
        }
    }
}

impl std::error::Error for DbError {}

#[derive(Debug, Clone)]
pub enum AdapterError {
    RedisError(String),
    StripeError(String),
    NetworkError(String),
}

impl fmt::Display for AdapterError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::RedisError(msg) => write!(f, "Redis error: {}", msg),
            Self::StripeError(msg) => write!(f, "Stripe error: {}", msg),
            Self::NetworkError(msg) => write!(f, "Network error: {}", msg),
        }
    }
}

impl std::error::Error for AdapterError {}

#[derive(Debug, Clone)]
pub enum MeterError {
    RedisError(String),
    CacheError(String),
}

impl fmt::Display for MeterError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::RedisError(msg) => write!(f, "Redis error: {}", msg),
            Self::CacheError(msg) => write!(f, "Cache error: {}", msg),
        }
    }
}

impl std::error::Error for MeterError {}

#[derive(Debug, Clone)]
pub enum NotificationError {
    SmtpError(String),
    PushServiceError(String),
}

impl fmt::Display for NotificationError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::SmtpError(msg) => write!(f, "SMTP error: {}", msg),
            Self::PushServiceError(msg) => write!(f, "Push service error: {}", msg),
        }
    }
}

impl std::error::Error for NotificationError {}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StripeSubscriptionDetails {
    pub stripe_subscription_id: String,
    pub status: String,
    pub plan_id: String,
}

#[derive(Debug, Clone)]
pub enum StripeError {
    ApiError(String),
}

impl fmt::Display for StripeError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::ApiError(msg) => write!(f, "Stripe API error: {}", msg),
        }
    }
}

impl std::error::Error for StripeError {}

#[derive(Debug, Clone)]
pub enum BillingError {
    OrchestrationError(String),
    DatabaseError(String),
    StripeError(String),
}

impl fmt::Display for BillingError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::OrchestrationError(msg) => write!(f, "Billing orchestration error: {}", msg),
            Self::DatabaseError(msg) => write!(f, "Billing database error: {}", msg),
            Self::StripeError(msg) => write!(f, "Billing stripe error: {}", msg),
        }
    }
}

impl std::error::Error for BillingError {}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WebhookResponse {
    pub success: bool,
    pub message: String,
}


