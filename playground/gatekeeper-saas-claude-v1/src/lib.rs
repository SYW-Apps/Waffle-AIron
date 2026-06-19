//! gatekeeper-saas: a multi-tenant control-plane microservice that authorizes
//! and meters API calls, enforces Stripe-backed subscription limits, and
//! notifies billing contacts on usage thresholds.
//!
//! The crate is organized one module per subsystem; each subsystem module holds
//! one file per L2 component, matching the spec tree's `sourcePath`s.

pub mod accounts;
pub mod domain;
pub mod gatekeeping;
pub mod metering;
pub mod notifications;
pub mod subscriptions;
pub mod web;
