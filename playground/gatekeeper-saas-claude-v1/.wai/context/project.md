# gatekeeper-saas-claude-v1

## Overview
**Gatekeeper** is a multi-tenant SaaS control-plane microservice that sits in front of
our platforms' APIs. It tracks customers, meters their API access in real time, and
enforces subscription limits backed by Stripe. On every protected API call, a customer
platform asks Gatekeeper to authorize the request; Gatekeeper checks the caller's
subscription tier and remaining quota, returns an allow/deny decision, and decrements
the usage counter. It reconciles metered usage against Stripe subscriptions, manages
per-tier limits, and emits usage-threshold notifications to each account's billing
email.

## Tech Stack
- **Language / Runtime:** Rust (async, Tokio).
- **Inbound transport:** HTTP/JSON (and optionally gRPC) ingress for the gate.
- **Authoritative store:** PostgreSQL (accounts, subscriptions, plans/limits, invoices,
  usage rollups) accessed via `sqlx`.
- **Hot path / counters:** Redis for per-subscription rate-limit & quota counters,
  accessed via `deadpool-redis`. The inline gate reads/decrements here.
- **External integrations (Adapters only):** Stripe via `async-stripe`
  (subscriptions, metered billing, webhooks); transactional email via an HTTP email
  provider adapter (e.g. SendGrid/Postmark).

## Enforcement Model
- **Inline synchronous gate.** Customer platforms call Gatekeeper to authorize each
  protected API call. The decision path is latency-critical: it reads cached
  limits + Redis counters, never blocking on Postgres in the hot path.
- Postgres is the source of truth; Redis counters are projections seeded from
  Postgres and periodically reconciled / flushed back as usage rollups.

## Key Conventions
- Follow Spec-Driven Development (SDD) using Wairon. The spec tree under `.wai/specs/`
  is the source of truth; agents and code are derived from it.
- Refrain from writing code implementation until specifications are approved and
  `sdd_validate_tree` passes with zero errors.
- Architectural vocabulary only (Portal, Orchestrator, Store, Index, Registry,
  Adapter, Observer, Specialist; Repository/Gateway patterns). No "Manager/Helper/Utils".
- Only `Portal` components accept external traffic. All external I/O (Postgres, Redis,
  Stripe, email) happens exclusively in `Adapter` components.
