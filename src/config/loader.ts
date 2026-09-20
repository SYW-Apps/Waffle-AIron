import { pathExists } from '../utils/fs.js';
import { readYamlFile, writeYamlFile } from '../utils/yaml.js';
import {  TopologyConfig,
  TopologyConfigSchema,
  createEmptyTopologyConfig,
} from '../models/index.js';
import { AI_PATHS, assertProjectInitialized } from './paths.js';

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/**
 * Resolve the agent registry. The SDD spec tree (.wai/specs/) is the single
 * source of truth for agents — the topology is always derived from it via
 * resolveAgentTopology(), never read from a hand-maintained agents.json.
 * Returns an empty registry when no system spec exists yet.
 */

// ---------------------------------------------------------------------------
// Topology config (free-standing domains) — .wai/topology.yaml
//
// Spec-backed domains are derived from the spec tree at read time and are NOT
// stored here. This file holds only free-standing (cross-cutting) domains.
// ---------------------------------------------------------------------------

export function loadTopologyConfig(): TopologyConfig {
  assertProjectInitialized();
  if (!pathExists(AI_PATHS.topologyConfig())) return createEmptyTopologyConfig();
  const raw = readYamlFile(AI_PATHS.topologyConfig());
  if (!raw) return createEmptyTopologyConfig();
  return TopologyConfigSchema.parse(raw);
}

export function saveTopologyConfig(config: TopologyConfig): void {
  writeYamlFile(AI_PATHS.topologyConfig(), config);
}
