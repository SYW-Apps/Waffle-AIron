//! Shared domain kernel: identifiers, value objects, and infrastructure errors
//! referenced across every subsystem. These are passed by reference/clone as
//! shared data models (zero-copy purity) rather than re-serialized between
//! local components.

pub mod email;
pub mod error;
pub mod ids;

pub use email::Email;
pub use error::{ApiError, DbError, StripeError};
pub use ids::{
    ApiKeyId, BillingAccountId, ContactId, CustomerId, PlanId, SubscriptionId, TierId,
};
