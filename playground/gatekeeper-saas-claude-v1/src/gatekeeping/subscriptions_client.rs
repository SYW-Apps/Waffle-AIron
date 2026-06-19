//! Subscriptions Client Adapter (Adapter stereotype): the only gatekeeping block
//! allowed to cross into the subscriptions subsystem. Calls the subscriptions
//! Portal's published resolve_entitlements endpoint and maps subscription errors
//! into gate errors.

use std::sync::Arc;

use async_trait::async_trait;

use crate::domain::SubscriptionId;
use crate::subscriptions::model::Entitlements;
use crate::subscriptions::portal::SubscriptionsPortalApi;

use super::model::GateError;

#[async_trait]
pub trait SubscriptionsClient: Send + Sync {
    async fn resolve_entitlements(
        &self,
        subscription_id: SubscriptionId,
    ) -> Result<Entitlements, GateError>;
}

pub struct SubscriptionsClientAdapter {
    portal: Arc<dyn SubscriptionsPortalApi>,
}

impl SubscriptionsClientAdapter {
    pub fn new(portal: Arc<dyn SubscriptionsPortalApi>) -> Self {
        Self { portal }
    }
}

#[async_trait]
impl SubscriptionsClient for SubscriptionsClientAdapter {
    async fn resolve_entitlements(
        &self,
        subscription_id: SubscriptionId,
    ) -> Result<Entitlements, GateError> {
        // Step 1: Call the subscriptions Portal's resolve_entitlements endpoint.
        let result = self.portal.resolve_entitlements(subscription_id).await;
        // Step 2: Map any SubscriptionError into GateError::Downstream and return the Entitlements.
        result.map_err(|e| GateError::Downstream(e.to_string()))
    }
}
