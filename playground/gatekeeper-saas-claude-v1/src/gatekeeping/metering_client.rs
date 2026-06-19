//! Metering Client Adapter (Adapter stereotype): the only gatekeeping block
//! allowed to cross into the metering subsystem. Calls the metering Portal's
//! published consume endpoint and maps metering errors into gate errors.

use std::sync::Arc;

use async_trait::async_trait;

use crate::metering::model::{ConsumeOutcome, ConsumeRequest};
use crate::metering::portal::MeteringPortalApi;

use super::model::GateError;

#[async_trait]
pub trait MeteringClient: Send + Sync {
    async fn consume(&self, req: ConsumeRequest) -> Result<ConsumeOutcome, GateError>;
}

pub struct MeteringClientAdapter {
    portal: Arc<dyn MeteringPortalApi>,
}

impl MeteringClientAdapter {
    pub fn new(portal: Arc<dyn MeteringPortalApi>) -> Self {
        Self { portal }
    }
}

#[async_trait]
impl MeteringClient for MeteringClientAdapter {
    async fn consume(&self, req: ConsumeRequest) -> Result<ConsumeOutcome, GateError> {
        // Step 1: Call the metering Portal's consume endpoint to check-and-decrement usage.
        let result = self.portal.consume(req).await;
        // Step 2: Map any MeteringError into GateError::Downstream and return the ConsumeOutcome.
        result.map_err(|e| GateError::Downstream(e.to_string()))
    }
}
