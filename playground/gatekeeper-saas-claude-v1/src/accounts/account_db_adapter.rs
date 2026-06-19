//! Account Postgres Adapter (Adapter stereotype): the only block doing Postgres
//! I/O for accounts (sqlx). No domain logic — pure persistence mapping.

use async_trait::async_trait;
use sqlx::{PgPool, Row};

use crate::domain::{BillingAccountId, CustomerId, DbError, Email};

use super::model::{Account, AccountStatus, BillingAccount, Contact};

/// sqlx Postgres I/O for the account aggregate.
#[async_trait]
pub trait AccountDbAdapter: Send + Sync {
    /// Load an account aggregate (customer + billing account + contacts).
    async fn load_account(&self, id: &BillingAccountId) -> Result<Option<Account>, DbError>;
    /// Insert or update the full aggregate transactionally.
    async fn upsert_account(&self, account: &Account) -> Result<(), DbError>;
    /// Delete an account aggregate.
    async fn delete_account(&self, id: &BillingAccountId) -> Result<(), DbError>;
}

pub struct PostgresAccountDbAdapter {
    pool: PgPool,
}

impl PostgresAccountDbAdapter {
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
    }
}

#[async_trait]
impl AccountDbAdapter for PostgresAccountDbAdapter {
    async fn load_account(&self, id: &BillingAccountId) -> Result<Option<Account>, DbError> {
        // Step 1: SELECT the customer, billing account, and contacts (joins) and
        // assemble the Account aggregate.
        let ba_row = sqlx::query(
            "SELECT id, customer_id, billing_email, status FROM billing_accounts WHERE id = $1",
        )
        .bind(&id.0)
        .fetch_optional(&self.pool)
        .await?;

        let Some(ba_row) = ba_row else {
            return Ok(None);
        };
        let customer_id: String = ba_row.try_get("customer_id")?;

        let cust_row = sqlx::query(
            "SELECT id, name, status, billing_account_id, created_at FROM customers WHERE id = $1",
        )
        .bind(&customer_id)
        .fetch_one(&self.pool)
        .await?;

        let contact_rows = sqlx::query(
            "SELECT id, customer_id, email, name, role FROM contacts WHERE customer_id = $1",
        )
        .bind(&customer_id)
        .fetch_all(&self.pool)
        .await?;

        let billing_account = BillingAccount {
            id: BillingAccountId::new(ba_row.try_get::<String, _>("id")?),
            customer_id: CustomerId::new(customer_id),
            billing_email: parse_email(ba_row.try_get("billing_email")?)?,
            status: parse_status(ba_row.try_get("status")?)?,
        };
        let customer = super::model::Customer {
            id: CustomerId::new(cust_row.try_get::<String, _>("id")?),
            name: cust_row.try_get("name")?,
            status: parse_status(cust_row.try_get("status")?)?,
            billing_account_id: BillingAccountId::new(
                cust_row.try_get::<String, _>("billing_account_id")?,
            ),
            created_at: cust_row.try_get("created_at")?,
        };
        let contacts = contact_rows
            .into_iter()
            .map(|row| {
                Ok(Contact {
                    id: crate::domain::ContactId::new(row.try_get::<String, _>("id")?),
                    customer_id: CustomerId::new(row.try_get::<String, _>("customer_id")?),
                    email: parse_email(row.try_get("email")?)?,
                    name: row.try_get("name")?,
                    role: row.try_get("role")?,
                })
            })
            .collect::<Result<Vec<_>, DbError>>()?;

        Ok(Some(Account {
            customer,
            billing_account,
            contacts,
        }))
    }

    async fn upsert_account(&self, account: &Account) -> Result<(), DbError> {
        // Step 1: In a transaction, upsert the customer, billing_account, and contact rows.
        let mut tx = self.pool.begin().await?;

        sqlx::query(
            "INSERT INTO customers (id, name, status, billing_account_id, created_at) \
             VALUES ($1, $2, $3, $4, $5) \
             ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, status = EXCLUDED.status, \
             billing_account_id = EXCLUDED.billing_account_id",
        )
        .bind(&account.customer.id.0)
        .bind(&account.customer.name)
        .bind(status_as_str(account.customer.status))
        .bind(&account.customer.billing_account_id.0)
        .bind(&account.customer.created_at)
        .execute(&mut *tx)
        .await?;

        sqlx::query(
            "INSERT INTO billing_accounts (id, customer_id, billing_email, status) \
             VALUES ($1, $2, $3, $4) \
             ON CONFLICT (id) DO UPDATE SET billing_email = EXCLUDED.billing_email, \
             status = EXCLUDED.status",
        )
        .bind(&account.billing_account.id.0)
        .bind(&account.billing_account.customer_id.0)
        .bind(account.billing_account.billing_email.as_str())
        .bind(status_as_str(account.billing_account.status))
        .execute(&mut *tx)
        .await?;

        for contact in &account.contacts {
            sqlx::query(
                "INSERT INTO contacts (id, customer_id, email, name, role) \
                 VALUES ($1, $2, $3, $4, $5) \
                 ON CONFLICT (id) DO UPDATE SET email = EXCLUDED.email, name = EXCLUDED.name, \
                 role = EXCLUDED.role",
            )
            .bind(&contact.id.0)
            .bind(&contact.customer_id.0)
            .bind(contact.email.as_str())
            .bind(&contact.name)
            .bind(&contact.role)
            .execute(&mut *tx)
            .await?;
        }

        tx.commit().await?;
        Ok(())
    }

    async fn delete_account(&self, id: &BillingAccountId) -> Result<(), DbError> {
        // Step 1: In a transaction, delete the contacts, billing account, and
        // customer for the aggregate (ON DELETE CASCADE removes children).
        let mut tx = self.pool.begin().await?;
        let customer_id: Option<String> =
            sqlx::query("SELECT customer_id FROM billing_accounts WHERE id = $1")
                .bind(&id.0)
                .fetch_optional(&mut *tx)
                .await?
                .map(|row| row.try_get("customer_id"))
                .transpose()?;
        if let Some(customer_id) = customer_id {
            sqlx::query("DELETE FROM customers WHERE id = $1")
                .bind(&customer_id)
                .execute(&mut *tx)
                .await?;
        }
        tx.commit().await?;
        Ok(())
    }
}

fn status_as_str(status: AccountStatus) -> &'static str {
    match status {
        AccountStatus::Active => "Active",
        AccountStatus::Suspended => "Suspended",
        AccountStatus::Deactivated => "Deactivated",
    }
}

fn parse_status(value: String) -> Result<AccountStatus, DbError> {
    match value.as_str() {
        "Active" => Ok(AccountStatus::Active),
        "Suspended" => Ok(AccountStatus::Suspended),
        "Deactivated" => Ok(AccountStatus::Deactivated),
        other => Err(DbError::Mapping(format!("unknown account status: {other}"))),
    }
}

fn parse_email(value: String) -> Result<Email, DbError> {
    Email::parse(value).map_err(|e| DbError::Mapping(e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn status_round_trips_through_strings() {
        for status in [
            AccountStatus::Active,
            AccountStatus::Suspended,
            AccountStatus::Deactivated,
        ] {
            assert_eq!(parse_status(status_as_str(status).to_string()).unwrap(), status);
        }
    }

    #[test]
    fn unknown_status_is_mapping_error() {
        assert!(matches!(
            parse_status("bogus".into()),
            Err(DbError::Mapping(_))
        ));
    }
}
