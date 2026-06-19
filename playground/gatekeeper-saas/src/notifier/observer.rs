use std::sync::Arc;
use tokio::sync::mpsc::Receiver;
use crate::models::UsageAlertEvent;
use crate::notifier::orchestrator::INotifierOrchestrator;

#[async_trait::async_trait]
pub trait INotifierObserver: Send + Sync {
    async fn handle_usage_event(&self, event: UsageAlertEvent) -> Result<(), String>;
}

pub struct NotifierObserver {
    orchestrator: Arc<dyn INotifierOrchestrator>,
}

impl NotifierObserver {
    pub fn new(orchestrator: Arc<dyn INotifierOrchestrator>) -> Self {
        Self { orchestrator }
    }

    pub async fn run_loop(self: Arc<Self>, mut receiver: Receiver<UsageAlertEvent>) {
        while let Some(event) = receiver.recv().await {
            let observer = Arc::clone(&self);
            tokio::spawn(async move {
                if let Err(e) = observer.handle_usage_event(event).await {
                    eprintln!("Error handling usage alert event: {}", e);
                }
            });
        }
    }
}

#[async_trait::async_trait]
impl INotifierObserver for NotifierObserver {
    async fn handle_usage_event(&self, event: UsageAlertEvent) -> Result<(), String> {
        // Step 1: Extract threshold alerts metadata values from event payload.
        let sub_id = event.subscription_id;
        let threshold = event.threshold;
        let usage = event.current_usage;
        let limit = event.limit;
        let billing_start = event.billing_start;

        // Step 2: Call Orchestrator to evaluate and dispatch alert warnings.
        self.orchestrator.notify_threshold_reached(sub_id, threshold, usage, limit, billing_start)
            .await
            .map_err(|e| format!("Orchestrator error: {}", e))?;

        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::{DateTime, Utc};
    use uuid::Uuid;
    use std::sync::Mutex;

    struct MockNotifierOrchestrator {
        calls: Mutex<Vec<(Uuid, i32, i64, i64, DateTime<Utc>)>>,
    }

    #[async_trait::async_trait]
    impl INotifierOrchestrator for MockNotifierOrchestrator {
        async fn notify_threshold_reached(
            &self,
            subscription_id: Uuid,
            threshold_percent: i32,
            current_usage: i64,
            request_limit: i64,
            billing_period_start: DateTime<Utc>,
        ) -> Result<(), String> {
            let mut guard = self.calls.lock().unwrap();
            guard.push((subscription_id, threshold_percent, current_usage, request_limit, billing_period_start));
            Ok(())
        }
    }

    #[tokio::test]
    async fn test_handle_usage_event_success() {
        let orch = Arc::new(MockNotifierOrchestrator { calls: Mutex::new(Vec::new()) });
        let observer = NotifierObserver::new(orch.clone());

        let sub_id = Uuid::new_v4();
        let now = Utc::now();
        let event = UsageAlertEvent {
            subscription_id: sub_id,
            threshold: 80,
            current_usage: 850,
            limit: 1000,
            billing_start: now,
        };

        observer.handle_usage_event(event).await.unwrap();

        let guard = orch.calls.lock().unwrap();
        assert_eq!(guard.len(), 1);
        assert_eq!(guard[0].0, sub_id);
        assert_eq!(guard[0].1, 80);
        assert_eq!(guard[0].2, 850);
        assert_eq!(guard[0].3, 1000);
        assert_eq!(guard[0].4, now);
    }
}
