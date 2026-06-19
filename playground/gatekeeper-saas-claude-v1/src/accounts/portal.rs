//! Accounts Portal (Portal stereotype): HTTP/JSON ingress for /v1/accounts and
//! /v1/customers, plus the published resolve_billing_email read used
//! cross-subsystem. The only inbound surface for the accounts subsystem;
//! validates and forwards to the account orchestrator and the account directory.
//! Never touches stores or adapters.

use std::sync::Arc;

use async_trait::async_trait;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, patch, post};
use axum::{Json, Router};
use serde::Deserialize;

use crate::domain::{ApiError, BillingAccountId, CustomerId, Email};

use super::account_directory::AccountDirectory;
use super::account_orchestrator::AccountOrchestrator;
use super::model::{Account, AccountError, CreateAccountCommand, Customer};

/// In-process published surface of the accounts Portal, consumed cross-subsystem
/// by the notifications and subscriptions client adapters. Depending on the
/// Portal (the front door) rather than the internal account directory keeps the
/// distribution seam intact.
#[async_trait]
pub trait AccountsPortalApi: Send + Sync {
    async fn resolve_billing_email(
        &self,
        id: &BillingAccountId,
    ) -> Result<Option<Email>, AccountError>;
}

/// Axum HTTP handlers for accounts/customers; forwards to the account orchestrator
/// and (for the published billing-email lookup) the account directory.
#[derive(Clone)]
pub struct AccountsPortal {
    orchestrator: Arc<dyn AccountOrchestrator>,
    directory: Arc<dyn AccountDirectory>,
}

impl AccountsPortal {
    pub fn new(
        orchestrator: Arc<dyn AccountOrchestrator>,
        directory: Arc<dyn AccountDirectory>,
    ) -> Self {
        Self { orchestrator, directory }
    }

    /// Mount the subsystem's routes (verb+path map 1:1 to the interface endpoints).
    pub fn router(self) -> Router {
        Router::new()
            .route("/v1/accounts", post(create_account))
            .route("/v1/accounts/:id", get(get_account))
            .route("/v1/customers/:id", get(get_customer))
            .route(
                "/v1/accounts/:id/billing-email",
                patch(update_billing_email).get(get_billing_email),
            )
            .route("/v1/accounts/:id/deactivate", post(deactivate_account))
            .with_state(self)
    }

    async fn create_account(&self, body: CreateAccountCommand) -> Result<Account, ApiError> {
        // Step 2: Forward to the account orchestrator. (Step 1, deserialize +
        // validate, is performed by the Json extractor + Email newtype.)
        self.orchestrator
            .create_account(body)
            .await
            .map_err(to_api_error)
    }

    async fn get_account(&self, id: BillingAccountId) -> Result<Account, ApiError> {
        // Step 1: Fetch the account aggregate via the orchestrator.
        self.orchestrator
            .get_account(&id)
            .await
            .map_err(to_api_error)
    }

    async fn get_customer(&self, id: CustomerId) -> Result<Customer, ApiError> {
        // Step 1: Fetch the customer via the orchestrator.
        self.orchestrator
            .get_customer(&id)
            .await
            .map_err(to_api_error)
    }

    async fn update_billing_email(
        &self,
        id: BillingAccountId,
        email: Email,
    ) -> Result<Account, ApiError> {
        // Step 2: Forward to the orchestrator. (Step 1, parsing id + Email, is
        // done by the extractors below.)
        self.orchestrator
            .update_billing_email(&id, email)
            .await
            .map_err(to_api_error)
    }

    async fn deactivate_account(&self, id: BillingAccountId) -> Result<(), ApiError> {
        // Step 1: Deactivate via the orchestrator.
        self.orchestrator
            .deactivate_account(&id)
            .await
            .map_err(to_api_error)
    }
}

#[async_trait]
impl AccountsPortalApi for AccountsPortal {
    async fn resolve_billing_email(
        &self,
        id: &BillingAccountId,
    ) -> Result<Option<Email>, AccountError> {
        // Step 1: Forward to the account directory to resolve the billing contact email.
        let email = self.directory.resolve_billing_email(id).await?;
        // Step 2: Return the Option<Email>.
        Ok(email)
    }
}

/// Map the accounts domain error onto the HTTP-facing envelope.
fn to_api_error(err: AccountError) -> ApiError {
    match err {
        AccountError::NotFound(msg) => ApiError::not_found(msg),
        AccountError::InvalidEmail(msg) => ApiError::bad_request(msg),
        AccountError::Conflict(msg) => ApiError::conflict(msg),
        AccountError::Persistence(msg) => ApiError::internal(msg),
    }
}

#[derive(Debug, Deserialize)]
struct UpdateBillingEmailBody {
    email: Email,
}

// --- axum handler adapters (extraction + status-code shaping) ---

async fn create_account(
    State(portal): State<AccountsPortal>,
    Json(body): Json<CreateAccountCommand>,
) -> Response {
    // Step 3: Return 201 Created or error.
    match portal.create_account(body).await {
        Ok(account) => (StatusCode::CREATED, Json(account)).into_response(),
        Err(err) => err.into_response(),
    }
}

async fn get_account(State(portal): State<AccountsPortal>, Path(id): Path<String>) -> Response {
    // Step 2: Return 200 or 404.
    match portal.get_account(BillingAccountId::new(id)).await {
        Ok(account) => (StatusCode::OK, Json(account)).into_response(),
        Err(err) => err.into_response(),
    }
}

async fn get_customer(State(portal): State<AccountsPortal>, Path(id): Path<String>) -> Response {
    // Step 2: Return 200 or 404.
    match portal.get_customer(CustomerId::new(id)).await {
        Ok(customer) => (StatusCode::OK, Json(customer)).into_response(),
        Err(err) => err.into_response(),
    }
}

async fn update_billing_email(
    State(portal): State<AccountsPortal>,
    Path(id): Path<String>,
    Json(body): Json<UpdateBillingEmailBody>,
) -> Response {
    // Step 3: Return 200 with the refreshed account or error.
    match portal
        .update_billing_email(BillingAccountId::new(id), body.email)
        .await
    {
        Ok(account) => (StatusCode::OK, Json(account)).into_response(),
        Err(err) => err.into_response(),
    }
}

async fn get_billing_email(
    State(portal): State<AccountsPortal>,
    Path(id): Path<String>,
) -> Response {
    // Steps 1-2: forward to the account directory; 200 with the Option<Email> or error.
    match AccountsPortalApi::resolve_billing_email(&portal, &BillingAccountId::new(id)).await {
        Ok(email) => (StatusCode::OK, Json(email)).into_response(),
        Err(err) => to_api_error(err).into_response(),
    }
}

async fn deactivate_account(
    State(portal): State<AccountsPortal>,
    Path(id): Path<String>,
) -> Response {
    // Step 2: Return 204 No Content or error.
    match portal.deactivate_account(BillingAccountId::new(id)).await {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(err) => err.into_response(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::accounts::test_support::{MockAccountDirectory, MockAccountOrchestrator};
    use axum::body::Body;
    use axum::http::Request;
    use tower::ServiceExt;

    fn portal() -> Router {
        AccountsPortal::new(
            Arc::new(MockAccountOrchestrator::default()),
            Arc::new(MockAccountDirectory::empty()),
        )
        .router()
    }

    #[tokio::test]
    async fn create_account_returns_201() {
        let app = portal();
        let body = serde_json::json!({
            "name": "Acme",
            "billing_email": "billing@acme.com",
            "contacts": []
        });
        let response = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/v1/accounts")
                    .header("content-type", "application/json")
                    .body(Body::from(body.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::CREATED);
    }

    #[tokio::test]
    async fn get_unknown_account_returns_404() {
        let app = portal();
        let response = app
            .oneshot(
                Request::builder()
                    .uri("/v1/accounts/missing")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn deactivate_returns_204() {
        let app = portal();
        let response = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/v1/accounts/ba-1/deactivate")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NO_CONTENT);
    }
}
