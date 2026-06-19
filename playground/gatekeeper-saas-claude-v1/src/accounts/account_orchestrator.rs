//! Account Orchestrator (Orchestrator stereotype): coordinates account
//! workflows — create a customer with its billing account and contacts, update
//! billing email, deactivate an account. Holds workflow control flow only;
//! delegates all persistence to the account repository facade.

use std::sync::Arc;

use async_trait::async_trait;
use uuid::Uuid;

use crate::domain::{BillingAccountId, ContactId, CustomerId, Email};

use super::account_repository::AccountRepository;
use super::model::{
    Account, AccountError, AccountStatus, BillingAccount, Contact, CreateAccountCommand, Customer,
};

/// Account workflows over the account repository.
#[async_trait]
pub trait AccountOrchestrator: Send + Sync {
    async fn create_account(&self, cmd: CreateAccountCommand) -> Result<Account, AccountError>;
    async fn get_account(&self, id: &BillingAccountId) -> Result<Account, AccountError>;
    async fn get_customer(&self, id: &CustomerId) -> Result<Customer, AccountError>;
    async fn update_billing_email(
        &self,
        id: &BillingAccountId,
        email: Email,
    ) -> Result<Account, AccountError>;
    async fn deactivate_account(&self, id: &BillingAccountId) -> Result<(), AccountError>;
}

pub struct AccountOrchestratorImpl {
    repository: Arc<dyn AccountRepository>,
}

impl AccountOrchestratorImpl {
    pub fn new(repository: Arc<dyn AccountRepository>) -> Self {
        Self { repository }
    }

    /// Assemble the Account aggregate from a validated command, generating ids
    /// and defaulting lifecycle status to Active.
    fn assemble_account(cmd: CreateAccountCommand) -> Account {
        let customer_id = CustomerId::new(Uuid::new_v4().to_string());
        let billing_account_id = BillingAccountId::new(Uuid::new_v4().to_string());
        let customer = Customer {
            id: customer_id.clone(),
            name: cmd.name,
            status: AccountStatus::Active,
            billing_account_id: billing_account_id.clone(),
            created_at: chrono::Utc::now().to_rfc3339(),
        };
        let billing_account = BillingAccount {
            id: billing_account_id,
            customer_id: customer_id.clone(),
            billing_email: cmd.billing_email,
            status: AccountStatus::Active,
        };
        let contacts = cmd
            .contacts
            .into_iter()
            .map(|draft| Contact {
                id: ContactId::new(Uuid::new_v4().to_string()),
                customer_id: customer_id.clone(),
                email: draft.email,
                name: draft.name,
                role: draft.role,
            })
            .collect();
        Account {
            customer,
            billing_account,
            contacts,
        }
    }
}

#[async_trait]
impl AccountOrchestrator for AccountOrchestratorImpl {
    async fn create_account(&self, cmd: CreateAccountCommand) -> Result<Account, AccountError> {
        // Step 1: Validate the billing email and assemble the Account aggregate
        // (generate ids, build Customer + BillingAccount [Active] + Contacts).
        // The `Email` newtype is validated at construction, so holding one proves validity.
        let account = Self::assemble_account(cmd);
        // Step 2: Persist the aggregate.
        self.repository.save_account(account.clone()).await?;
        // Step 3: Return the created Account.
        Ok(account)
    }

    async fn get_account(&self, id: &BillingAccountId) -> Result<Account, AccountError> {
        // Step 1: Find the account aggregate.
        let account = self.repository.find_account(id).await?;
        // Step 2: Return it or AccountError::NotFound.
        account.ok_or_else(|| AccountError::NotFound(id.to_string()))
    }

    async fn get_customer(&self, id: &CustomerId) -> Result<Customer, AccountError> {
        // Step 1: Find the customer.
        let customer = self.repository.find_customer(id).await?;
        // Step 2: Return it or NotFound.
        customer.ok_or_else(|| AccountError::NotFound(id.to_string()))
    }

    async fn update_billing_email(
        &self,
        id: &BillingAccountId,
        email: Email,
    ) -> Result<Account, AccountError> {
        // Step 1: Validate the new email, then apply the change. (Validity is
        // guaranteed by the `Email` newtype.)
        self.repository.update_billing_email(id, email).await?;
        // Step 2: Re-read the account.
        let account = self.repository.find_account(id).await?;
        // Step 3: Return the refreshed account or NotFound.
        account.ok_or_else(|| AccountError::NotFound(id.to_string()))
    }

    async fn deactivate_account(&self, id: &BillingAccountId) -> Result<(), AccountError> {
        // Step 1: Set the account status to Deactivated.
        self.repository
            .set_status(id, AccountStatus::Deactivated)
            .await?;
        // Step 2: Return Ok(()).
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::accounts::model::ContactDraft;
    use crate::accounts::test_support::MockAccountRepository;

    #[tokio::test]
    async fn create_account_assembles_and_persists() {
        let repo = Arc::new(MockAccountRepository::empty());
        let orch = AccountOrchestratorImpl::new(repo.clone());
        let cmd = CreateAccountCommand {
            name: "Acme".into(),
            billing_email: Email::parse("billing@acme.com").unwrap(),
            contacts: vec![ContactDraft {
                email: Email::parse("admin@acme.com").unwrap(),
                name: "Admin".into(),
                role: "Admin".into(),
            }],
        };
        let account = orch.create_account(cmd).await.unwrap();
        assert_eq!(account.customer.status, AccountStatus::Active);
        assert_eq!(account.contacts.len(), 1);
        assert!(!account.contacts[0].id.0.is_empty());
        assert_eq!(repo.saved_count(), 1);
    }

    #[tokio::test]
    async fn get_account_missing_is_not_found() {
        let repo = Arc::new(MockAccountRepository::empty());
        let orch = AccountOrchestratorImpl::new(repo);
        let err = orch
            .get_account(&BillingAccountId::new("ba-x"))
            .await
            .unwrap_err();
        assert!(matches!(err, AccountError::NotFound(_)));
    }

    #[tokio::test]
    async fn deactivate_sets_status() {
        let repo = Arc::new(MockAccountRepository::empty());
        let orch = AccountOrchestratorImpl::new(repo.clone());
        orch.deactivate_account(&BillingAccountId::new("ba-1"))
            .await
            .unwrap();
        assert_eq!(repo.last_status(), Some(AccountStatus::Deactivated));
    }
}
