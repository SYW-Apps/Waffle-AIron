use std::sync::Arc;
use axum::{
    extract::Request,
    response::{IntoResponse, Response},
    routing::post,
    Json, Router,
};
use axum::http::StatusCode;
use serde::Deserialize;
use crate::metering::orchestrator::IMeteringOrchestrator;

#[async_trait::async_trait]
pub trait IMeteringPortal: Send + Sync {
    async fn check_access(&self, req: Request) -> Response;
    async fn report_usage(&self, req: Request) -> Response;
}

pub struct MeteringPortal {
    orchestrator: Arc<dyn IMeteringOrchestrator>,
}

impl MeteringPortal {
    pub fn new(orchestrator: Arc<dyn IMeteringOrchestrator>) -> Self {
        Self { orchestrator }
    }

    pub fn routes(self: Arc<Self>) -> Router {
        Router::new()
            .route("/check", post({
                let portal = Arc::clone(&self);
                move |req| async move { portal.check_access(req).await }
            }))
            .route("/meter", post({
                let portal = Arc::clone(&self);
                move |req| async move { portal.report_usage(req).await }
            }))
    }
}

#[derive(Deserialize)]
struct ReportUsageRequest {
    #[serde(default = "default_cost")]
    cost: i32,
}

fn default_cost() -> i32 {
    1
}

#[async_trait::async_trait]
impl IMeteringPortal for MeteringPortal {
    async fn check_access(&self, req: Request) -> Response {
        // Step 1: Parse API key parameter from request headers.
        let key_val = req.headers().get("x-api-key")
            .and_then(|h| h.to_str().ok())
            .unwrap_or("")
            .to_string();

        if key_val.is_empty() {
            return (StatusCode::BAD_REQUEST, "Missing x-api-key header").into_response();
        }

        // Step 2: Call Orchestrator to verify API key validity and rate limits.
        let validation = match self.orchestrator.verify_access(key_val).await {
            Ok(v) => v,
            Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, e).into_response(),
        };

        // Step 3: Format and return JSON HTTP Response.
        if validation.authorized {
            (StatusCode::OK, Json(validation)).into_response()
        } else {
            (StatusCode::FORBIDDEN, Json(validation)).into_response()
        }
    }

    async fn report_usage(&self, req: Request) -> Response {
        // Step 1: Parse request headers and key cost weights from request body.
        let key_val = req.headers().get("x-api-key")
            .and_then(|h| h.to_str().ok())
            .unwrap_or("")
            .to_string();

        if key_val.is_empty() {
            return (StatusCode::BAD_REQUEST, "Missing x-api-key header").into_response();
        }

        let body_bytes = match axum::body::to_bytes(req.into_body(), 1024 * 16).await {
            Ok(b) => b,
            Err(_) => return (StatusCode::BAD_REQUEST, "Failed to read request body").into_response(),
        };

        let report_req: ReportUsageRequest = if body_bytes.is_empty() {
            ReportUsageRequest { cost: 1 }
        } else {
            match serde_json::from_slice(&body_bytes) {
                Ok(r) => r,
                Err(e) => return (StatusCode::BAD_REQUEST, format!("Invalid JSON: {}", e)).into_response(),
            }
        };

        // Step 2: Call Orchestrator to record request metrics usage.
        let usage_status = match self.orchestrator.increment_count(key_val, report_req.cost).await {
            Ok(s) => s,
            Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, e).into_response(),
        };

        // Step 3: Format and return JSON HTTP Response with usage summary.
        (StatusCode::OK, Json(usage_status)).into_response()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::Request as HttpRequest;
    use tower::util::ServiceExt;
    use serde_json::json;
    use crate::models::{AccessValidation, UsageStatus};

    struct MockOrchestrator;

    #[async_trait::async_trait]
    impl IMeteringOrchestrator for MockOrchestrator {
        async fn verify_access(&self, key_value: String) -> Result<AccessValidation, String> {
            if key_value == "valid_key" {
                Ok(AccessValidation {
                    authorized: true,
                    reason: "Authorized".to_string(),
                })
            } else {
                Ok(AccessValidation {
                    authorized: false,
                    reason: "Invalid key".to_string(),
                })
            }
        }

        async fn increment_count(&self, key_value: String, cost: i32) -> Result<UsageStatus, String> {
            if key_value == "valid_key" {
                Ok(UsageStatus {
                    current_usage: 100 + cost as i64,
                    limit: 1000,
                    rate_limit: 60,
                })
            } else {
                Err("Invalid key".to_string())
            }
        }
    }

    #[tokio::test]
    async fn test_check_access_success() {
        let orchestrator = Arc::new(MockOrchestrator);
        let portal = Arc::new(MeteringPortal::new(orchestrator));
        let router = portal.routes();

        let req = HttpRequest::builder()
            .method("POST")
            .uri("/check")
            .header("x-api-key", "valid_key")
            .body(axum::body::Body::empty())
            .unwrap();

        let response = router.oneshot(req).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn test_check_access_unauthorized() {
        let orchestrator = Arc::new(MockOrchestrator);
        let portal = Arc::new(MeteringPortal::new(orchestrator));
        let router = portal.routes();

        let req = HttpRequest::builder()
            .method("POST")
            .uri("/check")
            .header("x-api-key", "invalid_key")
            .body(axum::body::Body::empty())
            .unwrap();

        let response = router.oneshot(req).await.unwrap();
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
    }

    #[tokio::test]
    async fn test_report_usage_success() {
        let orchestrator = Arc::new(MockOrchestrator);
        let portal = Arc::new(MeteringPortal::new(orchestrator));
        let router = portal.routes();

        let req = HttpRequest::builder()
            .method("POST")
            .uri("/meter")
            .header("x-api-key", "valid_key")
            .header("content-type", "application/json")
            .body(axum::body::Body::from(json!({ "cost": 5 }).to_string()))
            .unwrap();

        let response = router.oneshot(req).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
    }
}
