import type { StateId } from '../core/statehash.js';
import type { LockRecord } from '../core/lockfile.js';

// ---------------------------------------------------------------------------
// Hosting value types (sdd_host)
// ---------------------------------------------------------------------------

/** Coarse compatibility role projected for DISPLAY only — never an authorization
 *  source. Precise authorization resolves from a Principal's permissionSubject
 *  through the permission resolver. (Named DisplayRole so the domain concept
 *  `Role` below can carry its canonical meaning: a permission template.) */
export type DisplayRole = 'editor' | 'admin';

// ---------------------------------------------------------------------------
// Hierarchical permission model (roles + assignments + the resolver)
// ---------------------------------------------------------------------------

/** The five capabilities the hierarchical permission model gates. There is NO
 *  '*' capability: the instance-admin bypass is env-anchored to the built-in
 *  super-admin/master and is never granted through the assignment grid. */
export type Capability =
  | 'project:read'
  | 'project:create'
  | 'project:write'
  | 'project:admin'
  | 'approval:decide';

/** A three-valued permission plus `inherit`. The values ARE the approval flow:
 *  `yes` = act directly, `approval` = create an approval request, `no` = deny
 *  (403 + invisible), `inherit` = defer to the next ancestor scope. */
export type PermissionValue = 'yes' | 'approval' | 'no' | 'inherit';

/** The value an effective resolution can settle on — `inherit` is consumed by the walk. */
export type EffectiveValue = Extract<PermissionValue, 'yes' | 'approval' | 'no'>;

/** The scope tiers permissions may be anchored at. */
export type ScopeKind = 'instance' | 'unit' | 'project';

/** One capability→value default a role confers. */
export interface RolePermission {
  capability: Capability;
  /** yes | approval | inherit. Roles GRANT only — combined most-permissively
   *  (yes > approval) with the subject's other roles anchored at the same scope;
   *  a role never denies, so 'no'/'inherit' is non-deciding during resolution. */
  value: PermissionValue;
}

/** A named, reusable permission template bound to users (optionally scoped).
 *  Most roles are admin-defined and stored; the BUILT-IN reserved roles are
 *  intrinsic constants always merged into the PermissionWorld. */
export interface Role {
  /** Stable role id (lowercase slug, e.g. 'intern', 'project-owner'). */
  id: string;
  name: string;
  description?: string;
  permissions: RolePermission[];
  createdAt: string;
  createdBy?: PrincipalSubject;
}

/** One (subject × scope × capability → value) binding — the atom of the grid.
 *  Roles are NOT assignment subjects: a role's values live on Role.permissions
 *  and apply through the user's RoleBindings, anchored at the binding's scope. */
export interface PermissionAssignment {
  id: string;
  /** user | everyone (a scope-wide default). */
  subjectKind: 'user' | 'everyone';
  /** The user id; absent when subjectKind is 'everyone'. */
  subjectId?: string;
  scopeKind: ScopeKind;
  /** Qualified unit id or project id; absent when scopeKind is 'instance'. */
  scopeId?: string;
  capability: Capability;
  value: PermissionValue;
  createdAt: string;
  createdBy?: PrincipalSubject;
}

/** Binds a role to a user within a scope. An unscoped binding applies
 *  instance-wide (anchored at the instance root during resolution). */
export interface RoleBinding {
  roleId: string;
  scopeKind?: ScopeKind;
  scopeId?: string;
}

/** The resolved caller handed to the pure permission resolver. */
export interface PermissionSubject {
  /** The principal's stable user id (matches PermissionAssignment.subjectId). */
  subjectId: string;
  /** Roles bound to this subject, optionally scoped. */
  roleBindings: RoleBinding[];
  /** True ONLY for the env-anchored built-in super-admin subject, the master
   *  credential, or (devMode) the local-developer subject — the resolver then
   *  bypasses to yes. Determined by SUBJECT IDENTITY, never by an assignment;
   *  a regular user is never instanceAdmin, even a delegated project:admin. */
  instanceAdmin: boolean;
}

/** The gathered, read-only data the pure resolver walks. The caller performs
 *  the I/O; the resolver performs none. */
export interface PermissionWorld {
  assignments: PermissionAssignment[];
  /** Stored roles MERGED with the intrinsic built-in reserved roles. */
  roles: Role[];
  units: OrganizationUnitRecord[];
  placements: ProjectPlacement[];
}

/** The resolved effective permission for one (subject, capability, target). */
export interface EffectivePermission {
  value: EffectiveValue;
  /** instance-admin | user | role | everyone-default | instance-default. */
  source: 'instance-admin' | 'user' | 'role' | 'everyone-default' | 'instance-default';
  decidedScopeKind?: ScopeKind;
  decidedScopeId?: string;
}

/** One scope in a subject's visibility view: actionable, or an ancestor shown
 *  only as a navigation breadcrumb. Never an ancestor's other children. */
export interface VisibleScope {
  scopeKind: 'unit' | 'project';
  scopeId: string;
  value: EffectiveValue;
  /** True when shown only as an ancestor breadcrumb (not directly actionable). */
  context: boolean;
}

/** Human, service, or bootstrap identity resolved from a credential. The stable
 *  actor identity attached to MCP tokens and audit events; raw secrets never appear. */
export interface PrincipalSubject {
  /** Stable Wairon user or service-principal id. */
  userId: string;
  /** Actor kind: 'human', 'service', or 'bootstrap'. */
  kind: string;
  /** Identity issuer such as 'local', 'bootstrap', or an external OIDC issuer id. */
  issuer: string;
  /** Issuer-local subject id when the identity came from SSO or another provider. */
  externalSubject?: string;
  /** Human-readable name for UI and audit views. */
  displayName?: string;
  /** Verified email address when available. */
  email?: string;
}

/** The authenticated caller identity and authorized scope. Transient (never
 *  persisted). Its subject, projects narrowing, and permissionSubject are
 *  server-side bindings derived from the token or bootstrap credential, never
 *  from client-supplied parameters. The role/projects fields remain a coarse
 *  compatibility projection for display; precise authorization is expressed
 *  through the permission resolver over permissionSubject, never stored grants. */
export interface Principal {
  tokenId: string;
  /** Coarse display projection — NOT an authorization source. */
  role: DisplayRole;
  /** Coarse projection of the token's project narrowing; '*' denotes no
   *  narrowing (the resolver still gates per project). */
  projects: string[];
  authenticated: boolean;
  /** Resolved human, service, or bootstrap identity behind the action. */
  subject?: PrincipalSubject;
  /** The resolved permission subject for hierarchical authorization. */
  permissionSubject?: PermissionSubject;
}

export const UNAUTHENTICATED: Principal = {
  tokenId: '',
  role: 'editor',
  projects: [],
  authenticated: false,
};

/** A persisted MCP/API credential: the hashed bearer token bound server-side to
 *  an owner identity and a projects narrowing. The token carries NO permissions
 *  of its own — within its narrowing it acts as the owner user's LIVE permission
 *  (the resolver gates per project). The plaintext is never stored. */
export interface ApiKeyRecord {
  id: string;
  keyHash: string;
  /** Legacy coarse display role, optional and display-only — NOT an authority
   *  source. Set by the legacy master-only mintKey path; unset by the
   *  user-bound mint flows. */
  role?: DisplayRole;
  /** The project ids this token may act on, or ['*'] for the owner's full
   *  accessible set — the token's narrowing, not a grant. */
  projects: string[];
  createdAt: string;
  /** Human or service identity that owns this token — the identity it acts as. */
  ownerSubject?: PrincipalSubject;
  /** Identity that minted this token (when an admin creates it for someone else). */
  createdBySubject?: PrincipalSubject;
  /** Human-readable label for token administration and audit screens. */
  label?: string;
  /** Optional ISO-8601 expiration timestamp. */
  expiresAt?: string;
  /** ISO-8601 revocation timestamp when revoked instead of hard-deleted. */
  revokedAt?: string;
}

/** A hosted human or service-principal account bound to an identity subject.
 *  Links tokens, permission bindings, and audit events to a stable actor
 *  identity. Permissions live in roleBindings + the assignment grid — never on
 *  the record as grants. */
export interface HostedUserRecord {
  id: string;
  /** The identity this account is bound to (issuer, kind, external subject). */
  subject: PrincipalSubject;
  /** Lifecycle status collapsed to a single axis: 'active' or inactive (any
   *  non-'active' value). An inactive record is retained for audit provenance
   *  but the user cannot act. */
  status: string;
  createdAt: string;
  /** Human-readable display name (from the SSO id_token 'name'/'preferred_username'
   *  claim at provisioning, refreshed on re-login). Shown in the admin UI and
   *  audit views instead of the opaque subject id. */
  displayName?: string;
  /** Email address from the SSO id_token 'email' claim when present; shown
   *  alongside the display name so admins identify users by name/email. */
  email?: string;
  /** ISO-8601 timestamp of the user's most recent authenticated activity. */
  lastSeenAt?: string;
  /** The user's home organization unit; scoped user administration lists and
   *  filters users by their home unit subtree. */
  unitId?: string;
  /** Roles bound to this user, optionally scoped to a unit/project subtree;
   *  combined with direct assignments and everyone-defaults during resolution.
   *  Authorization is expressed ONLY here (plus the grid), never via grants. */
  roleBindings?: RoleBinding[];
}

/** A durable, redacted audit event: who acted, through which token, on what, with what outcome.
 *  Never contains raw bearer tokens, secrets, or full spec bodies. */
export interface AuditEvent {
  id: string;
  timestamp: string;
  /** 'debug' | 'info' | 'warning' | 'error' | 'security' */
  level: string;
  /** e.g. 'auth' | 'mcp' | 'admin' | 'project' | 'lock' | 'pack' | 'producer' | 'audit' */
  category: string;
  /** Canonical action name, e.g. 'mcp.tool.call', 'token.mint', 'user.create'. */
  action: string;
  /** 'success' | 'denied' | 'failed' | 'skipped' */
  outcome: string;
  /** Resolved identity responsible for the action. */
  actor: PrincipalSubject;
  /** Credential id used for the request — never the raw token. */
  tokenId?: string;
  projectId?: string;
  requestId?: string;
  /** Redacted target identifier: tool name, route, key id, pack name, … */
  target?: string;
  /** Small redacted diagnostic payload serialized by policy. */
  metadata?: string;
}

/** Admin filter for querying the audit log; unset fields match everything. */
export interface AuditQuery {
  projectId?: string;
  actorUserId?: string;
  tokenId?: string;
  category?: string;
  action?: string;
  outcome?: string;
  minimumLevel?: string;
  /** ISO-8601 inclusive time range bounds. */
  from?: string;
  to?: string;
  limit?: number;
}

/** One diagnostic check outcome inside an instance health report. */
export interface DiagnosticCheckResult {
  id: string;
  /** 'pass' | 'warn' | 'fail' */
  status: string;
  message: string;
  observedAt: string;
  details?: string;
}

/** Resource usage observed for one scope ('instance' or a project id). */
export interface ResourceUsageSnapshot {
  scope: string;
  capturedAt: string;
  projectCount?: number;
  projectBytes?: number;
  mcpRequestsLastMinute?: number;
  auditEventsToday?: number;
  /** Advisory observe/warn findings annotated by the quota specialist. */
  quotaMessages: string[];
}

/** Advisory quota policy protecting the instance; observe/warn only. */
export interface ResourceQuotaPolicy {
  enabled: boolean;
  maxProjectsPerUser?: number;
  maxMcpRequestsPerMinute?: number;
  maxProjectBytes?: number;
  maxAuditEventsPerDay?: number;
  /** 'observe' | 'warn' */
  mode: string;
}

/** The assembled read-only instance health report. */
export interface InstanceHealthReport {
  /** 'ok' | 'degraded' | 'unhealthy' */
  status: string;
  generatedAt: string;
  checks: DiagnosticCheckResult[];
  usage?: ResourceUsageSnapshot[];
}

/** Instance-level durable audit capture and retention policy. */
export interface AuditRetentionPolicy {
  enabled: boolean;
  /** Lowest event level that is captured at all. */
  minimumLevel: string;
  retentionDays: number;
  /** Optional longer retention for 'security'-level events. */
  securityRetentionDays?: number;
  /** Whether read-only actions are captured (high volume). */
  includeReadEvents: boolean;
  /** 'none' | 'redacted' | 'full-redacted' — how much metadata is persisted. */
  metadataMode: string;
}

/** A durable request for a privileged hosted action, awaiting an authorized decision.
 *  The payload is redacted — never raw secrets or bearer tokens. */
export interface ApprovalRequest {
  id: string;
  /** Requested action kind: 'project:init' | 'project:lock' | 'project:promote' (more later). */
  kind: string;
  /** 'pending' | 'approved' | 'denied' | 'expired' | 'completed' | 'cancelled' */
  status: string;
  /** Identity that requested the action. */
  requestedBy: PrincipalSubject;
  /** Credential id the request came through, when via MCP/HTTP auth. */
  requestedTokenId?: string;
  /** Hosted project affected, when project-scoped. */
  projectId?: string;
  /** Human-readable redacted summary for approval UI/CLI. */
  summary: string;
  /** Redacted payload type identifier, e.g. 'ProjectInitRequest'. */
  payloadType?: string;
  /** Small redacted serialized payload needed to execute the approved action. */
  payload?: string;
  createdAt: string;
  /** After this instant a pending approval is invalid. */
  expiresAt?: string;
  decidedAt?: string;
  decidedBy?: PrincipalSubject;
  decisionReason?: string;
}

/** A decision supplied by an authorized user/admin for a pending approval request. */
export interface ApprovalDecision {
  requestId: string;
  /** False means denied. */
  approved: boolean;
  reason?: string;
  /** Identity making the decision — MUST differ from the request's requestedBy. */
  decidedBy: PrincipalSubject;
  decidedAt: string;
}

/** The profile selection applied to a hosted project at initialization or reconciliation. */
export interface ProjectProfileSelection {
  profileIds: string[];
  requiredPackNames: string[];
  defaultPackNames?: string[];
  selectedBy?: PrincipalSubject;
  selectedAt: string;
}

/** A request to initialize a new hosted project (project-lifecycle tools,
 *  admin UI, CLI, or MCP-assisted setup). */
export interface ProjectInitRequest {
  id: string;
  displayName?: string;
  description?: string;
  /** The organization unit that owns the project. REQUIRED — every project is
   *  placed at creation so the permission resolver can always enumerate it; a
   *  fresh instance must create its first organization unit before
   *  initializing projects. */
  ownerUnitId: string;
  environment?: string;
  profileSelection?: ProjectProfileSelection;
}

/** The hosted instance's pack/profile policy governing project initialization. */
export interface InstancePackPolicy {
  id: string;
  /** Packs every project must carry. */
  requiredGlobalPacks: string[];
  /** Packs applied to new projects unless explicitly overridden. */
  defaultProjectPacks: string[];
  allowedProfileIds?: string[];
  requiredProfileIds?: string[];
  blockedPackNames?: string[];
  requireProfileSelection: boolean;
  /** 'warn' (findings surface, actions proceed) | 'block' (violations reject) |
   *  'auto_reconcile' (like warn, and reconcileProjectPolicy may install missing packs). */
  enforcementMode: string;
  updatedAt: string;
  updatedBy?: PrincipalSubject;
}

/** Outcome of evaluating a project (or init request) against the active pack policy. */
export interface PolicyEvaluationResult {
  compliant: boolean;
  /** The enforcement mode the evaluation ran under. */
  mode: string;
  missingPackNames: string[];
  blockedPackNames: string[];
  missingProfileIds: string[];
  /** Human-readable findings for summaries and UI. */
  messages: string[];
}

/** A node in the hosted organization hierarchy (department, team, domain, …). */
export interface OrganizationUnitRecord {
  /** Qualified dot-path identity from the org root: the parent's qualified id +
   *  '.' + slug (a root unit's id IS its slug), e.g. "company_a.it.team_a". The
   *  stable unique key referenced by placements.unitId, assignment scopeIds,
   *  user.unitId, and exposeTo[]. Uniqueness is enforced on this qualified path;
   *  a create or move onto an existing id is an error (never a silent
   *  overwrite). There is no hidden opaque key. */
  id: string;
  name: string;
  /** e.g. 'business_entity' | 'department' | 'team' | 'portfolio' | 'group' */
  kind: string;
  /** Local segment, unique among sibling units under the same parentId
   *  (top-level slugs are unique instance-wide). Lowercase [a-z0-9-], dot-free
   *  ('.' is the qualified-id separator). Reused freely across parents:
   *  company_a.it and company_b.it coexist. */
  slug: string;
  /** Qualified id of the parent organization unit; absent for a root/tenant unit. */
  parentId?: string;
  status: string;
  createdAt: string;
  createdBy: PrincipalSubject;
  /** Surface-visibility posture of this unit's subtree: 'inherit' (default — take
   *  the parent's posture; a root unit inherits 'open'), 'open', or 'closed'
   *  (placements hidden from everyone outside this unit's subtree except units
   *  granted via exposeTo). Tenant roots are always closed toward OTHER tenant
   *  roots — cross-tenant visibility exists only through exposeTo (fail-closed). */
  visibility?: string;
  /** Unit ids granted visibility into this unit's subtree placements — the
   *  allow-list that punches holes through a closed posture and the ONLY path
   *  across tenant roots. No deny-lists: restrict by placing sensitive projects
   *  in a closed group instead. */
  exposeTo?: string[];
}

/** Places (or shares) a hosted project into an organization unit. Visual grouping only —
 *  placements never confer reachability. */
export interface ProjectPlacement {
  id: string;
  projectId: string;
  unitId: string;
  /** e.g. 'owner' | 'shared' */
  role: string;
  createdAt: string;
  createdBy: PrincipalSubject;
}

/** Both collections of the organization store, loaded together. */
export interface OrganizationState {
  units: OrganizationUnitRecord[];
  placements: ProjectPlacement[];
}

/** The chosen resolution when removing an organization unit — a unit is never
 *  silently cascade-deleted; the caller picks what happens to its child units
 *  and project placements. Every non-cascade disposition is an explicit move
 *  that rewrites the moved subtree's qualified ids and every reference to them. */
export interface UnitDisposition {
  /** 'migrate' (content → an existing targetUnitId) | 'alternative' (create a
   *  new sibling newSlug/newName and move content in — how a rename/replace is
   *  expressed) | 'absorb' (content → the parent unit) | 'cascade' (delete this
   *  unit with its entire subtree and their placements). */
  kind: 'migrate' | 'alternative' | 'absorb' | 'cascade';
  /** Required for kind='migrate': the existing destination unit that adopts this
   *  unit's children/placements. Must exist and must not be this unit or one of
   *  its own descendants. */
  targetUnitId?: string;
  /** Required for kind='alternative': slug of a new unit created under the same
   *  parent (unique among siblings) into which all content is moved. */
  newSlug?: string;
  /** Optional display name for the 'alternative' replacement unit; defaults to
   *  the removed unit's name. */
  newName?: string;
}

/** Maps an organization unit's previous qualified id to its new one after a
 *  reparent or rename. reparentUnit returns one per moved unit (the unit plus
 *  every descendant) so callers rewrite every reference to the old id —
 *  placements, assignment scopes, user home units, and exposeTo lists. */
export interface UnitIdRemap {
  oldId: string;
  newId: string;
}

/** A remote project public surface consumed across project boundaries. */
export interface RemotePublicInterfaceRef {
  projectId: string;
  systemInterfaceId: string;
  version?: string;
  reason: string;
}

/** A directed cross-project relation: source consumes target's public interface. */
export interface ProjectRelationRecord {
  id: string;
  sourceProjectId: string;
  targetProjectId: string;
  /** e.g. 'consumes' | 'depends-on' | 'observes' */
  kind: string;
  /** The source-side client Adapter component id realizing the hop. */
  sourceAdapter: string;
  targetPublicInterface: RemotePublicInterfaceRef;
  reason: string;
  /** 'active' | 'suspended' | 'retired' — only active relations confer reachability. */
  status: string;
  createdAt: string;
  createdBy: PrincipalSubject;
}

/** A redacted summary of one published system-level interface. Never carries private
 *  components, narratives, implementations, root paths, or secrets. */
export interface PublicInterfaceSummary {
  id: string;
  name: string;
  type: string;
  audience: string;
  version?: string;
  stability?: string;
  methods: string[];
  endpoints?: string[];
  publicTypes?: string[];
  details: string;
}

/** A downloadable rendered surface document (generate-and-download, the diagram pattern). */
export interface SurfaceArtifact {
  body: string;
  contentType: string;
  filename: string;
}

/** The computed surface-visibility view of one observer project (visibility_specialist). */
export interface VisibilityResolution {
  observerProjectId: string;
  /** Units the observer's placements land in, plus their ancestor chains. */
  observerUnitIds: string[];
  /** Per visible target: the audience distance and the placement unit that granted visibility. */
  visibleProjects: { projectId: string; distance: 'department' | 'instance' | 'partner'; via: string }[];
}

/** One entry of the visibility-resolved discovery catalog (listVisibleSurfaces). */
export interface VisibleSurfaceEntry {
  projectId: string;
  distance: string;
  /** Redacted catalog summaries, already audience-filtered for this observer. */
  interfaces: PublicInterfaceSummary[];
}

/** The stored, redacted public surface of one hosted project at one spec state. */
export interface ProjectPublicSurfaceSnapshot {
  projectId: string;
  stateId: string;
  systemName: string;
  interfaces: PublicInterfaceSummary[];
  exportedAt: string;
  exportedBy?: PrincipalSubject;
}

/** One project id reachable from the caller's current project, with the relations
 *  that make it reachable. */
export interface ReachableProjectRef {
  projectId: string;
  relationIds: string[];
  relationKinds: string[];
  publicInterfaceIds: string[];
}

/** A node of the hosted landscape graph (unit, project, or public interface). */
export interface LandscapeNode {
  id: string;
  label: string;
  /** 'unit' | 'project' | 'interface' */
  nodeKind: string;
  projectId?: string;
  unitId?: string;
  publicInterfaceId?: string;
  status?: string;
  /** True when the caller can act on this scope. False/absent on an
   *  ancestor-breadcrumb (context) unit included only so the hierarchy stays
   *  navigable to the root — shown read-only, its non-visible children omitted.
   *  An instance-admin sees every node actionable. */
  actionable?: boolean;
}

/** A directed edge of the hosted landscape graph. */
export interface LandscapeEdge {
  from: string;
  to: string;
  /** 'hierarchy' | 'placement' | 'relation' */
  edgeKind: string;
  relationId?: string;
  label?: string;
}

/** The assembled hosted landscape graph. */
export interface LandscapeGraphModel {
  nodes: LandscapeNode[];
  edges: LandscapeEdge[];
  generatedAt: string;
  scope?: string;
}

/** An OIDC/SSO identity provider configuration. Never carries a raw client secret —
 *  clientSecretRef points into the host secret mechanism. */
export interface IdentityProviderConfig {
  id: string;
  /** e.g. 'oidc' | 'authentik' | 'keycloak' | 'google' | 'entra' */
  providerType: string;
  /** Optional admin-set human label, shown on the login screen's
   *  "Sign in with <displayName>" button. Defaults to the provider id when
   *  unset. Presentation only — never used for provider resolution. */
  displayName?: string;
  issuerUrl?: string;
  clientId?: string;
  clientSecretRef?: string;
  /** Email domains allowed to first-login provision, when set. */
  allowedDomains?: string[];
  /** Provider group claims that map to instance-admin, when set. */
  adminGroupClaims?: string[];
  /** Exact-match allowlist of redirect URIs accepted for this provider's SSO flow.
   *  When set and non-empty, a redirectUri not on the list is refused. When
   *  unset/empty, any redirectUri is accepted (backward compatible). */
  allowedRedirectUris?: string[];
  /** Explicit browser-facing (front-channel) authorization endpoint override.
   *  When set, wins over OIDC discovery and providerType templates. The PUBLIC URL
   *  the user's browser is redirected to; the split-horizon lever paired with an
   *  internal tokenEndpoint. */
  authorizationEndpoint?: string;
  /** Explicit server-facing (back-channel) token endpoint override. When set, wins
   *  over discovery/templates. The URL the host calls directly for code->token
   *  exchange, so it may be a VPC-internal address unreachable from the internet. */
  tokenEndpoint?: string;
  /** Explicit JWKS URI override for id_token signature verification (server-facing
   *  back-channel; may be VPC-internal). When unset, resolved from discovery or the
   *  providerType template. */
  jwksUri?: string;
  /** Explicit userinfo endpoint override (server-facing back-channel), used as a
   *  fallback identity-verification path when JWKS verification is unavailable. */
  userinfoEndpoint?: string;
  enabled: boolean;
  updatedAt: string;
}

/** The resolved set of OIDC endpoints for one identity provider, computed once by
 *  the identity provider adapter (from explicit config overrides, OIDC discovery, or
 *  a providerType template) and threaded through the authorization-URL build,
 *  code->token exchange, and id_token verification. Splits the browser-facing
 *  front-channel (authorizationEndpoint) from the server-facing back-channel
 *  (tokenEndpoint, jwksUri, userinfoEndpoint) so the two may live at different
 *  addresses (public authorize vs VPC-internal token/jwks). Mirrors
 *  .wai/specs/types/provider_endpoints.yaml. */
export interface ProviderEndpoints {
  /** The provider's canonical issuer identifier, matched against the id_token iss claim. */
  issuer: string;
  /** Browser-facing (front-channel) authorization endpoint the user agent is redirected to. */
  authorizationEndpoint: string;
  /** Server-facing (back-channel) token endpoint the host calls for code->token exchange. */
  tokenEndpoint: string;
  /** Server-facing JWKS URI providing the public keys for id_token signature verification. */
  jwksUri?: string;
  /** Server-facing userinfo endpoint used as a fallback verification path. */
  userinfoEndpoint?: string;
}

/** Reserved prefix marking a session id as a first-class web-session
 *  credential — transport and auth code brand-check credentials against it. */
export const WEB_SESSION_PREFIX = 'ws_';

/** A durable browser session for the hosted web UI. The session id (reserved
 *  prefix) is itself a first-class credential — it resolves to a Principal via
 *  authenticateCredential exactly like a bearer token, so the browser reuses
 *  every scoped endpoint. Created on SSO sign-in, removed on sign-out, expiring. */
export interface WebSession {
  id: string;
  subject: PrincipalSubject;
  /** The session's project narrowing ('*' = none). It stores no permissions:
   *  the single auth authority resolves permissionSubject (roleBindings +
   *  instanceAdmin) LIVE at authentication. */
  projects: string[];
  createdAt: string;
  expiresAt: string;
  lastSeenAt?: string;
  providerId?: string;
  /** Optional correlated user-bound token id, for correlated revocation; never
   *  a raw token. Unset when the session itself is the credential. */
  tokenId?: string;
}

/** One node of the web UI's level-of-detail architecture graph. */
export interface WebGraphNode {
  id: string;
  label: string;
  /** 'unit' | 'project' | 'subsystem' | 'component' | 'interface' | 'type' */
  kind: string;
  /** Detail level: lower = higher-level (landscape/subsystem), deeper = L2/L3. */
  level: number;
  /** Id of the containing node, for hierarchical expand/collapse. Spans the full
   *  environment tree: unit→unit (nested org hierarchy over the qualified unit
   *  paths), unit→project, project→subsystem, subsystem→component,
   *  component→interface. Absent only at the environment root. */
  parentId?: string;
  projectId?: string;
  status?: string;
  /** Count of validation issues on this node (overlaid on the project tier). */
  issueCount?: number;
  /** True when the caller can act on this scope. False/absent on an ancestor
   *  breadcrumb shown read-only only so the tree stays navigable to a deeper
   *  actionable scope (the no@org + yes@one-project case). Carried through from
   *  LandscapeNode.actionable on the landscape tier. */
  actionable?: boolean;
}

/** A level-of-detail graph payload for the web UI: the landscape tier, or one
 *  project's spec graph expanded to the requested level. */
export interface WebGraphModel {
  /** 'landscape' | 'project' */
  tier: string;
  nodes: WebGraphNode[];
  edges: LandscapeEdge[];
  /** The maximum detail level included. */
  level: number;
  generatedAt: string;
  scope?: string;
}

/** The pre-auth login-options projection the login screen renders from: which
 *  sign-in methods this hosted instance offers. Served UNAUTHENTICATED on the
 *  webUiEnabled-gated data plane, so it is deliberately minimal — a
 *  password-login flag plus enabled-provider ids and display labels (standard,
 *  safe pre-auth SSO discovery). NEVER carries secrets, clientIds, issuer URLs,
 *  endpoints, or any other provider config. Mirrors
 *  .wai/specs/types/web_login_options.yaml. */
export interface WebLoginOptions {
  /** Whether the built-in admin password login is configured (BOTH
   *  WAIRON_ADMIN_USER and WAIRON_ADMIN_PASSWORD set on the server). */
  passwordLogin: boolean;
  /** One entry per ENABLED identity provider — displayName is the admin-set
   *  label, defaulting to the provider id. Disabled providers never appear. */
  providers: { id: string; displayName: string }[];
}

/** The current principal's identity + derived capability flags, so the web
 *  client renders role-appropriately (an admin is a developer with more scope). */
export interface WebContext {
  subject: PrincipalSubject;
  /** True only for the env-anchored instance super-admin. Delegated/SSO admins
   *  are NOT flagged here — the client drives admin chrome from their
   *  project:admin visible scopes; every endpoint enforces server-side. */
  isAdmin: boolean;
  /** True when this context comes from the local developer server (`wairon dev`):
   *  the SAME reused client hides the tenancy/login/account chrome (Landscape tier,
   *  project picker, sign-out, admin badge) and renders the single local project
   *  only. Absent/false in the hosted multi-tenant UI. */
  local?: boolean;
}

/** A registered hosted project mapped to its isolated .wai/ root. */
export interface HostedProjectRecord {
  id: string;
  rootPath: string;
  status: 'active' | 'disabled';
  createdAt: string;
}

/** Runtime exposure posture for a hosted instance: which control-plane surfaces
 *  are bound over HTTP versus local/CLI-only. Mirrors
 *  .wai/specs/types/host_exposure_policy.yaml. */
export interface HostExposurePolicy {
  /** 'disabled' | 'local_only' | 'private_network' | 'public'. */
  adminApiMode: string;
  /** Whether the optional browser admin UI is served. */
  adminUiEnabled: boolean;
  /** Whether the draft identity/audit control-plane API is served over HTTP. */
  identityApiEnabled: boolean;
  /** Whether the draft landscape control-plane API is served over HTTP. */
  landscapeApiEnabled: boolean;
  /** Whether the draft project-policy control-plane API is served over HTTP. */
  projectPolicyApiEnabled: boolean;
  /** Whether local CLI/container execution may use the control workflows even
   *  when HTTP admin APIs are disabled. */
  cliControlEnabled: boolean;
  /** Whether externally exposed HTTP control-plane surfaces must sit behind TLS. */
  requireTls: boolean;
  /** Optional allowed browser origins for UI/control-plane requests. */
  allowedOrigins?: string[];
  /** Optional CIDR/network labels allowed to reach private-network surfaces. */
  allowedNetworks?: string[];
  /** Whether the operations (health/usage/quota) control-plane API is served over HTTP. */
  operationsApiEnabled: boolean;
  /** Whether the unified browser web UI (SSO sign-in + live level-of-detail graph)
   *  is served over HTTP on the DATA-plane listener. A NEW public surface, so it is
   *  OPT-IN: false in the compatible default — existing instances are unaffected. */
  webUiEnabled: boolean;
}

/** Resolved runtime configuration for the hosting server. */
export interface HostConfig {
  host: string;
  port: number;
  adminHost: string;
  adminPort: number;
  dataDir: string;
  authEnabled: boolean;
  /** Runtime control-plane exposure posture; the secure compatible default is
   *  resolved when omitted. */
  exposurePolicy?: HostExposurePolicy;
  /** Advisory (observe/warn) resource quota policy; a disabled default is
   *  resolved when omitted. Never blocks or throttles in this draft. */
  quotaPolicy?: ResourceQuotaPolicy;
  /** True only when the server runs as the local single-project developer server
   *  (`wairon dev`): loopback-bound, auth off, the one project = the current
   *  working directory. NEVER set by the hosted `serve` command, so the dev-only
   *  auto-session path can never appear in a real deployment. */
  devMode?: boolean;
  /** Built-in super-admin web-login username, read from WAIRON_ADMIN_USER by the
   *  serve command. When this or builtinAdminPassword is unset, password login is
   *  disabled (SSO-only) — the server still starts. */
  builtinAdminUser?: string;
  /** Built-in super-admin web-login password, read from WAIRON_ADMIN_PASSWORD by
   *  the serve command. Held in memory only — never persisted or logged; compared
   *  constant-time by the auth specialist. */
  builtinAdminPassword?: string;
}

/** Outcome of a gated promote — never an actual merge. */
export interface PromoteResult {
  status: 'ready' | 'stale' | 'not-locked';
  stateId?: StateId;
  message: string;
}

/** The standardized result of a project lifecycle action (initialize/lock/promote).
 *  EXECUTE-PRIMARY: when the caller is authorized the action RUNS and status is
 *  'completed' with the natural result; when their effective permission is
 *  'approval' the action is not run and status is 'pending-approval' carrying
 *  the created request. A 'no' permission never returns this — it raises Forbidden. */
export interface ProjectActionOutcome {
  status: 'completed' | 'pending-approval';
  action: 'project:init' | 'project:lock' | 'project:promote';
  /** Human-readable outcome: the result detail when completed, or that a
   *  request was submitted when pending-approval. */
  summary: string;
  /** The pending approval request — only when status is 'pending-approval'. */
  approval?: ApprovalRequest;
  /** The lock record, present when a project:lock completed. */
  lock?: LockRecord;
  /** The promote result, present when a project:promote completed. */
  promote?: PromoteResult;
}

/** A verified short-lived capability to view one project's diagram in a browser —
 *  the decoded, signature-checked, unexpired payload of a signed view link. */
export interface ViewGrant {
  project: string;
  format: string;
  expiresAt: string;
}

/** The result of probing one extension pack: its declared name, where it lives,
 *  and how many profiles/languages/rules it contributes — or its load error. */
export interface PackDescriptor {
  name: string;
  scope: 'global' | 'project';
  ref: string;
  profiles: number;
  languages: number;
  rules: number;
  error?: string;
  /** Which global tier the pack came from: 'image' (immutable, baked into an
   *  extended image at WAIRON_IMAGE_PACKS_DIR) or 'instance' (mutable, on the
   *  data volume). Absent for project-scoped packs. */
  tier?: string;
  /** True on an image-tier pack shadowed by a same-named instance pack
   *  (instance wins; shadowing is drift and surfaces in the health report). */
  shadowed?: boolean;
}

/** A project's declared pack/profile references — path-free, safe for
 *  redacted diagnostics. */
export interface ProjectPackReference {
  projectId: string;
  packNames: string[];
  profileIds?: string[];
}
