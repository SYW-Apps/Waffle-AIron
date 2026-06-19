//! Usage Event Observer (Observer stereotype): subscribes to usage.threshold
//! events on the message bus and forwards each to the notification orchestrator.
//! Realizes the notifications subsystem's MessageBus public interface (the
//! consumer side of the usage.threshold topic).

use std::sync::Arc;

use async_trait::async_trait;

use crate::metering::model::UsageThresholdEvent;

use super::model::NotificationError;
use super::notification_orchestrator::NotificationOrchestrator;

#[async_trait]
pub trait UsageEventObserver: Send + Sync {
    async fn on_usage_threshold(
        &self,
        event: UsageThresholdEvent,
    ) -> Result<(), NotificationError>;
}

pub struct UsageEventObserverImpl {
    orchestrator: Arc<dyn NotificationOrchestrator>,
}

impl UsageEventObserverImpl {
    pub fn new(orchestrator: Arc<dyn NotificationOrchestrator>) -> Self {
        Self { orchestrator }
    }
}

#[async_trait]
impl UsageEventObserver for UsageEventObserverImpl {
    async fn on_usage_threshold(
        &self,
        event: UsageThresholdEvent,
    ) -> Result<(), NotificationError> {
        // Step 1: Forward the deserialized event to the notification orchestrator.
        self.orchestrator.handle_threshold(event).await?;
        // Step 2: Acknowledge on success; on error the caller lets the bus retry.
        Ok(())
    }
}
