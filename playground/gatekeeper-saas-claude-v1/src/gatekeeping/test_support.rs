//! Test doubles for the gatekeeping subsystem.

use std::sync::atomic::{AtomicUsize, Ordering};

use async_trait::async_trait;

use crate::domain::{ApiKeyId, DbError, SubscriptionId};
use crate::metering::model::{ConsumeOutcome, ConsumeRequest};
use crate::subscriptions::model::Entitlements;

use super::api_key_authenticator::ApiKeyAuthenticator;
use super::audit_adapter::AuditAdapter;
use super::credential_db_adapter::CredentialDbAdapter;
use super::credential_orchestrator::CredentialOrchestrator;
use super::gate_orchestrator::GateOrchestrator;
use super::metering_client::MeteringClient;
use super::model::{
    ApiKey, AuthResult, AuthorizeDecision, AuthorizeRequest, DecisionAuditRecord, GateError,
    IssuedKey,
};
use super::subscriptions_client::SubscriptionsClient;

// --- Credential db adapter double ---

pub struct MockCredentialDbAdapter {
    upserts: AtomicUsize,
}

impl MockCredentialDbAdapter {
    pub fn ok() -> Self {
        Self { upserts: AtomicUsize::new(0) }
    }
    pub fn upsert_calls(&self) -> usize {
        self.upserts.load(Ordering::SeqCst)
    }
}

#[async_trait]
impl CredentialDbAdapter for MockCredentialDbAdapter {
    async fn load_all(&self) -> Result<Vec<ApiKey>, DbError> {
        Ok(vec![])
    }
    async fn upsert_key(&self, _key: &ApiKey) -> Result<(), DbError> {
        self.upserts.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }
}

// --- Authenticator double ---

pub struct MockApiKeyAuthenticator {
    subscription: Option<SubscriptionId>,
}

impl MockApiKeyAuthenticator {
    pub fn ok(subscription_id: &str) -> Self {
        Self { subscription: Some(SubscriptionId::new(subscription_id)) }
    }
    pub fn unauthenticated() -> Self {
        Self { subscription: None }
    }
}

#[async_trait]
impl ApiKeyAuthenticator for MockApiKeyAuthenticator {
    async fn authenticate(&self, _api_key: String) -> Result<AuthResult, GateError> {
        match &self.subscription {
            Some(id) => Ok(AuthResult { subscription_id: id.clone() }),
            None => Err(GateError::Unauthenticated("mock".into())),
        }
    }
}

// --- Subscriptions client double ---

pub struct MockSubscriptionsClient {
    entitlements: Entitlements,
}

impl MockSubscriptionsClient {
    pub fn with(entitlements: Entitlements) -> Self {
        Self { entitlements }
    }
}

#[async_trait]
impl SubscriptionsClient for MockSubscriptionsClient {
    async fn resolve_entitlements(
        &self,
        _subscription_id: SubscriptionId,
    ) -> Result<Entitlements, GateError> {
        Ok(self.entitlements.clone())
    }
}

// --- Metering client double ---

pub struct MockMeteringClient {
    remaining: i64,
}

impl MockMeteringClient {
    pub fn allowing(remaining: i64) -> Self {
        Self { remaining }
    }
}

#[async_trait]
impl MeteringClient for MockMeteringClient {
    async fn consume(&self, _req: ConsumeRequest) -> Result<ConsumeOutcome, GateError> {
        Ok(ConsumeOutcome { allowed: true, used: 0, remaining: self.remaining })
    }
}

// --- Audit adapter double ---

pub struct MockAuditAdapter {
    records: AtomicUsize,
}

impl MockAuditAdapter {
    pub fn new() -> Self {
        Self { records: AtomicUsize::new(0) }
    }
    pub fn records(&self) -> usize {
        self.records.load(Ordering::SeqCst)
    }
}

impl Default for MockAuditAdapter {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl AuditAdapter for MockAuditAdapter {
    async fn record_decision(&self, _record: DecisionAuditRecord) -> Result<(), GateError> {
        self.records.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }
}

// --- Orchestrator doubles (for portal tests) ---

pub struct MockGateOrchestrator {
    reason: String,
}

impl MockGateOrchestrator {
    pub fn denying(reason: &str) -> Self {
        Self { reason: reason.to_string() }
    }
}

#[async_trait]
impl GateOrchestrator for MockGateOrchestrator {
    async fn authorize(&self, _req: AuthorizeRequest) -> Result<AuthorizeDecision, GateError> {
        Ok(AuthorizeDecision { allowed: false, reason: self.reason.clone(), remaining: 0 })
    }
}

#[derive(Default)]
pub struct MockCredentialOrchestrator;

#[async_trait]
impl CredentialOrchestrator for MockCredentialOrchestrator {
    async fn issue_key(&self, subscription_id: SubscriptionId) -> Result<IssuedKey, GateError> {
        Ok(IssuedKey {
            id: ApiKeyId::new("k-mock"),
            plaintext: "gk_mockplaintext".into(),
            subscription_id,
        })
    }
    async fn revoke_key(&self, _key_id: ApiKeyId) -> Result<(), GateError> {
        Ok(())
    }
}
