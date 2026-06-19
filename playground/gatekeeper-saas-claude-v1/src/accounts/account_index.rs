//! Account Index (Index stereotype): read path projecting the account store.
//! Never mutates.

use std::sync::Arc;

use crate::domain::{BillingAccountId, CustomerId, Email};

use super::account_store::AccountStore;
use super::model::{Account, Customer};

/// Read projection over the account store.
pub trait AccountIndex: Send + Sync {
    /// Look up the full aggregate by billing account id.
    fn find_account(&self, id: &BillingAccountId) -> Option<Account>;
    /// Look up a customer by id.
    fn find_customer(&self, id: &CustomerId) -> Option<Customer>;
    /// Resolve the billing email for an account.
    fn resolve_billing_email(&self, id: &BillingAccountId) -> Option<Email>;
}

pub struct AccountIndexImpl {
    store: Arc<dyn AccountStore>,
}

impl AccountIndexImpl {
    pub fn new(store: Arc<dyn AccountStore>) -> Self {
        Self { store }
    }
}

impl AccountIndex for AccountIndexImpl {
    fn find_account(&self, id: &BillingAccountId) -> Option<Account> {
        // Step 1: Read the aggregate from the store by billing account id.
        let account = self.store.get(id);
        // Step 2: Return the result.
        account
    }

    fn find_customer(&self, id: &CustomerId) -> Option<Customer> {
        // Step 1: Read the aggregate by customer id.
        let account = self.store.get_by_customer(id);
        // Step 2: Extract and return the Customer, or None.
        account.map(|a| a.customer)
    }

    fn resolve_billing_email(&self, id: &BillingAccountId) -> Option<Email> {
        // Step 1: Read the aggregate by billing account id.
        let account = self.store.get(id);
        // Step 2: Return the billing_account.billing_email, or None.
        account.map(|a| a.billing_account.billing_email)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::accounts::model::{AccountStatus, BillingAccount};
    use crate::accounts::test_support::MockAccountStore;

    fn account() -> Account {
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
    fn projects_account_customer_and_email() {
        let store = Arc::new(MockAccountStore::seeded(account()));
        let index = AccountIndexImpl::new(store);
        assert!(index.find_account(&BillingAccountId::new("ba-1")).is_some());
        assert_eq!(
            index.find_customer(&CustomerId::new("cust-1")).unwrap().name,
            "Acme"
        );
        assert_eq!(
            index
                .resolve_billing_email(&BillingAccountId::new("ba-1"))
                .unwrap()
                .as_str(),
            "billing@acme.com"
        );
    }

    #[test]
    fn returns_none_for_unknown_ids() {
        let store = Arc::new(MockAccountStore::empty());
        let index = AccountIndexImpl::new(store);
        assert!(index.find_account(&BillingAccountId::new("x")).is_none());
        assert!(index.find_customer(&CustomerId::new("x")).is_none());
        assert!(index.resolve_billing_email(&BillingAccountId::new("x")).is_none());
    }
}
