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
  /** Optional ISO-8601 expiry for temporary grants. */
  expiresAt?: string;
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
  enabled: boolean;
  updatedAt: string;
}

/** A registered hosted project mapped to its isolated .wai/ root. */
export interface HostedProjectRecord {
  id: string;
  rootPath: string;
  status: 'active' | 'disabled';
  createdAt: string;
}

/** Resolved runtime configuration for the hosting server. */
export interface HostConfig {
  host: string;
  port: number;
  adminHost: string;
  adminPort: number;
  dataDir: string;
  authEnabled: boolean;
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
}
