import { z } from 'zod';
import { AgentRecordSchema } from './agent.js';

// ---------------------------------------------------------------------------
// Registry — lives at .wai/registry/agents.json
//
// The registry is the authoritative list of all agents defined for this project.
// It is managed programmatically by the CLI and should not be edited by hand
// (though it is human-readable for inspection).
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
