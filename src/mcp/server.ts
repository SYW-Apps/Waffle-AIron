import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { WAIRON_VERSION } from '../config/defaults.js';
import type { ValidationIssue } from '../core/validation.js';

// ---------------------------------------------------------------------------
// wairon MCP Server
//
// Exposes the wairon library over the Model Context Protocol so AI tools can
// query agent topology, validate configuration, run pipelines, and check job
// and run status — all without manual CLI invocation.
//
// Transport: stdio (for use with Claude Code / Gemini CLI MCP config)
// Usage: wairon mcp serve  (add to .claude/settings.json mcpServers)
// ---------------------------------------------------------------------------

function requireLoader() {
  /* eslint-disable @typescript-eslint/no-require-imports */
  return require('../config/loader.js') as typeof import('../config/loader.js');
}

function requireValidation() {
  /* eslint-disable @typescript-eslint/no-require-imports */
  return require('../core/validation.js') as typeof import('../core/validation.js');
}

function requireWorkspace() {
  /* eslint-disable @typescript-eslint/no-require-imports */
  return require('../core/workspace.js') as typeof import('../core/workspace.js');
}

function requirePipeline() {
  /* eslint-disable @typescript-eslint/no-require-imports */
  return require('../core/pipeline.js') as typeof import('../core/pipeline.js');
}

function requireSessions() {
  /* eslint-disable @typescript-eslint/no-require-imports */
  return require('../core/sessions.js') as typeof import('../core/sessions.js');
}

function requireJobs() {
  /* eslint-disable @typescript-eslint/no-require-imports */
  return require('../core/jobs.js') as typeof import('../core/jobs.js');
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function text(content: string): CallToolResult {
  return { content: [{ type: 'text', text: content }] };
}

function json(value: unknown): CallToolResult {
  return text(JSON.stringify(value, null, 2));
}

function errText(message: string): CallToolResult {
  return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
}

// TypeScript hits TS2589 ("type instantiation excessively deep") on McpServer.registerTool
// when inputSchema contains ZodOptional / ZodDefault / ZodString.describe() wrappers,
// because the SDK's generic chain recurses beyond TS's limit. This helper breaks the
// inference chain while preserving typed callback args via the explicit <Args> param.
function reg<Args extends Record<string, unknown>>(
  server: McpServer,
  name: string,
  config: { description: string; inputSchema?: Record<string, z.ZodTypeAny> },
  cb: (args: Args) => CallToolResult,
): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (server as any).registerTool(name, config, cb as any);
}

// ---------------------------------------------------------------------------
// Server factory
// ---------------------------------------------------------------------------

export function createMcpServer(): McpServer {
  const server = new McpServer({
    name: 'wairon',
    version: WAIRON_VERSION,
  });

  // ── Topology tools ────────────────────────────────────────────────────────

  reg<{ domainId?: string }>(server,
    'listAgents',
    {
      description: 'List all AI agents registered in this project. Returns id, name, description, domainRoot, template, tags, and status for each agent. Filter by domainId to scope to one domain.',
      inputSchema: { domainId: z.string().optional() },
    },
    ({ domainId }) => {
      try {
        const { loadRegistry } = requireLoader();
        const registry = loadRegistry();
        const agents = domainId
          ? registry.agents.filter((a) => a.domainRoot === domainId)
          : registry.agents;
        return json(agents.map((a) => ({
          id:          a.id,
          name:        a.name,
          description: a.description,
          domainRoot:  a.domainRoot,
          template:    a.template,
          tags:        a.tags,
          status:      a.status,
        })));
      } catch (e) {
        return errText(String(e));
      }
    },
  );

  reg<{ id: string }>(server,
    'getAgent',
    {
      description: 'Get full details of a specific agent by id, including ownership rules, context, and output targets.',
      inputSchema: { id: z.string() },
    },
    ({ id }) => {
      try {
        const { loadRegistry } = requireLoader();
        const registry = loadRegistry();
        const agent = registry.agents.find((a) => a.id === id);
        if (!agent) return errText(`Agent "${id}" not found.`);
        return json(agent);
      } catch (e) {
        return errText(String(e));
      }
    },
  );

  reg<Record<string, never>>(server,
    'listDomains',
    {
      description: 'List all domains registered in this project with their paths and types.',
    },
    () => {
      try {
        const { loadDomainRegistry } = requireLoader();
        const reg = loadDomainRegistry();
        return json(reg.domains);
      } catch (e) {
        return errText(String(e));
      }
    },
  );

  reg<Record<string, never>>(server,
    'validateTopology',
    {
      description: 'Validate the project\'s agent topology. Returns errors and warnings (duplicate ids, overlapping ownership, missing paths, etc.).',
    },
    () => {
      try {
        const { loadRegistry, loadProjectConfig } = requireLoader();
        const { validateRegistry } = requireValidation();
        const registry = loadRegistry();
        const config   = loadProjectConfig();
        const result   = validateRegistry(registry, config.rules ?? { requireCreationReason: false });
        return json({
          valid:    result.issues.filter((i: ValidationIssue) => i.severity === 'error').length === 0,
          errors:   result.issues.filter((i: ValidationIssue) => i.severity === 'error'),
          warnings: result.issues.filter((i: ValidationIssue) => i.severity === 'warning'),
        });
      } catch (e) {
        return errText(String(e));
      }
    },
  );

  reg<Record<string, never>>(server,
    'getProjectConfig',
    {
      description: 'Get the current project configuration (name, defaultBackend, profile, targets, git settings).',
    },
    () => {
      try {
        const { loadProjectConfig } = requireLoader();
        return json(loadProjectConfig());
      } catch (e) {
        return errText(String(e));
      }
    },
  );

  // ── Run / workspace tools ─────────────────────────────────────────────────

  reg<{ limit: number }>(server,
    'listRuns',
    {
      description: 'List all run records for this project (most recent first). Each run corresponds to a `wairon run start` or pipeline execution.',
      inputSchema: { limit: z.number().min(1).max(50).default(20) },
    },
    ({ limit }) => {
      try {
        const { listRuns } = requireWorkspace();
        const runs = listRuns().slice(0, limit);
        return json(runs.map((r) => ({
          id:        r.id,
          status:    r.status,
          label:     r.label,
          createdAt: r.createdAt,
          steps:     r.steps.length,
        })));
      } catch (e) {
        return errText(String(e));
      }
    },
  );

  reg<{ runId: string }>(server,
    'getRunStatus',
    {
      description: 'Get full status of a specific run including all steps, their status, backends, and domain scope.',
      inputSchema: { runId: z.string() },
    },
    ({ runId }) => {
      try {
        const { loadRun } = requireWorkspace();
        const run = loadRun(runId);
        return json({
          id:         run.id,
          status:     run.status,
          label:      run.label,
          pipelineId: run.pipelineId,
          createdAt:  run.createdAt,
          steps: run.steps.map((s) => ({
            id:      s.id,
            label:   s.label,
            status:  s.status,
            backend: s.backend,
            domain:  s.domain,
          })),
        });
      } catch (e) {
        return errText(String(e));
      }
    },
  );

  reg<{ runId: string; stepId: string }>(server,
    'getStepResult',
    {
      description: 'Get the result (summary, output, status) from a specific step of a run.',
      inputSchema: { runId: z.string(), stepId: z.string() },
    },
    ({ runId, stepId }) => {
      try {
        const { loadStepResult } = requireWorkspace();
        const result = loadStepResult(runId, stepId);
        if (!result) return text('No result found for this step yet.');
        return json(result);
      } catch (e) {
        return errText(String(e));
      }
    },
  );

  // ── Pipeline tools ────────────────────────────────────────────────────────

  reg<Record<string, never>>(server,
    'listPipelines',
    {
      description: 'List all pipeline definitions for this project.',
    },
    () => {
      try {
        const { listPipelines } = requirePipeline();
        const pipelines = listPipelines();
        return json(pipelines.map((p) => ({
          id:          p.id,
          name:        p.name,
          description: p.description,
          steps:       p.steps.length,
          variables:   Object.keys(p.variables ?? {}),
        })));
      } catch (e) {
        return errText(String(e));
      }
    },
  );

  reg<{ id: string }>(server,
    'getPipeline',
    {
      description: 'Get the full definition of a specific pipeline including all steps, dependencies, and variables.',
      inputSchema: { id: z.string() },
    },
    ({ id }) => {
      try {
        const { loadPipeline } = requirePipeline();
        const pipeline = loadPipeline(id);
        return json(pipeline);
      } catch (e) {
        return errText(String(e));
      }
    },
  );

  reg<{ pipelineId: string; limit: number }>(server,
    'getPipelineStatus',
    {
      description: 'Get the status of runs associated with a specific pipeline (most recent runs first).',
      inputSchema: {
        pipelineId: z.string(),
        limit:      z.number().min(1).max(20).default(5),
      },
    },
    ({ pipelineId, limit }) => {
      try {
        const { listRuns } = requireWorkspace();
        const runs = listRuns()
          .filter((r) => r.pipelineId === pipelineId)
          .slice(0, limit);
        return json(runs.map((r) => ({
          id:        r.id,
          status:    r.status,
          createdAt: r.createdAt,
          steps:     r.steps.map((s) => ({ id: s.id, status: s.status })),
        })));
      } catch (e) {
        return errText(String(e));
      }
    },
  );

  // ── Session tools ─────────────────────────────────────────────────────────

  reg<Record<string, never>>(server,
    'listSessions',
    {
      description: 'List all active and recent AI session workspaces for this project.',
    },
    () => {
      try {
        const { listSessions } = requireSessions();
        const sessions = listSessions();
        return json(sessions.map((s) => ({
          id:            s.id,
          label:         s.label,
          status:        s.status,
          backend:       s.backend,
          domainId:      s.domainId,
          startCount:    s.startCount,
          lastStartedAt: s.lastStartedAt,
        })));
      } catch (e) {
        return errText(String(e));
      }
    },
  );

  // ── Job tools ─────────────────────────────────────────────────────────────

  reg<{ limit: number }>(server,
    'listJobs',
    {
      description: 'List all delegated jobs for this project (most recent first). Jobs are created by `wairon delegate`.',
      inputSchema: { limit: z.number().min(1).max(50).default(20) },
    },
    ({ limit }) => {
      try {
        const { listJobs } = requireJobs();
        const jobs = listJobs().slice(0, limit);
        return json(jobs.map((j) => ({
          id:      j.id,
          status:  j.status,
          task:    j.task,
          domain:  j.domain,
          backend: j.backend,
          created: j.createdAt,
        })));
      } catch (e) {
        return errText(String(e));
      }
    },
  );

  reg<{ id: string }>(server,
    'getJob',
    {
      description: 'Get details and result of a specific delegated job.',
      inputSchema: { id: z.string() },
    },
    ({ id }) => {
      try {
        const { loadJob } = requireJobs();
        const job = loadJob(id);
        return json(job);
      } catch (e) {
        return errText(String(e));
      }
    },
  );

  return server;
}

// ---------------------------------------------------------------------------
// Start server with stdio transport
// ---------------------------------------------------------------------------

export async function startMcpServer(): Promise<void> {
  const server    = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // server runs until process is killed — stdio transport keeps it alive
}
