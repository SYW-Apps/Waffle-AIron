import { computeStateId } from '../core/statehash.js';
import { readLockRecord, writeLockRecord } from '../core/lockfile.js';
import { loadSystemSpec, loadSubsystemSpecs, buildProjectGraph } from '../core/specs.js';
import { provisionProject, promoteAllComplete } from '../core/provision.js';
import { validateAsComplete } from '../core/validation.js';
import { renderDiagram } from '../core/diagram.js';
import { loadProjectConfig } from '../config/loader.js';
import { createMcpServer } from '../mcp/server.js';
import * as gitPortal from '../git/index.js';
import * as producerPortal from '../producers/index.js';
import * as surfacePortal from '../core/surfaces.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

// ---------------------------------------------------------------------------
// Host client adapters (sdd_host)
//
// The sanctioned Adapter → remote-Portal hops that let the hosting control and
// data planes reuse sdd_core / sdd_validator / sdd_mcp unchanged, scoped to the
// already-bound project root. Kept intentionally thin (pure forwarding).
// ---------------------------------------------------------------------------

// host_core_adapter → sdd_core (core_portal)
export const hostCore = {
  provisionProject,
  computeStateId,
  readLockRecord,
  writeLockRecord,
  promoteAllComplete,
  renderDiagram,
  // L0/L1 reads used by the landscape plane to project a redacted public-surface
  // snapshot; thin forwarders to the core spec reads (request-scoped root).
  loadSystemSpec,
  loadSubsystemSpecs,
  // Level-of-detail project-tier graph for the web UI, forwarded to core_portal.
  buildProjectGraph,
};

// host_validator_adapter → sdd_validator (validator_portal)
export function validateProjectAsComplete() {
  const config = loadProjectConfig();
  return validateAsComplete({ rules: config.rules, projectType: config.projectType });
}

// host_mcp_adapter → sdd_mcp (mcp_portal): reuse the sdd_* tool surface in-scope,
// with the hosted data-plane tools ADVERTISED for discovery (their execution is
// intercepted by the request orchestrator before reaching the server).
export function createScopedServer(): McpServer {
  return createMcpServer({ hostedTools: true });
}

// host_git_adapter → sdd_git (git_portal)
export const hostGit = {
  enable: gitPortal.enable,
  disable: gitPortal.disable,
  sync: gitPortal.sync,
  publish: gitPortal.publish,
};

// host_producer_adapter → sdd_producers (producer_portal)
export const hostProducer = {
  configure: producerPortal.configure,
  produce: producerPortal.produce,
  remove: producerPortal.remove,
  list: producerPortal.list,
};

// host_surfaces_adapter → sdd_surfaces (surface_portal): surface-artifact
// generation against the CURRENTLY BOUND project root (callers bind via
// runWithProjectRoot, exactly like hostCore reads).
export const hostSurfaces = {
  exportBoundSurface: surfacePortal.exportSurface,
};
