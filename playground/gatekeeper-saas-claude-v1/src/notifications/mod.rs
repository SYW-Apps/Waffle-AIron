//! Notifications subsystem: sends usage-threshold and billing alerts to each
//! account's billing email. Observer-driven — subscribes to usage.threshold
//! events from metering, resolves the billing contact via accounts, and
//! dispatches email through the Email Adapter. Owns the Email Adapter.

pub mod accounts_client;
pub mod email_adapter;
pub mod model;
pub mod notification_log_adapter;
pub mod notification_orchestrator;
pub mod usage_event_observer;

#[cfg(test)]
pub mod test_support;

use std::sync::Arc;

use crate::accounts::portal::AccountsPortalApi;
use crate::metering::usage_event_adapter::UsageEventBus;

use accounts_client::AccountsClientAdapter;
use email_adapter::{EmailProviderConfig, HttpEmailAdapter};
use notification_log_adapter::PostgresNotificationLogAdapter;
use notification_orchestrator::NotificationOrchestratorImpl;
use usage_event_observer::{UsageEventObserver, UsageEventObserverImpl};

/// Wired notifications subsystem: the usage-threshold observer (the subsystem's
/// MessageBus public interface). It has no HTTP router — it is driven by the bus.
pub struct NotificationsSubsystem {
    pub observer: Arc<dyn UsageEventObserver>,
}

impl NotificationsSubsystem {
    pub fn new(
        pool: sqlx::PgPool,
        accounts_portal: Arc<dyn AccountsPortalApi>,
        email: EmailProviderConfig,
    ) -> Self {
        let accounts = Arc::new(AccountsClientAdapter::new(accounts_portal));
        let email_adapter = Arc::new(HttpEmailAdapter::new(email));
        let log = Arc::new(PostgresNotificationLogAdapter::new(pool));
        let orchestrator =
            Arc::new(NotificationOrchestratorImpl::new(accounts, email_adapter, log));
        let observer: Arc<dyn UsageEventObserver> =
            Arc::new(UsageEventObserverImpl::new(orchestrator));
        Self { observer }
    }

    /// Drive the observer from the in-process usage.threshold bus until shutdown.
    /// Spawned by the composition root.
    pub async fn run_consumer(observer: Arc<dyn UsageEventObserver>, bus: &UsageEventBus) {
        let mut rx = bus.subscribe();
        loop {
            match rx.recv().await {
                Ok(event) => {
                    if let Err(err) = observer.on_usage_threshold(event).await {
                        tracing::warn!(error = %err, "notification handling failed");
                    }
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
            }
        }
    }
}
