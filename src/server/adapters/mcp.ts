import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createMcpServer } from '../../mcp/server.js';

// ---------------------------------------------------------------------------
// host_mcp_adapter — sdd_host's client hop into sdd_mcp.
// ---------------------------------------------------------------------------

/**
 * host_mcp_adapter.createScopedServer — the sdd_* tool surface, in scope, with
 * the hosted data-plane tools ADVERTISED for discovery (their execution is
 * intercepted by the request orchestrator before it reaches the server).
 */
export function createScopedServer(): McpServer {
  return createMcpServer({ hostedTools: true });
}
