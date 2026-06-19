//! Accounts subsystem: manages customers, their billing accounts, and
//! contact/email details. Authoritative source for tenant identity and the
//! billing contact email used by notifications.

pub mod account_db_adapter;
pub mod account_directory;
pub mod account_index;
pub mod account_orchestrator;
pub mod account_registry;
pub mod account_repository;
pub mod account_store;
pub mod model;
pub mod portal;

#[cfg(test)]
pub mod test_support;

use std::sync::Arc;

use account_directory::{AccountDirectory, AccountDirectoryImpl};
use account_orchestrator::AccountOrchestratorImpl;
use account_repository::AccountRepositoryImpl;
use portal::{AccountsPortal, AccountsPortalApi};

/// Wired accounts subsystem: the HTTP router plus the published Portal surface
/// (the front door) consumed cross-subsystem by notifications and subscriptions.
pub struct AccountsSubsystem {
    pub router: axum::Router,
    pub portal: Arc<dyn AccountsPortalApi>,
}

impl AccountsSubsystem {
    /// Compose the subsystem over a Postgres connection pool.
    pub fn new(pool: sqlx::PgPool) -> Self {
        let repository = Arc::new(AccountRepositoryImpl::from_pool(pool));
        let directory: Arc<dyn AccountDirectory> =
            Arc::new(AccountDirectoryImpl::new(repository.clone()));
        let orchestrator = Arc::new(AccountOrchestratorImpl::new(repository));
        let portal = AccountsPortal::new(orchestrator, directory);
        let portal_api: Arc<dyn AccountsPortalApi> = Arc::new(portal.clone());
        let router = portal.router();
        Self { router, portal: portal_api }
    }
}
