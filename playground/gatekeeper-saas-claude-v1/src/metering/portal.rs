//! Metering Portal (Portal stereotype): HTTP/JSON ingress for /v1/usage plus the
//! published hot-path consume. This is the metering subsystem's inbound front
//! door — it forwards usage reads to the usage query specialist and consume to
//! the usage meter. Sibling subsystems cross in through this Portal (via a local
//! client adapter), never through the internal meter. Never touches adapters or
//! repositories directly.

use std::sync::Arc;

use async_trait::async_trait;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};

use crate::domain::{ApiError, SubscriptionId};

use super::model::{ConsumeOutcome, ConsumeRequest, MeteringError};
use super::usage_meter::UsageMeter;
use super::usage_query::UsageQuery;

/// In-process published surface of the metering Portal, consumed cross-subsystem
/// by gatekeeping's metering client adapter. Depending on the Portal (the front
/// door) rather than the internal usage meter keeps the distribution seam intact.
#[async_trait]
pub trait MeteringPortalApi: Send + Sync {
    async fn consume(&self, req: ConsumeRequest) -> Result<ConsumeOutcome, MeteringError>;
}

#[derive(Clone)]
pub struct MeteringPortal {
    usage: Arc<dyn UsageQuery>,
    meter: Arc<dyn UsageMeter>,
}

impl MeteringPortal {
    pub fn new(usage: Arc<dyn UsageQuery>, meter: Arc<dyn UsageMeter>) -> Self {
        Self { usage, meter }
    }

    pub fn router(self) -> Router {
        Router::new()
            .route("/v1/usage/consume", post(consume))
            .route("/v1/usage/:subscription_id/:resource", get(get_usage))
            .route("/v1/usage/:subscription_id", get(list_usage))
            .with_state(self)
    }
}

#[async_trait]
impl MeteringPortalApi for MeteringPortal {
    async fn consume(&self, req: ConsumeRequest) -> Result<ConsumeOutcome, MeteringError> {
        // Step 1: Forward the consume request to the usage meter.
        let outcome = self.meter.consume(req).await?;
        // Step 2: Return the ConsumeOutcome.
        Ok(outcome)
    }
}

fn to_api_error(err: MeteringError) -> ApiError {
    match err {
        MeteringError::NotFound(msg) => ApiError::not_found(msg),
        other => ApiError::internal(other.to_string()),
    }
}

async fn get_usage(
    State(portal): State<MeteringPortal>,
    Path((subscription_id, resource)): Path<(String, String)>,
) -> Response {
    // Steps 1-2: read usage via the query specialist; 200 or error.
    match portal
        .usage
        .get_usage(SubscriptionId::new(subscription_id), resource)
        .await
        .map_err(to_api_error)
    {
        Ok(view) => (StatusCode::OK, Json(view)).into_response(),
        Err(err) => err.into_response(),
    }
}

async fn list_usage(
    State(portal): State<MeteringPortal>,
    Path(subscription_id): Path<String>,
) -> Response {
    // Steps 1-2: list usage across resources; 200 with the list.
    match portal
        .usage
        .list_usage(SubscriptionId::new(subscription_id))
        .await
        .map_err(to_api_error)
    {
        Ok(views) => (StatusCode::OK, Json(views)).into_response(),
        Err(err) => err.into_response(),
    }
}

async fn consume(
    State(portal): State<MeteringPortal>,
    Json(req): Json<ConsumeRequest>,
) -> Response {
    // Steps 1-2: forward to the usage meter; 200 with the outcome or error.
    match MeteringPortalApi::consume(&portal, req).await.map_err(to_api_error) {
        Ok(outcome) => (StatusCode::OK, Json(outcome)).into_response(),
        Err(err) => err.into_response(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::metering::test_support::{MockUsageMeter, MockUsageQuery};
    use axum::body::Body;
    use axum::http::Request;
    use tower::ServiceExt;

    fn portal() -> Router {
        MeteringPortal::new(
            Arc::new(MockUsageQuery::default()),
            Arc::new(MockUsageMeter::default()),
        )
        .router()
    }

    #[tokio::test]
    async fn list_usage_returns_200() {
        let response = portal()
            .oneshot(Request::builder().uri("/v1/usage/sub-1").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn get_unknown_usage_returns_404() {
        let response = portal()
            .oneshot(
                Request::builder()
                    .uri("/v1/usage/sub-1/unknown")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
    }
}
