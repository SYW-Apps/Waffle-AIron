import type { StateId } from '../core/statehash.js';

// ---------------------------------------------------------------------------
// Hosting value types (sdd_host)
// ---------------------------------------------------------------------------

export type Role = 'editor' | 'admin';

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

/** Server-side authorization grant binding a principal/token to a hosted project
 *  and a precise permission set. Callers may not self-assert grants. */
export interface ProjectGrant {
  /** Hosted project id the grant applies to, or '*' for an instance-wide grant. */
  projectId: string;
  /** Permission identifiers such as 'mcp:read', 'mcp:write', 'key:manage', or '*'. */
  permissions: string[];
  /** Optional coarse display role derived from permissions ('viewer'…'admin'). */
  role?: string;
  /** When set, the grant is scoped to an organization unit: it covers every
   *  hosted project placed in that unit AND all descendant units (recursive
   *  subtree). '*' in projectId remains the instance-wide super-admin scope. */
  orgUnitId?: string;
  /** Optional ISO-8601 expiry for temporary grants. */
  expiresAt?: string;
}

/** The set of hosted projects/units a principal may act on for a permission —
 *  or `all` for an instance-wide ('*') super-admin, meaning no filtering. */
export interface ScopeResolution {
  /** True = super-admin: unrestricted, projectIds/unitIds are not consulted. */
  all: boolean;
  /** In-scope project ids (empty when all=true — callers short-circuit on all). */
  projectIds: string[];
  /** In-scope unit ids (the resolved subtree) — used to filter users by home unit. */
  unitIds: string[];
}

/** The authenticated caller identity and authorized scope. Transient. The
 *  role/projects fields remain a coarse compatibility projection; precise
 *  authorization is expressed by grants. */
export interface Principal {
  tokenId: string;
  role: Role;
  /** Authorized project ids, or ['*'] for all. */
  projects: string[];
  authenticated: boolean;
  /** Resolved human, service, or bootstrap identity behind the action. */
  subject?: PrincipalSubject;
  /** Precise server-derived project and instance permissions. */
  grants?: ProjectGrant[];
}

export const UNAUTHENTICATED: Principal = {
  tokenId: '',
  role: 'editor',
  projects: [],
  authenticated: false,
};

/** A persisted API-key credential (the plaintext is never stored). */
export interface ApiKeyRecord {
  id: string;
  keyHash: string;
  role: Role;
  projects: string[];
  createdAt: string;
  /** Human or service identity that owns this token. */
  ownerSubject?: PrincipalSubject;
  /** Identity that minted this token (when an admin creates it for someone else). */
  createdBySubject?: PrincipalSubject;
  /** Precise project and instance permissions granted to this token. */
  grants?: ProjectGrant[];
  /** Human-readable label for token administration and audit screens. */
  label?: string;
  /** Optional ISO-8601 expiration timestamp. */
  expiresAt?: string;
  /** ISO-8601 revocation timestamp when revoked instead of hard-deleted. */
  revokedAt?: string;
}

/** A hosted human or service-principal account bound to an identity subject. */
export interface HostedUserRecord {
  id: string;
  /** The identity this account is bound to (issuer, kind, external subject). */
  subject: PrincipalSubject;
  /** Lifecycle status: 'active' | 'suspended' | 'deactivated'. */
  status: string;
  /** Project and instance permissions granted to this user. */
  grants: ProjectGrant[];
  createdAt: string;
  /** ISO-8601 timestamp of the user's most recent authenticated activity. */
  lastSeenAt?: string;
  /** The user's home organization unit; scoped user administration lists and
   *  filters users by their home unit subtree. */
  unitId?: string;
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

/** A self-service request to initialize a new hosted project. */
export interface ProjectInitRequest {
  id: string;
  displayName?: string;
  description?: string;
  ownerUnitId?: string;
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
  id: string;
  name: string;
  /** e.g. 'organization' | 'department' | 'team' | 'domain' */
  kind: string;
  /** Parent unit id; absent on root units. (Type spec marks this required — narrative
   *  says "when set"; root units omit it. Flagged for a type-spec fix.) */
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
  grants: ProjectGrant[];
  createdAt: string;
  expiresAt: string;
  lastSeenAt?: string;
  providerId?: string;
  /** Optional correlated user-bound token id, for correlated revocation. */
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
  parentId?: string;
  projectId?: string;
  status?: string;
  /** Count of validation issues on this node (overlaid on the project tier). */
  issueCount?: number;
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

/** The current principal's identity + derived capability flags, so the web
 *  client renders role-appropriately (an admin is a developer with more scope). */
export interface WebContext {
  subject: PrincipalSubject;
  grants: ProjectGrant[];
  isAdmin: boolean;
  canWriteProjects: boolean;
  visibleProjectIds: string[];
  visibleUnitIds: string[];
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
}

/** Outcome of a gated promote — never an actual merge. */
export interface PromoteResult {
  status: 'ready' | 'stale' | 'not-locked';
  stateId?: StateId;
  message: string;
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
