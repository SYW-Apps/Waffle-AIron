//! Gatekeeping subsystem: the gate. Authorizes each protected API call in real
//! time by authenticating the key, consulting resolved entitlements from
//! subscriptions, and check-and-decrementing counters in metering. Owns
//! decision/policy logic; holds no usage state itself. Crosses subsystem
//! boundaries only through local client adapters.

pub mod api_key_authenticator;
pub mod audit_adapter;
pub mod credential_db_adapter;
pub mod credential_index;
pub mod credential_orchestrator;
pub mod credential_registry;
pub mod credential_repository;
pub mod credential_store;
pub mod gate_orchestrator;
pub mod metering_client;
pub mod model;
pub mod portal;
pub mod subscriptions_client;

#[cfg(test)]
pub mod test_support;

use std::sync::Arc;

use crate::metering::portal::MeteringPortalApi;
use crate::subscriptions::portal::SubscriptionsPortalApi;

use api_key_authenticator::ApiKeyAuthenticatorImpl;
use audit_adapter::PostgresAuditAdapter;
use credential_orchestrator::CredentialOrchestratorImpl;
use credential_repository::{CredentialRepository, CredentialRepositoryImpl};
use gate_orchestrator::GateOrchestratorImpl;
use metering_client::MeteringClientAdapter;
use portal::GatekeepingPortal;
use subscriptions_client::SubscriptionsClientAdapter;

/// Wired gatekeeping subsystem: the HTTP router for the gate and key management.
pub struct GatekeepingSubsystem {
    pub router: axum::Router,
}

impl GatekeepingSubsystem {
    pub fn new(
        pool: sqlx::PgPool,
        subscriptions_portal: Arc<dyn SubscriptionsPortalApi>,
        metering_portal: Arc<dyn MeteringPortalApi>,
    ) -> Self {
        let credentials: Arc<dyn CredentialRepository> =
            Arc::new(CredentialRepositoryImpl::from_pool(pool.clone()));
        let authenticator = Arc::new(ApiKeyAuthenticatorImpl::new(credentials.clone()));
        let subscriptions_client = Arc::new(SubscriptionsClientAdapter::new(subscriptions_portal));
        let metering_client = Arc::new(MeteringClientAdapter::new(metering_portal));
        let audit = Arc::new(PostgresAuditAdapter::new(pool));

        let gate = Arc::new(GateOrchestratorImpl::new(
            authenticator,
            subscriptions_client,
            metering_client,
            audit,
        ));
        let credential_orch = Arc::new(CredentialOrchestratorImpl::new(credentials));

        let router = GatekeepingPortal::new(gate, credential_orch).router();
        Self { router }
    }
}
