import { z } from 'zod';

// ---------------------------------------------------------------------------
// Domain — a unit of agent ownership / responsibility in the topology.
//
// A *subsystem* (L1 spec) is a software unit; a *domain* is who owns a scope.
// Every subsystem yields a domain; not every domain comes from a subsystem.
//
// Two flavours:
//   - Spec-backed: derived from an L1 subsystem (boundTo = subsystem id).
//     Not hand-maintained — produced by resolveDomains() from the spec tree.
//   - Free-standing: declared in .wai/topology.yaml for cross-cutting scopes
//     (docs, infra, packages) that are not a software subsystem.
// ---------------------------------------------------------------------------

export const DomainSchema = z.object({
  /** Unique identifier within the project, e.g. "billing" or "docs". */
  id: z.string().regex(/^[a-z0-9-_]+$/, 'Domain id must be lowercase alphanumeric with dashes or underscores'),

  /** Optional display name. */
  name: z.string().optional(),

  /** Optional description of the domain's responsibility. */
  description: z.string().optional(),

  /**
   * The spec node this domain binds to: a subsystem id (the common case) or a
   * component id. Omitted means the domain is free-standing.
   */
  boundTo: z.string().optional(),

  /** Glob patterns this domain owns. Derived for spec-backed, authored for free-standing. */
  ownedPaths: z.array(z.string()).default([]),

  /** Optional physical directory (e.g. a monorepo package or submodule root). */
  path: z.string().optional(),
});

export type Domain = z.infer<typeof DomainSchema>;

// ---------------------------------------------------------------------------
// Topology config — lives at .wai/topology.yaml
//
// Holds only FREE-STANDING domains. Spec-backed domains are derived from the
// spec tree at read time (resolveDomains) and are never stored here.
// ---------------------------------------------------------------------------

export const TopologyConfigSchema = z.object({
  schemaVersion: z.string().default('1.0.0'),
  domains: z.array(DomainSchema).default([]),
});
export type TopologyConfig = z.infer<typeof TopologyConfigSchema>;

export function createEmptyTopologyConfig(): TopologyConfig {
  return { schemaVersion: '1.0.0', domains: [] };
}

// ---------------------------------------------------------------------------
// Detection — physical directory candidates (the `domains scan` helper).
// These describe *candidates* before the user adds them as free-standing
// domains; they are not the stored domain shape.
// ---------------------------------------------------------------------------

export const DomainTypeSchema = z.enum([
  'git-submodule',  // declared in .gitmodules
  'git-repo',       // directory containing a .git folder
  'package-root',   // directory with package.json / pyproject.toml / Cargo.toml / go.mod
  'manual',         // explicitly added by the user
]);
export type DomainType = z.infer<typeof DomainTypeSchema>;

export interface DetectedDomainCandidate {
  /** Suggested id derived from path */
  suggestedId: string;
  /** Suggested display name */
  suggestedName: string;
  /** Path relative to project root */
  path: string;
  type: DomainType;
  /** Whether this path is already covered by an existing domain */
  alreadyTracked: boolean;
}
