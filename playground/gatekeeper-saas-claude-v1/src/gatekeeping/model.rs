//! Gatekeeping subsystem domain model: API-key credentials, the authorize
//! request/decision, the audit record, and the gate error. The billing account
//! is sourced from entitlements at authorize time, never stored on a credential.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::domain::{ApiKeyId, DbError, SubscriptionId};
use crate::metering::model::MeteringError;
use crate::subscriptions::model::SubscriptionError;

/// Lifecycle status of an API key.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ApiKeyStatus {
    Active,
    Revoked,
}

impl ApiKeyStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            ApiKeyStatus::Active => "Active",
            ApiKeyStatus::Revoked => "Revoked",
        }
    }

    pub fn parse(value: &str) -> Result<Self, DbError> {
        match value {
            "Active" => Ok(ApiKeyStatus::Active),
            "Revoked" => Ok(ApiKeyStatus::Revoked),
            other => Err(DbError::Mapping(format!("unknown api key status: {other}"))),
        }
    }
}

/// A credential mapping a hashed API key to a subscription.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ApiKey {
    pub id: ApiKeyId,
    pub subscription_id: SubscriptionId,
    pub key_hash: String,
    pub status: ApiKeyStatus,
    pub created_at: String,
}

/// The identity resolved from a valid API key.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AuthResult {
    pub subscription_id: SubscriptionId,
}

/// Result of issuing an API key; carries the plaintext exactly once.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct IssuedKey {
    pub id: ApiKeyId,
    pub plaintext: String,
    pub subscription_id: SubscriptionId,
}

/// Inbound request to authorize a single protected API call.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AuthorizeRequest {
    pub api_key: String,
    pub resource: String,
    pub amount: i64,
}

/// The gate's allow/deny verdict for an authorize request.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AuthorizeDecision {
    pub allowed: bool,
    /// Decision reason, e.g. ok | over_quota | unauthenticated | forbidden.
    pub reason: String,
    pub remaining: i64,
}

/// An append-only record of one authorize decision.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DecisionAuditRecord {
    pub subscription_id: SubscriptionId,
    pub billing_account_id: crate::domain::BillingAccountId,
    pub resource: String,
    pub allowed: bool,
    pub reason: String,
    pub timestamp: String,
}

/// Domain error for the gatekeeping subsystem.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum GateError {
    #[error("unauthenticated: {0}")]
    Unauthenticated(String),
    #[error("forbidden: {0}")]
    Forbidden(String),
    #[error("over quota: {0}")]
    OverQuota(String),
    #[error("downstream failure: {0}")]
    Downstream(String),
    #[error("persistence failure: {0}")]
    Persistence(String),
}

impl From<SubscriptionError> for GateError {
    fn from(err: SubscriptionError) -> Self {
        GateError::Downstream(err.to_string())
    }
}

impl From<MeteringError> for GateError {
    fn from(err: MeteringError) -> Self {
        GateError::Downstream(err.to_string())
    }
}

impl From<DbError> for GateError {
    fn from(err: DbError) -> Self {
        GateError::Persistence(err.to_string())
    }
}

/// Hash an API key with SHA-256 (the same algorithm used at issue and verify
/// time); only the hash is ever persisted.
pub fn hash_key(plaintext: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(plaintext.as_bytes());
    hex::encode(hasher.finalize())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hash_is_stable_and_hex() {
        let a = hash_key("gk_secret");
        let b = hash_key("gk_secret");
        assert_eq!(a, b);
        assert_eq!(a.len(), 64);
        assert_ne!(a, hash_key("other"));
    }
}
