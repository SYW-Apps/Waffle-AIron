import { z } from 'zod';

// ---------------------------------------------------------------------------
// Output target definitions
// ---------------------------------------------------------------------------

export const BuiltinTargetSchema = z.enum(['claude', 'gemini', 'agy', 'cursor', 'copilot', 'codex']);
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
   * The domain id this agent is responsible for (a subsystem id or a
   * free-standing domain id). Undefined = root-level agent.
   */
  domainRoot: z.string().optional(),

  /**
   * Paths this agent owns, expressed relative to the project root.
   * e.g. ["services/core/**"]
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

  /** Rendered implementation guidance for this agent's variant-tagged components (deep variant integration); empty when none. */
  variantGuidance: z.string().optional(),

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
// Live delegation brief — composed on demand from the CURRENT spec tree
// (never persisted, never stale); the dynamic replacement for generate-time
// agent files, served over MCP.
// ---------------------------------------------------------------------------

export const AgentTemplateSchema = z.object({
  /** Template identifier (architect, domain-owner, implementer, …) */
  templateName: z.string(),

  /** The raw instruction body with {{variable}} placeholders, before rendering */
  instructions: z.string(),
});

export type AgentTemplate = z.infer<typeof AgentTemplateSchema>;

export const AgentBriefSchema = z.object({
  /** The resolved agent's stable id (e.g. sdd_core-owner, system-architect) */
  agentId: z.string(),

  /** Human-readable display name of the agent */
  name: z.string(),

  /** The instruction template the brief was rendered from */
  template: z.string(),

  /** Domain the agent belongs to (absent = global root) */
  domainRoot: z.string().optional(),

  /** Glob patterns of the files this agent owns — the write-scope fence */
  ownedPaths: z.array(z.string()),

  /** Spec paths the subagent should read first */
  readPaths: z.array(z.string()).optional(),

  /** The fully rendered instruction body — paste-ready as a subagent prompt */
  instructions: z.string(),

  /** Rendered variant guidance, also folded into instructions */
  variantGuidance: z.string().optional(),
});

export type AgentBrief = z.infer<typeof AgentBriefSchema>;

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
