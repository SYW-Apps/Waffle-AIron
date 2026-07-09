# Phased Design — Waffle-AIron

## Base system (Stages 1–6)
- [x] Stage 1–5: L0–L5 designed for sdd_core, sdd_validator, sdd_cli, sdd_mcp, sdd_skills, sdd_git, sdd_producers, sdd_host (base)
- [x] Stage 6: implemented; tree validates; hosted server shipped

## Professional-use expansion (sdd_host draft layer, committed 2026-07-09)
Design doc: `docs/design/hosted-professional-use.md`. Phases run: design-finalize → validate → human lock → implement.

### Phase 1 — Identity + Audit (ACTIVE)
- [x] L3 contract fixes on iidentity_orchestrator (credential-based auth pattern; add listUsers/queryAuditEvents/pruneAuditEvents; defer resolveOrCreateUser + recordAuthenticatedAction)
- [x] L4/L5 batch 1: audit_store/registry/index/repository, user_store/registry/index/repository
- [x] L4/L5 batch 2: identity_orchestrator (full), identity_portal (calls-only)
- [x] Integration deltas on complete components (user-approved): auth_specialist grants/subject resolution (+authenticateCredential); host_request_orchestrator audit append
- [x] Status promotion to complete (identity_provider_adapter stays draft until Phase 5/SSO)
- [x] User-provisioning gap closed: admin upsertUser + setUserStatus on identity portal/orchestrator; allows narrowed to 4 (findByExternalSubject ×2 → Phase 5 SSO, audit count ×2 → Phase 5 pagination)
- [x] sdd_validate_tree zero errors; validate --ci exit 0; as-complete gate zero errors
- [x] Human ran `wairon lock` (2026-07-09; blanket draft→complete freeze on Phase 2–5 planes reverted — product gap: lock needs phase awareness)
- [x] Implementation: auth foundation (grants/expiry/authenticateCredential), audit plane (audit.ts), user plane (users.ts), identity API (identity.ts, /identity/* on admin listener), data-plane mcp.tool.call audit append (request.ts). 293 tests green; live e2e verified (mint → scoped MCP call → audit provenance).

Phase 1 COMPLETE. Vocabulary follow-ups for the Phase 2 spec pass: canonicalize the 'user:admin' permission string; decide whether mintToken should resolve ownerSubject from the user repository (currently synthesized from ownerUserId).

### Phase 2 — Approvals + Self-service (ACTIVE)
Approved design: credential-based iself_service contract (house pattern); policy + identity deps deferred (Phase 3+); decision surface = admin_portal → self_service directly (avoids the admin_orchestrator cycle); admin plane gains pre-authorized executeApproved* entry points (approval IS the authorization — master-gated methods can't serve execution); host_request dispatches the four sdd_host_* MCP tools; lazy expiry wires expirePending; self-approval invariant on decideRequest; new grant vocab: approval:decide.
- [x] L3 rework (credential pattern) + member interfaces (iapproval_store/registry/index) + narratives (approval triad intent, facade forwarding, 7 full self-service methods) + deltas (host_request four-tool switch dispatch; admin_portal /admin/approvals endpoints; admin_orchestrator executeApproved* entries) + promotion; index/facade filter param aligned (requestedByUserId)
- [x] Validation green: sdd_validate_tree + validate --ci exit 0, zero warnings on promoted specs; as-complete gate zero errors
- [x] Human ran `wairon lock` (draft-freeze on Phase 3–5 planes reverted again, status-only)
- [x] Implementation: approvals storage (approvals.ts, 23 tests) → self-service orchestrator + pre-authorized admin entries (selfservice.ts/admin.ts, 22 tests) → MCP dispatch (request.ts, 6 tests) ∥ admin endpoints (http.ts, 11 tests). 355 tests green; live e2e verified: agent requested init over MCP → admin listed/approved/executed → project provisioned; audit chain complete (token.mint → approval.request.created → mcp.tool.call → approval.decided → approval.executed).

Phase 2 COMPLETE.

### Phase 3 — Project policy / profiles
- [ ] Not started

### Phase 4 — Landscape / organization
- [ ] Not started

### Phase 5 — Operations, Admin UI (SSO), local control
- [ ] Not started (identity_provider_adapter narratives land here)
