//! Test doubles for the accounts subsystem. Each mock implements one L2
//! component's L3 interface so a unit under test can be exercised in isolation
//! with its direct dependencies stubbed.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;

use async_trait::async_trait;

use crate::domain::{BillingAccountId, CustomerId, DbError, Email};

use super::account_db_adapter::AccountDbAdapter;
use super::account_directory::AccountDirectory;
use super::account_index::AccountIndex;
use super::account_orchestrator::AccountOrchestrator;
use super::account_registry::AccountRegistry;
use super::account_repository::AccountRepository;
use super::account_store::{AccountStore, InMemoryAccountStore};
use super::model::{
    Account, AccountError, AccountStatus, BillingAccount, Contact, CreateAccountCommand, Customer,
};

// --- Store double (delegates to the real in-memory store for fidelity) ---

pub struct MockAccountStore {
    inner: InMemoryAccountStore,
}

impl MockAccountStore {
    pub fn empty() -> Self {
        Self {
            inner: InMemoryAccountStore::new(),
        }
    }

    pub fn seeded(account: Account) -> Self {
        let store = Self::empty();
        store.inner.insert(account);
        store
    }
}

impl AccountStore for MockAccountStore {
    fn insert(&self, account: Account) {
        self.inner.insert(account)
    }
    fn get(&self, id: &BillingAccountId) -> Option<Account> {
        self.inner.get(id)
    }
    fn get_by_customer(&self, id: &CustomerId) -> Option<Account> {
        self.inner.get_by_customer(id)
    }
    fn apply_billing_email(&self, id: &BillingAccountId, email: Email) -> bool {
        self.inner.apply_billing_email(id, email)
    }
    fn set_status(&self, id: &BillingAccountId, status: AccountStatus) -> bool {
        self.inner.set_status(id, status)
    }
}

// --- Db adapter double ---

pub struct MockAccountDbAdapter {
    fail: bool,
    upserts: AtomicUsize,
}

impl MockAccountDbAdapter {
    pub fn ok() -> Self {
        Self {
            fail: false,
            upserts: AtomicUsize::new(0),
        }
    }
    pub fn failing() -> Self {
        Self {
            fail: true,
            upserts: AtomicUsize::new(0),
        }
    }
    pub fn upsert_calls(&self) -> usize {
        self.upserts.load(Ordering::SeqCst)
    }
}

#[async_trait]
impl AccountDbAdapter for MockAccountDbAdapter {
    async fn load_account(&self, _id: &BillingAccountId) -> Result<Option<Account>, DbError> {
        Ok(None)
    }
    async fn upsert_account(&self, _account: &Account) -> Result<(), DbError> {
        if self.fail {
            return Err(DbError::Query("mock upsert failure".into()));
        }
        self.upserts.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }
    async fn delete_account(&self, _id: &BillingAccountId) -> Result<(), DbError> {
        Ok(())
    }
}

// --- Registry double ---

pub struct MockAccountRegistry {
    set_status_calls: AtomicUsize,
}

impl MockAccountRegistry {
    pub fn ok() -> Self {
        Self {
            set_status_calls: AtomicUsize::new(0),
        }
    }
    pub fn set_status_calls(&self) -> usize {
        self.set_status_calls.load(Ordering::SeqCst)
    }
}

#[async_trait]
impl AccountRegistry for MockAccountRegistry {
    async fn create_account(&self, _account: Account) -> Result<(), AccountError> {
        Ok(())
    }
    async fn update_billing_email(
        &self,
        _id: &BillingAccountId,
        _email: Email,
    ) -> Result<(), AccountError> {
        Ok(())
    }
    async fn set_status(
        &self,
        _id: &BillingAccountId,
        _status: AccountStatus,
    ) -> Result<(), AccountError> {
        self.set_status_calls.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }
}

// --- Index double ---

pub struct MockAccountIndex;

impl MockAccountIndex {
    pub fn empty() -> Self {
        Self
    }
}

impl AccountIndex for MockAccountIndex {
    fn find_account(&self, _id: &BillingAccountId) -> Option<Account> {
        None
    }
    fn find_customer(&self, _id: &CustomerId) -> Option<Customer> {
        None
    }
    fn resolve_billing_email(&self, _id: &BillingAccountId) -> Option<Email> {
        None
    }
}

// --- Repository double ---

pub struct MockAccountRepository {
    email: Option<Email>,
    saved: AtomicUsize,
    last_status: Mutex<Option<AccountStatus>>,
}

impl MockAccountRepository {
    pub fn empty() -> Self {
        Self {
            email: None,
            saved: AtomicUsize::new(0),
            last_status: Mutex::new(None),
        }
    }
    pub fn with_email(email: Email) -> Self {
        Self {
            email: Some(email),
            saved: AtomicUsize::new(0),
            last_status: Mutex::new(None),
        }
    }
    pub fn saved_count(&self) -> usize {
        self.saved.load(Ordering::SeqCst)
    }
    pub fn last_status(&self) -> Option<AccountStatus> {
        *self.last_status.lock().unwrap()
    }
}

#[async_trait]
impl AccountRepository for MockAccountRepository {
    async fn save_account(&self, _account: Account) -> Result<(), AccountError> {
        self.saved.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }
    async fn update_billing_email(
        &self,
        _id: &BillingAccountId,
        _email: Email,
    ) -> Result<(), AccountError> {
        Ok(())
    }
    async fn set_status(
        &self,
        _id: &BillingAccountId,
        status: AccountStatus,
    ) -> Result<(), AccountError> {
        *self.last_status.lock().unwrap() = Some(status);
        Ok(())
    }
    async fn find_account(
        &self,
        _id: &BillingAccountId,
    ) -> Result<Option<Account>, AccountError> {
        Ok(None)
    }
    async fn find_customer(&self, _id: &CustomerId) -> Result<Option<Customer>, AccountError> {
        Ok(None)
    }
    async fn resolve_billing_email(
        &self,
        _id: &BillingAccountId,
    ) -> Result<Option<Email>, AccountError> {
        Ok(self.email.clone())
    }
}

// --- Directory double (for portal tests / cross-subsystem clients) ---

pub struct MockAccountDirectory {
    email: Option<Email>,
}

impl MockAccountDirectory {
    pub fn empty() -> Self {
        Self { email: None }
    }
    pub fn with_email(addr: &str) -> Self {
        Self { email: Some(Email::parse(addr).unwrap()) }
    }
}

#[async_trait]
impl AccountDirectory for MockAccountDirectory {
    async fn resolve_billing_email(
        &self,
        _id: &BillingAccountId,
    ) -> Result<Option<Email>, AccountError> {
        Ok(self.email.clone())
    }
}

// --- Orchestrator double ---

#[derive(Default)]
pub struct MockAccountOrchestrator;

#[async_trait]
impl AccountOrchestrator for MockAccountOrchestrator {
    async fn create_account(&self, cmd: CreateAccountCommand) -> Result<Account, AccountError> {
        let customer_id = CustomerId::new("cust-mock");
        let billing_account_id = BillingAccountId::new("ba-mock");
        Ok(Account {
            customer: Customer {
                id: customer_id.clone(),
                name: cmd.name,
                status: AccountStatus::Active,
                billing_account_id: billing_account_id.clone(),
                created_at: "2026-01-01T00:00:00Z".into(),
            },
            billing_account: BillingAccount {
                id: billing_account_id,
                customer_id: customer_id.clone(),
                billing_email: cmd.billing_email,
                status: AccountStatus::Active,
            },
            contacts: cmd
                .contacts
                .into_iter()
                .map(|d| Contact {
                    id: crate::domain::ContactId::new("c-mock"),
                    customer_id: customer_id.clone(),
                    email: d.email,
                    name: d.name,
                    role: d.role,
                })
                .collect(),
        })
    }
    async fn get_account(&self, id: &BillingAccountId) -> Result<Account, AccountError> {
        Err(AccountError::NotFound(id.to_string()))
    }
    async fn get_customer(&self, id: &CustomerId) -> Result<Customer, AccountError> {
        Err(AccountError::NotFound(id.to_string()))
    }
    async fn update_billing_email(
        &self,
        id: &BillingAccountId,
        _email: Email,
    ) -> Result<Account, AccountError> {
        Err(AccountError::NotFound(id.to_string()))
    }
    async fn deactivate_account(&self, _id: &BillingAccountId) -> Result<(), AccountError> {
        Ok(())
    }
}
