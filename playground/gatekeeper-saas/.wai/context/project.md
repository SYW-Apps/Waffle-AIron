# gatekeeper-saas

## Overview
The `gatekeeper-saas` is a high-performance, resilient microservice designed to track customers, meter API access, enforce subscription limits, and handle notification alerts for over-limit/warning usage. It integrates with Stripe for lifecycle billing and subscription events, and manages client access token authentication and rate-limiting.

## Tech Stack
- **Language/Runtime:** Rust (stable)
- **Primary Database:** PostgreSQL (for relational metadata: users, subscriptions, configurations)
- **Caching & Metering Store:** Redis (for low-latency, high-throughput token-bucket or sliding-window rate-limiting and usage counters)
- **External Services:** Stripe (Billing/Subscriptions), SMTP/SendGrid (Email Notifications)

## Key Conventions
- **Spec-Driven Development (SDD):** Built using the Wairon SDD framework. Spec tree under `.wai/specs/` is the single source of truth.
- **Architectural Perfection:** Narrative composition, semantic naming, zero-copy models, zero-wait concurrency, and passive foundations.
- **Testing Gate:** Unit and integration test coverage must be developed test-first before component implementation.

