//! Subscriptions Portal (Portal stereotype): HTTP/JSON ingress for /v1/plans and
//! /v1/subscriptions management, plus the published resolve_entitlements read used
//! cross-subsystem. The subsystem's inbound front door — forwards validated
//! requests to the plan and subscription orchestrators and the entitlement
//! resolver. Never touches stores, repositories, or adapters.

use std::sync::Arc;

use async_trait::async_trait;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, patch, post};
use axum::{Json, Router};
use serde::Deserialize;

use crate::domain::{ApiError, PlanId, SubscriptionId, TierId};

use super::entitlement_resolver::EntitlementResolver;
use super::model::{CreateSubscriptionCommand, Entitlements, LimitSet, Plan, SubscriptionError};
use super::plan_orchestrator::PlanOrchestrator;
use super::subscription_orchestrator::SubscriptionOrchestrator;

/// In-process published surface of the subscriptions Portal, consumed
/// cross-subsystem by gatekeeping's subscriptions client adapter. Depending on
/// the Portal (the front door) rather than the internal entitlement resolver
/// keeps the distribution seam intact.
#[async_trait]
pub trait SubscriptionsPortalApi: Send + Sync {
    async fn resolve_entitlements(
        &self,
        subscription_id: SubscriptionId,
    ) -> Result<Entitlements, SubscriptionError>;
}

#[derive(Clone)]
pub struct SubscriptionsPortal {
    plans: Arc<dyn PlanOrchestrator>,
    subscriptions: Arc<dyn SubscriptionOrchestrator>,
    entitlements: Arc<dyn EntitlementResolver>,
}

impl SubscriptionsPortal {
    pub fn new(
        plans: Arc<dyn PlanOrchestrator>,
        subscriptions: Arc<dyn SubscriptionOrchestrator>,
        entitlements: Arc<dyn EntitlementResolver>,
    ) -> Self {
        Self { plans, subscriptions, entitlements }
    }

    pub fn router(self) -> Router {
        Router::new()
            .route("/v1/plans", post(create_plan).get(list_plans))
            .route("/v1/plans/:plan_id/tiers/:tier_id/limits", patch(update_tier_limits))
            .route("/v1/subscriptions", post(create_subscription))
            .route("/v1/subscriptions/:id", get(get_subscription))
            .route("/v1/subscriptions/:id/tier", patch(change_tier))
            .route("/v1/subscriptions/:id/cancel", post(cancel_subscription))
            .route("/v1/subscriptions/:id/entitlements", get(get_entitlements))
            .with_state(self)
    }
}

#[async_trait]
impl SubscriptionsPortalApi for SubscriptionsPortal {
    async fn resolve_entitlements(
        &self,
        subscription_id: SubscriptionId,
    ) -> Result<Entitlements, SubscriptionError> {
        // Step 1: Forward to the entitlement resolver for the subscription.
        let entitlements = self.entitlements.resolve(&subscription_id).await?;
        // Step 2: Return the Entitlements.
        Ok(entitlements)
    }
}

/// Map the subscriptions domain error onto the HTTP-facing envelope.
fn to_api_error(err: SubscriptionError) -> ApiError {
    match err {
        SubscriptionError::NotFound(msg) => ApiError::not_found(msg),
        SubscriptionError::InvalidTier(msg) => ApiError::bad_request(msg),
        SubscriptionError::StripeFailure(msg) => ApiError::new(502, "stripe_failure", msg),
        SubscriptionError::Conflict(msg) => ApiError::conflict(msg),
        SubscriptionError::Persistence(msg) => ApiError::internal(msg),
    }
}

#[derive(Debug, Deserialize)]
struct ChangeTierBody {
    tier_id: TierId,
}

// --- axum handler adapters ---

async fn create_plan(State(p): State<SubscriptionsPortal>, Json(body): Json<Plan>) -> Response {
    // Steps 1-3: validate (deserialization) -> orchestrator -> 201/err.
    match p.plans.create_plan(body).await.map_err(to_api_error) {
        Ok(plan) => (StatusCode::CREATED, Json(plan)).into_response(),
        Err(err) => err.into_response(),
    }
}

async fn list_plans(State(p): State<SubscriptionsPortal>) -> Response {
    match p.plans.list_plans().await.map_err(to_api_error) {
        Ok(plans) => (StatusCode::OK, Json(plans)).into_response(),
        Err(err) => err.into_response(),
    }
}

async fn update_tier_limits(
    State(p): State<SubscriptionsPortal>,
    Path((plan_id, tier_id)): Path<(String, String)>,
    Json(limits): Json<LimitSet>,
) -> Response {
    match p
        .plans
        .update_tier_limits(&PlanId::new(plan_id), &TierId::new(tier_id), limits)
        .await
        .map_err(to_api_error)
    {
        Ok(plan) => (StatusCode::OK, Json(plan)).into_response(),
        Err(err) => err.into_response(),
    }
}

async fn create_subscription(
    State(p): State<SubscriptionsPortal>,
    Json(body): Json<CreateSubscriptionCommand>,
) -> Response {
    match p
        .subscriptions
        .create_subscription(body)
        .await
        .map_err(to_api_error)
    {
        Ok(sub) => (StatusCode::CREATED, Json(sub)).into_response(),
        Err(err) => err.into_response(),
    }
}

async fn get_subscription(
    State(p): State<SubscriptionsPortal>,
    Path(id): Path<String>,
) -> Response {
    match p
        .subscriptions
        .get_subscription(&SubscriptionId::new(id))
        .await
        .map_err(to_api_error)
    {
        Ok(sub) => (StatusCode::OK, Json(sub)).into_response(),
        Err(err) => err.into_response(),
    }
}

async fn change_tier(
    State(p): State<SubscriptionsPortal>,
    Path(id): Path<String>,
    Json(body): Json<ChangeTierBody>,
) -> Response {
    match p
        .subscriptions
        .change_tier(&SubscriptionId::new(id), body.tier_id)
        .await
        .map_err(to_api_error)
    {
        Ok(sub) => (StatusCode::OK, Json(sub)).into_response(),
        Err(err) => err.into_response(),
    }
}

async fn cancel_subscription(
    State(p): State<SubscriptionsPortal>,
    Path(id): Path<String>,
) -> Response {
    match p
        .subscriptions
        .cancel_subscription(&SubscriptionId::new(id))
        .await
        .map_err(to_api_error)
    {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(err) => err.into_response(),
    }
}

async fn get_entitlements(
    State(p): State<SubscriptionsPortal>,
    Path(id): Path<String>,
) -> Response {
    // Steps 1-2: forward to the entitlement resolver; 200 with the Entitlements or error.
    match SubscriptionsPortalApi::resolve_entitlements(&p, SubscriptionId::new(id))
        .await
        .map_err(to_api_error)
    {
        Ok(entitlements) => (StatusCode::OK, Json(entitlements)).into_response(),
        Err(err) => err.into_response(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::subscriptions::test_support::{
        MockEntitlementResolver, MockPlanOrchestrator, MockSubscriptionOrchestrator,
    };
    use axum::body::Body;
    use axum::http::Request;
    use tower::ServiceExt;

    fn portal() -> Router {
        SubscriptionsPortal::new(
            Arc::new(MockPlanOrchestrator::default()),
            Arc::new(MockSubscriptionOrchestrator::default()),
            Arc::new(MockEntitlementResolver::default()),
        )
        .router()
    }

    #[tokio::test]
    async fn list_plans_returns_200() {
        let response = portal()
            .oneshot(Request::builder().uri("/v1/plans").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn get_unknown_subscription_returns_404() {
        let response = portal()
            .oneshot(
                Request::builder()
                    .uri("/v1/subscriptions/missing")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
    }
}
