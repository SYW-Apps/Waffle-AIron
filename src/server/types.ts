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
