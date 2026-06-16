use crate::models::DbError;
use async_trait::async_trait;
use sqlx::{PgPool, Row, Column};
use serde_json::Value;

#[async_trait]
pub trait DatabaseAdapter {
    async fn execute_query(&self, query: String, params: Vec<String>) -> Result<u64, DbError>;
    async fn fetch_row(&self, query: String, params: Vec<String>) -> Result<Option<String>, DbError>;
}

pub struct DatabaseAdapterImpl {
    pool: PgPool,
}

impl DatabaseAdapterImpl {
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
    }
}

#[async_trait]
impl DatabaseAdapter for DatabaseAdapterImpl {
    async fn execute_query(&self, query: String, params: Vec<String>) -> Result<u64, DbError> {
        // Step 1: Acquire a database connection from the SQLx connection pool
        // Step 2: Execute SQL query mapping query parameters
        let mut sql_query = sqlx::query(&query);
        for param in &params {
            sql_query = sql_query.bind(param);
        }
        let result = sql_query.execute(&self.pool).await
            .map_err(|e| DbError::QueryError(e.to_string()))?;

        // Step 3: Return number of rows affected
        Ok(result.rows_affected())
    }

    async fn fetch_row(&self, query: String, params: Vec<String>) -> Result<Option<String>, DbError> {
        // Step 1: Acquire a database connection from the SQLx connection pool
        // Step 2: Execute SQL select query mapping parameters
        let mut sql_query = sqlx::query(&query);
        for param in &params {
            sql_query = sql_query.bind(param);
        }

        let row_opt = sql_query.fetch_optional(&self.pool).await
            .map_err(|e| DbError::QueryError(e.to_string()))?;

        // Step 3: Serialize row data into JSON string and return Option
        match row_opt {
            Some(row) => {
                let mut map = serde_json::Map::new();
                for column in row.columns() {
                    let col_name = column.name();
                    let value = if let Ok(val) = row.try_get::<String, _>(col_name) {
                        Value::String(val)
                    } else if let Ok(val) = row.try_get::<i64, _>(col_name) {
                        Value::Number(val.into())
                    } else if let Ok(val) = row.try_get::<i32, _>(col_name) {
                        Value::Number(val.into())
                    } else if let Ok(val) = row.try_get::<bool, _>(col_name) {
                        Value::Bool(val)
                    } else if let Ok(val) = row.try_get::<uuid::Uuid, _>(col_name) {
                        Value::String(val.to_string())
                    } else if let Ok(val) = row.try_get::<chrono::NaiveDateTime, _>(col_name) {
                        Value::String(val.to_string())
                    } else if let Ok(val) = row.try_get::<f64, _>(col_name) {
                        if let Some(num) = serde_json::Number::from_f64(val) {
                            Value::Number(num)
                        } else {
                            Value::Null
                        }
                    } else {
                        Value::Null
                    };
                    map.insert(col_name.to_string(), value);
                }
                let json_str = serde_json::to_string(&Value::Object(map))
                    .map_err(|e| DbError::QueryError(e.to_string()))?;
                Ok(Some(json_str))
            }
            None => Ok(None),
        }
    }
}
