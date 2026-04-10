import { z } from 'zod';

// ---------------------------------------------------------------------------
// Domain — a tracked architectural scope within the project
//
// A domain maps to a real directory boundary: a git submodule, a nested
// git repo, a package root, or a manually defined path.
//
// Domains are the unit of agent ownership and delegation. Each domain:
//   - owns a directory subtree
//   - has its own agent files co-located in that directory
//   - can have lightweight reference agents propagated to parent domains
//   - can receive delegated jobs from parent agents
// ---------------------------------------------------------------------------

export const DomainTypeSchema = z.enum([
  'root',           // the master project root — always exactly one
  'git-submodule',  // declared in .gitmodules
  'git-repo',       // directory containing a .git folder (not declared as submodule)
  'package-root',   // directory containing package.json / pyproject.toml / Cargo.toml / go.mod
  'manual',         // explicitly added by the user — no auto-detection signal
]);
export type DomainType = z.infer<typeof DomainTypeSchema>;

export const PropagationSchema = z.enum([
  'flat',         // propagate lightweight reference agents all the way up to root
  'parent-only',  // propagate one level up only
  'none',         // no propagation — only accessible via waffagent delegate
]);
export type Propagation = z.infer<typeof PropagationSchema>;

export const DomainStatusSchema = z.enum([
  'active',    // tracked and generating agents
  'excluded',  // detected but deliberately excluded by user
  'pending',   // detected but not yet confirmed by user
]);
export type DomainStatus = z.infer<typeof DomainStatusSchema>;

export const DomainSchema = z.object({
  /** Unique identifier within the project, e.g. "core-service" */
  id: z.string().regex(/^[a-z0-9-]+$/, 'Domain id must be lowercase alphanumeric with dashes'),

  /** Display name */
  name: z.string(),

  /** Path relative to project root, e.g. "services/core" */
  path: z.string(),

  type: DomainTypeSchema,

  /** Parent domain id. null for root. */
  parent: z.string().nullable().default(null),

  /**
   * How agents from this domain propagate to parent domains.
   *
   * flat        → lightweight reference agents appear at root and all parents
   * parent-only → only the immediate parent gets reference agents
   * none        → no propagation; use `waffagent delegate` to work in this domain
   *
   * Default is 'flat' because most users work from the root project.
   */
  propagation: PropagationSchema.default('flat'),

  status: DomainStatusSchema.default('active'),

  /** When this domain was first detected by the scanner */
  detectedAt: z.string().datetime().optional(),

  /** When this domain was added to the registry */
  addedAt: z.string().datetime(),
});

export type Domain = z.infer<typeof DomainSchema>;

// ---------------------------------------------------------------------------
// Domain registry — lives at .ai/registry/domains.json
// ---------------------------------------------------------------------------

export const DomainRegistrySchema = z.object({
  schemaVersion: z.string().default('1.0.0'),
  domains: z.array(DomainSchema).default([]),
  updatedAt: z.string().datetime(),
});
export type DomainRegistry = z.infer<typeof DomainRegistrySchema>;

export function createEmptyDomainRegistry(): DomainRegistry {
  return {
    schemaVersion: '1.0.0',
    domains: [],
    updatedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Detected domain candidate — result of the scanner before user confirmation
// ---------------------------------------------------------------------------

export interface DetectedDomainCandidate {
  /** Suggested id derived from path */
  suggestedId: string;
  /** Suggested display name */
  suggestedName: string;
  /** Path relative to project root */
  path: string;
  type: DomainType;
  /** Whether this domain is already tracked */
  alreadyTracked: boolean;
}
