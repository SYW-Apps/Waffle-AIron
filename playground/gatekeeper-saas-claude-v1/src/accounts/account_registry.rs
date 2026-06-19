//! Account Registry (Registry stereotype): the write path for the Account
//! aggregate. Applies mutations to the store and persists via the Postgres
//! adapter.

use std::sync::Arc;

use async_trait::async_trait;

use crate::domain::{BillingAccountId, Email};

use super::account_db_adapter::AccountDbAdapter;
use super::account_store::AccountStore;
use super::model::{Account, AccountError, AccountStatus};

/// Write path: mutate store then persist.
#[async_trait]
pub trait AccountRegistry: Send + Sync {
    /// Insert into store and upsert via adapter.
    async fn create_account(&self, account: Account) -> Result<(), AccountError>;
    /// Apply email change to store and persist.
    async fn update_billing_email(
        &self,
        id: &BillingAccountId,
        email: Email,
    ) -> Result<(), AccountError>;
    /// Apply status change to store and persist.
    async fn set_status(
        &self,
        id: &BillingAccountId,
        status: AccountStatus,
    ) -> Result<(), AccountError>;
}

pub struct AccountRegistryImpl {
    store: Arc<dyn AccountStore>,
    db: Arc<dyn AccountDbAdapter>,
}

impl AccountRegistryImpl {
    pub fn new(store: Arc<dyn AccountStore>, db: Arc<dyn AccountDbAdapter>) -> Self {
        Self { store, db }
    }
}

#[async_trait]
impl AccountRegistry for AccountRegistryImpl {
    async fn create_account(&self, account: Account) -> Result<(), AccountError> {
        // Step 1: Insert the aggregate into the store.
        self.store.insert(account.clone());
        // Step 2: Persist the aggregate to Postgres.
        self.db.upsert_account(&account).await?;
        // Step 3: Return Ok(()).
        Ok(())
    }

    async fn update_billing_email(
        &self,
        id: &BillingAccountId,
        email: Email,
    ) -> Result<(), AccountError> {
        // Step 1: Apply the billing email change in the store (NotFound if absent).
        if !self.store.apply_billing_email(id, email) {
            return Err(AccountError::NotFound(id.to_string()));
        }
        // Step 2: Read back the updated aggregate.
        let account = self
            .store
            .get(id)
            .ok_or_else(|| AccountError::NotFound(id.to_string()))?;
        // Step 3: Persist the updated aggregate.
        self.db.upsert_account(&account).await?;
        // Step 4: Return Ok(()).
        Ok(())
    }

    async fn set_status(
        &self,
        id: &BillingAccountId,
        status: AccountStatus,
    ) -> Result<(), AccountError> {
        // Step 1: Apply the status change in the store (NotFound if absent).
        if !self.store.set_status(id, status) {
            return Err(AccountError::NotFound(id.to_string()));
        }
        // Step 2: Read back the updated aggregate.
        let account = self
            .store
            .get(id)
            .ok_or_else(|| AccountError::NotFound(id.to_string()))?;
        // Step 3: Persist the updated aggregate.
        self.db.upsert_account(&account).await?;
        // Step 4: Return Ok(()).
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::accounts::model::{BillingAccount, Customer};
    use crate::accounts::test_support::{MockAccountDbAdapter, MockAccountStore};
    use crate::domain::CustomerId;

    fn account() -> Account {
        Account {
            customer: Customer {
                id: CustomerId::new("cust-1"),
                name: "Acme".into(),
                status: AccountStatus::Active,
                billing_account_id: BillingAccountId::new("ba-1"),
                created_at: "2026-01-01T00:00:00Z".into(),
            },
            billing_account: BillingAccount {
                id: BillingAccountId::new("ba-1"),
                customer_id: CustomerId::new("cust-1"),
                billing_email: Email::parse("billing@acme.com").unwrap(),
                status: AccountStatus::Active,
            },
            contacts: vec![],
        }
    }

    #[tokio::test]
    async fn create_account_inserts_then_persists() {
        let store = Arc::new(MockAccountStore::empty());
        let db = Arc::new(MockAccountDbAdapter::ok());
        let registry = AccountRegistryImpl::new(store.clone(), db.clone());
        registry.create_account(account()).await.unwrap();
        assert!(store.get(&BillingAccountId::new("ba-1")).is_some());
        assert_eq!(db.upsert_calls(), 1);
    }

    #[tokio::test]
    async fn update_billing_email_absent_is_not_found_and_skips_persist() {
        let store = Arc::new(MockAccountStore::empty());
        let db = Arc::new(MockAccountDbAdapter::ok());
        let registry = AccountRegistryImpl::new(store, db.clone());
        let email = Email::parse("new@acme.com").unwrap();
        let err = registry
            .update_billing_email(&BillingAccountId::new("ba-1"), email)
            .await
            .unwrap_err();
        assert!(matches!(err, AccountError::NotFound(_)));
        assert_eq!(db.upsert_calls(), 0);
    }

    #[tokio::test]
    async fn set_status_propagates_persistence_error() {
        let store = Arc::new(MockAccountStore::seeded(account()));
        let db = Arc::new(MockAccountDbAdapter::failing());
        let registry = AccountRegistryImpl::new(store, db);
        let err = registry
            .set_status(&BillingAccountId::new("ba-1"), AccountStatus::Deactivated)
            .await
            .unwrap_err();
        assert!(matches!(err, AccountError::Persistence(_)));
    }
}
