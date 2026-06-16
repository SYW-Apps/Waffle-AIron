use sqlx::{PgPool, pool::PoolConnection, Postgres, postgres::PgPoolOptions};
use tokio::sync::OnceCell;

#[async_trait::async_trait]
pub trait INotifierStore: Send + Sync {
    async fn get_connection(&self) -> Result<PoolConnection<Postgres>, sqlx::Error>;
}

pub struct NotifierStore {
    pool: OnceCell<PgPool>,
    database_url: String,
}

impl NotifierStore {
    pub fn new(database_url: String) -> Self {
        Self {
            pool: OnceCell::new(),
            database_url,
        }
    }
}

#[async_trait::async_trait]
impl INotifierStore for NotifierStore {
    async fn get_connection(&self) -> Result<PoolConnection<Postgres>, sqlx::Error> {
        // Step 1: Verify pool state; initialize database connection if inactive.
        let pool = self.pool.get_or_try_init(|| async {
            PgPoolOptions::new()
                .max_connections(5)
                .connect(&self.database_url)
                .await
        }).await?;

        // Step 2: Return connection client.
        let conn = pool.acquire().await?;
        Ok(conn)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_store_initialization() {
        let store = NotifierStore::new("postgres://localhost/test_db".to_string());
        assert!(store.pool.get().is_none());
    }

    #[tokio::test]
    async fn test_get_connection_invalid_url() {
        let store = NotifierStore::new("postgres://invalid_user:invalid_pass@invalid_host:5432/invalid_db".to_string());
        let result = store.get_connection().await;
        assert!(result.is_err());
    }
}
