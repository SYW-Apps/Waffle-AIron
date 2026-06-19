//! Accounts subsystem domain model. The `Account` aggregate is one consistency
//! boundary: a `Customer` root with its `BillingAccount` and `Contacts`.

use serde::{Deserialize, Serialize};

use crate::domain::{BillingAccountId, ContactId, CustomerId, DbError, Email};

/// Lifecycle state of an account.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum AccountStatus {
    Active,
    Suspended,
    Deactivated,
}

/// A tenant of the platform; aggregate root sub-entity.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Customer {
    pub id: CustomerId,
    pub name: String,
    pub status: AccountStatus,
    pub billing_account_id: BillingAccountId,
    /// RFC3339 creation timestamp.
    pub created_at: String,
}

/// The billing identity for a customer; root reference for subscriptions and the
/// billing email used by notifications. Free of Stripe concerns.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BillingAccount {
    pub id: BillingAccountId,
    pub customer_id: CustomerId,
    pub billing_email: Email,
    pub status: AccountStatus,
}

/// A named contact person on a customer account.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Contact {
    pub id: ContactId,
    pub customer_id: CustomerId,
    pub email: Email,
    pub name: String,
    /// Role label, e.g. Admin | Billing | Technical.
    pub role: String,
}

/// The Account aggregate persisted as one consistency boundary.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Account {
    pub customer: Customer,
    pub billing_account: BillingAccount,
    pub contacts: Vec<Contact>,
}

/// Input to create a new account: a name, a billing email, and zero or more
/// contacts (whose ids are assigned on creation).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CreateAccountCommand {
    pub name: String,
    pub billing_email: Email,
    #[serde(default)]
    pub contacts: Vec<ContactDraft>,
}

/// A contact supplied at creation time, before an id is assigned.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ContactDraft {
    pub email: Email,
    pub name: String,
    pub role: String,
}

/// Domain error for the accounts subsystem.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum AccountError {
    #[error("account not found: {0}")]
    NotFound(String),
    #[error("invalid email: {0}")]
    InvalidEmail(String),
    #[error("conflict: {0}")]
    Conflict(String),
    #[error("persistence failure: {0}")]
    Persistence(String),
}

impl From<DbError> for AccountError {
    fn from(err: DbError) -> Self {
        match err {
            DbError::NotFound(msg) => AccountError::NotFound(msg),
            DbError::Conflict(msg) => AccountError::Conflict(msg),
            other => AccountError::Persistence(other.to_string()),
        }
    }
}
