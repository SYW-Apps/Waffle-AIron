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

### Phase 3 — Project policy / profiles (ACTIVE)
Approved design: IdP methods on ipolicy_repository deferred to Phase 5; policy-aware approval execution via pre-authorized executeApprovedInit wrapping admin executeApprovedCreate (keeps it wired; self_service → policy → admin acyclic); request-time evaluateInitRequest in requestProjectInitialization (warn attaches findings, enforce rejects); direct portal creation gated by project:create; new vocab: policy:manage. Policy store = single active InstancePackPolicy at pack-policy.json.
- [x] Spec finalization; all gates green; human locked (draft-freeze reverted)
- [x] Implementation: policy plane (policy.ts, 17 tests; packs.ts pre-authorized entries) → self-service retarget (5 tests). 377 tests green; live e2e: block-mode policy rejected a non-compliant agent request at request time with actionable findings; compliant request flowed through approval; project provisioned with profileSelection recorded.

Phase 3 COMPLETE. Tech debt: ProjectConfigSchema doesn't model profileSelection (raw-YAML workaround in policy.ts) — fold into the core-model pass. UX watch-item (Robbe): warn/block surfacing needs an end-user pass with the Phase 5 UI.

### Phase 4 — Landscape / organization (ACTIVE)
Approved design: credential-based discovery methods (uniform with Phases 1–3); directional relations-only reachability (placements = visual grouping, no access); upsertRelation validates targetPublicInterface against the target's snapshot (refresh required first); refreshPublicSurface reads L0 publicInterfaces leniently via raw YAML (core SystemSpecSchema gap stays in the validation-extensions batch, like profileSelection); private-by-default (no L0 surface = empty snapshot); vocab += landscape:manage, landscape:read. Source layout: organization.ts / relations.ts / surfaces.ts (triads), landscape.ts (orchestrator+portal+specialist).
- [x] Spec finalization (9 member interfaces, removeRelation + getUnit wirings, host_core_adapter spec-read forwarders, organization_state type); all gates green; human locked (draft-freeze reverted)
- [x] Implementation: 3 parallel triads (organization/relations/surfaces, 39 tests) → landscape.ts (18 tests; adapters.ts spec-read forwarders) → request.ts discovery dispatch (6 tests). 440 tests green; live e2e: beta published an L0 surface → redacted snapshot → snapshot-validated relation alpha→beta → alpha's agent discovered exactly [beta] + its redacted interfaces; gamma denied with no existence leak.

Phase 4 COMPLETE. Type-spec fix pending: organization_unit_record.parentId required-vs-"when set" mismatch (typed optional in code).

### Phase 5 — split per approved scope decision
**5a — Headless SSO onboarding (ACTIVE)**: /identity/sso/start + /identity/sso/callback on the identity portal (OIDC code exchange → resolve-or-create user inlined into completeSsoLogin → mint user-bound token shown once); stateless HMAC SSO state signed by auth_specialist; IdP config CRUD restored on ipolicy_repository (instance-admin gated, surfaced on /identity/providers); audit count endpoint. Clears all 4 lint allows + every Phase-5 deferral marker. resolveOrCreateUser resolves as inlined narrative steps (a public method would be uncallable → honest inline instead).
**5b — Slim operations + exposure enforcement**: health/usage/advisory-quota read-only surface (diagnostics + quota specialists); HostExposurePolicy actually gates the mounted control planes; backup_* + backup_archive_adapter + restore specs DELETED (platform snapshots are the documented backup path).
**Deferred as drafts**: admin_ui_* (+ web_session) pending real-usage/UX evidence; local_control_portal pending exposure-policy-driven need.
**5c — skills resources** (sdd_mcp/sdd_skills): after 5a/5b.
- [x] 5a COMPLETE: spec'd, locked, implemented (idp.ts OIDC adapter; auth.ts SSO state; policy.ts IdP storage; identity.ts six flows + routes; errors.ts extracted breaking the identity↔policy cycle). 476+ tests; live e2e: stub provider → start → callback → first-login user (empty grants) → 403 on data plane → admin grants → re-login → data-plane success; zero lint allows remain anywhere. Bonus fix found by e2e: URL-decode path segments in all four routers (SSO ids carry colons).
- [ ] 5b spec finalization (slim operations + HostExposurePolicy enforcement + backup_* deletion) → lock → implementation
- [ ] 5c skills resources
