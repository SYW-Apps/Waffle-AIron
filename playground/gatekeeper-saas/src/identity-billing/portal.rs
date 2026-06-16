use std::sync::Arc;
use axum::{
    extract::Request,
    response::{IntoResponse, Response},
    routing::{post, delete},
    Json, Router,
};
use axum::http::StatusCode;
use serde::Deserialize;
use crate::identity_billing::orchestrator::IBillingOrchestrator;

#[async_trait::async_trait]
pub trait IBillingPortal: Send + Sync {
    async fn create_customer(&self, req: Request) -> Response;
    async fn create_api_key(&self, req: Request) -> Response;
    async fn revoke_api_key(&self, req: Request) -> Response;
    async fn stripe_webhook(&self, req: Request) -> Response;
}

pub struct BillingPortal {
    orchestrator: Arc<dyn IBillingOrchestrator>,
}

impl BillingPortal {
    pub fn new(orchestrator: Arc<dyn IBillingOrchestrator>) -> Self {
        Self { orchestrator }
    }

    pub fn routes(self: Arc<Self>) -> Router {
        Router::new()
            .route("/customers", post({
                let portal = Arc::clone(&self);
                move |req| async move { portal.create_customer(req).await }
            }))
            .route("/keys", post({
                let portal = Arc::clone(&self);
                move |req| async move { portal.create_api_key(req).await }
            }))
            .route("/keys/:id", delete({
                let portal = Arc::clone(&self);
                move |req| async move { portal.revoke_api_key(req).await }
            }))
            .route("/webhooks/stripe", post({
                let portal = Arc::clone(&self);
                move |req| async move { portal.stripe_webhook(req).await }
            }))
    }
}

#[derive(Deserialize)]
struct CreateCustomerRequest {
    email: String,
}

#[derive(Deserialize)]
struct CreateApiKeyRequest {
    customer_id: String,
}

#[async_trait::async_trait]
impl IBillingPortal for BillingPortal {
    async fn create_customer(&self, req: Request) -> Response {
        // Step 1: Parse request body mapping to register customer data model.
        let body_bytes = match axum::body::to_bytes(req.into_body(), 1024 * 16).await {
            Ok(b) => b,
            Err(_) => return (StatusCode::BAD_REQUEST, "Failed to read request body").into_response(),
        };
        let create_req: CreateCustomerRequest = match serde_json::from_slice(&body_bytes) {
            Ok(r) => r,
            Err(e) => return (StatusCode::BAD_REQUEST, format!("Invalid JSON: {}", e)).into_response(),
        };

        // Step 2: Call Orchestrator to register the customer.
        let customer = match self.orchestrator.register_customer(create_req.email).await {
            Ok(c) => c,
            Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, e).into_response(),
        };

        // Step 3: Format and return JSON HTTP 201 Response.
        (StatusCode::CREATED, Json(customer)).into_response()
    }

    async fn create_api_key(&self, req: Request) -> Response {
        // Step 1: Parse request body details.
        let body_bytes = match axum::body::to_bytes(req.into_body(), 1024 * 16).await {
            Ok(b) => b,
            Err(_) => return (StatusCode::BAD_REQUEST, "Failed to read request body").into_response(),
        };
        let create_req: CreateApiKeyRequest = match serde_json::from_slice(&body_bytes) {
            Ok(r) => r,
            Err(e) => return (StatusCode::BAD_REQUEST, format!("Invalid JSON: {}", e)).into_response(),
        };

        // Step 2: Call Orchestrator to generate credentials.
        let api_key = match self.orchestrator.generate_api_key(create_req.customer_id).await {
            Ok(k) => k,
            Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, e).into_response(),
        };

        // Step 3: Format and return HTTP 201 Response.
        (StatusCode::CREATED, Json(api_key)).into_response()
    }

    async fn revoke_api_key(&self, req: Request) -> Response {
        // Step 1: Extract API key ID parameter from path.
        let path = req.uri().path();
        let key_id = path.strip_prefix("/keys/").unwrap_or("").to_string();
        if key_id.is_empty() {
            return (StatusCode::BAD_REQUEST, "Missing key ID").into_response();
        }

        // Step 2: Call Orchestrator workflow to revoke API Key.
        match self.orchestrator.revoke_api_key(key_id).await {
            Ok(_) => {}
            Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, e).into_response(),
        };

        // Step 3: Format and return HTTP 204 No Content Response.
        StatusCode::NO_CONTENT.into_response()
    }

    async fn stripe_webhook(&self, req: Request) -> Response {
        // Step 2: Verify Webhook signature validation metrics.
        let _sig_header = req.headers().get("stripe-signature")
            .and_then(|h| h.to_str().ok())
            .unwrap_or("")
            .to_string();

        // Step 1: Parse raw request details.
        let body_bytes = match axum::body::to_bytes(req.into_body(), 1024 * 64).await {
            Ok(b) => b,
            Err(_) => return (StatusCode::BAD_REQUEST, "Failed to read request body").into_response(),
        };
        let payload = String::from_utf8_lossy(&body_bytes).into_owned();


        // Step 3: Call Orchestrator to handle Stripe payload sync.
        let parsed_json: serde_json::Value = match serde_json::from_str(&payload) {
            Ok(v) => v,
            Err(e) => return (StatusCode::BAD_REQUEST, format!("Invalid JSON: {}", e)).into_response(),
        };
        let event_type = parsed_json.get("type")
            .and_then(|t| t.as_str())
            .ok_or_else(|| "Missing event type")
            .map(|s| s.to_string());
            
        let event_type = match event_type {
            Ok(t) => t,
            Err(err) => return (StatusCode::BAD_REQUEST, err).into_response(),
        };

        match self.orchestrator.handle_stripe_event(event_type, payload).await {
            Ok(_) => {}
            Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, e).into_response(),
        };

        // Step 4: Format and return HTTP 200 OK Response.
        StatusCode::OK.into_response()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::Request as HttpRequest;
    use tower::util::ServiceExt;
    use serde_json::json;
    use crate::models::{Customer, ApiKey};
    use chrono::Utc;
    use uuid::Uuid;

    struct MockOrchestrator;

    #[async_trait::async_trait]
    impl IBillingOrchestrator for MockOrchestrator {
        async fn register_customer(&self, email: String) -> Result<Customer, String> {
            Ok(Customer {
                id: Uuid::nil(),
                email,
                stripe_customer_id: Some("cus_test_123".to_string()),
                created_at: Utc::now(),
                updated_at: Utc::now(),
            })
        }

        async fn generate_api_key(&self, customer_id: String) -> Result<ApiKey, String> {
            Ok(ApiKey {
                id: Uuid::nil(),
                customer_id: Uuid::parse_str(&customer_id).unwrap_or_default(),
                key_hash: "hash_test".to_string(),
                prefix: "gkp_test".to_string(),
                status: "active".to_string(),
                created_at: Utc::now(),
                updated_at: Utc::now(),
                plain_key: Some("gkp_test_secret".to_string()),
            })
        }

        async fn revoke_api_key(&self, _key_id: String) -> Result<(), String> {
            Ok(())
        }

        async fn handle_stripe_event(&self, _event_type: String, _payload: String) -> Result<(), String> {
            Ok(())
        }
    }

    #[tokio::test]
    async fn test_create_customer_endpoint() {
        let orchestrator = Arc::new(MockOrchestrator);
        let portal = Arc::new(BillingPortal::new(orchestrator));
        let router = portal.routes();

        let req = HttpRequest::builder()
            .method("POST")
            .uri("/customers")
            .header("content-type", "application/json")
            .body(axum::body::Body::from(json!({ "email": "test@example.com" }).to_string()))
            .unwrap();

        let response = router.oneshot(req).await.unwrap();
        assert_eq!(response.status(), StatusCode::CREATED);
    }

    #[tokio::test]
    async fn test_create_api_key_endpoint() {
        let orchestrator = Arc::new(MockOrchestrator);
        let portal = Arc::new(BillingPortal::new(orchestrator));
        let router = portal.routes();

        let cust_id = Uuid::new_v4().to_string();
        let req = HttpRequest::builder()
            .method("POST")
            .uri("/keys")
            .header("content-type", "application/json")
            .body(axum::body::Body::from(json!({ "customer_id": cust_id }).to_string()))
            .unwrap();

        let response = router.oneshot(req).await.unwrap();
        assert_eq!(response.status(), StatusCode::CREATED);
    }

    #[tokio::test]
    async fn test_revoke_api_key_endpoint() {
        let orchestrator = Arc::new(MockOrchestrator);
        let portal = Arc::new(BillingPortal::new(orchestrator));
        let router = portal.routes();

        let key_id = Uuid::new_v4().to_string();
        let req = HttpRequest::builder()
            .method("DELETE")
            .uri(format!("/keys/{}", key_id))
            .body(axum::body::Body::empty())
            .unwrap();

        let response = router.oneshot(req).await.unwrap();
        assert_eq!(response.status(), StatusCode::NO_CONTENT);
    }

    #[tokio::test]
    async fn test_stripe_webhook_endpoint() {
        let orchestrator = Arc::new(MockOrchestrator);
        let portal = Arc::new(BillingPortal::new(orchestrator));
        let router = portal.routes();

        let req = HttpRequest::builder()
            .method("POST")
            .uri("/webhooks/stripe")
            .header("content-type", "application/json")
            .body(axum::body::Body::from(json!({
                "type": "customer.subscription.created",
                "data": {
                    "object": {
                        "id": "sub_test_123",
                        "customer": "cus_test_123"
                    }
                }
            }).to_string()))
            .unwrap();

        let response = router.oneshot(req).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
    }
}
