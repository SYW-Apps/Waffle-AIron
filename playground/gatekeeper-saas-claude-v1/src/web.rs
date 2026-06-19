//! Cross-cutting HTTP glue shared by all Portals: renders the domain `ApiError`
//! envelope into an axum response with the mapped status code and JSON body.

use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;

use crate::domain::ApiError;

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let status =
            StatusCode::from_u16(self.status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
        (status, Json(self)).into_response()
    }
}
