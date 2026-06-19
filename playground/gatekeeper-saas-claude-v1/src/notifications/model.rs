//! Notifications subsystem domain model: the composed email message, the
//! append-only delivery record, and the notification error.

use serde::{Deserialize, Serialize};

use crate::accounts::model::AccountError;
use crate::domain::{BillingAccountId, DbError, Email};

/// A composed email alert ready to send.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NotificationMessage {
    pub to: Email,
    pub subject: String,
    pub body: String,
}

/// An append-only record of a sent notification.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NotificationRecord {
    pub billing_account_id: BillingAccountId,
    pub to: Email,
    pub subject: String,
    pub sent_at: String,
    /// Delivery status: sent | failed.
    pub status: String,
}

/// Domain error for the notifications subsystem.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum NotificationError {
    #[error("no billing email: {0}")]
    NoBillingEmail(String),
    #[error("send failure: {0}")]
    SendFailure(String),
    #[error("lookup failure: {0}")]
    Lookup(String),
    #[error("persistence failure: {0}")]
    Persistence(String),
}

impl From<AccountError> for NotificationError {
    fn from(err: AccountError) -> Self {
        NotificationError::Lookup(err.to_string())
    }
}

impl From<DbError> for NotificationError {
    fn from(err: DbError) -> Self {
        NotificationError::Persistence(err.to_string())
    }
}
