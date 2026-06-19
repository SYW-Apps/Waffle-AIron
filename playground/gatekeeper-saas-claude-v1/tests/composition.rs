//! System-level composition tests. All five subsystems are wired together with
//! their real types; only the external I/O boundaries (Postgres/Redis/Stripe/
//! email) are faked. These validate the end-to-end control plane: account →
//! plan → subscription → API key → authorize → quota enforcement → usage
//! threshold → billing notification, plus the HTTP surface.

mod common;

use common::{
    build_system, email, single_tier_plan, AnyError, CreateAccountCommand,
    CreateSubscriptionCommand, PlanId, TierId,
};

use gatekeeper_saas::gatekeeping::model::AuthorizeRequest;

/// Run the standard provisioning chain and return (billing_account_id, subscription_id, api key plaintext).
async fn provision(sys: &common::System, quota: i64) -> Result<(String, String, String), AnyError> {
    let account = sys
        .accounts
        .create_account(CreateAccountCommand {
            name: "Acme".into(),
            billing_email: email("billing@acme.com"),
            contacts: vec![],
        })
        .await?;
    let billing_account_id = account.billing_account.id.clone();

    sys.plans
        .create_plan(single_tier_plan("plan-1", "tier-1", "api_calls", quota))
        .await?;

    let sub = sys
        .subscriptions
        .create_subscription(CreateSubscriptionCommand {
            billing_account_id: billing_account_id.clone(),
            plan_id: PlanId::new("plan-1"),
            tier_id: TierId::new("tier-1"),
        })
        .await?;

    let issued = sys.credentials.issue_key(sub.id.clone()).await?;
    Ok((billing_account_id.0, sub.id.0, issued.plaintext))
}

fn authorize_req(key: &str) -> AuthorizeRequest {
    AuthorizeRequest { api_key: key.to_string(), resource: "api_calls".into(), amount: 1 }
}

#[tokio::test]
async fn full_lifecycle_allows_within_quota_then_denies() -> Result<(), AnyError> {
    let sys = build_system();
    let (_ba, _sub, key) = provision(&sys, 2).await?;

    let d1 = sys.gate.authorize(authorize_req(&key)).await?;
    let d2 = sys.gate.authorize(authorize_req(&key)).await?;
    let d3 = sys.gate.authorize(authorize_req(&key)).await?;

    assert!(d1.allowed && d1.reason == "ok");
    assert!(d2.allowed, "second call within quota should be allowed");
    assert!(!d3.allowed, "third call exceeds quota of 2");
    assert_eq!(d3.reason, "over_quota");
    // Every authenticated decision is audited (3 here).
    assert_eq!(sys.audit.count(), 3);
    Ok(())
}

#[tokio::test]
async fn unauthenticated_key_is_denied_and_not_audited() -> Result<(), AnyError> {
    let sys = build_system();
    let _ = provision(&sys, 5).await?;

    let decision = sys.gate.authorize(authorize_req("not-a-real-key")).await?;
    assert!(!decision.allowed);
    assert_eq!(decision.reason, "unauthenticated");
    assert_eq!(sys.audit.count(), 0, "unauthenticated path must not audit");
    Ok(())
}

#[tokio::test]
async fn crossing_threshold_publishes_and_notifies_billing_email() -> Result<(), AnyError> {
    let sys = build_system();
    let (_ba, _sub, key) = provision(&sys, 2).await?;

    // Subscribe before generating traffic so we observe the published events.
    let mut rx = sys.bus.subscribe();

    // Two calls take usage from 0 -> 2 (=100% of quota), crossing the 80% and 100% boundaries.
    sys.gate.authorize(authorize_req(&key)).await?;
    sys.gate.authorize(authorize_req(&key)).await?;

    // Drain published usage.threshold events through the real notifications observer.
    let mut delivered = 0;
    while let Ok(event) = rx.try_recv() {
        sys.observer.on_usage_threshold(event).await?;
        delivered += 1;
    }

    assert!(delivered >= 1, "at least one threshold event should be published");
    assert_eq!(sys.email.sent(), delivered, "every event dispatches an email");
    assert_eq!(
        sys.email.last_to().as_deref(),
        Some("billing@acme.com"),
        "notification resolves the account's billing email via the accounts directory"
    );
    assert_eq!(sys.notif_log.last_status().as_deref(), Some("sent"));
    Ok(())
}

#[tokio::test]
async fn authorize_over_http_returns_200_allow() -> Result<(), AnyError> {
    use axum::body::Body;
    use axum::http::Request;
    use tower::ServiceExt;

    let sys = build_system();
    let (_ba, _sub, key) = provision(&sys, 5).await?;
    let app = sys.gatekeeping_router();

    let body = serde_json::json!({ "api_key": key, "resource": "api_calls", "amount": 1 });
    let response = app
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

    assert_eq!(response.status(), 200);
    let bytes = axum::body::to_bytes(response.into_body(), usize::MAX).await.unwrap();
    let decision: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(decision["allowed"], serde_json::Value::Bool(true));
    assert_eq!(decision["reason"], "ok");
    Ok(())
}

#[tokio::test]
async fn revoked_key_no_longer_authenticates() -> Result<(), AnyError> {
    let sys = build_system();
    let account = sys
        .accounts
        .create_account(CreateAccountCommand {
            name: "Acme".into(),
            billing_email: email("billing@acme.com"),
            contacts: vec![],
        })
        .await?;
    sys.plans
        .create_plan(single_tier_plan("plan-1", "tier-1", "api_calls", 10))
        .await?;
    let sub = sys
        .subscriptions
        .create_subscription(CreateSubscriptionCommand {
            billing_account_id: account.billing_account.id.clone(),
            plan_id: PlanId::new("plan-1"),
            tier_id: TierId::new("tier-1"),
        })
        .await?;
    let issued = sys.credentials.issue_key(sub.id.clone()).await?;

    assert!(sys.gate.authorize(authorize_req(&issued.plaintext)).await?.allowed);

    sys.credentials.revoke_key(issued.id.clone()).await?;
    let after = sys.gate.authorize(authorize_req(&issued.plaintext)).await?;
    assert!(!after.allowed);
    assert_eq!(after.reason, "unauthenticated");
    Ok(())
}
