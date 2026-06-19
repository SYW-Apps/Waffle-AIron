//! Shared infrastructure errors. `DbError` and `StripeError` carry a closed set
//! of variants (faithful to the spec's `variant` discriminator) plus a
//! human-readable message; `ApiError` is the HTTP-facing envelope returned by
//! Portals.

use serde::{Deserialize, Serialize};

/// Shared persistence error surfaced by Postgres adapters (sqlx). Wraps
/// connection, query, and mapping failures.
#[derive(Debug, Clone, thiserror::Error)]
pub enum DbError {
    #[error("connection error: {0}")]
    Connection(String),
    #[error("query error: {0}")]
    Query(String),
    #[error("mapping error: {0}")]
    Mapping(String),
    #[error("not found: {0}")]
    NotFound(String),
    #[error("conflict: {0}")]
    Conflict(String),
}

impl From<sqlx::Error> for DbError {
    fn from(err: sqlx::Error) -> Self {
        match err {
            sqlx::Error::RowNotFound => DbError::NotFound(err.to_string()),
            sqlx::Error::PoolTimedOut | sqlx::Error::PoolClosed | sqlx::Error::Io(_) => {
                DbError::Connection(err.to_string())
            }
            sqlx::Error::ColumnDecode { .. } | sqlx::Error::Decode(_) => {
                DbError::Mapping(err.to_string())
            }
            other => DbError::Query(other.to_string()),
        }
    }
}

/// Shared error surfaced by the Stripe adapter for API and webhook-verification
/// failures.
#[derive(Debug, Clone, thiserror::Error)]
pub enum StripeError {
    #[error("stripe api error: {0}")]
    Api(String),
    #[error("stripe rate limited: {0}")]
    RateLimited(String),
    #[error("invalid stripe signature: {0}")]
    InvalidSignature(String),
    #[error("stripe parse error: {0}")]
    Parse(String),
}

/// Shared HTTP-facing error returned by Portals. Maps a domain error to an HTTP
/// status and a stable machine-readable code.
#[derive(Debug, Clone, Serialize, Deserialize, thiserror::Error)]
#[error("{status} {code}: {message}")]
pub struct ApiError {
    pub status: u16,
    pub code: String,
    pub message: String,
}

impl ApiError {
    pub fn new(status: u16, code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            status,
            code: code.into(),
            message: message.into(),
        }
    }

    pub fn not_found(message: impl Into<String>) -> Self {
        Self::new(404, "not_found", message)
    }

    pub fn bad_request(message: impl Into<String>) -> Self {
        Self::new(400, "bad_request", message)
    }

    pub fn conflict(message: impl Into<String>) -> Self {
        Self::new(409, "conflict", message)
    }

    pub fn internal(message: impl Into<String>) -> Self {
        Self::new(500, "internal", message)
    }
}
