use crate::models::{SubscriptionDetails, RepositoryError};
use async_trait::async_trait;
use std::sync::Arc;
use crate::billing::subscription_repository::SubscriptionRepository;

#[async_trait]
pub trait BillingClientAdapter {
    async fn get_subscription_by_key(
        &self,
        api_key: String,
    ) -> Result<Option<SubscriptionDetails>, RepositoryError>;
}

pub struct BillingClientAdapterImpl {
    subscription_repo: Arc<dyn SubscriptionRepository + Send + Sync>,
}

impl BillingClientAdapterImpl {
    pub fn new(subscription_repo: Arc<dyn SubscriptionRepository + Send + Sync>) -> Self {
        Self { subscription_repo }
    }
}

#[async_trait]
impl BillingClientAdapter for BillingClientAdapterImpl {
    async fn get_subscription_by_key(
        &self,
        api_key: String,
    ) -> Result<Option<SubscriptionDetails>, RepositoryError> {
        self.subscription_repo.get_subscription_by_key(api_key).await
    }
}
