# gatekeeper-saas

## Overview
The `gatekeeper-saas` is a high-performance, scalable Rust-based microservice designed to track customers, meter API access across platforms, enforce subscriptions via Stripe, and monitor usage limits. It automatically alerts customers via email and push notifications when they approach (80%) or exceed (100%) their subscription limits.

## Tech Stack
*   **Runtime & Language:** Rust (Async with `tokio`, Web server with `axum`)
*   **Durable Database:** PostgreSQL (using `sqlx` for asynchronous SQL)
*   **Metering & Rate Limiting Cache:** Redis (using `redis` crate)
*   **Stripe Integration:** Stripe API via `stripe` crate
*   **Notification Delivery:** SMTP/Email Adapter & Webhook/Push Notification Adapter

## Key Conventions
*   **SDD Conformity:** Spec-Driven Development using Wairon. No implementation code is written until specs are validated.
*   **Architectural Perfection:**
    1. **Narrative Composition:** Functions are structured as lists of named steps.
    2. **Semantic Naming:** Stereotype names only (Portal, Orchestrator, Store, Registry, Index, Adapter, Observer, Specialist, Supervisor, Actor). No "Managers" or "Utils".
    3. **Passive Foundations:** Database, filesystem, and external models do not trigger side-effects directly.
    4. **Zero-Wait Concurrency:** Wait-free read-swaps and serialized write locks for state mutations.
    5. **Zero-Copy Purity:** Leverage Rust references (`&T`, `Arc<T>`) for shared models instead of unnecessary copying or serialization.
    6. **Architectural Visibility:** File paths and names reflect the 10,000ft view.
