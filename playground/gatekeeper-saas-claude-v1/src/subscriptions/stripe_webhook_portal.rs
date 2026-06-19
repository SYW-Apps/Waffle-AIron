//! Stripe Webhook Portal (Portal stereotype): dedicated HTTP ingress for
//! /v1/stripe/webhook. Receives the raw signed Stripe event body (no API-key
//! auth) and forwards it to the stripe event orchestrator.

use std::sync::Arc;

use axum::body::Bytes;
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use axum::Router;

use crate::domain::ApiError;

use super::model::SubscriptionError;
use super::stripe_event_orchestrator::StripeEventOrchestrator;

#[derive(Clone)]
pub struct StripeWebhookPortal {
    orchestrator: Arc<dyn StripeEventOrchestrator>,
}

impl StripeWebhookPortal {
    pub fn new(orchestrator: Arc<dyn StripeEventOrchestrator>) -> Self {
        Self { orchestrator }
    }

    pub fn router(self) -> Router {
        Router::new()
            .route("/v1/stripe/webhook", post(handle_webhook))
            .with_state(self)
    }

    async fn handle_webhook(
        &self,
        raw_body: Vec<u8>,
        signature: String,
    ) -> Result<(), ApiError> {
        // Step 2: Forward to the stripe event orchestrator for verification and processing.
        // (Step 1, reading raw bytes + signature header, is done by the handler below.)
        self.orchestrator
            .process_event(raw_body, signature)
            .await
            .map_err(map_err)
    }
}

/// Stripe signature failures surface as 400; everything else as 500.
fn map_err(err: SubscriptionError) -> ApiError {
    match err {
        SubscriptionError::StripeFailure(msg) | SubscriptionError::Conflict(msg) => {
            ApiError::bad_request(msg)
        }
        other => ApiError::internal(other.to_string()),
    }
}

async fn handle_webhook(
    State(portal): State<StripeWebhookPortal>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    // Step 1: Read the raw request body bytes and the Stripe-Signature header.
    let signature = headers
        .get("Stripe-Signature")
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default()
        .to_string();
    // Step 3: Return 200 on success, 400 on signature/parse failure.
    match portal.handle_webhook(body.to_vec(), signature).await {
        Ok(()) => StatusCode::OK.into_response(),
        Err(err) => err.into_response(),
    }
}
