//! Subscriptions subsystem domain model: plans, tiers, per-tier limits,
//! subscriptions (which own all Stripe state), resolved entitlements, and the
//! Stripe value objects exchanged with the Stripe adapter.

use serde::{Deserialize, Serialize};

use crate::domain::{BillingAccountId, DbError, PlanId, StripeError, SubscriptionId, TierId};

/// A single usage limit: how much of a resource is allowed per time window.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Limit {
    pub resource: String,
    pub quota: i64,
    /// Reset window: minute | day | month.
    pub window: String,
}

/// A collection of limits applied together (for a tier or as overrides).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LimitSet {
    pub limits: Vec<Limit>,
}

/// A subscription tier within a plan, mapped to a Stripe price.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Tier {
    pub id: TierId,
    pub name: String,
    pub stripe_price_id: String,
    pub limits: Vec<Limit>,
}

/// A catalog plan: a named set of tiers offered to customers.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Plan {
    pub id: PlanId,
    pub name: String,
    pub active: bool,
    pub tiers: Vec<Tier>,
}

impl Plan {
    /// Find a tier within this plan by id.
    pub fn tier(&self, tier_id: &TierId) -> Option<&Tier> {
        self.tiers.iter().find(|t| &t.id == tier_id)
    }
}

/// Lifecycle status of a subscription, mirroring Stripe.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum SubscriptionStatus {
    Trialing,
    Active,
    PastDue,
    Canceled,
    Incomplete,
}

impl SubscriptionStatus {
    /// Map a Stripe status string into our status enum.
    pub fn from_stripe(value: &str) -> Self {
        match value {
            "trialing" => SubscriptionStatus::Trialing,
            "active" => SubscriptionStatus::Active,
            "past_due" => SubscriptionStatus::PastDue,
            "canceled" => SubscriptionStatus::Canceled,
            _ => SubscriptionStatus::Incomplete,
        }
    }

    pub fn as_str(&self) -> &'static str {
        match self {
            SubscriptionStatus::Trialing => "Trialing",
            SubscriptionStatus::Active => "Active",
            SubscriptionStatus::PastDue => "PastDue",
            SubscriptionStatus::Canceled => "Canceled",
            SubscriptionStatus::Incomplete => "Incomplete",
        }
    }

    pub fn parse(value: &str) -> Result<Self, DbError> {
        match value {
            "Trialing" => Ok(SubscriptionStatus::Trialing),
            "Active" => Ok(SubscriptionStatus::Active),
            "PastDue" => Ok(SubscriptionStatus::PastDue),
            "Canceled" => Ok(SubscriptionStatus::Canceled),
            "Incomplete" => Ok(SubscriptionStatus::Incomplete),
            other => Err(DbError::Mapping(format!("unknown subscription status: {other}"))),
        }
    }
}

/// A billing account's subscription to a plan tier, linked to Stripe.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Subscription {
    pub id: SubscriptionId,
    pub billing_account_id: BillingAccountId,
    pub plan_id: PlanId,
    pub tier_id: TierId,
    pub stripe_customer_id: Option<String>,
    pub stripe_subscription_id: Option<String>,
    pub status: SubscriptionStatus,
    pub current_period_end: String,
    pub overrides: Vec<Limit>,
}

/// The resolved effective limit set and status for a subscription. Published
/// contract consumed by the gatekeeping subsystem.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Entitlements {
    pub subscription_id: SubscriptionId,
    pub billing_account_id: BillingAccountId,
    pub status: SubscriptionStatus,
    pub limits: Vec<Limit>,
}

/// Input to create a subscription: which billing account subscribes to which
/// plan tier.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CreateSubscriptionCommand {
    pub billing_account_id: BillingAccountId,
    pub plan_id: PlanId,
    pub tier_id: TierId,
}

/// Reference returned by Stripe after creating a customer.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct StripeCustomerRef {
    pub stripe_customer_id: String,
}

/// Reference returned by Stripe after creating/updating a subscription.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct StripeSubscriptionRef {
    pub stripe_subscription_id: String,
    pub status: SubscriptionStatus,
    pub current_period_end: String,
}

/// A verified, parsed Stripe webhook event.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct StripeEvent {
    pub id: String,
    pub kind: String,
    pub payload: String,
}

/// Domain error for the subscriptions subsystem (plans and subscriptions).
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum SubscriptionError {
    #[error("not found: {0}")]
    NotFound(String),
    #[error("invalid tier: {0}")]
    InvalidTier(String),
    #[error("stripe failure: {0}")]
    StripeFailure(String),
    #[error("conflict: {0}")]
    Conflict(String),
    #[error("persistence failure: {0}")]
    Persistence(String),
}

impl From<StripeError> for SubscriptionError {
    fn from(err: StripeError) -> Self {
        SubscriptionError::StripeFailure(err.to_string())
    }
}

impl From<DbError> for SubscriptionError {
    fn from(err: DbError) -> Self {
        match err {
            DbError::NotFound(msg) => SubscriptionError::NotFound(msg),
            DbError::Conflict(msg) => SubscriptionError::Conflict(msg),
            other => SubscriptionError::Persistence(other.to_string()),
        }
    }
}

/// Merge tier limits with subscription overrides, keyed by resource. Overrides
/// replace tier limits for the same resource; new override resources are added.
pub fn merge_limits(tier_limits: &[Limit], overrides: &[Limit]) -> Vec<Limit> {
    let mut merged: Vec<Limit> = tier_limits.to_vec();
    for ov in overrides {
        if let Some(existing) = merged.iter_mut().find(|l| l.resource == ov.resource) {
            *existing = ov.clone();
        } else {
            merged.push(ov.clone());
        }
    }
    merged
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn overrides_replace_matching_resource_and_add_new() {
        let tier = vec![
            Limit { resource: "api_calls".into(), quota: 100, window: "day".into() },
            Limit { resource: "seats".into(), quota: 5, window: "month".into() },
        ];
        let overrides = vec![
            Limit { resource: "api_calls".into(), quota: 1000, window: "day".into() },
            Limit { resource: "exports".into(), quota: 10, window: "month".into() },
        ];
        let merged = merge_limits(&tier, &overrides);
        let api = merged.iter().find(|l| l.resource == "api_calls").unwrap();
        assert_eq!(api.quota, 1000);
        assert!(merged.iter().any(|l| l.resource == "exports"));
        assert_eq!(merged.len(), 3);
    }

    #[test]
    fn stripe_status_strings_map() {
        assert_eq!(SubscriptionStatus::from_stripe("active"), SubscriptionStatus::Active);
        assert_eq!(SubscriptionStatus::from_stripe("past_due"), SubscriptionStatus::PastDue);
        assert_eq!(SubscriptionStatus::from_stripe("weird"), SubscriptionStatus::Incomplete);
    }
}
