import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { RootsListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { setProjectRoot } from '../utils/fs.js';
import { WAIRON_VERSION } from '../config/defaults.js';
import type { ValidationIssue } from '../core/validation.js';
import { EndpointSchema, type Endpoint } from '../models/specs.js';

// ---------------------------------------------------------------------------
// wairon MCP Server
//
// Exposes the wairon library over the Model Context Protocol so AI tools can
// query agent topology, validate configuration, and author/validate the SDD
// spec tree — all without manual CLI invocation.
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

function requireSpecs() {
  /* eslint-disable @typescript-eslint/no-require-imports */
  return require('../core/specs.js') as typeof import('../core/specs.js');
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
      description: 'List all domains in this project: subsystem-derived (boundTo set) plus free-standing domains from .wai/topology.yaml.',
    },
    () => {
      try {
        const { resolveDomains } = require('../core/domains.js') as typeof import('../core/domains.js');
        return json(resolveDomains());
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
      description: 'Get the current project configuration (name, targets, rules, paths).',
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


  // ── SDD Spec-Driven Development Tools ─────────────────────────────────────

  reg<{ name: string; vision: string; boundaries?: any[]; globalRequirements?: any[] }>(server,
    'sdd_initialize_system',
    {
      description: 'Initialize the L0 System Specification (system.yaml).',
      inputSchema: {
        name: z.string().describe('Overarching name of the project/system'),
        vision: z.string().describe('Vision, mission, and core goals of the system'),
        boundaries: z.array(z.union([z.string(), z.object({ name: z.string(), description: z.string().optional() })])).optional().describe('System boundary rules or scope statements (strings or name/description objects)'),
        globalRequirements: z.array(z.union([z.string(), z.object({ description: z.string() })])).optional().describe('Global functional and non-functional requirements (strings or description objects)'),
      },
    },
    ({ name, vision, boundaries, globalRequirements }) => {
      try {
        const { saveSystemSpec } = requireSpecs();
        const now = new Date().toISOString();
        saveSystemSpec({
          schemaVersion: '1.0.0',
          name,
          vision,
          boundaries: boundaries ?? [],
          globalRequirements: globalRequirements ?? [],
          createdAt: now,
          updatedAt: now,
        });
        return text(`Successfully initialized L0 System Spec for "${name}".`);
      } catch (e) {
        return errText(String(e));
      }
    },
  );

  reg<{ id: string; name: string; description: string; publicInterfaces?: { type: 'REST' | 'GraphQL' | 'MessageBus' | 'RPC' | 'Custom'; details: string; component?: string; interface?: string }[] }>(server,
    'sdd_add_subsystem',
    {
      description: 'Add an L1 Subsystem / Service under the system boundary. publicInterfaces should bind each entry to the component that realizes it (the subsystem\'s published surface); if components do not exist yet, add them later with sdd_set_public_interfaces.',
      inputSchema: {
        id: z.string().describe('Lowercase identifier for the subsystem'),
        name: z.string().describe('Human-readable display name'),
        description: z.string().describe('Purpose and details of the subsystem'),
        publicInterfaces: z.array(z.object({
          type: z.enum(['REST', 'GraphQL', 'MessageBus', 'RPC', 'Custom']),
          details: z.string(),
          component: z.string().optional().describe('The L2 component id that realizes this interface (this subsystem\'s published surface)'),
          interface: z.string().optional().describe('Optional L3 interface id on that component backing this entry'),
        })).optional().describe('Public entrypoints exposed by this subsystem, each bound to a realizing component'),
      },
    },
    ({ id, name, description, publicInterfaces }) => {
      try {
        const { loadSystemSpec, saveSubsystemSpec } = requireSpecs();
        const system = loadSystemSpec();
        if (!system) return errText('System spec must be initialized (sdd_initialize_system) first.');
        const now = new Date().toISOString();
        saveSubsystemSpec({
          id,
          name,
          description,
          parentSystem: system.name,
          publicInterfaces: publicInterfaces ?? [],
          status: 'draft',
          createdAt: now,
          updatedAt: now,
        });
        return text(`Successfully added L1 Subsystem Spec "${name}" (${id}).`);
      } catch (e) {
        return errText(String(e));
      }
    },
  );

  reg<{ subsystem: string; publicInterfaces: { type: 'REST' | 'GraphQL' | 'MessageBus' | 'RPC' | 'Custom'; details: string; component?: string; interface?: string }[] }>(server,
    'sdd_set_public_interfaces',
    {
      description: 'Set (replace) an existing subsystem\'s publicInterfaces, binding each to the component (and optional interface) that realizes it. Use this to backfill bindings once the subsystem\'s components exist — cross-subsystem dependencies may only target a published public component.',
      inputSchema: {
        subsystem: z.string().describe('The L1 subsystem id to update'),
        publicInterfaces: z.array(z.object({
          type: z.enum(['REST', 'GraphQL', 'MessageBus', 'RPC', 'Custom']),
          details: z.string(),
          component: z.string().optional().describe('The L2 component id that realizes this interface'),
          interface: z.string().optional().describe('Optional L3 interface id on that component'),
        })).describe('The full replacement list of public interfaces for this subsystem'),
      },
    },
    ({ subsystem, publicInterfaces }) => {
      try {
        const { loadSubsystemSpec, saveSubsystemSpec } = requireSpecs();
        const sub = loadSubsystemSpec(subsystem);
        if (!sub) return errText(`Subsystem "${subsystem}" does not exist.`);
        saveSubsystemSpec({
          ...sub,
          publicInterfaces,
          updatedAt: new Date().toISOString(),
        });
        return text(`Updated public interfaces for subsystem "${subsystem}" (${publicInterfaces.length} ${publicInterfaces.length === 1 ? 'entry' : 'entries'}).`);
      } catch (e) {
        return errText(String(e));
      }
    },
  );

  reg<{ id: string; name: string; description: string; subsystem: string; componentType: 'Portal' | 'Orchestrator' | 'Supervisor' | 'Actor' | 'Store' | 'Index' | 'Registry' | 'Adapter' | 'Observer' | 'Specialist' | 'Repository' | 'Gateway'; owns?: string[]; dependsOn?: string[]; portalType?: 'HTTP_API' | 'gRPC' | 'GraphQL' | 'MessageBus' | 'CLI' | 'NamedPipe' | 'IPC' | 'Custom' }>(server,
    'sdd_add_component',
    {
      description: 'Add an L2 Component under a subsystem. componentType is a building block (Portal, Orchestrator, Supervisor, Actor, Store, Index, Registry, Adapter, Observer, Specialist) or a pattern (Repository, Gateway). Patterns set "owns" (their private member blocks); all components set "dependsOn" (collaborators — facades or standalone blocks).',
      inputSchema: {
        id: z.string().describe('Lowercase identifier for the component'),
        name: z.string().describe('Human-readable display name'),
        description: z.string().describe('Responsibility / internal architecture details'),
        subsystem: z.string().describe('The L1 subsystem ID this component belongs to'),
        componentType: z.enum(['Portal', 'Orchestrator', 'Supervisor', 'Actor', 'Store', 'Index', 'Registry', 'Adapter', 'Observer', 'Specialist', 'Repository', 'Gateway']).describe('The building block, or pattern (Repository/Gateway)'),
        owns: z.array(z.string()).optional().describe('Member block ids privately owned by this component (patterns only)'),
        dependsOn: z.array(z.string()).optional().describe('IDs of other components this collaborates with (facades or standalone blocks)'),
        portalType: z.enum(['HTTP_API', 'gRPC', 'GraphQL', 'MessageBus', 'CLI', 'NamedPipe', 'IPC', 'Custom']).optional().describe('Required when componentType is Portal'),
      },
    },
    ({ id, name, description, subsystem, componentType, owns, dependsOn, portalType }) => {
      try {
        const { loadSubsystemSpec, saveComponentSpec } = requireSpecs();
        const sub = loadSubsystemSpec(subsystem);
        if (!sub) return errText(`Parent subsystem "${subsystem}" does not exist.`);
        const now = new Date().toISOString();
        saveComponentSpec({
          id,
          name,
          description,
          subsystem,
          componentType,
          owns: owns ?? [],
          dependsOn: dependsOn ?? [],
          ...(portalType ? { portalType } : {}),
          status: 'draft',
          createdAt: now,
          updatedAt: now,
        });
        return text(`Successfully added L2 Component Spec "${name}" (${id}, ${componentType}).`);
      } catch (e) {
        return errText(String(e));
      }
    },
  );

  reg<{ id: string; name: string; description: string; component: string; methods?: { name: string; description: string; signature: string; returns: string; guarantees?: ('idempotent' | 'atomic' | 'transactional' | 'exactly-once')[] }[] }>(server,
    'sdd_define_interface',
    {
      description: 'Define an L3 Contract / Interface with method signatures for a component.',
      inputSchema: {
        id: z.string().describe('Lowercase identifier prefixed with "i", e.g. "istorage"'),
        name: z.string().describe('Human-readable contract name'),
        description: z.string().describe('Contract description and obligations'),
        component: z.string().describe('The L2 component ID this interface belongs to'),
        methods: z.array(z.object({
          name: z.string(),
          description: z.string(),
          signature: z.string(),
          returns: z.string(),
          guarantees: z.array(z.enum(['idempotent', 'atomic', 'transactional', 'exactly-once'])).optional().describe('Semantic guarantees this method promises (combinable). The implementer must honour them; the gate requires any guarantee a narrative step asserts to be declared here. Set when an L0 requirement or a narrative step depends on the guarantee.'),
        })).optional().describe('List of method signature contracts'),
      },
    },
    ({ id, name, description, component, methods }) => {
      try {
        const { loadComponentSpec, saveInterfaceSpec } = requireSpecs();
        const comp = loadComponentSpec(component);
        if (!comp) return errText(`Component "${component}" does not exist.`);
        const now = new Date().toISOString();
        saveInterfaceSpec({
          id,
          name,
          description,
          component,
          methods: methods ?? [],
          status: 'draft',
          createdAt: now,
          updatedAt: now,
        });
        return text(`Successfully defined L3 Interface Contract "${name}" (${id}).`);
      } catch (e) {
        return errText(String(e));
      }
    },
  );

  // One generic tool for ALL public-facing wire endpoints — HTTP, gRPC, GraphQL,
  // MessageBus, NamedPipe, IPC, CLI, Custom — binding each interface method to a
  // concrete `endpoint`. This is what a Portal needs to satisfy the gate's
  // MISSING_ENDPOINT / ENDPOINT_TRANSPORT_MISMATCH rules. Run it after
  // sdd_define_interface (the methods must already exist).
  reg<{ interface: string; endpoints: Array<{ method: string; transport: 'HTTP' | 'gRPC' | 'GraphQL' | 'MessageBus' | 'NamedPipe' | 'IPC' | 'CLI' | 'Custom'; httpMethod?: string; path?: string; service?: string; rpcMethod?: string; operation?: string; field?: string; topic?: string; event?: string; queue?: string; direction?: string; pipe?: string; channel?: string; command?: string; address?: string }> }>(server,
    'sdd_set_endpoints',
    {
      description: 'Bind the concrete wire endpoint for one or more methods on an L3 interface. ONE generic tool for every transport (HTTP, gRPC, GraphQL, MessageBus, NamedPipe, IPC, CLI, Custom) — pick `transport` and fill that transport\'s address fields. Required to satisfy the gate for any Portal component. The interface and its methods must already exist (call sdd_define_interface first).',
      inputSchema: {
        interface: z.string().describe('The L3 interface ID (e.g. "ibilling-gateway")'),
        endpoints: z.array(z.object({
          method: z.string().describe('The NAME of the interface method to bind (not the HTTP verb)'),
          transport: z.enum(['HTTP', 'gRPC', 'GraphQL', 'MessageBus', 'NamedPipe', 'IPC', 'CLI', 'Custom']).describe('Wire protocol; must match the Portal\'s portalType'),
          httpMethod: z.enum(['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS', 'HEAD']).optional().describe('HTTP: verb'),
          path: z.string().optional().describe('HTTP: route path, e.g. "/v1/checkout"'),
          service: z.string().optional().describe('gRPC: service name'),
          rpcMethod: z.string().optional().describe('gRPC: rpc method name'),
          operation: z.enum(['query', 'mutation', 'subscription']).optional().describe('GraphQL: operation kind'),
          field: z.string().optional().describe('GraphQL: root field name'),
          topic: z.string().optional().describe('MessageBus: topic'),
          event: z.string().optional().describe('MessageBus: event name'),
          queue: z.string().optional().describe('MessageBus: optional queue/consumer group'),
          direction: z.enum(['subscribe', 'publish']).optional().describe('MessageBus: subscribe (default) or publish'),
          pipe: z.string().optional().describe('NamedPipe: pipe name, e.g. "\\\\.\\pipe\\gk-events"'),
          channel: z.string().optional().describe('IPC: channel name'),
          command: z.string().optional().describe('CLI: command/subcommand'),
          address: z.string().optional().describe('Custom: free-form address'),
        })).describe('One binding per method'),
      },
    },
    ({ interface: interfaceId, endpoints }) => {
      try {
        const { loadInterfaceSpec, saveInterfaceSpec } = requireSpecs();
        const intf = loadInterfaceSpec(interfaceId);
        if (!intf) return errText(`Interface "${interfaceId}" does not exist.`);

        const buildRaw = (e: typeof endpoints[number]): Record<string, unknown> => {
          switch (e.transport) {
            case 'HTTP':       return { transport: 'HTTP', method: e.httpMethod, path: e.path };
            case 'gRPC':       return { transport: 'gRPC', service: e.service, method: e.rpcMethod };
            case 'GraphQL':    return { transport: 'GraphQL', operation: e.operation, field: e.field };
            case 'MessageBus': return { transport: 'MessageBus', topic: e.topic, event: e.event, queue: e.queue, direction: e.direction ?? 'subscribe' };
            case 'NamedPipe':  return { transport: 'NamedPipe', pipe: e.pipe };
            case 'IPC':        return { transport: 'IPC', channel: e.channel };
            case 'CLI':        return { transport: 'CLI', command: e.command };
            case 'Custom':     return { transport: 'Custom', address: e.address };
          }
        };

        const bound: string[] = [];
        for (const e of endpoints) {
          const m = intf.methods.find(x => x.name === e.method);
          if (!m) return errText(`Method "${e.method}" not found on interface "${interfaceId}". Define it via sdd_define_interface first.`);
          const parsed = EndpointSchema.safeParse(buildRaw(e));
          if (!parsed.success) {
            const detail = parsed.error.issues.map(i => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
            return errText(`Invalid ${e.transport} endpoint for method "${e.method}": ${detail}`);
          }
          m.endpoint = parsed.data as Endpoint;
          bound.push(`${e.method}→${e.transport}`);
        }
        intf.updatedAt = new Date().toISOString();
        saveInterfaceSpec(intf);
        return text(`Bound ${bound.length} endpoint(s) on "${interfaceId}": ${bound.join(', ')}.`);
      } catch (e) {
        return errText(String(e));
      }
    },
  );

  reg<{ id: string; name: string; description: string; contract: string; sourcePath?: string; methods?: { name: string; narrative: { stepNumber: number; description: string; type: 'local' | 'call'; targetComponent?: string; targetMethod?: string }[] }[] }>(server,
    'sdd_write_narrative',
    {
      description: 'Write L4 Concrete Implementation spec containing L5 method narratives.',
      inputSchema: {
        id: z.string().describe('Lowercase identifier, e.g. "vfs_storage"'),
        name: z.string().describe('Human-readable implementation name'),
        description: z.string().describe('Implementation details'),
        contract: z.string().describe('The L3 Interface contract ID this implements'),
        sourcePath: z.string().optional().describe('Optional: target source code file path relative to project root'),
        methods: z.array(z.object({
          name: z.string(),
          narrative: z.array(z.object({
            stepNumber: z.number().int().positive(),
            description: z.string(),
            type: z.enum(['local', 'call']),
            targetComponent: z.string().optional(),
            targetMethod: z.string().optional(),
          })),
        })).optional().describe('Method implementations containing L5 narratives'),
      },
    },
    ({ id, name, description, contract, sourcePath, methods }) => {
      try {
        const { loadInterfaceSpec, saveImplementationSpec } = requireSpecs();
        const intf = loadInterfaceSpec(contract);
        if (!intf) return errText(`Interface contract "${contract}" does not exist.`);
        const now = new Date().toISOString();
        saveImplementationSpec({
          id,
          name,
          description,
          contract,
          sourcePath,
          methods: methods ?? [],
          status: 'draft',
          createdAt: now,
          updatedAt: now,
        });
        return text(`Successfully saved L4 Implementation Spec "${name}" (${id}) with method narratives.`);
      } catch (e) {
        return errText(String(e));
      }
    },
  );

  reg<{ kind: 'entity' | 'value-object'; id: string; name: string; description?: string; subsystem?: string; fields?: { name: string; type: string; description?: string; optional?: boolean }[]; methods?: { name: string; signature: string; returns: string; description?: string }[] }>(server,
    'sdd_add_type',
    {
      description: 'Define an entity or value-object type (the data components operate on). Entities are owned by a subsystem; shared value objects omit subsystem (system-level). Fields are data; methods are PURE intrinsic behaviour only — anything needing a collaborator belongs on a component, taking the entity as an argument.',
      inputSchema: {
        kind: z.enum(['entity', 'value-object']).describe('entity (owned by a subsystem) or value-object (often system-level shared)'),
        id: z.string().describe('Lowercase identifier'),
        name: z.string().describe('Human-readable name'),
        description: z.string().optional(),
        subsystem: z.string().optional().describe('Owning subsystem id; omit for a system-level shared value object'),
        fields: z.array(z.object({ name: z.string(), type: z.string(), description: z.string().optional(), optional: z.boolean().optional() })).optional().describe('Data fields (type is a primitive or a qualified type id, e.g. "billing.Invoice")'),
        methods: z.array(z.object({ name: z.string(), signature: z.string(), returns: z.string(), description: z.string().optional() })).optional().describe('Pure intrinsic methods only'),
      },
    },
    ({ kind, id, name, description, subsystem, fields, methods }) => {
      try {
        const { saveTypeSpec } = requireSpecs();
        const now = new Date().toISOString();
        saveTypeSpec({
          kind,
          id,
          name,
          ...(description ? { description } : {}),
          ...(subsystem ? { subsystem } : {}),
          fields: (fields ?? []).map((f) => ({ name: f.name, type: f.type, description: f.description, optional: f.optional ?? false })),
          methods: methods ?? [],
          createdAt: now,
          updatedAt: now,
        });
        return text(`Successfully defined ${kind} type "${name}" (${id}).`);
      } catch (e) {
        return errText(String(e));
      }
    },
  );

  reg<Record<string, never>>(server,
    'sdd_validate_tree',
    {
      description: 'Validate the entire SDD spec tree, checking parent references, contract compatibility, narratives, and component type boundaries.',
    },
    () => {
      try {
        const { loadProjectConfig } = requireLoader();
        const config = loadProjectConfig();
        const { validateSddTree } = requireValidation();
        const result = validateSddTree(config.rules);
        return json({
          valid: result.valid,
          errors: result.issues.filter((i) => i.severity === 'error'),
          warnings: result.issues.filter((i) => i.severity === 'warning'),
        });
      } catch (e) {
        return errText(String(e));
      }
    },
  );

  reg<Record<string, never>>(server,
    'sdd_get_status',
    {
      description: 'Get the completeness status dashboard of the SDD spec tree.',
    },
    () => {
      try {
        const { getStatusReport } = require('../commands/status.js') as typeof import('../commands/status.js');
        return text(getStatusReport());
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

/**
 * Scope the server to the client's actual workspace via MCP "roots". This is how
 * a server launched with an unrelated cwd (e.g. a single global Antigravity
 * registration) attaches to the right project — and it stays correct per client
 * connection, so multiple projects each get their own server scoped to their own
 * .wai/ tree. If the client doesn't support roots, we keep the cwd/env fallback.
 */
async function scopeToClientWorkspace(server: McpServer): Promise<void> {
  let roots: { uri: string; name?: string }[];
  try {
    const result = await server.server.listRoots();
    roots = (result?.roots ?? []) as { uri: string; name?: string }[];
  } catch {
    return; // client did not advertise the roots capability
  }

  for (const r of roots) {
    let dir: string | null = null;
    try { dir = r.uri.startsWith('file:') ? fileURLToPath(r.uri) : r.uri; } catch { dir = null; }
    if (dir && (fs.existsSync(path.join(dir, '.wai')) || fs.existsSync(path.join(dir, '.wairon')))) {
      setProjectRoot(dir);
      process.stderr.write(`[wairon mcp] scoped to client workspace root: ${dir}\n`);
      return;
    }
  }
  if (roots.length > 0) {
    process.stderr.write(`[wairon mcp] client provided ${roots.length} root(s), none containing .wai/ — keeping current project root\n`);
  }
}

export async function startMcpServer(): Promise<void> {
  const server    = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Prefer the client's workspace over the launch cwd, and follow workspace changes.
  await scopeToClientWorkspace(server);
  try {
    server.server.setNotificationHandler(RootsListChangedNotificationSchema, async () => {
      await scopeToClientWorkspace(server);
    });
  } catch { /* roots-changed notifications unsupported — ignore */ }

  // server runs until process is killed — stdio transport keeps it alive
}
