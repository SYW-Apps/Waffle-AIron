//! Account Directory (Specialist stereotype): the published read API of the
//! accounts subsystem for in-process cross-subsystem lookups. Resolves the
//! billing email for a billing account by delegating to the account repository.
//! Exposes no write access.

use std::sync::Arc;

use async_trait::async_trait;

use crate::domain::{BillingAccountId, Email};

use super::account_repository::AccountRepository;
use super::model::AccountError;

/// Published read capability for cross-subsystem billing lookups.
#[async_trait]
pub trait AccountDirectory: Send + Sync {
    /// Resolve the billing email for a billing account.
    async fn resolve_billing_email(
        &self,
        id: &BillingAccountId,
    ) -> Result<Option<Email>, AccountError>;
}

pub struct AccountDirectoryImpl {
    repository: Arc<dyn AccountRepository>,
}

impl AccountDirectoryImpl {
    pub fn new(repository: Arc<dyn AccountRepository>) -> Self {
        Self { repository }
    }
}

#[async_trait]
impl AccountDirectory for AccountDirectoryImpl {
    async fn resolve_billing_email(
        &self,
        id: &BillingAccountId,
    ) -> Result<Option<Email>, AccountError> {
        // Step 1: Resolve the billing email via the account repository.
        let email = self.repository.resolve_billing_email(id).await?;
        // Step 2: Return the Option<Email>.
        Ok(email)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::accounts::test_support::MockAccountRepository;

    #[tokio::test]
    async fn delegates_to_repository() {
        let email = Email::parse("billing@acme.com").unwrap();
        let repo = Arc::new(MockAccountRepository::with_email(email.clone()));
        let directory = AccountDirectoryImpl::new(repo);
        let resolved = directory
            .resolve_billing_email(&BillingAccountId::new("ba-1"))
            .await
            .unwrap();
        assert_eq!(resolved, Some(email));
    }
}
