import type { StateId } from '../core/statehash.js';

// ---------------------------------------------------------------------------
// Hosting value types (sdd_host)
// ---------------------------------------------------------------------------

export type Role = 'editor' | 'admin';

/** The authenticated caller identity and authorized scope. Transient. */
export interface Principal {
  tokenId: string;
  role: Role;
  /** Authorized project ids, or ['*'] for all. */
  projects: string[];
  authenticated: boolean;
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
