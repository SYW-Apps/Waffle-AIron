import { z } from 'zod';
import { AgentRecordSchema } from './agent.js';

// ---------------------------------------------------------------------------
// Registry — the in-memory agent set
//
// Agents are derived from the SDD spec tree (resolveAgentTopology); this is the
// in-memory shape returned by loadRegistry(). There is no hand-maintained
// agents.json — generated agent files are outputs, not a source of truth.
//
// JSON is used (not YAML) because:
// - The registry is primarily written by the CLI, not by humans
// - JSON is universally parseable with no ambiguity
// - Diffs are clear and predictable in version control
// ---------------------------------------------------------------------------

export const RegistrySchema = z.object({
  schemaVersion: z.string().default('1.0.0'),
  agents: z.array(AgentRecordSchema).default([]),
  updatedAt: z.string().datetime(),
});

export type Registry = z.infer<typeof RegistrySchema>;

export function createEmptyRegistry(): Registry {
  return {
    schemaVersion: '1.0.0',
    agents: [],
    updatedAt: new Date().toISOString(),
  };
}
