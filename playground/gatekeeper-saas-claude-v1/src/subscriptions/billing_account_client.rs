//! Billing Account Client Adapter (Adapter stereotype): the only subscriptions
//! block allowed to cross into the accounts subsystem. Calls the accounts
//! Portal's published resolve_billing_email endpoint and maps account errors into
//! subscription errors.

use std::sync::Arc;

use async_trait::async_trait;

use crate::accounts::portal::AccountsPortalApi;
use crate::domain::{BillingAccountId, Email};

use super::model::SubscriptionError;

#[async_trait]
pub trait BillingAccountClient: Send + Sync {
    async fn resolve_billing_email(
        &self,
        id: &BillingAccountId,
    ) -> Result<Option<Email>, SubscriptionError>;
}

pub struct BillingAccountClientAdapter {
    portal: Arc<dyn AccountsPortalApi>,
}

impl BillingAccountClientAdapter {
    pub fn new(portal: Arc<dyn AccountsPortalApi>) -> Self {
        Self { portal }
    }
}

#[async_trait]
impl BillingAccountClient for BillingAccountClientAdapter {
    async fn resolve_billing_email(
        &self,
        id: &BillingAccountId,
    ) -> Result<Option<Email>, SubscriptionError> {
        // Step 1: Call the accounts Portal's resolve_billing_email endpoint.
        let result = self.portal.resolve_billing_email(id).await;
        // Step 2: Map any AccountError into SubscriptionError and return the Option<Email>.
        result.map_err(|e| SubscriptionError::Conflict(e.to_string()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::accounts::portal::AccountsPortal;
    use crate::accounts::test_support::{MockAccountDirectory, MockAccountOrchestrator};

    #[tokio::test]
    async fn resolves_via_portal() {
        let portal = Arc::new(AccountsPortal::new(
            Arc::new(MockAccountOrchestrator::default()),
            Arc::new(MockAccountDirectory::with_email("billing@acme.com")),
        ));
        let client = BillingAccountClientAdapter::new(portal);
        let resolved = client
            .resolve_billing_email(&BillingAccountId::new("ba-1"))
            .await
            .unwrap();
        assert_eq!(resolved, Some(Email::parse("billing@acme.com").unwrap()));
    }
}
