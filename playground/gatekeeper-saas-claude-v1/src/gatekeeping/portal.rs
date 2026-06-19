//! Gatekeeping Portal (Portal stereotype): HTTP/JSON ingress for /v1/authorize
//! (the gate hot path) and /v1/api-keys (issue/revoke). Forwards to the gate and
//! credential orchestrators. The only inbound surface for gatekeeping.

use std::sync::Arc;

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use axum::{Json, Router};
use serde::Deserialize;

use crate::domain::{ApiError, ApiKeyId, SubscriptionId};

use super::credential_orchestrator::CredentialOrchestrator;
use super::gate_orchestrator::GateOrchestrator;
use super::model::{AuthorizeDecision, AuthorizeRequest, GateError};

#[derive(Clone)]
pub struct GatekeepingPortal {
    gate: Arc<dyn GateOrchestrator>,
    credentials: Arc<dyn CredentialOrchestrator>,
}

impl GatekeepingPortal {
    pub fn new(
        gate: Arc<dyn GateOrchestrator>,
        credentials: Arc<dyn CredentialOrchestrator>,
    ) -> Self {
        Self { gate, credentials }
    }

    pub fn router(self) -> Router {
        Router::new()
            .route("/v1/authorize", post(authorize))
            .route("/v1/api-keys", post(issue_api_key))
            .route("/v1/api-keys/:key_id", axum::routing::delete(revoke_api_key))
            .with_state(self)
    }
}

/// Map a GateError onto the HTTP-facing envelope.
fn to_api_error(err: GateError) -> ApiError {
    match err {
        GateError::Unauthenticated(msg) => ApiError::new(401, "unauthenticated", msg),
        GateError::Forbidden(msg) => ApiError::new(403, "forbidden", msg),
        GateError::OverQuota(msg) => ApiError::new(429, "over_quota", msg),
        GateError::Downstream(msg) => ApiError::new(502, "downstream", msg),
        GateError::Persistence(msg) => ApiError::internal(msg),
    }
}

/// Status code for a returned decision (allow/deny share 200 except for the
/// authentication/quota reasons, which map to their HTTP equivalents).
fn decision_status(decision: &AuthorizeDecision) -> StatusCode {
    if decision.allowed {
        return StatusCode::OK;
    }
    match decision.reason.as_str() {
        "unauthenticated" => StatusCode::UNAUTHORIZED,
        "over_quota" => StatusCode::TOO_MANY_REQUESTS,
        "forbidden" => StatusCode::FORBIDDEN,
        _ => StatusCode::OK,
    }
}

#[derive(Debug, Deserialize)]
struct IssueKeyBody {
    subscription_id: SubscriptionId,
}

async fn authorize(
    State(portal): State<GatekeepingPortal>,
    Json(body): Json<AuthorizeRequest>,
) -> Response {
    // Steps 1-3: forward to the gate orchestrator; map decision/error to a response.
    match portal.gate.authorize(body).await {
        Ok(decision) => (decision_status(&decision), Json(decision)).into_response(),
        Err(err) => to_api_error(err).into_response(),
    }
}

async fn issue_api_key(
    State(portal): State<GatekeepingPortal>,
    Json(body): Json<IssueKeyBody>,
) -> Response {
    // Steps 1-3: forward to the credential orchestrator; 201 with the IssuedKey.
    match portal.credentials.issue_key(body.subscription_id).await {
        Ok(issued) => (StatusCode::CREATED, Json(issued)).into_response(),
        Err(err) => to_api_error(err).into_response(),
    }
}

async fn revoke_api_key(
    State(portal): State<GatekeepingPortal>,
    Path(key_id): Path<String>,
) -> Response {
    // Steps 1-3: forward to the credential orchestrator; 204 No Content.
    match portal.credentials.revoke_key(ApiKeyId::new(key_id)).await {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(err) => to_api_error(err).into_response(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::gatekeeping::test_support::{MockCredentialOrchestrator, MockGateOrchestrator};
    use axum::body::Body;
    use axum::http::Request;
    use tower::ServiceExt;

    fn portal() -> Router {
        GatekeepingPortal::new(
            Arc::new(MockGateOrchestrator::denying("unauthenticated")),
            Arc::new(MockCredentialOrchestrator::default()),
        )
        .router()
    }

    #[tokio::test]
    async fn unauthenticated_decision_maps_to_401() {
        let body = serde_json::json!({"api_key": "x", "resource": "api_calls", "amount": 1});
        let response = portal()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/v1/authorize")
                    .header("content-type", "application/json")
                    .body(Body::from(body.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn issue_key_returns_201() {
        let app = GatekeepingPortal::new(
            Arc::new(MockGateOrchestrator::denying("ok")),
            Arc::new(MockCredentialOrchestrator::default()),
        )
        .router();
        let body = serde_json::json!({"subscription_id": "sub-1"});
        let response = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/v1/api-keys")
                    .header("content-type", "application/json")
                    .body(Body::from(body.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::CREATED);
    }
}
