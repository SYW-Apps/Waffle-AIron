/**
 * Client-side mirrors of the host's /web JSON contract (src/server/types.ts).
 * Only the fields the UI consumes are modeled; the server remains authoritative.
 */

export type Capability =
  | 'project:read'
  | 'project:create'
  | 'project:write'
  | 'project:admin'
  | 'approval:decide'
  | 'share:create';
export type PermissionValue = 'yes' | 'approval' | 'no' | 'inherit';
export type ScopeKind = 'instance' | 'unit' | 'project';

export const CAPABILITIES: Capability[] = [
  'project:read',
  'project:create',
  'project:write',
  'project:admin',
  'approval:decide',
  'share:create',
];

export const PERMISSION_VALUES: PermissionValue[] = ['inherit', 'yes', 'approval', 'no'];

export interface PrincipalSubject {
  userId: string;
  kind: string;
  issuer: string;
  externalId?: string;
  displayName?: string;
  email?: string;
}

export interface RoleBinding {
  roleId: string;
  scopeKind?: ScopeKind;
  scopeId?: string;
}

export interface RolePermission {
  capability: Capability;
  value: PermissionValue;
}

export interface Role {
  id: string;
  name: string;
  description?: string;
  permissions: RolePermission[];
  createdAt: string;
  builtin?: boolean;
}

export interface PermissionAssignment {
  id: string;
  subjectKind: 'user' | 'everyone';
  subjectId?: string;
  scopeKind: ScopeKind;
  scopeId?: string;
  capability: Capability;
  value: PermissionValue;
  createdAt: string;
}

export interface HostedUserRecord {
  id: string;
  subject: PrincipalSubject;
  status: string;
  createdAt: string;
  displayName?: string;
  email?: string;
  lastSeenAt?: string;
  unitId?: string;
  roleBindings?: RoleBinding[];
}

export interface OrganizationUnitRecord {
  id: string;
  name: string;
  kind: string;
  slug: string;
  parentId?: string;
  status: string;
  visibility?: string;
  exposeTo?: string[];
}

export interface ProjectRecord {
  id: string;
  status: string;
  unitId?: string;
}

export interface WebContext {
  subject: PrincipalSubject;
  isAdmin: boolean;
  local?: boolean;
}

// ── Per-project ops ──────────────────────────────────────────────────────────

export interface PackDescriptor {
  name: string;
  scope: 'global' | 'project';
  ref: string;
  profiles: number;
  languages: number;
  rules: number;
  /** Enriched contents: the concrete ids each pack contributes (optional — the
   *  server may send only the numeric counts on some endpoints). */
  profileIds?: string[];
  languageIds?: string[];
  ruleIds?: string[];
  error?: string;
  tier?: string;
  /** True when a higher tier already provides a pack of the same name. */
  shadowed?: boolean;
}

/** A profile the instance policy can allow/require, sourced from the built-in set
 *  or a specific installed pack (grouped by `source` in the policy pickers). */
export interface AvailableProfile {
  id: string;
  /** "builtin" or the name of the pack that provides it. */
  source: string;
  family?: string;
  description?: string;
}

export interface PolicyEvaluationResult {
  compliant: boolean;
  mode: string;
  missingPackNames: string[];
  blockedPackNames: string[];
  missingProfileIds: string[];
  messages: string[];
}

export interface ProducerConfig {
  target: string;
  parentPageId: string;
}

export interface GitBackingStatus {
  enabled: boolean;
  remote?: string;
  branch?: string;
  workingBranch?: string;
  dirty?: boolean;
  periodicSyncMinutes?: number;
  skipIfClean?: boolean;
  lastSyncAt?: string;
  /** Secret-store key of this connection's own PAT, when it has one. */
  credentialRef?: string;
}

// ── Public share links ────────────────────────────────────────────────────────

export interface ShareLink {
  id: string;
  projectId: string;
  view: string;
  snapshotId: string;
  mode: string;
  enabled: boolean;
  expiresAt?: string;
  allowDownloadHtml: boolean;
  allowDownloadOpenapi: boolean;
  frameAncestors: string[];
  createdAt: string;
}

export interface ShareLinkCreated {
  link: ShareLink;
  /** The raw token — shown to the creator exactly once. */
  token: string;
}

export interface ShareAccessEntry {
  id: string;
  linkId: string;
  at: string;
  ip: string;
  userAgent: string;
  referer?: string;
  outcome: string;
}

// ── Instance health / diagnostics ─────────────────────────────────────────────

export interface DiagnosticCheckResult {
  id: string;
  status: string; // 'pass' | 'warn' | 'fail'
  message: string;
  observedAt: string;
  details?: string;
}

export interface ResourceUsageSnapshot {
  scope: string;
  capturedAt: string;
  projectCount?: number;
  projectBytes?: number;
  mcpRequestsLastMinute?: number;
  auditEventsToday?: number;
  quotaMessages: string[];
}

export interface InstanceHealthReport {
  status: string; // 'ok' | 'degraded' | 'unhealthy'
  generatedAt: string;
  checks: DiagnosticCheckResult[];
  usage?: ResourceUsageSnapshot[];
}

// ── Identity providers / tokens / approvals / audit / instance policy ────────

export interface IdentityProviderConfig {
  id: string;
  providerType: string;
  displayName?: string;
  issuerUrl?: string;
  clientId?: string;
  clientSecretRef?: string;
  allowedDomains?: string[];
  adminGroupClaims?: string[];
  allowedRedirectUris?: string[];
  authorizationEndpoint?: string;
  tokenEndpoint?: string;
  jwksUri?: string;
  userinfoEndpoint?: string;
  enabled: boolean;
  updatedAt?: string;
}

export interface ApiKeyRecord {
  id: string;
  projects: string[];
  createdAt: string;
  label?: string;
  ownerSubject?: PrincipalSubject;
  expiresAt?: string;
  revokedAt?: string;
}

export interface ApprovalRequest {
  id: string;
  kind: string;
  status: string;
  requestedBy: PrincipalSubject;
  projectId?: string;
  summary: string;
  createdAt: string;
  expiresAt?: string;
}

export interface AuditEvent {
  id: string;
  timestamp: string;
  level: string;
  category: string;
  action: string;
  outcome: string;
  actor: PrincipalSubject;
  projectId?: string;
  target?: string;
  metadata?: string;
}

export interface InstancePackPolicy {
  id: string;
  requiredGlobalPacks: string[];
  defaultProjectPacks: string[];
  allowedProfileIds?: string[];
  requiredProfileIds?: string[];
  blockedPackNames?: string[];
  requireProfileSelection: boolean;
  enforcementMode: string;
}

export interface HostExposurePolicy {
  adminApiMode: string;
  adminUiEnabled: boolean;
  identityApiEnabled: boolean;
  landscapeApiEnabled: boolean;
  projectPolicyApiEnabled: boolean;
  cliControlEnabled: boolean;
  requireTls: boolean;
  allowedOrigins?: string[];
  allowedNetworks?: string[];
  operationsApiEnabled: boolean;
  webUiEnabled: boolean;
}

export interface GitBackingBinding {
  id: string;
  scopeKind: string;
  scopeId?: string;
  remote: string;
  branch?: string;
  lastSyncAt?: string;
  /** Secret-store key of this connection's own PAT, when it has one. */
  credentialRef?: string;
  /** Instance scope: also mirror hashed credential records. */
  includeCredentials?: boolean;
}

/** The best human label for a user or subject: name, then email, then a short id. */
export function subjectLabel(s: { displayName?: string; email?: string; userId?: string }): string {
  if (s.displayName && s.displayName.trim()) return s.displayName;
  if (s.email && s.email.trim()) return s.email;
  const id = s.userId ?? '';
  return id.length > 24 ? id.slice(0, 10) + '…' + id.slice(-6) : id || 'unknown';
}

export function userLabel(u: HostedUserRecord): string {
  return subjectLabel({ displayName: u.displayName, email: u.email, userId: u.subject?.userId ?? u.id });
}
