//! Composition root / process entrypoint. Builds every subsystem over shared
//! infrastructure (Postgres pool, Redis pool, in-process usage.threshold bus) and
//! serves the merged HTTP surface. Background tasks (usage reconciler, notification
//! consumer) are spawned here.

use std::net::SocketAddr;

use gatekeeper_saas::accounts::AccountsSubsystem;
use gatekeeper_saas::gatekeeping::GatekeepingSubsystem;
use gatekeeper_saas::metering::MeteringSubsystem;
use gatekeeper_saas::notifications::NotificationsSubsystem;
use gatekeeper_saas::subscriptions::{StripeConfig, SubscriptionsSubsystem};
use gatekeeper_saas::notifications::email_adapter::EmailProviderConfig;
use sqlx::postgres::PgPoolOptions;
use tokio::sync::broadcast;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let database_url = std::env::var("DATABASE_URL")
        .unwrap_or_else(|_| "postgres://localhost/gatekeeper".to_string());
    let pool = PgPoolOptions::new()
        .max_connections(16)
        .connect(&database_url)
        .await?;

    let redis_url =
        std::env::var("REDIS_URL").unwrap_or_else(|_| "redis://127.0.0.1:6379".to_string());
    let redis_pool = deadpool_redis::Config::from_url(redis_url)
        .create_pool(Some(deadpool_redis::Runtime::Tokio1))?;

    // In-process realization of the usage.threshold topic shared between metering
    // (publisher) and notifications (subscriber).
    let (usage_event_bus, _initial_rx) = broadcast::channel(1024);

    let accounts = AccountsSubsystem::new(pool.clone());
    let subscriptions = SubscriptionsSubsystem::new(
        pool.clone(),
        accounts.portal.clone(),
        StripeConfig {
            api_key: std::env::var("STRIPE_API_KEY").unwrap_or_default(),
            signing_secret: std::env::var("STRIPE_WEBHOOK_SECRET").unwrap_or_default(),
        },
    );
    let metering = MeteringSubsystem::new(pool.clone(), redis_pool, usage_event_bus.clone());
    let gatekeeping = GatekeepingSubsystem::new(
        pool.clone(),
        subscriptions.portal.clone(),
        metering.portal.clone(),
    );

    let notifications = NotificationsSubsystem::new(
        pool,
        accounts.portal.clone(),
        EmailProviderConfig {
            endpoint: std::env::var("EMAIL_PROVIDER_URL").unwrap_or_default(),
            api_key: std::env::var("EMAIL_API_KEY").unwrap_or_default(),
        },
    );

    // Spawn the background usage reconciler (Redis counters -> Postgres rollups).
    let reconciler = metering.reconciler.clone();
    tokio::spawn(async move { reconciler.run().await });

    // Drive the notifications observer from the in-process usage.threshold bus.
    let observer = notifications.observer.clone();
    let bus_for_consumer = usage_event_bus.clone();
    tokio::spawn(async move {
        NotificationsSubsystem::run_consumer(observer, &bus_for_consumer).await;
    });

    let app = accounts
        .router
        .merge(subscriptions.router)
        .merge(metering.router)
        .merge(gatekeeping.router);

    let addr = SocketAddr::from(([0, 0, 0, 0], 8080));
    let listener = tokio::net::TcpListener::bind(addr).await?;
    println!("gatekeeper-saas listening on {addr}");
    axum::serve(listener, app).await?;
    Ok(())
}
