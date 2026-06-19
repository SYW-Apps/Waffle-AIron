//! Usage Event Adapter (Adapter stereotype): the only block publishing
//! usage.threshold events to the message bus. No domain logic; serializes and
//! emits the event payload. Realized here as an in-process broadcast bus so the
//! notifications subsystem can subscribe without a network hop.

use async_trait::async_trait;
use tokio::sync::broadcast;

use super::model::{MeteringError, UsageThresholdEvent};

/// In-process realization of the `usage.threshold` topic.
pub type UsageEventBus = broadcast::Sender<UsageThresholdEvent>;

#[async_trait]
pub trait UsageEventAdapter: Send + Sync {
    async fn publish_threshold(
        &self,
        event: UsageThresholdEvent,
    ) -> Result<(), MeteringError>;
}

pub struct BroadcastUsageEventAdapter {
    bus: UsageEventBus,
}

impl BroadcastUsageEventAdapter {
    pub fn new(bus: UsageEventBus) -> Self {
        Self { bus }
    }
}

#[async_trait]
impl UsageEventAdapter for BroadcastUsageEventAdapter {
    async fn publish_threshold(
        &self,
        event: UsageThresholdEvent,
    ) -> Result<(), MeteringError> {
        // Step 1: Serialize the event and publish it to the usage.threshold topic.
        // A send error means no active subscribers, which must not fail the hot
        // path, so it is treated as a successful (dropped) publish.
        let _ = self.bus.send(event);
        Ok(())
    }
}
