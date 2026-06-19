//! Account Store (Store stereotype): authoritative in-memory state for the
//! Account aggregate with a customer-id secondary index. Reads are wait-free via
//! an atomic snapshot swap; writes are serialized by a mutex and published with
//! copy-on-write (the write-lock / read-swap hybrid).

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use arc_swap::ArcSwap;

use crate::domain::{BillingAccountId, CustomerId, Email};

use super::model::{Account, AccountStatus};

/// Authoritative in-process state boundary for the Account aggregate.
pub trait AccountStore: Send + Sync {
    /// Insert or replace an account aggregate.
    fn insert(&self, account: Account);
    /// Get aggregate by billing account id.
    fn get(&self, id: &BillingAccountId) -> Option<Account>;
    /// Get aggregate by customer id.
    fn get_by_customer(&self, id: &CustomerId) -> Option<Account>;
    /// Mutate billing email; returns false if not present.
    fn apply_billing_email(&self, id: &BillingAccountId, email: Email) -> bool;
    /// Mutate status; returns false if not present.
    fn set_status(&self, id: &BillingAccountId, status: AccountStatus) -> bool;
}

#[derive(Default)]
struct State {
    by_billing: HashMap<String, Account>,
    customer_to_billing: HashMap<String, String>,
}

/// In-memory account aggregate state.
pub struct InMemoryAccountStore {
    snapshot: ArcSwap<State>,
    write_lock: Mutex<()>,
}

impl Default for InMemoryAccountStore {
    fn default() -> Self {
        Self {
            snapshot: ArcSwap::from_pointee(State::default()),
            write_lock: Mutex::new(()),
        }
    }
}

impl InMemoryAccountStore {
    pub fn new() -> Self {
        Self::default()
    }

    /// Serialize a write: clone the current state, let the caller mutate it,
    /// then publish the new snapshot atomically.
    fn mutate<R>(&self, f: impl FnOnce(&mut State) -> R) -> R {
        let _guard = self.write_lock.lock().expect("account store write lock");
        let mut next = State {
            by_billing: self.snapshot.load().by_billing.clone(),
            customer_to_billing: self.snapshot.load().customer_to_billing.clone(),
        };
        let result = f(&mut next);
        self.snapshot.store(Arc::new(next));
        result
    }
}

impl AccountStore for InMemoryAccountStore {
    fn insert(&self, account: Account) {
        // Step 1: Insert or replace the aggregate in the billing-account-id map
        // and update the customer-id secondary index.
        self.mutate(|state| {
            let billing_id = account.billing_account.id.0.clone();
            let customer_id = account.customer.id.0.clone();
            state.customer_to_billing.insert(customer_id, billing_id.clone());
            state.by_billing.insert(billing_id, account);
        });
    }

    fn get(&self, id: &BillingAccountId) -> Option<Account> {
        // Step 1: Return a clone of the aggregate for the billing account id if present.
        self.snapshot.load().by_billing.get(&id.0).cloned()
    }

    fn get_by_customer(&self, id: &CustomerId) -> Option<Account> {
        // Step 1: Resolve the billing account id via the customer secondary index
        // and return a clone if present.
        let snapshot = self.snapshot.load();
        let billing_id = snapshot.customer_to_billing.get(&id.0)?;
        snapshot.by_billing.get(billing_id).cloned()
    }

    fn apply_billing_email(&self, id: &BillingAccountId, email: Email) -> bool {
        // Step 1: If present, mutate the billing_account.billing_email and return true, else false.
        self.mutate(|state| match state.by_billing.get_mut(&id.0) {
            Some(account) => {
                account.billing_account.billing_email = email;
                true
            }
            None => false,
        })
    }

    fn set_status(&self, id: &BillingAccountId, status: AccountStatus) -> bool {
        // Step 1: If present, mutate the status (customer + billing account) and return true, else false.
        self.mutate(|state| match state.by_billing.get_mut(&id.0) {
            Some(account) => {
                account.customer.status = status;
                account.billing_account.status = status;
                true
            }
            None => false,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::accounts::model::{BillingAccount, Customer};

    fn sample_account() -> Account {
        Account {
            customer: Customer {
                id: CustomerId::new("cust-1"),
                name: "Acme".into(),
                status: AccountStatus::Active,
                billing_account_id: BillingAccountId::new("ba-1"),
                created_at: "2026-01-01T00:00:00Z".into(),
            },
            billing_account: BillingAccount {
                id: BillingAccountId::new("ba-1"),
                customer_id: CustomerId::new("cust-1"),
                billing_email: Email::parse("billing@acme.com").unwrap(),
                status: AccountStatus::Active,
            },
            contacts: vec![],
        }
    }

    #[test]
    fn insert_then_get_by_both_keys() {
        let store = InMemoryAccountStore::new();
        store.insert(sample_account());
        assert!(store.get(&BillingAccountId::new("ba-1")).is_some());
        assert!(store.get_by_customer(&CustomerId::new("cust-1")).is_some());
        assert!(store.get(&BillingAccountId::new("missing")).is_none());
    }

    #[test]
    fn apply_billing_email_updates_or_reports_absent() {
        let store = InMemoryAccountStore::new();
        store.insert(sample_account());
        let new_email = Email::parse("new@acme.com").unwrap();
        assert!(store.apply_billing_email(&BillingAccountId::new("ba-1"), new_email.clone()));
        let got = store.get(&BillingAccountId::new("ba-1")).unwrap();
        assert_eq!(got.billing_account.billing_email, new_email);
        assert!(!store.apply_billing_email(&BillingAccountId::new("missing"), new_email));
    }

    #[test]
    fn set_status_updates_customer_and_billing() {
        let store = InMemoryAccountStore::new();
        store.insert(sample_account());
        assert!(store.set_status(&BillingAccountId::new("ba-1"), AccountStatus::Deactivated));
        let got = store.get(&BillingAccountId::new("ba-1")).unwrap();
        assert_eq!(got.customer.status, AccountStatus::Deactivated);
        assert_eq!(got.billing_account.status, AccountStatus::Deactivated);
        assert!(!store.set_status(&BillingAccountId::new("missing"), AccountStatus::Active));
    }
}
