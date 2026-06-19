//! Stripe Adapter (Adapter stereotype): the only block doing Stripe I/O. Manages
//! customers and subscriptions via the Stripe REST API and verifies/parses
//! webhook signatures (HMAC-SHA256, the scheme Stripe uses for `Stripe-Signature`).
//! Performs no domain logic.

use async_trait::async_trait;
use hmac::{Hmac, Mac};
use sha2::Sha256;

use crate::domain::{Email, StripeError};

use super::model::{StripeCustomerRef, StripeEvent, StripeSubscriptionRef, SubscriptionStatus};

type HmacSha256 = Hmac<Sha256>;

#[async_trait]
pub trait StripeAdapter: Send + Sync {
    async fn create_customer(&self, email: Email) -> Result<StripeCustomerRef, StripeError>;
    async fn create_subscription(
        &self,
        stripe_customer_id: String,
        price_id: String,
    ) -> Result<StripeSubscriptionRef, StripeError>;
    async fn update_subscription(
        &self,
        stripe_subscription_id: String,
        price_id: String,
    ) -> Result<StripeSubscriptionRef, StripeError>;
    async fn cancel_subscription(
        &self,
        stripe_subscription_id: String,
    ) -> Result<(), StripeError>;
    fn verify_and_parse_event(
        &self,
        raw_body: Vec<u8>,
        signature: String,
    ) -> Result<StripeEvent, StripeError>;
}

pub struct StripeHttpAdapter {
    api_key: String,
    signing_secret: String,
    base_url: String,
    http: reqwest::Client,
}

impl StripeHttpAdapter {
    pub fn new(api_key: String, signing_secret: String) -> Self {
        Self::with_base_url(api_key, signing_secret, "https://api.stripe.com".to_string())
    }

    pub fn with_base_url(api_key: String, signing_secret: String, base_url: String) -> Self {
        Self {
            api_key,
            signing_secret,
            base_url,
            http: reqwest::Client::new(),
        }
    }

    async fn post_form(
        &self,
        path: &str,
        form: &[(&str, &str)],
    ) -> Result<serde_json::Value, StripeError> {
        let response = self
            .http
            .post(format!("{}{path}", self.base_url))
            .bearer_auth(&self.api_key)
            .form(form)
            .send()
            .await
            .map_err(map_reqwest)?;
        parse_json(response).await
    }
}

fn map_reqwest(err: reqwest::Error) -> StripeError {
    StripeError::Api(err.to_string())
}

async fn parse_json(response: reqwest::Response) -> Result<serde_json::Value, StripeError> {
    let status = response.status();
    let text = response.text().await.map_err(map_reqwest)?;
    if status.as_u16() == 429 {
        return Err(StripeError::RateLimited(text));
    }
    if !status.is_success() {
        return Err(StripeError::Api(format!("{status}: {text}")));
    }
    serde_json::from_str(&text).map_err(|e| StripeError::Parse(e.to_string()))
}

/// Map a Stripe subscription JSON object into our typed reference.
fn map_subscription_ref(value: &serde_json::Value) -> Result<StripeSubscriptionRef, StripeError> {
    let id = value
        .get("id")
        .and_then(|v| v.as_str())
        .ok_or_else(|| StripeError::Parse("missing subscription id".into()))?;
    let status = value
        .get("status")
        .and_then(|v| v.as_str())
        .unwrap_or("incomplete");
    let period_end = value
        .get("current_period_end")
        .and_then(|v| v.as_i64())
        .unwrap_or(0);
    Ok(StripeSubscriptionRef {
        stripe_subscription_id: id.to_string(),
        status: SubscriptionStatus::from_stripe(status),
        current_period_end: unix_to_rfc3339(period_end),
    })
}

fn unix_to_rfc3339(secs: i64) -> String {
    chrono::DateTime::from_timestamp(secs, 0)
        .unwrap_or_else(|| chrono::DateTime::from_timestamp(0, 0).unwrap())
        .to_rfc3339()
}

#[async_trait]
impl StripeAdapter for StripeHttpAdapter {
    async fn create_customer(&self, email: Email) -> Result<StripeCustomerRef, StripeError> {
        // Step 1: Call Stripe Customers create with the billing email; map into StripeCustomerRef.
        let json = self.post_form("/v1/customers", &[("email", email.as_str())]).await?;
        let id = json
            .get("id")
            .and_then(|v| v.as_str())
            .ok_or_else(|| StripeError::Parse("missing customer id".into()))?;
        Ok(StripeCustomerRef {
            stripe_customer_id: id.to_string(),
        })
    }

    async fn create_subscription(
        &self,
        stripe_customer_id: String,
        price_id: String,
    ) -> Result<StripeSubscriptionRef, StripeError> {
        // Step 1: Call Stripe Subscriptions create with the customer id and price id; map the result.
        let json = self
            .post_form(
                "/v1/subscriptions",
                &[("customer", &stripe_customer_id), ("items[0][price]", &price_id)],
            )
            .await?;
        map_subscription_ref(&json)
    }

    async fn update_subscription(
        &self,
        stripe_subscription_id: String,
        price_id: String,
    ) -> Result<StripeSubscriptionRef, StripeError> {
        // Step 1: Swap the subscription item to the new price; map into StripeSubscriptionRef.
        // Resolve the current first item id so the swap replaces (not appends) the price.
        let current = self
            .http
            .get(format!("{}/v1/subscriptions/{stripe_subscription_id}", self.base_url))
            .bearer_auth(&self.api_key)
            .send()
            .await
            .map_err(map_reqwest)?;
        let current = parse_json(current).await?;
        let item_id = current
            .pointer("/items/data/0/id")
            .and_then(|v| v.as_str())
            .ok_or_else(|| StripeError::Parse("missing subscription item id".into()))?;
        let json = self
            .post_form(
                &format!("/v1/subscriptions/{stripe_subscription_id}"),
                &[("items[0][id]", item_id), ("items[0][price]", &price_id)],
            )
            .await?;
        map_subscription_ref(&json)
    }

    async fn cancel_subscription(
        &self,
        stripe_subscription_id: String,
    ) -> Result<(), StripeError> {
        // Step 1: Call Stripe Subscriptions cancel for the subscription id.
        let response = self
            .http
            .delete(format!("{}/v1/subscriptions/{stripe_subscription_id}", self.base_url))
            .bearer_auth(&self.api_key)
            .send()
            .await
            .map_err(map_reqwest)?;
        parse_json(response).await.map(|_| ())
    }

    fn verify_and_parse_event(
        &self,
        raw_body: Vec<u8>,
        signature: String,
    ) -> Result<StripeEvent, StripeError> {
        // Step 1: Verify the webhook HMAC signature against the configured signing secret.
        verify_signature(&self.signing_secret, &raw_body, &signature)?;
        // Step 2: Parse the verified payload into a typed StripeEvent {id, kind, payload}.
        let body = String::from_utf8(raw_body).map_err(|e| StripeError::Parse(e.to_string()))?;
        let value: serde_json::Value =
            serde_json::from_str(&body).map_err(|e| StripeError::Parse(e.to_string()))?;
        let id = value
            .get("id")
            .and_then(|v| v.as_str())
            .ok_or_else(|| StripeError::Parse("missing event id".into()))?;
        let kind = value
            .get("type")
            .and_then(|v| v.as_str())
            .ok_or_else(|| StripeError::Parse("missing event type".into()))?;
        Ok(StripeEvent {
            id: id.to_string(),
            kind: kind.to_string(),
            payload: body,
        })
    }
}

/// Verify a `Stripe-Signature` header (`t=<ts>,v1=<hex hmac>`) over `t.body`.
fn verify_signature(secret: &str, body: &[u8], header: &str) -> Result<(), StripeError> {
    let (timestamp, expected) = parse_signature_header(header)?;
    let mut mac = HmacSha256::new_from_slice(secret.as_bytes())
        .map_err(|e| StripeError::InvalidSignature(e.to_string()))?;
    mac.update(timestamp.as_bytes());
    mac.update(b".");
    mac.update(body);
    let computed = hex::encode(mac.finalize().into_bytes());
    if constant_time_eq(computed.as_bytes(), expected.as_bytes()) {
        Ok(())
    } else {
        Err(StripeError::InvalidSignature("signature mismatch".into()))
    }
}

fn parse_signature_header(header: &str) -> Result<(String, String), StripeError> {
    let mut timestamp = None;
    let mut v1 = None;
    for part in header.split(',') {
        let mut kv = part.splitn(2, '=');
        match (kv.next(), kv.next()) {
            (Some("t"), Some(value)) => timestamp = Some(value.trim().to_string()),
            (Some("v1"), Some(value)) => v1 = Some(value.trim().to_string()),
            _ => {}
        }
    }
    match (timestamp, v1) {
        (Some(t), Some(v)) => Ok((t, v)),
        _ => Err(StripeError::InvalidSignature(
            "malformed Stripe-Signature header".into(),
        )),
    }
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

#[cfg(test)]
mod tests {
    use super::*;

    fn signed_header(secret: &str, ts: &str, body: &[u8]) -> String {
        let mut mac = HmacSha256::new_from_slice(secret.as_bytes()).unwrap();
        mac.update(ts.as_bytes());
        mac.update(b".");
        mac.update(body);
        let sig = hex::encode(mac.finalize().into_bytes());
        format!("t={ts},v1={sig}")
    }

    fn adapter() -> StripeHttpAdapter {
        StripeHttpAdapter::new("sk_test".into(), "whsec_test".into())
    }

    #[test]
    fn verifies_and_parses_valid_event() {
        let body = br#"{"id":"evt_1","type":"customer.subscription.updated"}"#.to_vec();
        let header = signed_header("whsec_test", "1718000000", &body);
        let event = adapter().verify_and_parse_event(body, header).unwrap();
        assert_eq!(event.id, "evt_1");
        assert_eq!(event.kind, "customer.subscription.updated");
    }

    #[test]
    fn rejects_tampered_signature() {
        let body = br#"{"id":"evt_1","type":"x"}"#.to_vec();
        let header = signed_header("whsec_test", "1718000000", b"different");
        let err = adapter().verify_and_parse_event(body, header).unwrap_err();
        assert!(matches!(err, StripeError::InvalidSignature(_)));
    }

    #[test]
    fn rejects_malformed_header() {
        let err = adapter()
            .verify_and_parse_event(b"{}".to_vec(), "garbage".into())
            .unwrap_err();
        assert!(matches!(err, StripeError::InvalidSignature(_)));
    }
}
