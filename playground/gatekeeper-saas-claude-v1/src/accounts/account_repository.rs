//! Account Repository (Repository pattern): persistence facade for the Account
//! aggregate. Owns the store, write registry, read index, and Postgres adapter;
//! each method forwards 1:1 to the owned registry (writes) or index (reads).
//! Consumers use this facade only, never its inner blocks.

use std::sync::Arc;

use async_trait::async_trait;

use crate::domain::{BillingAccountId, CustomerId, Email};

use super::account_db_adapter::{AccountDbAdapter, PostgresAccountDbAdapter};
use super::account_index::{AccountIndex, AccountIndexImpl};
use super::account_registry::{AccountRegistry, AccountRegistryImpl};
use super::account_store::{AccountStore, InMemoryAccountStore};
use super::model::{Account, AccountError, AccountStatus, Customer};

/// Persistence facade for the Account aggregate.
#[async_trait]
pub trait AccountRepository: Send + Sync {
    async fn save_account(&self, account: Account) -> Result<(), AccountError>;
    async fn update_billing_email(
        &self,
        id: &BillingAccountId,
        email: Email,
    ) -> Result<(), AccountError>;
    async fn set_status(
        &self,
        id: &BillingAccountId,
        status: AccountStatus,
    ) -> Result<(), AccountError>;
    async fn find_account(&self, id: &BillingAccountId)
        -> Result<Option<Account>, AccountError>;
    async fn find_customer(&self, id: &CustomerId) -> Result<Option<Customer>, AccountError>;
    async fn resolve_billing_email(
        &self,
        id: &BillingAccountId,
    ) -> Result<Option<Email>, AccountError>;
}

pub struct AccountRepositoryImpl {
    registry: Arc<dyn AccountRegistry>,
    index: Arc<dyn AccountIndex>,
}

impl AccountRepositoryImpl {
    /// Compose the repository from explicit owned blocks.
    pub fn new(registry: Arc<dyn AccountRegistry>, index: Arc<dyn AccountIndex>) -> Self {
        Self { registry, index }
    }

    /// Build the full owned block graph (store + registry + index) over a
    /// Postgres-backed adapter and warm the store from the database is left to
    /// callers; this wires the in-memory authoritative state and its persistence.
    pub fn with_postgres(db: Arc<dyn AccountDbAdapter>) -> Self {
        let store: Arc<dyn AccountStore> = Arc::new(InMemoryAccountStore::new());
        let registry = Arc::new(AccountRegistryImpl::new(store.clone(), db));
        let index = Arc::new(AccountIndexImpl::new(store));
        Self::new(registry, index)
    }

    /// Convenience: build the owned block graph from a raw connection pool.
    pub fn from_pool(pool: sqlx::PgPool) -> Self {
        let db: Arc<dyn AccountDbAdapter> = Arc::new(PostgresAccountDbAdapter::new(pool));
        Self::with_postgres(db)
    }
}

#[async_trait]
impl AccountRepository for AccountRepositoryImpl {
    async fn save_account(&self, account: Account) -> Result<(), AccountError> {
        // Step 1: Forward to the registry.
        self.registry.create_account(account).await
    }

    async fn update_billing_email(
        &self,
        id: &BillingAccountId,
        email: Email,
    ) -> Result<(), AccountError> {
        // Step 1: Forward to the registry.
        self.registry.update_billing_email(id, email).await
    }

    async fn set_status(
        &self,
        id: &BillingAccountId,
        status: AccountStatus,
    ) -> Result<(), AccountError> {
        // Step 1: Forward to the registry.
        self.registry.set_status(id, status).await
    }

    async fn find_account(
        &self,
        id: &BillingAccountId,
    ) -> Result<Option<Account>, AccountError> {
        // Step 1: Forward to the index.
        Ok(self.index.find_account(id))
    }

    async fn find_customer(&self, id: &CustomerId) -> Result<Option<Customer>, AccountError> {
        // Step 1: Forward to the index.
        Ok(self.index.find_customer(id))
    }

    async fn resolve_billing_email(
        &self,
        id: &BillingAccountId,
    ) -> Result<Option<Email>, AccountError> {
        // Step 1: Forward to the index.
        Ok(self.index.resolve_billing_email(id))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::accounts::test_support::{MockAccountIndex, MockAccountRegistry};

    #[tokio::test]
    async fn writes_forward_to_registry_reads_to_index() {
        let registry = Arc::new(MockAccountRegistry::ok());
        let index = Arc::new(MockAccountIndex::empty());
        let repo = AccountRepositoryImpl::new(registry.clone(), index.clone());
        repo.set_status(&BillingAccountId::new("ba-1"), AccountStatus::Suspended)
            .await
            .unwrap();
        assert_eq!(registry.set_status_calls(), 1);
        assert!(repo
            .find_account(&BillingAccountId::new("ba-1"))
            .await
            .unwrap()
            .is_none());
    }
}
