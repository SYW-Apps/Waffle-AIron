use crate::models::NotificationError;
use async_trait::async_trait;
use std::sync::Arc;
use crate::notification::orchestrator::NotificationOrchestrator;

#[async_trait]
pub trait NotificationClientAdapter {
    async fn dispatch_alert(
        &self,
        customer_email: String,
        alert_type: String,
        current_usage: u32,
        limit: u32,
    ) -> Result<(), NotificationError>;
}

pub struct NotificationClientAdapterImpl {
    notification_orchestrator: Arc<dyn NotificationOrchestrator + Send + Sync>,
}

impl NotificationClientAdapterImpl {
    pub fn new(notification_orchestrator: Arc<dyn NotificationOrchestrator + Send + Sync>) -> Self {
        Self { notification_orchestrator }
    }
}

#[async_trait]
impl NotificationClientAdapter for NotificationClientAdapterImpl {
    async fn dispatch_alert(
        &self,
        customer_email: String,
        alert_type: String,
        current_usage: u32,
        limit: u32,
    ) -> Result<(), NotificationError> {
        self.notification_orchestrator
            .dispatch_alert(customer_email, alert_type, current_usage, limit)
            .await
    }
}
