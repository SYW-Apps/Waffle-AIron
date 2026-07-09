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
- [ ] Human runs `wairon lock`
- [ ] Implementation

### Phase 2 — Approvals + Self-service
- [ ] Not started

### Phase 3 — Project policy / profiles
- [ ] Not started

### Phase 4 — Landscape / organization
- [ ] Not started

### Phase 5 — Operations, Admin UI (SSO), local control
- [ ] Not started (identity_provider_adapter narratives land here)
