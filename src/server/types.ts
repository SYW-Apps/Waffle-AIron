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
