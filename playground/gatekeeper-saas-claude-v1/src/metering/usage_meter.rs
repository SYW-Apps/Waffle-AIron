//! Usage Meter (Orchestrator stereotype): the hot-path consume workflow.
//! Atomically check-and-decrement a subscription's per-resource counter via
//! Redis, detect threshold crossings, and publish usage.threshold events once per
//! threshold per period. Receives quota/window from the caller, so it never
//! depends on subscriptions. Published as metering's hot-path interface.

use std::sync::Arc;

use async_trait::async_trait;

use super::model::{
    window_ttl_seconds, ConsumeOutcome, ConsumeRequest, MeteringError, UsageThresholdEvent,
};
use super::redis_counter_adapter::CounterAdapter;
use super::usage_event_adapter::UsageEventAdapter;

/// Threshold boundaries (as fractions of quota) that fire a notification.
const THRESHOLDS: [f64; 2] = [0.8, 1.0];

#[async_trait]
pub trait UsageMeter: Send + Sync {
    async fn consume(&self, req: ConsumeRequest) -> Result<ConsumeOutcome, MeteringError>;
}

pub struct UsageMeterImpl {
    counters: Arc<dyn CounterAdapter>,
    events: Arc<dyn UsageEventAdapter>,
}

impl UsageMeterImpl {
    pub fn new(counters: Arc<dyn CounterAdapter>, events: Arc<dyn UsageEventAdapter>) -> Self {
        Self { counters, events }
    }
}

/// Thresholds (as fractions) whose absolute boundary was crossed by moving usage
/// from `before` to `after` against `quota`.
fn crossed_thresholds(before: i64, after: i64, quota: i64) -> Vec<f64> {
    if quota <= 0 || after <= before {
        return Vec::new();
    }
    THRESHOLDS
        .iter()
        .copied()
        .filter(|t| {
            let boundary = t * quota as f64;
            (before as f64) < boundary && (after as f64) >= boundary
        })
        .collect()
}

#[async_trait]
impl UsageMeter for UsageMeterImpl {
    async fn consume(&self, req: ConsumeRequest) -> Result<ConsumeOutcome, MeteringError> {
        // Step 1: Build the counter key and compute the TTL from the window.
        let key = format!("{}:{}:{}", req.subscription_id, req.resource, req.window);
        let ttl = window_ttl_seconds(&req.window);
        // Step 2: Atomically increment usage and check against quota in Redis.
        let outcome = self
            .counters
            .check_and_decrement(key.clone(), req.amount, req.quota, ttl)
            .await?;
        // Step 3: Determine whether this call crossed a configured threshold boundary.
        let before = if outcome.allowed { outcome.used - req.amount } else { outcome.used };
        for threshold in crossed_thresholds(before, outcome.used, req.quota) {
            // Step 4: Atomically set the edge-trigger flag so it fires once per period.
            let flag = (threshold * 100.0) as i64;
            let newly_set = self.counters.try_mark_threshold(key.clone(), flag, ttl).await?;
            // Step 5: If newly set, build and publish a UsageThresholdEvent.
            if newly_set {
                let event = UsageThresholdEvent {
                    subscription_id: req.subscription_id.clone(),
                    billing_account_id: req.billing_account_id.clone(),
                    resource: req.resource.clone(),
                    used: outcome.used,
                    quota: req.quota,
                    ratio: outcome.used as f64 / req.quota as f64,
                    window: req.window.clone(),
                };
                self.events.publish_threshold(event).await?;
            }
        }
        // Step 6: Return the ConsumeOutcome.
        Ok(outcome)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::{BillingAccountId, SubscriptionId};
    use crate::metering::test_support::{MockUsageEventAdapter, ScriptedCounterAdapter};

    fn request(amount: i64, quota: i64) -> ConsumeRequest {
        ConsumeRequest {
            subscription_id: SubscriptionId::new("sub-1"),
            billing_account_id: BillingAccountId::new("ba-1"),
            resource: "api_calls".into(),
            quota,
            window: "day".into(),
            amount,
        }
    }

    #[test]
    fn crossing_detection() {
        // quota 100, 0.8 boundary = 80
        assert_eq!(crossed_thresholds(79, 80, 100), vec![0.8]);
        assert_eq!(crossed_thresholds(80, 81, 100), Vec::<f64>::new());
        assert_eq!(crossed_thresholds(99, 100, 100), vec![1.0]);
        assert!(crossed_thresholds(10, 10, 100).is_empty());
    }

    #[tokio::test]
    async fn publishes_once_when_threshold_crossed() {
        let counters = Arc::new(ScriptedCounterAdapter::allowing(80)); // used after = 80
        let events = Arc::new(MockUsageEventAdapter::new());
        let meter = UsageMeterImpl::new(counters, events.clone());
        let outcome = meter.consume(request(1, 100)).await.unwrap();
        assert!(outcome.allowed);
        assert_eq!(events.published(), 1);
    }

    #[tokio::test]
    async fn no_publish_when_below_threshold() {
        let counters = Arc::new(ScriptedCounterAdapter::allowing(10));
        let events = Arc::new(MockUsageEventAdapter::new());
        let meter = UsageMeterImpl::new(counters, events.clone());
        meter.consume(request(1, 100)).await.unwrap();
        assert_eq!(events.published(), 0);
    }
}
