//! Plan Repository (Repository pattern): persistence facade for the Plan
//! aggregate. Owns the store, registry, index, and Postgres adapter; each method
//! forwards 1:1 to the owned registry (writes) or index (reads).

use std::sync::Arc;

use async_trait::async_trait;

use crate::domain::{PlanId, TierId};

use super::model::{LimitSet, Plan, SubscriptionError};
use super::plan_db_adapter::{PlanDbAdapter, PostgresPlanDbAdapter};
use super::plan_index::{PlanIndex, PlanIndexImpl};
use super::plan_registry::{PlanRegistry, PlanRegistryImpl};
use super::plan_store::{InMemoryPlanStore, PlanStore};

#[async_trait]
pub trait PlanRepository: Send + Sync {
    async fn save_plan(&self, plan: Plan) -> Result<(), SubscriptionError>;
    async fn update_tier_limits(
        &self,
        plan_id: &PlanId,
        tier_id: &TierId,
        limits: LimitSet,
    ) -> Result<(), SubscriptionError>;
    async fn find_plan(&self, id: &PlanId) -> Result<Option<Plan>, SubscriptionError>;
    async fn list_plans(&self) -> Result<Vec<Plan>, SubscriptionError>;
    async fn find_tier_limits(
        &self,
        plan_id: &PlanId,
        tier_id: &TierId,
    ) -> Result<Option<LimitSet>, SubscriptionError>;
}

pub struct PlanRepositoryImpl {
    registry: Arc<dyn PlanRegistry>,
    index: Arc<dyn PlanIndex>,
}

impl PlanRepositoryImpl {
    pub fn new(registry: Arc<dyn PlanRegistry>, index: Arc<dyn PlanIndex>) -> Self {
        Self { registry, index }
    }

    pub fn with_db(db: Arc<dyn PlanDbAdapter>) -> Self {
        let store: Arc<dyn PlanStore> = Arc::new(InMemoryPlanStore::new());
        let registry = Arc::new(PlanRegistryImpl::new(store.clone(), db));
        let index = Arc::new(PlanIndexImpl::new(store));
        Self::new(registry, index)
    }

    pub fn from_pool(pool: sqlx::PgPool) -> Self {
        let db: Arc<dyn PlanDbAdapter> = Arc::new(PostgresPlanDbAdapter::new(pool));
        Self::with_db(db)
    }
}

#[async_trait]
impl PlanRepository for PlanRepositoryImpl {
    async fn save_plan(&self, plan: Plan) -> Result<(), SubscriptionError> {
        // Step 1: Forward to the registry.
        self.registry.create_plan(plan).await
    }

    async fn update_tier_limits(
        &self,
        plan_id: &PlanId,
        tier_id: &TierId,
        limits: LimitSet,
    ) -> Result<(), SubscriptionError> {
        // Step 1: Forward to the registry.
        self.registry.update_tier_limits(plan_id, tier_id, limits).await
    }

    async fn find_plan(&self, id: &PlanId) -> Result<Option<Plan>, SubscriptionError> {
        // Step 1: Forward to the index.
        Ok(self.index.find_plan(id))
    }

    async fn list_plans(&self) -> Result<Vec<Plan>, SubscriptionError> {
        // Step 1: Forward to the index.
        Ok(self.index.list_plans())
    }

    async fn find_tier_limits(
        &self,
        plan_id: &PlanId,
        tier_id: &TierId,
    ) -> Result<Option<LimitSet>, SubscriptionError> {
        // Step 1: Forward to the index.
        Ok(self.index.find_tier_limits(plan_id, tier_id))
    }
}
