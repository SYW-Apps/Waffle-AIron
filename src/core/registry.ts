import { loadRegistry, saveRegistry } from '../config/loader.js';
import { AgentRecord } from '../models/agent.js';
import { Registry } from '../models/registry.js';
import { WaironError } from '../utils/errors.js';

// ---------------------------------------------------------------------------
// Registry operations
//
// All mutations go through these functions so validation stays centralised.
// ---------------------------------------------------------------------------

/**
 * Add an agent to the registry.
 * Throws if an agent with the same id already exists.
 */
export function addAgent(agent: AgentRecord): void {
  const registry = loadRegistry();

  if (registry.agents.some((a) => a.id === agent.id)) {
    throw new WaironError(`Agent with id "${agent.id}" already exists in the registry.`);
  }

  registry.agents.push(agent);
  saveRegistry(registry);
}

/**
 * Update an existing agent in the registry.
 * Throws if the agent does not exist.
 */
export function updateAgent(updated: AgentRecord): void {
  const registry = loadRegistry();

  const index = registry.agents.findIndex((a) => a.id === updated.id);
  if (index === -1) {
    throw new WaironError(`Agent "${updated.id}" not found in registry.`);
  }

  updated.updatedAt = new Date().toISOString();
  registry.agents[index] = updated;
  saveRegistry(registry);
}

/**
 * Look up an agent by id. Returns undefined if not found.
 */
export function findAgent(id: string): AgentRecord | undefined {
  const registry = loadRegistry();
  return registry.agents.find((a) => a.id === id);
}

/**
 * Return all agents in the registry.
 */
export function listAgents(): AgentRecord[] {
  const registry = loadRegistry();
  return registry.agents;
}

/**
 * Remove an agent from the registry by id.
 * Throws if not found.
 */
export function removeAgent(id: string): void {
  const registry = loadRegistry();

  const index = registry.agents.findIndex((a) => a.id === id);
  if (index === -1) {
    throw new WaironError(`Agent "${id}" not found in registry.`);
  }

  registry.agents.splice(index, 1);
  saveRegistry(registry);
}

/**
 * Replace the entire registry (used by bulk operations like generate).
 */
export function replaceRegistry(registry: Registry): void {
  saveRegistry(registry);
}
