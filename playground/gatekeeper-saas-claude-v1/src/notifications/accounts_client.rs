//! Accounts Client Adapter (Adapter stereotype): the only notifications block
//! allowed to cross into the accounts subsystem. Calls the accounts Portal's
//! published resolve_billing_email endpoint and maps account errors into
//! notification errors.

use std::sync::Arc;

use async_trait::async_trait;

use crate::accounts::portal::AccountsPortalApi;
use crate::domain::{BillingAccountId, Email};

use super::model::NotificationError;

#[async_trait]
pub trait AccountsClient: Send + Sync {
    async fn resolve_billing_email(
        &self,
        id: &BillingAccountId,
    ) -> Result<Option<Email>, NotificationError>;
}

pub struct AccountsClientAdapter {
    portal: Arc<dyn AccountsPortalApi>,
}

impl AccountsClientAdapter {
    pub fn new(portal: Arc<dyn AccountsPortalApi>) -> Self {
        Self { portal }
    }
}

#[async_trait]
impl AccountsClient for AccountsClientAdapter {
    async fn resolve_billing_email(
        &self,
        id: &BillingAccountId,
    ) -> Result<Option<Email>, NotificationError> {
        // Step 1: Call the accounts Portal's resolve_billing_email endpoint.
        let result = self.portal.resolve_billing_email(id).await;
        // Step 2: Map any AccountError into NotificationError and return the Option<Email>.
        result.map_err(|e| NotificationError::Lookup(e.to_string()))
    }
}
