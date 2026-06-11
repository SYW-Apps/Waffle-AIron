import { z } from 'zod';

// ---------------------------------------------------------------------------
// Output target definitions
// ---------------------------------------------------------------------------

export const BuiltinTargetSchema = z.enum(['claude', 'gemini']);
export type BuiltinTarget = z.infer<typeof BuiltinTargetSchema>;

export const CustomTargetSchema = z.object({
  type: z.literal('custom'),
  /** Human-readable label for this target, e.g. "Cursor" */
  label: z.string(),
  /** Root output directory relative to the project root, e.g. ".cursor/agents" */
  outputDir: z.string(),
});
export type CustomTarget = z.infer<typeof CustomTargetSchema>;

export const OutputTargetSchema = z.union([BuiltinTargetSchema, CustomTargetSchema]);
export type OutputTarget = z.infer<typeof OutputTargetSchema>;

// ---------------------------------------------------------------------------
// Agent status
// ---------------------------------------------------------------------------

export const AgentStatusSchema = z.enum(['active', 'draft', 'deprecated']);
export type AgentStatus = z.infer<typeof AgentStatusSchema>;

// ---------------------------------------------------------------------------
// Core agent record — the internal source-of-truth representation
// ---------------------------------------------------------------------------

export const AgentRecordSchema = z.object({
  /** Unique identifier within this project, e.g. "core-service-owner" */
  id: z.string().regex(/^[a-z0-9-_]+$/, 'Agent id must be lowercase alphanumeric with dashes or underscores'),

  /** Human-readable display name */
  name: z.string(),

  /** Short description of what this agent is responsible for */
  description: z.string(),

  /** Template id this agent was created from, e.g. "domain-owner" */
  template: z.string(),

  /** Bundle id this agent was created as part of, if applicable */
  bundleOrigin: z.string().optional(),

  /**
   * The domain id this agent is canonically owned by.
   * null / undefined = root project agent.
   *
   * When set, the agent is generated in two forms:
   *   1. Standalone (full authority) → written to <domainPath>/<target>/agents/<id>.md
   *   2. Project reference (scoped)  → written to <root>/<target>/agents/<id>.md
   *      (only if domain.propagation !== 'none')
   */
  domainRoot: z.string().optional(),

  /**
   * Paths this agent owns, expressed relative to the project root.
   * e.g. ["services/core/**"]
   *
   * When generating the standalone (subdomain) version, these are automatically
   * converted to domain-relative paths (e.g. ["**"]).
   */
  ownedPaths: z.array(z.string()).default([]),

  /** Paths this agent may read but does not own */
  readPaths: z.array(z.string()).default([]),

  /** Paths this agent may write to but does not own */
  writePaths: z.array(z.string()).default([]),

  /** Classification tags, e.g. ["service", "backend", "critical"] */
  tags: z.array(z.string()).default([]),

  /** Ids of related agents this agent should be aware of */
  dependencies: z.array(z.string()).default([]),

  /** Why this agent was created — the architectural reason for its existence */
  creationReason: z.string(),

  status: AgentStatusSchema.default('active'),

  /** Which output targets should receive this agent's generated file */
  targets: z.array(OutputTargetSchema).default(['claude']),

  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export type AgentRecord = z.infer<typeof AgentRecordSchema>;

// ---------------------------------------------------------------------------
// Helper: create a minimal valid agent record (useful in tests / stubs)
// ---------------------------------------------------------------------------

export function createAgentRecord(
  partial: Pick<AgentRecord, 'id' | 'name' | 'template' | 'creationReason'> &
    Partial<AgentRecord>,
): AgentRecord {
  const now = new Date().toISOString();
  return AgentRecordSchema.parse({
    description: '',
    ownedPaths: [],
    readPaths: [],
    writePaths: [],
    tags: [],
    dependencies: [],
    status: 'active',
    targets: ['claude'],
    createdAt: now,
    updatedAt: now,
    ...partial,
  });
}
