import { computeStateId } from '../core/statehash.js';
import { readLockRecord, writeLockRecord } from '../core/lockfile.js';
import { provisionProject, promoteAllComplete } from '../core/provision.js';
import { validateAsComplete } from '../core/validation.js';
import { loadProjectConfig } from '../config/loader.js';
import { createMcpServer } from '../mcp/server.js';
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
};

// host_validator_adapter → sdd_validator (validator_portal)
export function validateProjectAsComplete() {
  const config = loadProjectConfig();
  return validateAsComplete({ rules: config.rules, projectType: config.projectType });
}

// host_mcp_adapter → sdd_mcp (mcp_portal): reuse the sdd_* tool surface in-scope
export function createScopedServer(): McpServer {
  return createMcpServer();
}
