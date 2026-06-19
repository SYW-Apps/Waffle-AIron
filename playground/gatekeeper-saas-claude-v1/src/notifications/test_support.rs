//! Test doubles for the notifications subsystem.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;

use async_trait::async_trait;

use crate::domain::{BillingAccountId, Email};

use super::accounts_client::AccountsClient;
use super::email_adapter::EmailAdapter;
use super::model::{NotificationError, NotificationMessage, NotificationRecord};
use super::notification_log_adapter::NotificationLogAdapter;

// --- Accounts client double ---

pub struct MockAccountsClient {
    email: Option<Email>,
}

impl MockAccountsClient {
    pub fn with_email(addr: &str) -> Self {
        Self { email: Some(Email::parse(addr).unwrap()) }
    }
    pub fn without_email() -> Self {
        Self { email: None }
    }
}

#[async_trait]
impl AccountsClient for MockAccountsClient {
    async fn resolve_billing_email(
        &self,
        _id: &BillingAccountId,
    ) -> Result<Option<Email>, NotificationError> {
        Ok(self.email.clone())
    }
}

// --- Email adapter double ---

pub struct MockEmailAdapter {
    fail: bool,
    sent: AtomicUsize,
}

impl MockEmailAdapter {
    pub fn ok() -> Self {
        Self { fail: false, sent: AtomicUsize::new(0) }
    }
    pub fn failing() -> Self {
        Self { fail: true, sent: AtomicUsize::new(0) }
    }
    pub fn sent(&self) -> usize {
        self.sent.load(Ordering::SeqCst)
    }
}

#[async_trait]
impl EmailAdapter for MockEmailAdapter {
    async fn send(&self, _message: NotificationMessage) -> Result<(), NotificationError> {
        if self.fail {
            return Err(NotificationError::SendFailure("mock".into()));
        }
        self.sent.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }
}

// --- Notification log adapter double ---

pub struct MockNotificationLogAdapter {
    last_status: Mutex<Option<String>>,
}

impl MockNotificationLogAdapter {
    pub fn new() -> Self {
        Self { last_status: Mutex::new(None) }
    }
    pub fn last_status(&self) -> Option<String> {
        self.last_status.lock().unwrap().clone()
    }
}

impl Default for MockNotificationLogAdapter {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl NotificationLogAdapter for MockNotificationLogAdapter {
    async fn record_sent(&self, record: NotificationRecord) -> Result<(), NotificationError> {
        *self.last_status.lock().unwrap() = Some(record.status);
        Ok(())
    }
}
