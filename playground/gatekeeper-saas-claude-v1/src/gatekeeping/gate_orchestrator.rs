//! Gate Orchestrator (Orchestrator stereotype): the authorize workflow.
//! Authenticate the API key, resolve entitlements via the subscriptions client
//! adapter, check-and-decrement via the metering client adapter, record the
//! decision via the audit adapter, and return an allow/deny verdict. Crosses
//! subsystem boundaries only through local client adapters.

use std::sync::Arc;

use async_trait::async_trait;

use crate::metering::model::ConsumeRequest;
use crate::subscriptions::model::{Entitlements, SubscriptionStatus};

use super::api_key_authenticator::ApiKeyAuthenticator;
use super::audit_adapter::AuditAdapter;
use super::metering_client::MeteringClient;
use super::model::{AuthorizeDecision, AuthorizeRequest, DecisionAuditRecord, GateError};
use super::subscriptions_client::SubscriptionsClient;

#[async_trait]
pub trait GateOrchestrator: Send + Sync {
    async fn authorize(&self, req: AuthorizeRequest) -> Result<AuthorizeDecision, GateError>;
}

pub struct GateOrchestratorImpl {
    authenticator: Arc<dyn ApiKeyAuthenticator>,
    subscriptions: Arc<dyn SubscriptionsClient>,
    metering: Arc<dyn MeteringClient>,
    audit: Arc<dyn AuditAdapter>,
}

impl GateOrchestratorImpl {
    pub fn new(
        authenticator: Arc<dyn ApiKeyAuthenticator>,
        subscriptions: Arc<dyn SubscriptionsClient>,
        metering: Arc<dyn MeteringClient>,
        audit: Arc<dyn AuditAdapter>,
    ) -> Self {
        Self { authenticator, subscriptions, metering, audit }
    }

    /// Audit a decision then return it (shared tail for the entitled paths).
    async fn audit_and_return(
        &self,
        entitlements: &Entitlements,
        resource: &str,
        decision: AuthorizeDecision,
    ) -> Result<AuthorizeDecision, GateError> {
        // Step 6: Record the decision in the append-only audit log.
        let record = DecisionAuditRecord {
            subscription_id: entitlements.subscription_id.clone(),
            billing_account_id: entitlements.billing_account_id.clone(),
            resource: resource.to_string(),
            allowed: decision.allowed,
            reason: decision.reason.clone(),
            timestamp: chrono::Utc::now().to_rfc3339(),
        };
        self.audit.record_decision(record).await?;
        // Step 7: Return the AuthorizeDecision.
        Ok(decision)
    }
}

fn denied(reason: &str) -> AuthorizeDecision {
    AuthorizeDecision { allowed: false, reason: reason.to_string(), remaining: 0 }
}

#[async_trait]
impl GateOrchestrator for GateOrchestratorImpl {
    async fn authorize(&self, req: AuthorizeRequest) -> Result<AuthorizeDecision, GateError> {
        // Step 1: Authenticate the presented API key; on Unauthenticated, deny.
        let auth = match self.authenticator.authenticate(req.api_key).await {
            Ok(auth) => auth,
            Err(GateError::Unauthenticated(_)) => return Ok(denied("unauthenticated")),
            Err(other) => return Err(other),
        };

        // Step 2: Resolve the subscription's entitlements via the subscriptions client.
        let entitlements = self
            .subscriptions
            .resolve_entitlements(auth.subscription_id)
            .await?;

        // Step 3: Verify status is Active and find the limit for the resource; otherwise forbidden.
        if entitlements.status != SubscriptionStatus::Active {
            return self
                .audit_and_return(&entitlements, &req.resource, denied("forbidden"))
                .await;
        }
        let limit = match entitlements.limits.iter().find(|l| l.resource == req.resource) {
            Some(limit) => limit.clone(),
            None => {
                return self
                    .audit_and_return(&entitlements, &req.resource, denied("forbidden"))
                    .await
            }
        };

        // Step 4: Assemble a ConsumeRequest and check-and-decrement via the metering client.
        let consume_req = ConsumeRequest {
            subscription_id: entitlements.subscription_id.clone(),
            billing_account_id: entitlements.billing_account_id.clone(),
            resource: req.resource.clone(),
            quota: limit.quota,
            window: limit.window.clone(),
            amount: req.amount,
        };
        let outcome = self.metering.consume(consume_req).await?;

        // Step 5: Build the AuthorizeDecision from the ConsumeOutcome.
        let decision = AuthorizeDecision {
            allowed: outcome.allowed,
            reason: if outcome.allowed { "ok".into() } else { "over_quota".into() },
            remaining: outcome.remaining,
        };

        // Steps 6-7: Audit and return.
        self.audit_and_return(&entitlements, &req.resource, decision).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::{BillingAccountId, SubscriptionId};
    use crate::subscriptions::model::Limit;
    use crate::gatekeeping::test_support::{
        MockApiKeyAuthenticator, MockAuditAdapter, MockMeteringClient, MockSubscriptionsClient,
    };

    fn entitlements(status: SubscriptionStatus) -> Entitlements {
        Entitlements {
            subscription_id: SubscriptionId::new("sub-1"),
            billing_account_id: BillingAccountId::new("ba-1"),
            status,
            limits: vec![Limit { resource: "api_calls".into(), quota: 100, window: "day".into() }],
        }
    }

    fn request() -> AuthorizeRequest {
        AuthorizeRequest { api_key: "gk".into(), resource: "api_calls".into(), amount: 1 }
    }

    #[tokio::test]
    async fn unauthenticated_denies_without_calling_downstream() {
        let audit = Arc::new(MockAuditAdapter::new());
        let gate = GateOrchestratorImpl::new(
            Arc::new(MockApiKeyAuthenticator::unauthenticated()),
            Arc::new(MockSubscriptionsClient::with(entitlements(SubscriptionStatus::Active))),
            Arc::new(MockMeteringClient::allowing(99)),
            audit.clone(),
        );
        let decision = gate.authorize(request()).await.unwrap();
        assert!(!decision.allowed);
        assert_eq!(decision.reason, "unauthenticated");
        assert_eq!(audit.records(), 0);
    }

    #[tokio::test]
    async fn inactive_subscription_is_forbidden_and_audited() {
        let audit = Arc::new(MockAuditAdapter::new());
        let gate = GateOrchestratorImpl::new(
            Arc::new(MockApiKeyAuthenticator::ok("sub-1")),
            Arc::new(MockSubscriptionsClient::with(entitlements(SubscriptionStatus::Canceled))),
            Arc::new(MockMeteringClient::allowing(99)),
            audit.clone(),
        );
        let decision = gate.authorize(request()).await.unwrap();
        assert_eq!(decision.reason, "forbidden");
        assert_eq!(audit.records(), 1);
    }

    #[tokio::test]
    async fn allowed_path_consumes_and_audits() {
        let audit = Arc::new(MockAuditAdapter::new());
        let gate = GateOrchestratorImpl::new(
            Arc::new(MockApiKeyAuthenticator::ok("sub-1")),
            Arc::new(MockSubscriptionsClient::with(entitlements(SubscriptionStatus::Active))),
            Arc::new(MockMeteringClient::allowing(42)),
            audit.clone(),
        );
        let decision = gate.authorize(request()).await.unwrap();
        assert!(decision.allowed);
        assert_eq!(decision.reason, "ok");
        assert_eq!(decision.remaining, 42);
        assert_eq!(audit.records(), 1);
    }

    #[tokio::test]
    async fn unknown_resource_is_forbidden() {
        let audit = Arc::new(MockAuditAdapter::new());
        let gate = GateOrchestratorImpl::new(
            Arc::new(MockApiKeyAuthenticator::ok("sub-1")),
            Arc::new(MockSubscriptionsClient::with(entitlements(SubscriptionStatus::Active))),
            Arc::new(MockMeteringClient::allowing(1)),
            audit,
        );
        let req = AuthorizeRequest { api_key: "gk".into(), resource: "unknown".into(), amount: 1 };
        let decision = gate.authorize(req).await.unwrap();
        assert_eq!(decision.reason, "forbidden");
    }
}
