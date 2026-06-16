use crate::models::{AuthDecision, GatekeeperError, SubscriptionDetails, MeterResult, MeterError, RepositoryError, NotificationError};
use crate::billing::subscription_repository::SubscriptionRepository;
use crate::gatekeeper::meter_repository::MeterRepository;
use crate::notification::orchestrator::NotificationOrchestrator;
use async_trait::async_trait;
use std::sync::Arc;

#[async_trait]
pub trait GatekeeperOrchestrator {
    async fn authorize_request(
        &self,
        api_key: String,
    ) -> Result<AuthDecision, GatekeeperError>;
}

pub struct GatekeeperOrchestratorImpl {
    subscription_repo: Arc<dyn SubscriptionRepository + Send + Sync>,
    meter_repo: Arc<dyn MeterRepository + Send + Sync>,
    notification_orchestrator: Arc<dyn NotificationOrchestrator + Send + Sync>,
}

impl GatekeeperOrchestratorImpl {
    pub fn new(
        subscription_repo: Arc<dyn SubscriptionRepository + Send + Sync>,
        meter_repo: Arc<dyn MeterRepository + Send + Sync>,
        notification_orchestrator: Arc<dyn NotificationOrchestrator + Send + Sync>,
    ) -> Self {
        Self {
            subscription_repo,
            meter_repo,
            notification_orchestrator,
        }
    }
}

#[async_trait]
impl GatekeeperOrchestrator for GatekeeperOrchestratorImpl {
    async fn authorize_request(
        &self,
        api_key: String,
    ) -> Result<AuthDecision, GatekeeperError> {
        // Step 1: Call the subscription repository to fetch limits and active status associated with the key
        let subscription = self.subscription_repo
            .get_subscription_by_key(api_key)
            .await
            .map_err(|e| GatekeeperError::DatabaseError(e.to_string()))?
            .ok_or(GatekeeperError::SubscriptionNotFound)?;

        // Step 2: Verify if subscription is active and return unauthorized if not active
        if subscription.status != "active" {
            return Ok(AuthDecision {
                allowed: false,
                remaining_requests: 0,
                reset_seconds: 0,
                error_message: Some("Subscription is inactive".to_string()),
            });
        }

        let rate_limit = match subscription.tier_id.as_str() {
            "free" => 10,
            "pro" => 100,
            "enterprise" => 1000,
            _ => 10,
        };

        // Step 3: Call the meter repository to atomically check rate limits and monthly limits, incrementing counts if allowed
        let meter_result = self.meter_repo
            .check_and_increment(
                subscription.id.to_string(),
                rate_limit,
                subscription.api_limit,
            )
            .await
            .map_err(|e| GatekeeperError::CacheError(e.to_string()))?;

        // Step 4: Check if the usage counters have reached the 80% or 100% threshold trigger points
        let previous_usage = meter_result.current_monthly_count.saturating_sub(1);
        let limit = subscription.api_limit;
        let threshold_80 = (limit as f64 * 0.8) as u32;
        let threshold_100 = limit;

        let mut alert_type = None;
        if meter_result.current_monthly_count >= threshold_100 && previous_usage < threshold_100 {
            alert_type = Some("LIMIT_EXCEEDED".to_string());
        } else if meter_result.current_monthly_count >= threshold_80 && previous_usage < threshold_80 {
            alert_type = Some("WARNING_80".to_string());
        }

        // Step 5: Call the notification orchestrator asynchronously to dispatch warning emails/alerts if thresholds are crossed
        if let Some(alert) = alert_type {
            let email = subscription.customer_email.clone();
            let notifier = Arc::clone(&self.notification_orchestrator);
            let usage = meter_result.current_monthly_count;
            tokio::spawn(async move {
                let _ = notifier.dispatch_alert(email, alert, usage, limit).await;
            });
        }

        // Step 6: Return the final authorization decision (allowed/denied) along with rate-limiting response details
        let allowed = meter_result.rate_limit_allowed && meter_result.monthly_limit_allowed;
        let error_message = if !meter_result.rate_limit_allowed {
            Some("Rate limit exceeded".to_string())
        } else if !meter_result.monthly_limit_allowed {
            Some("Monthly quota exceeded".to_string())
        } else {
            None
        };

        Ok(AuthDecision {
            allowed,
            remaining_requests: rate_limit.saturating_sub(meter_result.current_rate_count),
            reset_seconds: 60,
            error_message,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use uuid::Uuid;
    use chrono::Utc;
    use std::sync::Mutex;

    struct MockSubscriptionRepo {
        should_fail: bool,
        subscription: Option<SubscriptionDetails>,
    }

    #[async_trait]
    impl SubscriptionRepository for MockSubscriptionRepo {
        async fn get_subscription_by_key(&self, _api_key: String) -> Result<Option<SubscriptionDetails>, RepositoryError> {
            if self.should_fail {
                return Err(RepositoryError::DatabaseError("DB error".to_string()));
            }
            Ok(self.subscription.clone())
        }
        async fn update_subscription_status(&self, _stripe_sub_id: String, _status: String, _plan_id: String) -> Result<(), RepositoryError> {
            Ok(())
        }
    }

    struct MockMeterRepo {
        should_fail: bool,
        result: MeterResult,
    }

    #[async_trait]
    impl MeterRepository for MockMeterRepo {
        async fn check_and_increment(&self, _subscription_id: String, _rate_limit: u32, _monthly_limit: u32) -> Result<MeterResult, MeterError> {
            if self.should_fail {
                return Err(MeterError::RedisError("Redis error".to_string()));
            }
            Ok(self.result.clone())
        }
        async fn get_current_usage(&self, _subscription_id: String) -> Result<u32, MeterError> {
            Ok(self.result.current_monthly_count)
        }
    }

    struct MockNotificationOrchestrator {
        dispatched_alerts: Arc<Mutex<Vec<(String, String, u32)>>>,
    }

    #[async_trait]
    impl NotificationOrchestrator for MockNotificationOrchestrator {
        async fn dispatch_alert(&self, customer_email: String, alert_type: String, current_usage: u32, _limit: u32) -> Result<(), NotificationError> {
            self.dispatched_alerts.lock().unwrap().push((customer_email, alert_type, current_usage));
            Ok(())
        }
    }

    #[tokio::test]
    async fn test_authorize_request_success() {
        let sub_id = Uuid::new_v4();
        let sub = SubscriptionDetails {
            id: sub_id,
            customer_id: Uuid::new_v4(),
            customer_email: "test@example.com".to_string(),
            stripe_subscription_id: "sub_123".to_string(),
            status: "active".to_string(),
            tier_id: "pro".to_string(),
            api_limit: 10000,
            current_period_start: Utc::now().naive_utc(),
            current_period_end: Utc::now().naive_utc(),
        };

        let sub_repo = Arc::new(MockSubscriptionRepo {
            should_fail: false,
            subscription: Some(sub),
        });

        let meter_repo = Arc::new(MockMeterRepo {
            should_fail: false,
            result: MeterResult {
                rate_limit_allowed: true,
                monthly_limit_allowed: true,
                current_rate_count: 5,
                current_monthly_count: 50,
            },
        });

        let alerts = Arc::new(Mutex::new(Vec::new()));
        let notif_orch = Arc::new(MockNotificationOrchestrator {
            dispatched_alerts: Arc::clone(&alerts),
        });

        let orchestrator = GatekeeperOrchestratorImpl::new(sub_repo, meter_repo, notif_orch);
        let result = orchestrator.authorize_request("key_123".to_string()).await;

        assert!(result.is_ok());
        let decision = result.unwrap();
        assert!(decision.allowed);
        assert_eq!(decision.remaining_requests, 95); // 100 (pro) - 5
        assert_eq!(alerts.lock().unwrap().len(), 0);
    }

    #[tokio::test]
    async fn test_authorize_request_inactive_subscription() {
        let sub = SubscriptionDetails {
            id: Uuid::new_v4(),
            customer_id: Uuid::new_v4(),
            customer_email: "test@example.com".to_string(),
            stripe_subscription_id: "sub_123".to_string(),
            status: "past_due".to_string(), // inactive status
            tier_id: "pro".to_string(),
            api_limit: 10000,
            current_period_start: Utc::now().naive_utc(),
            current_period_end: Utc::now().naive_utc(),
        };

        let sub_repo = Arc::new(MockSubscriptionRepo {
            should_fail: false,
            subscription: Some(sub),
        });

        let meter_repo = Arc::new(MockMeterRepo {
            should_fail: false,
            result: MeterResult {
                rate_limit_allowed: true,
                monthly_limit_allowed: true,
                current_rate_count: 0,
                current_monthly_count: 0,
            },
        });

        let notif_orch = Arc::new(MockNotificationOrchestrator {
            dispatched_alerts: Arc::new(Mutex::new(Vec::new())),
        });

        let orchestrator = GatekeeperOrchestratorImpl::new(sub_repo, meter_repo, notif_orch);
        let result = orchestrator.authorize_request("key_123".to_string()).await;

        assert!(result.is_ok());
        let decision = result.unwrap();
        assert!(!decision.allowed);
        assert_eq!(decision.error_message, Some("Subscription is inactive".to_string()));
    }

    #[tokio::test]
    async fn test_authorize_request_trigger_80_percent_warning() {
        let sub = SubscriptionDetails {
            id: Uuid::new_v4(),
            customer_id: Uuid::new_v4(),
            customer_email: "alert@example.com".to_string(),
            stripe_subscription_id: "sub_123".to_string(),
            status: "active".to_string(),
            tier_id: "pro".to_string(),
            api_limit: 10000,
            current_period_start: Utc::now().naive_utc(),
            current_period_end: Utc::now().naive_utc(),
        };

        let sub_repo = Arc::new(MockSubscriptionRepo {
            should_fail: false,
            subscription: Some(sub),
        });

        let meter_repo = Arc::new(MockMeterRepo {
            should_fail: false,
            result: MeterResult {
                rate_limit_allowed: true,
                monthly_limit_allowed: true,
                current_rate_count: 1,
                current_monthly_count: 8000, // exactly 80% of 10000
            },
        });

        let alerts = Arc::new(Mutex::new(Vec::new()));
        let notif_orch = Arc::new(MockNotificationOrchestrator {
            dispatched_alerts: Arc::clone(&alerts),
        });

        let orchestrator = GatekeeperOrchestratorImpl::new(sub_repo, meter_repo, notif_orch);
        let result = orchestrator.authorize_request("key_123".to_string()).await;

        assert!(result.is_ok());
        
        // Wait for tokio task to finish
        tokio::time::sleep(tokio::time::Duration::from_millis(50)).await;
        
        let alerts_guard = alerts.lock().unwrap();
        assert_eq!(alerts_guard.len(), 1);
        assert_eq!(alerts_guard[0].0, "alert@example.com");
        assert_eq!(alerts_guard[0].1, "WARNING_80");
        assert_eq!(alerts_guard[0].2, 8000);
    }

    #[tokio::test]
    async fn test_authorize_request_db_error() {
        let sub_repo = Arc::new(MockSubscriptionRepo {
            should_fail: true,
            subscription: None,
        });
        let meter_repo = Arc::new(MockMeterRepo {
            should_fail: false,
            result: MeterResult {
                rate_limit_allowed: true,
                monthly_limit_allowed: true,
                current_rate_count: 0,
                current_monthly_count: 0,
            },
        });
        let notif_orch = Arc::new(MockNotificationOrchestrator {
            dispatched_alerts: Arc::new(Mutex::new(Vec::new())),
        });

        let orchestrator = GatekeeperOrchestratorImpl::new(sub_repo, meter_repo, notif_orch);
        let result = orchestrator.authorize_request("key_123".to_string()).await;

        assert!(result.is_err());
        match result.unwrap_err() {
            GatekeeperError::DatabaseError(msg) => assert!(msg.contains("DB error")),
            _ => panic!("Expected DatabaseError"),
        }
    }

    #[tokio::test]
    async fn test_authorize_request_not_found() {
        let sub_repo = Arc::new(MockSubscriptionRepo {
            should_fail: false,
            subscription: None,
        });
        let meter_repo = Arc::new(MockMeterRepo {
            should_fail: false,
            result: MeterResult {
                rate_limit_allowed: true,
                monthly_limit_allowed: true,
                current_rate_count: 0,
                current_monthly_count: 0,
            },
        });
        let notif_orch = Arc::new(MockNotificationOrchestrator {
            dispatched_alerts: Arc::new(Mutex::new(Vec::new())),
        });

        let orchestrator = GatekeeperOrchestratorImpl::new(sub_repo, meter_repo, notif_orch);
        let result = orchestrator.authorize_request("key_123".to_string()).await;

        assert!(result.is_err());
        assert!(matches!(result.unwrap_err(), GatekeeperError::SubscriptionNotFound));
    }

    #[tokio::test]
    async fn test_authorize_request_cache_error() {
        let sub = SubscriptionDetails {
            id: Uuid::new_v4(),
            customer_id: Uuid::new_v4(),
            customer_email: "test@example.com".to_string(),
            stripe_subscription_id: "sub_123".to_string(),
            status: "active".to_string(),
            tier_id: "pro".to_string(),
            api_limit: 10000,
            current_period_start: Utc::now().naive_utc(),
            current_period_end: Utc::now().naive_utc(),
        };

        let sub_repo = Arc::new(MockSubscriptionRepo {
            should_fail: false,
            subscription: Some(sub),
        });

        let meter_repo = Arc::new(MockMeterRepo {
            should_fail: true,
            result: MeterResult {
                rate_limit_allowed: true,
                monthly_limit_allowed: true,
                current_rate_count: 0,
                current_monthly_count: 0,
            },
        });

        let notif_orch = Arc::new(MockNotificationOrchestrator {
            dispatched_alerts: Arc::new(Mutex::new(Vec::new())),
        });

        let orchestrator = GatekeeperOrchestratorImpl::new(sub_repo, meter_repo, notif_orch);
        let result = orchestrator.authorize_request("key_123".to_string()).await;

        assert!(result.is_err());
        match result.unwrap_err() {
            GatekeeperError::CacheError(msg) => assert!(msg.contains("Redis error")),
            _ => panic!("Expected CacheError"),
        }
    }

    #[tokio::test]
    async fn test_mocks_coverage() {
        let sub_repo = MockSubscriptionRepo {
            should_fail: false,
            subscription: None,
        };
        let res1 = sub_repo.update_subscription_status("".to_string(), "".to_string(), "".to_string()).await;
        assert!(res1.is_ok());

        let meter_repo = MockMeterRepo {
            should_fail: false,
            result: MeterResult {
                rate_limit_allowed: true,
                monthly_limit_allowed: true,
                current_rate_count: 0,
                current_monthly_count: 42,
            },
        };
        let res2 = meter_repo.get_current_usage("".to_string()).await;
        assert_eq!(res2.unwrap(), 42);
    }

    #[tokio::test]
    async fn test_authorize_request_different_tiers() {
        // Test "free" tier
        let sub_free = SubscriptionDetails {
            id: Uuid::new_v4(),
            customer_id: Uuid::new_v4(),
            customer_email: "free@example.com".to_string(),
            stripe_subscription_id: "sub_free".to_string(),
            status: "active".to_string(),
            tier_id: "free".to_string(),
            api_limit: 10000,
            current_period_start: Utc::now().naive_utc(),
            current_period_end: Utc::now().naive_utc(),
        };
        let sub_repo = Arc::new(MockSubscriptionRepo {
            should_fail: false,
            subscription: Some(sub_free),
        });
        let meter_repo = Arc::new(MockMeterRepo {
            should_fail: false,
            result: MeterResult {
                rate_limit_allowed: true,
                monthly_limit_allowed: true,
                current_rate_count: 1,
                current_monthly_count: 5,
            },
        });
        let notif_orch = Arc::new(MockNotificationOrchestrator {
            dispatched_alerts: Arc::new(Mutex::new(Vec::new())),
        });
        let orchestrator = GatekeeperOrchestratorImpl::new(sub_repo.clone(), meter_repo.clone(), notif_orch.clone());
        let res = orchestrator.authorize_request("key_free".to_string()).await.unwrap();
        assert_eq!(res.remaining_requests, 9); // 10 - 1

        // Test "enterprise" tier
        let sub_ent = SubscriptionDetails {
            id: Uuid::new_v4(),
            customer_id: Uuid::new_v4(),
            customer_email: "ent@example.com".to_string(),
            stripe_subscription_id: "sub_ent".to_string(),
            status: "active".to_string(),
            tier_id: "enterprise".to_string(),
            api_limit: 10000000,
            current_period_start: Utc::now().naive_utc(),
            current_period_end: Utc::now().naive_utc(),
        };
        let sub_repo = Arc::new(MockSubscriptionRepo {
            should_fail: false,
            subscription: Some(sub_ent),
        });
        let orchestrator = GatekeeperOrchestratorImpl::new(sub_repo, meter_repo.clone(), notif_orch.clone());
        let res = orchestrator.authorize_request("key_ent".to_string()).await.unwrap();
        assert_eq!(res.remaining_requests, 999); // 1000 - 1

        // Test fallback tier
        let sub_other = SubscriptionDetails {
            id: Uuid::new_v4(),
            customer_id: Uuid::new_v4(),
            customer_email: "other@example.com".to_string(),
            stripe_subscription_id: "sub_other".to_string(),
            status: "active".to_string(),
            tier_id: "other".to_string(),
            api_limit: 10000,
            current_period_start: Utc::now().naive_utc(),
            current_period_end: Utc::now().naive_utc(),
        };
        let sub_repo = Arc::new(MockSubscriptionRepo {
            should_fail: false,
            subscription: Some(sub_other),
        });
        let orchestrator = GatekeeperOrchestratorImpl::new(sub_repo, meter_repo, notif_orch);
        let res = orchestrator.authorize_request("key_other".to_string()).await.unwrap();
        assert_eq!(res.remaining_requests, 9); // 10 (fallback) - 1
    }
}
