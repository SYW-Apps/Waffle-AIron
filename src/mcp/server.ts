import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import {
  RootsListChangedNotificationSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  McpError,
  ErrorCode,
} from '@modelcontextprotocol/sdk/types.js';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { setProjectRoot } from '../utils/fs.js';
import { WAIRON_VERSION } from '../config/defaults.js';
import type { ValidationIssue } from '../core/validation.js';
import { resolveNarrativeLabels } from '../core/narrative-labels.js';
import { EndpointSchema, type Endpoint, type SubsystemSpec } from '../models/specs.js';
import {
  listResources as coreListSkillResources,
  readResource as coreReadSkillResource,
  type SkillResourceDescriptor,
} from '../core/skills.js';
import { resolveChainingParent } from '../core/specs.js';
import {
  listExternalInterfaces as coreListExternalInterfaces,
  type ExternalSurfaceEntry,
} from '../core/surfaces.js';

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

function requireProvision() {
  /* eslint-disable @typescript-eslint/no-require-imports */
  return require('../core/provision.js') as typeof import('../core/provision.js');
}

// mcp_surfaces_adapter — thin forwarder across the boundary into the surface
// portal. Statically imported (like the skills adapter below, not lazily
// required): the portal function reads the request-scoped project root at
// call time, so a static binding stays correct per bound project.
function listExternalInterfaces(): ExternalSurfaceEntry[] {
  return coreListExternalInterfaces();
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
// ---------------------------------------------------------------------------
// Build freshness — the stale-server guard.
//
// A long-running MCP server keeps the Zod schemas it was started with; after a
// rebuild, writes through the OLD process silently STRIP any field a newer
// schema added (this destroyed data twice before this guard existed). The
// server stamps its own entry file at startup and, once the file on disk
// changes, appends a loud warning to every tool result until restarted.
// ---------------------------------------------------------------------------

export interface BuildStamp {
  path: string;
  mtimeMs: number;
  size: number;
}

/** Stamp a build entry file; null when it cannot be stat'd (e.g. pkg snapshot fs). */
export function captureBuildStamp(entryPath: string): BuildStamp | null {
  try {
    const s = fs.statSync(entryPath);
    return { path: entryPath, mtimeMs: s.mtimeMs, size: s.size };
  } catch {
    return null;
  }
}

/** True once the stamped entry file changed on disk (rebuild/update since start). */
export function isBuildStale(stamp: BuildStamp | null): boolean {
  if (!stamp) return false;
  try {
    const s = fs.statSync(stamp.path);
    return s.mtimeMs !== stamp.mtimeMs || s.size !== stamp.size;
  } catch {
    return false;
  }
}

const SERVER_BUILD_STAMP = captureBuildStamp(__filename);

const STALE_SERVER_WARNING =
  '\n\n⚠ STALE SERVER: the wairon build on disk changed after this MCP server started. '
  + 'Restart the MCP session (e.g. /mcp reconnect) before further spec edits — writes through '
  + 'a stale server can silently drop fields introduced by newer schemas.';

function withStaleWarning(result: CallToolResult): CallToolResult {
  if (!isBuildStale(SERVER_BUILD_STAMP)) return result;
  const first = result.content?.[0];
  if (first && first.type === 'text') {
    return {
      ...result,
      content: [{ ...first, text: `${first.text}${STALE_SERVER_WARNING}` }, ...result.content.slice(1)],
    };
  }
  return result;
}

function reg<Args extends Record<string, unknown>>(
  server: McpServer,
  name: string,
  config: { description: string; inputSchema?: Record<string, z.ZodTypeAny> },
  cb: (args: Args) => CallToolResult,
): void {
  const guarded = (args: Args): CallToolResult => withStaleWarning(cb(args));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (server as any).registerTool(name, config, guarded as any);
}

// ---------------------------------------------------------------------------
// Built-in SDD skill resources (mcp_skills_adapter + SDK registration)
//
// The MCP server publishes the four built-in SDD skills as read-only MCP
// resources so cloud-only agents (which cannot receive the filesystem-exported
// skills) can still discover and pull them. mcp_skills_adapter is the sanctioned
// cross-subsystem hop into the sdd_skills portal.
// ---------------------------------------------------------------------------

const SKILL_RESOURCE_MIME = 'text/markdown';

// mcp_skills_adapter — thin forwarders across the boundary into the skills
// portal. Statically imported (not lazily required like the project-root-
// sensitive core adapters) because the skills templates resolve relative to the
// package, independent of the request-scoped project root.
function listSkillResources(): SkillResourceDescriptor[] {
  return coreListSkillResources();
}
function readSkillResource(resourceId: string): string {
  return coreReadSkillResource(resourceId);
}

/** Resolve an MCP resource URI (wairon-skill://<id>) back to its skill id. */
function skillIdFromResourceUri(uri: string): string {
  try {
    const u = new URL(uri);
    return u.host || u.pathname.replace(/^\/+/, '') || uri;
  } catch {
    return uri;
  }
}

/**
 * Register the resources/list + resources/read endpoints on the SDK server so
 * both the stdio server and the hosted per-project scoped server (which reuse
 * this same factory) publish the built-in SDD skills automatically. Reads
 * dispatch through the skills adapter to the resource workflow; an unknown URI
 * surfaces the not-found message as an MCP error.
 */
function registerSkillResources(server: McpServer): void {
  server.server.registerCapabilities({ resources: {} });

  server.server.setRequestHandler(ListResourcesRequestSchema, () => ({
    resources: listSkillResources().map((d) => ({
      uri: d.resourceUri,
      name: d.name,
      description: d.description,
      mimeType: SKILL_RESOURCE_MIME,
    })),
  }));

  server.server.setRequestHandler(ReadResourceRequestSchema, (request) => {
    const uri = request.params.uri;
    try {
      const content = readSkillResource(skillIdFromResourceUri(uri));
      return { contents: [{ uri, mimeType: SKILL_RESOURCE_MIME, text: content }] };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      throw new McpError(ErrorCode.InvalidParams, message);
    }
  });
}

// ---------------------------------------------------------------------------
// Server factory
// ---------------------------------------------------------------------------

export interface McpServerOptions {
  /**
   * Advertise the hosted data-plane tools (self-service approvals + landscape
   * discovery/exchange) in tools/list. Their EXECUTION is intercepted by the
   * hosting request orchestrator BEFORE any call reaches this server — the
   * registrations here exist so MCP clients can DISCOVER the tools; the stub
   * handlers only fire outside a hosted request, where the tools are
   * unsupported by design. Never set for the local stdio server.
   */
  hostedTools?: boolean;
}

export function createMcpServer(options: McpServerOptions = {}): McpServer {
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

  reg<{ subsystem?: string }>(server,
    'validateTopology',
    {
      description: 'Validate the project\'s agent topology. Returns errors and warnings (duplicate ids, overlapping ownership, missing paths, etc.). Supports optional subsystem scoping.',
      inputSchema: {
        subsystem: z.string().optional().describe('Only validate topology for agents under the specified subsystem'),
      },
    },
    ({ subsystem }) => {
      try {
        const { loadRegistry, loadProjectConfig } = requireLoader();
        const { validateRegistry } = requireValidation();
        let registry = loadRegistry();
        if (subsystem) {
          registry = {
            ...registry,
            agents: registry.agents.filter((a) => a.domainRoot === subsystem || a.domainRoot?.startsWith(`${subsystem}::`)),
          };
        }
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

  reg<{ name: string; vision: string; boundaries?: any[]; globalRequirements?: any[]; targetLanguage?: string }>(server,
    'sdd_initialize_system',
    {
      description: 'Initialize the L0 System Specification (system.yaml).',
      inputSchema: {
        name: z.string().describe('Overarching name of the project/system'),
        vision: z.string().describe('Vision, mission, and core goals of the system'),
        boundaries: z.array(z.union([z.string(), z.object({ name: z.string(), description: z.string().optional() })])).optional().describe('System boundary rules or scope statements (strings or name/description objects)'),
        globalRequirements: z.array(z.union([z.string(), z.object({ description: z.string() })])).optional().describe('Global functional and non-functional requirements (strings or description objects)'),
        targetLanguage: z.string().optional().describe('Default implementation language for the system (e.g. "typescript", "rust", "python"). Subsystems may override. Enables language-aware validation.'),
      },
    },
    ({ name, vision, boundaries, globalRequirements, targetLanguage }) => {
      try {
        const { saveSystemSpec } = requireSpecs();
        const now = new Date().toISOString();
        saveSystemSpec({
          schemaVersion: '1.0.0',
          name,
          vision,
          boundaries: boundaries ?? [],
          globalRequirements: globalRequirements ?? [],
          databases: [],
          ...(targetLanguage ? { targetLanguage } : {}),
          createdAt: now,
          updatedAt: now,
        });
        return text(`Successfully initialized L0 System Spec for "${name}".`);
      } catch (e) {
        return errText(String(e));
      }
    },
  );

  reg<{ id: string; name: string; description: string; publicInterfaces?: { type: 'REST' | 'GraphQL' | 'MessageBus' | 'RPC' | 'Custom'; details: string; component?: string; interface?: string }[]; projectPath?: string; targetLanguage?: string; profile?: string; designDepth?: 'components' | 'interfaces' | 'implementations' | 'narratives'; trustedLinks?: { subsystem: string; reason: string }[]; lifecycle?: { phase: 'init' | 'shutdown' | 'cyclic' | 'interrupt' | 'scheduled'; component: string; method: string; description?: string }[] }>(server,
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
        projectPath: z.string().optional().describe('Relative path to external project root for subsystem chaining'),
        targetLanguage: z.string().optional().describe('Override of the system-level targetLanguage for this subsystem'),
        profile: z.string().optional().describe('Architectural profile override for this subsystem (built-ins: backend, frontend-reactive, frontend-controller, lowlevel-os, game-ecs, realtime-embedded, plc-cyclic; extension packs may add more — unknown names get UNKNOWN_PROFILE)'),
        designDepth: z.enum(['components', 'interfaces', 'implementations', 'narratives']).optional().describe('How deep THIS subsystem commits to designing (overrides project rules.designDepth; default narratives = full depth). Expectation checks below the depth are gated — soundness of authored content always applies.'),
        trustedLinks: z.array(z.object({
          subsystem: z.string().describe('Peer subsystem id'),
          reason: z.string().describe('Why the coupling is sanctioned (e.g. "dispatch latency fast lane")'),
        })).optional().describe('Sanctioned tight couplings with peers — required to acknowledge a mutual subsystem dependency; the Adapter → published Portal shape still applies.'),
        lifecycle: z.array(z.object({
          phase: z.enum(['init', 'shutdown', 'cyclic', 'interrupt', 'scheduled']).describe('Which lifecycle/execution flow this roots (cyclic = every scan/tick, interrupt = hardware/OS interrupt, scheduled = timer/cron)'),
          component: z.string().describe('Component id whose method the runtime invokes at this phase'),
          method: z.string().describe('Method name on that component\'s interface'),
          description: z.string().optional(),
        })).optional().describe('Declared execution-flow roots — reachability entrypoints alongside Portals/Observers. Only init flows feed the durable-Store hydration check (MISSING_HYDRATION); cyclic/interrupt/scheduled root non-request/response execution models (PLC scan, ISR, cron).'),
      },
    },
    ({ id, name, description, publicInterfaces, projectPath, targetLanguage, profile, designDepth, trustedLinks, lifecycle }) => {
      try {
        const { loadSystemSpec, saveSubsystemSpec } = requireSpecs();
        const system = loadSystemSpec();
        if (!system) return errText('System spec must be initialized (sdd_initialize_system) first.');
        const now = new Date().toISOString();
        const spec: SubsystemSpec = {
          id,
          name,
          description,
          parentSystem: system.name,
          publicInterfaces: publicInterfaces ?? [],
          projectPath,
          ...(targetLanguage ? { targetLanguage } : {}),
          ...(profile ? { profile } : {}),
          ...(designDepth ? { designDepth } : {}),
          ...(lifecycle ? { lifecycle } : {}),
          trustedLinks: trustedLinks ?? [],
          status: 'draft',
          createdAt: now,
          updatedAt: now,
        };
        // External (chained) subsystem: also scaffold the child project so the
        // projectPath never points at an empty directory.
        if (projectPath && projectPath.trim() !== '') {
          const { createChainedSubsystem } = requireProvision();
          createChainedSubsystem(spec, name);
          return text(`Successfully added external subsystem "${name}" (${id}) and scaffolded its child project at ${projectPath}.`);
        }
        saveSubsystemSpec(spec);
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

  reg<{ subsystem: string; projectPath?: string }>(server,
    'sdd_set_subsystem_project_path',
    {
      description: 'Set (or clear) the projectPath of an L1 Subsystem for subsystem chaining. projectPath should be a relative path to the external project root directory.',
      inputSchema: {
        subsystem: z.string().describe('The L1 subsystem id to update'),
        projectPath: z.string().optional().describe('Relative path to external project root (or omit to clear)'),
      },
    },
    ({ subsystem, projectPath }) => {
      try {
        const { loadSubsystemSpec, saveSubsystemSpec } = requireSpecs();
        const sub = loadSubsystemSpec(subsystem);
        if (!sub) return errText(`Subsystem "${subsystem}" does not exist.`);
        saveSubsystemSpec({
          ...sub,
          projectPath,
          updatedAt: new Date().toISOString(),
        });
        return text(`Updated projectPath for subsystem "${subsystem}" to: ${projectPath || 'none (cleared)'}`);
      } catch (e) {
        return errText(String(e));
      }
    },
  );

  reg<{ subsystem: string; newProjectPath: string }>(server,
    'sdd_move_subsystem_project',
    {
      description: 'Relocate an external subsystem: move its subproject directory on disk to newProjectPath and update its projectPath link in one step. Errors if the subsystem has no projectPath (not an external subproject).',
      inputSchema: {
        subsystem: z.string().describe('The external L1 subsystem id to relocate'),
        newProjectPath: z.string().describe('The new relative path for the subproject directory'),
      },
    },
    ({ subsystem, newProjectPath }) => {
      try {
        const { moveSubsystemProject } = requireProvision();
        moveSubsystemProject(subsystem, newProjectPath);
        return text(`Moved subsystem "${subsystem}" to: ${newProjectPath}`);
      } catch (e) {
        return errText(String(e));
      }
    },
  );

  reg<{ subsystem: string; projectPath: string }>(server,
    'sdd_externalize_subsystem',
    {
      description: 'Migrate an internal subsystem into a standalone subproject at projectPath: move its spec subtree out, mount it via projectPath, and rewrite cross-subsystem references to the new namespaced ids. Source code is not moved. Errors if the subsystem is missing or already external.',
      inputSchema: {
        subsystem: z.string().describe('The internal L1 subsystem id to externalize'),
        projectPath: z.string().describe('Relative destination directory for the new subproject'),
      },
    },
    ({ subsystem, projectPath }) => {
      try {
        const { externalizeSubsystem } = requireProvision();
        externalizeSubsystem(subsystem, projectPath);
        return text(`Externalized subsystem "${subsystem}" into subproject: ${projectPath}. Move its source code there and re-validate.`);
      } catch (e) {
        return errText(String(e));
      }
    },
  );

  reg<{ subsystem: string }>(server,
    'sdd_internalize_subsystem',
    {
      description: 'Migrate an external subsystem back into the parent tree: move its subproject spec subtree back under the parent, drop projectPath, delete the child .wai project, and rewrite references back to bare ids. Errors if the subsystem is not external or its subproject is not a single flat subsystem.',
      inputSchema: {
        subsystem: z.string().describe('The external L1 subsystem id to internalize'),
      },
    },
    ({ subsystem }) => {
      try {
        const { internalizeSubsystem } = requireProvision();
        internalizeSubsystem(subsystem);
        return text(`Internalized subsystem "${subsystem}" back into this project (child .wai removed).`);
      } catch (e) {
        return errText(String(e));
      }
    },
  );

  reg<{ id: string; name: string; description: string; subsystem: string; componentType: 'Portal' | 'Orchestrator' | 'Supervisor' | 'Actor' | 'Store' | 'Index' | 'Registry' | 'Adapter' | 'Observer' | 'Specialist' | 'Repository' | 'Gateway'; owns?: string[]; dependsOn?: string[]; portalType?: 'HTTP_API' | 'gRPC' | 'GraphQL' | 'MessageBus' | 'CLI' | 'NamedPipe' | 'IPC' | 'Custom'; basePath?: string; dispatch?: { capability: string; component: string; method: string; description?: string }[]; durability?: 'ram-projection' | 'durable' | 'read-through' | 'cache'; emits?: { topic: string; event?: string; description?: string }[]; subscribesTo?: { topic: string; event?: string; description?: string }[]; ext?: Record<string, unknown> }>(server,
    'sdd_add_component',
    {
      description: 'Add an L2 Component under a subsystem. componentType is a building block (Portal, Orchestrator, Supervisor, Actor, Store, Index, Registry, Adapter, Observer, Specialist) or a pattern (Repository, Gateway). Patterns set "owns" (their private member blocks); all components set "dependsOn" (collaborators — facades or standalone blocks). Held/persisted state (configs, permissions, sessions, caches): model the Repository recipe — a Store + Registry (write) + Index (read) owned by a Repository facade consumers depend on; a deliberately standalone Store is the sanctioned lightweight form (workflow-layer consumers + lint.allow on UNOWNED_STORE). Never hold state as fields inside an Orchestrator/Specialist because a Store link was refused.',
      inputSchema: {
        id: z.string().describe('Lowercase identifier for the component'),
        name: z.string().describe('Human-readable display name'),
        description: z.string().describe('Responsibility / internal architecture details'),
        subsystem: z.string().describe('The L1 subsystem ID this component belongs to'),
        componentType: z.enum(['Portal', 'Orchestrator', 'Supervisor', 'Actor', 'Store', 'Index', 'Registry', 'Adapter', 'Observer', 'Specialist', 'Repository', 'Gateway']).describe('The building block, or pattern (Repository/Gateway)'),
        owns: z.array(z.string()).optional().describe('Member block ids privately owned by this component (patterns only)'),
        dependsOn: z.array(z.string()).optional().describe('IDs of other components this collaborates with (facades or standalone blocks)'),
        portalType: z.enum(['HTTP_API', 'gRPC', 'GraphQL', 'MessageBus', 'CLI', 'NamedPipe', 'IPC', 'Custom']).optional().describe('Required when componentType is Portal'),
        basePath: z.string().optional().describe('Portal-only: base path/prefix all the portal\'s endpoints mount under (UNEXPECTED_PORTAL_FIELD on non-Portals)'),
        dispatch: z.array(z.object({
          capability: z.string().describe('Capability name exactly as dispatched at runtime (e.g. "shadow_module.get")'),
          component: z.string().describe('Component id serving this capability (must also appear under dependsOn/owns)'),
          method: z.string().describe('Method name on the serving component\'s interface'),
          description: z.string().optional(),
        })).optional().describe('Portal-only: capability → component.method dispatch table for generic-handle portals. Gives the reachability walker real edges and is validated against target interfaces (UNSERVED_CAPABILITY).'),
        durability: z.enum(['ram-projection', 'durable', 'read-through', 'cache']).optional().describe('Store-only, and every Store should declare one (MISSING_DURABILITY): durable = persisted RAM projection (hydration read-back from a lifecycle init entrypoint required — MISSING_HYDRATION); read-through = persisted with no RAM copy (every read is the read-back, hydration exempt); ram-projection = rebuilt not restored; cache = evictable loss-safe memo state.'),
        emits: z.array(z.object({
          topic: z.string().describe('Topic/channel name exactly as used on the bus'),
          event: z.string().optional().describe('Optional event name within the topic (informational; pairing is by topic)'),
          description: z.string().optional(),
        })).optional().describe('Topics this component publishes — every emitted topic needs a subscriber somewhere in the tree (UNCONSUMED_TOPIC).'),
        subscribesTo: z.array(z.object({
          topic: z.string().describe('Topic/channel name exactly as used on the bus'),
          event: z.string().optional(),
          description: z.string().optional(),
        })).optional().describe('Topics this component consumes (typical on Observers) — every subscription needs an emitter somewhere in the tree (UNSOURCED_SUBSCRIPTION).'),
        ext: z.record(z.unknown()).optional().describe('Opaque pack/tool extension data (namespaced keys, e.g. "mypack:priority") — preserved verbatim, never validated or interpreted by the core'),
      },
    },
    ({ id, name, description, subsystem, componentType, owns, dependsOn, portalType, basePath, dispatch, durability, emits, subscribesTo, ext }) => {
      try {
        const { loadSubsystemSpec, saveComponentSpec } = requireSpecs();
        const sub = loadSubsystemSpec(subsystem);
        if (!sub) return errText(`Parent subsystem "${subsystem}" does not exist.`);
        const now = new Date().toISOString();
        const notices = saveComponentSpec({
          id,
          name,
          description,
          subsystem,
          componentType,
          owns: owns ?? [],
          dependsOn: dependsOn ?? [],
          ...(portalType ? { portalType } : {}),
          ...(basePath ? { basePath } : {}),
          ...(dispatch ? { dispatch } : {}),
          ...(durability ? { durability } : {}),
          ...(emits ? { emits } : {}),
          ...(subscribesTo ? { subscribesTo } : {}),
          ...(ext ? { ext } : {}),
          status: 'draft',
          createdAt: now,
          updatedAt: now,
        });
        const noticeBlock = notices.length ? `\n\nNOTICE:\n- ${notices.join('\n- ')}` : '';
        return text(`Successfully added L2 Component Spec "${name}" (${id}, ${componentType}).${noticeBlock}`);
      } catch (e) {
        return errText(String(e));
      }
    },
  );

  reg<{ id: string; name: string; description: string; component: string; methods?: { name: string; description: string; signature: string; returns: string; params?: { name: string; type: string; description?: string; optional?: boolean }[]; guarantees?: string[]; effect?: 'read' | 'write'; ext?: Record<string, unknown> }[] }>(server,
    'sdd_define_interface',
    {
      description: 'Define an L3 Contract / Interface with method signatures for a component. Prefer supplying structured `params` per method — they are the authoritative source for type checking (the free-form signature string then becomes display-only and is never heuristically parsed).',
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
          params: z.array(z.object({
            name: z.string(),
            type: z.string().describe('A primitive/builtin or a defined type id (e.g. "billing.Invoice")'),
            description: z.string().optional(),
            optional: z.boolean().optional(),
          })).optional().describe('Structured parameters — authoritative for type checking (the prose signature becomes display-only). Strongly preferred.'),
          guarantees: z.array(z.string().min(1)).optional().describe('Semantic guarantees the method promises (combinable); any guarantee a narrative step asserts must be declared here. Builtin tokens: idempotent | atomic | transactional | exactly-once; extension packs may declare more (any other token is UNKNOWN_GUARANTEE)'),
          effect: z.enum(['read', 'write']).optional().describe('State-effect direction on the component\'s held state — required on a durable Store\'s contract methods so the durability round-trip rule can pair writes with hydration read-backs'),
          ext: z.record(z.unknown()).optional().describe('Opaque pack/tool extension data for this method (namespaced keys) — preserved verbatim'),
        })).optional().describe('List of method signature contracts'),
      },
    },
    ({ id, name, description, component, methods }) => {
      try {
        const { loadComponentSpec, loadInterfaceSpec, saveInterfaceSpec } = requireSpecs();
        const comp = loadComponentSpec(component);
        if (!comp) return errText(`Component "${component}" does not exist.`);
        const now = new Date().toISOString();
        // Redefining an EXISTING interface replaces what the input expresses —
        // but the input cannot express spec-level lint/ext or per-method
        // endpoint bindings (sdd_set_endpoints), and may omit per-method ext.
        // Carry those forward from the previous definition (createdAt likewise)
        // instead of silently dropping them.
        const existing = loadInterfaceSpec(id);
        const carried: string[] = [];
        if (existing) carried.push('createdAt');
        if (existing?.lint !== undefined) carried.push('lint');
        if (existing?.ext !== undefined) carried.push('ext');
        const specMethods = (methods ?? []).map((m) => {
          const prev = existing?.methods.find((p) => p.name === m.name);
          const endpoint = prev?.endpoint;
          const ext = m.ext ?? prev?.ext;
          if (prev?.endpoint !== undefined) carried.push(`endpoint (${m.name})`);
          if (m.ext === undefined && prev?.ext !== undefined) carried.push(`method ext (${m.name})`);
          return {
            ...m,
            ...(endpoint !== undefined ? { endpoint } : {}),
            ...(ext !== undefined ? { ext } : {}),
          };
        });
        const notices = saveInterfaceSpec({
          id,
          name,
          description,
          component,
          methods: specMethods,
          ...(existing?.lint !== undefined ? { lint: existing.lint } : {}),
          ...(existing?.ext !== undefined ? { ext: existing.ext } : {}),
          status: 'draft',
          createdAt: existing?.createdAt ?? now,
          updatedAt: now,
        });
        if (existing) {
          notices.push(`Interface "${id}" already existed — redefined; carried forward from the previous definition: ${carried.join(', ')}.`);
        }
        const noticeBlock = notices.length ? `\n\nNOTICE:\n- ${notices.join('\n- ')}` : '';
        return text(`Successfully defined L3 Interface Contract "${name}" (${id}).${noticeBlock}`);
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
      description: 'Bind concrete wire endpoints to existing L3 interface methods (required for every Portal). Pick `transport` and fill that transport\'s address fields. Run after sdd_define_interface.',
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

  const stepNo = () => z.number().int().positive();
  const labelRef = () => z.string().min(1);
  const narrativeStepInput = z.object({
    stepNumber: stepNo().optional().describe('Defaults to the 1-based array position — jump fields reference these numbers'),
    label: labelRef().optional().describe('Optional symbolic anchor for this step (unique per narrative). Every jump-by-number field has a *Label twin resolved against these anchors at write time — prefer labels over hand-counted step numbers'),
    description: z.string(),
    type: z.enum(['local', 'call', 'dispatch', 'branch', 'switch', 'loop', 'try', 'parallel', 'jump', 'return', 'throw']),
    targetComponent: z.string().optional().describe('call/dispatch: L2 component id (for dispatch, the Portal routed through)'),
    targetMethod: z.string().optional().describe('call: method name on the target'),
    auth: z.object({ from: z.string(), note: z.string().optional() }).optional().describe('call/dispatch: the credential this step presents to an AUTHED callee Portal and WHERE it loads from (`from`). Opaque form (env:API_KEY, a config key, vault:path) = a design note wairon never resolves; modeled form `component:<id>` references the Adapter/Store that provides the secret and is validated (must resolve, be an Adapter/Store, and be wired to the presenter). Absence on a call into a Portal whose auth ≠ none warns (PORTAL_AUTH_UNMET). The authenticated call itself should be made by an Adapter (AUTH_PRESENTER_NOT_ADAPTER).'),
    detach: z.boolean().optional().describe('call/dispatch: fire-and-forget — issue the call and continue without awaiting the result (no later step consumes it)'),
    capability: z.string().optional().describe('dispatch: the capability routed through the target Portal\'s dispatch table (validated against it — UNSERVED_CAPABILITY)'),
    assertsGuarantees: z.array(z.string().min(1)).optional().describe('Semantic guarantees this step relies on — each must be declared in the called method\'s L3 guarantees (NARRATIVE_SEMANTIC_UNBACKED otherwise). Builtin tokens: idempotent | atomic | transactional | exactly-once; extension packs may declare more (any other token is UNKNOWN_GUARANTEE)'),
    assertsInvariants: z.array(z.string()).optional().describe('Declared entity invariants this step upholds, as "<type-id>.<invariant-id>" refs (UNKNOWN_INVARIANT_REF when unresolved); write-effect methods of the entity\'s componentClass must carry one per declared invariant (UNASSERTED_INVARIANT)'),
    condition: z.string().optional().describe('branch / while / doWhile'),
    onTrueStep: stepNo().optional().describe('branch: default = next step'),
    onTrueLabel: labelRef().optional().describe('branch: symbolic alternative to onTrueStep'),
    onFalseStep: stepNo().optional().describe('branch: required (or onFalseLabel)'),
    onFalseLabel: labelRef().optional().describe('branch: symbolic alternative to onFalseStep'),
    on: z.string().optional().describe('switch: the dispatched value'),
    cases: z.array(z.object({ value: z.string(), step: stepNo().optional(), label: labelRef().optional() })).optional().describe('switch: required; each case targets its region by step number or label'),
    defaultStep: stepNo().optional().describe('switch: default = next step'),
    defaultLabel: labelRef().optional().describe('switch: symbolic alternative to defaultStep'),
    loopKind: z.enum(['forEach', 'for', 'while', 'doWhile']).optional().describe('loop: default forEach when "over" is set, else while'),
    over: z.string().optional().describe('loop forEach/for: iteration source'),
    endStep: stepNo().optional().describe('loop/try: last step of the body region (required, or endLabel)'),
    endLabel: labelRef().optional().describe('loop/try: symbolic alternative to endStep'),
    catches: z.array(z.object({ error: z.string(), step: stepNo().optional(), label: labelRef().optional() })).optional().describe('try: handler regions, each targeted by step number or label'),
    finallyStep: stepNo().optional().describe('try: first step of the always-runs region'),
    finallyLabel: labelRef().optional().describe('try: symbolic alternative to finallyStep'),
    branches: z.array(z.object({ step: stepNo().optional(), label: labelRef().optional(), name: z.string().optional() })).optional().describe('parallel: >= 2 arm entries (step number or label), ascending, first = the step after the header; arms are contiguous sub-regions of body next..endStep, joining after endStep once ALL complete'),
    toStep: stepNo().optional().describe('jump: required (break/continue/rejoin), or toLabel'),
    toLabel: labelRef().optional().describe('jump: symbolic alternative to toStep — resolves to the labeled step at write time'),
    outcome: z.string().optional().describe('return: e.g. "success", "not found"'),
    error: z.string().optional().describe('throw: the raised error'),
  });
  type NarrativeStepIn = z.infer<typeof narrativeStepInput>;
  const detailEnum = z.enum(['full', 'calls-only', 'intent']);

  const conformanceEnum = z.enum(['declared', 'anchored', 'off']);
  reg<{ id: string; name: string; description: string; contract: string; sourcePath?: string; simPath?: string; technologies?: string[]; detail?: 'full' | 'calls-only' | 'intent'; conformance?: 'declared' | 'anchored' | 'off'; methods?: { name: string; detail?: 'full' | 'calls-only' | 'intent'; intent?: string; conformance?: 'declared' | 'anchored' | 'off'; symbol?: string; ext?: Record<string, unknown>; narrative?: NarrativeStepIn[] }[] }>(server,
    'sdd_write_narrative',
    {
      description: 'Write L4 Concrete Implementation spec containing L5 method narratives. Narratives are a FLAT ordered step list; flow steps (branch/switch/loop/try/parallel/jump/return/throw) jump by step number — blocks are just skipped regions. Steps may declare a `label` anchor, and every jump field has a *Label twin (toLabel, onTrueLabel, endLabel, …) resolved to step numbers at write time — prefer labels over hand-counted numbers; an unresolvable label rejects the write. Detail dial per method: full (narrative required) | calls-only (call choreography suffices) | intent (prose instead of steps); omitted = stereotype default (Portal/Observer/Adapter: calls-only, Store/Index/Registry: intent, else full). Conformance dial per method or spec: declared | anchored | off — how strictly structural conformance requires contract methods to be realized in the sourcePath file (omitted = Portal: anchored, else declared).',
      inputSchema: {
        id: z.string().describe('Lowercase identifier, e.g. "vfs_storage"'),
        name: z.string().describe('Human-readable implementation name'),
        description: z.string().describe('Implementation details'),
        contract: z.string().describe('The L3 Interface contract ID this implements'),
        sourcePath: z.string().optional().describe('Optional: target source code file path relative to project root'),
        simPath: z.string().optional().describe('Optional: the committed integration-sim harness file (project-relative; N:1 sharing allowed). The validator proves it exists and its import graph wires the REAL modules (this component + each direct dependency; technology adapters may stay faked) — running it is CI\'s job. Declaring the first simPath in a subsystem activates MISSING_INTEGRATION_SIM for its other complete non-leaf implementations'),
        technologies: z.array(z.string()).optional().describe('External technologies this implementation binds to (e.g. ["mysql"]) — declares this component\'s ownership tree as the technology\'s home; references outside it are flagged (TECH_LEAKAGE) and contract identifiers must stay intent-language. Only for Adapter/Store/Registry/Index components.'),
        detail: detailEnum.optional().describe('Spec-level narrative detail default for all methods'),
        conformance: conformanceEnum.optional().describe('Spec-level structural-conformance tier default: declared | anchored | off (omitted = stereotype default: Portal → anchored, else declared)'),
        methods: z.array(z.object({
          name: z.string(),
          detail: detailEnum.optional().describe('Detail level for this method (overrides the spec default)'),
          intent: z.string().optional().describe('detail: intent — behavioral prose (what it does and how it fails); substitute for a narrative'),
          conformance: conformanceEnum.optional().describe('Conformance tier for this method (overrides the spec default)'),
          symbol: z.string().optional().describe('Code-level name realizing this contract method in the sourcePath file, when it legitimately differs from the intent-language contract name (e.g. put realized by saveSnapshot)'),
          ext: z.record(z.unknown()).optional().describe('Opaque pack/tool extension data for this method (namespaced keys) — preserved verbatim'),
          narrative: z.array(narrativeStepInput).optional(),
        })).optional().describe('Method implementations containing L5 narratives'),
      },
    },
    ({ id, name, description, contract, sourcePath, simPath, technologies, detail, conformance, methods }) => {
      try {
        const { loadInterfaceSpec, loadImplementationSpec, saveImplementationSpec } = requireSpecs();
        const intf = loadInterfaceSpec(contract);
        if (!intf) return errText(`Interface contract "${contract}" does not exist.`);
        // Re-authoring an EXISTING implementation replaces what the input
        // expresses — but the input cannot express spec-level lint/ext and may
        // omit per-method ext. Carry those forward from the previous version
        // (createdAt likewise) instead of silently dropping them.
        const existing = loadImplementationSpec(id);
        const carried: string[] = [];
        if (existing) carried.push('createdAt');
        if (existing?.lint !== undefined) carried.push('lint');
        if (existing?.ext !== undefined) carried.push('ext');
        const resolvedMethods = (methods ?? []).map(m => {
          const prev = existing?.methods.find(p => p.name === m.name);
          const ext = m.ext ?? prev?.ext;
          if (m.ext === undefined && prev?.ext !== undefined) carried.push(`method ext (${m.name})`);
          return {
            ...m,
            ...(ext !== undefined ? { ext } : {}),
            narrative: (m.narrative ?? []).map((s, i) => ({ ...s, stepNumber: s.stepNumber ?? i + 1 })),
          };
        });
        // Symbolic *Label references resolve to step numbers before the spec
        // is saved; an unresolvable reference rejects the whole write.
        const labelErrors = resolvedMethods.flatMap(m => resolveNarrativeLabels(m.name, m.narrative));
        if (labelErrors.length) return errText(`Unresolved narrative label references — nothing was saved:\n- ${labelErrors.join('\n- ')}`);
        const now = new Date().toISOString();
        const notices = saveImplementationSpec({
          id,
          name,
          description,
          contract,
          sourcePath,
          simPath,
          technologies,
          detail,
          conformance,
          ...(existing?.lint !== undefined ? { lint: existing.lint } : {}),
          ...(existing?.ext !== undefined ? { ext: existing.ext } : {}),
          // Post-resolution every cases/catches entry has its numeric step —
          // the *Label twins exist only in the input type, not the spec's.
          methods: resolvedMethods as Parameters<typeof saveImplementationSpec>[0]['methods'],
          status: 'draft',
          createdAt: existing?.createdAt ?? now,
          updatedAt: now,
        });
        if (existing) {
          notices.push(`Implementation "${id}" already existed — re-authored; carried forward from the previous version: ${carried.join(', ')}.`);
        }
        const noticeBlock = notices.length ? `\n\nNOTICE:\n- ${notices.join('\n- ')}` : '';
        return text(`Successfully saved L4 Implementation Spec "${name}" (${id}) with method narratives.${noticeBlock}`);
      } catch (e) {
        return errText(String(e));
      }
    },
  );

  reg<{ kind: 'entity' | 'value-object'; id: string; name: string; description?: string; subsystem?: string; group?: string; fields?: { name: string; type: string; description?: string; optional?: boolean; key?: 'primary' | 'unique' | 'foreign'; references?: string }[]; methods?: { name: string; signature: string; returns: string; description?: string }[]; componentClass?: string; invariants?: { id: string; description: string }[]; database?: string; table?: string; linkedEntity?: string }>(server,
    'sdd_add_type',
    {
      description: 'Define an entity or value-object type (the data components operate on). Entities are owned by a subsystem; shared value objects omit subsystem (system-level). Fields are data; methods are PURE intrinsic behaviour only — anything needing a collaborator belongs on a component, taking the entity as an argument.',
      inputSchema: {
        kind: z.enum(['entity', 'value-object']).describe('entity (owned by a subsystem) or value-object (often system-level shared)'),
        id: z.string().describe('Lowercase identifier'),
        name: z.string().describe('Human-readable name'),
        description: z.string().optional(),
        subsystem: z.string().optional().describe('Owning subsystem id; omit for a system-level shared value object'),
        group: z.string().optional().describe('Optional logical group ID to organize this type in subfolders'),
        fields: z.array(z.object({
          name: z.string(),
          type: z.string(),
          description: z.string().optional(),
          optional: z.boolean().optional(),
          key: z.enum(['primary', 'unique', 'foreign']).optional().describe('Identity marker (PK/unique/FK) for ERD and database schema derivation'),
          references: z.string().optional().describe('For foreign keys, the referenced type/table id and optional field, e.g. "invoice.id"'),
        })).optional().describe('Data fields (type is a primitive or a qualified type id, e.g. "billing.Invoice")'),
        methods: z.array(z.object({ name: z.string(), signature: z.string(), returns: z.string(), description: z.string().optional() })).optional().describe('Pure intrinsic methods only'),
        componentClass: z.string().optional().describe('Optional component id that implements or owns this logical entity'),
        invariants: z.array(z.object({
          id: z.string().describe('Stable invariant id, unique within the entity'),
          description: z.string().describe('The property that must hold, stated precisely'),
        })).optional().describe('Declared domain invariants (entities): every write-effect method of the componentClass must carry a narrative step asserting each (assertsInvariants) — declarations checked, enforcement never proven'),
        database: z.string().optional().describe('Optional database id for table-schema types'),
        table: z.string().optional().describe('Optional database table name for table-schema types'),
        linkedEntity: z.string().optional().describe('Optional logical entity id represented by this table-schema type'),
      },
    },
    ({ kind, id, name, description, subsystem, group, fields, methods, componentClass, invariants, database, table, linkedEntity }) => {
      try {
        const { saveTypeSpec } = requireSpecs();
        const now = new Date().toISOString();
        const notices = saveTypeSpec({
          kind,
          id,
          name,
          ...(description ? { description } : {}),
          ...(subsystem ? { subsystem } : {}),
          ...(group ? { group } : {}),
          fields: (fields ?? []).map((f) => ({
            name: f.name,
            type: f.type,
            description: f.description,
            optional: f.optional ?? false,
            ...(f.key ? { key: f.key } : {}),
            ...(f.references ? { references: f.references } : {}),
          })),
          methods: methods ?? [],
          ...(componentClass ? { componentClass } : {}),
          ...(invariants?.length ? { invariants } : {}),
          ...(database ? { database } : {}),
          ...(table ? { table } : {}),
          ...(linkedEntity ? { linkedEntity } : {}),
          createdAt: now,
          updatedAt: now,
        });
        const noticeBlock = notices.length ? `\n\nNOTICE:\n- ${notices.join('\n- ')}` : '';
        return text(`Successfully defined ${kind} type "${name}" (${id}).${noticeBlock}`);
      } catch (e) {
        return errText(String(e));
      }
    },
  );

  reg<{ subsystem?: string; recursive?: boolean }>(server,
    'sdd_validate_tree',
    {
      description: 'Validate the SDD spec tree, checking parent references, contract compatibility, narratives, and component type boundaries. Supports scoping and recursion controls.',
      inputSchema: {
        subsystem: z.string().optional().describe('Only validate the specified subsystem (granular)'),
        recursive: z.boolean().optional().describe('Whether to recursively validate subprojects (default: true)'),
      },
    },
    ({ subsystem, recursive }) => {
      try {
        const { loadProjectConfig } = requireLoader();
        const config = loadProjectConfig();
        const { validateSddTree } = requireValidation();
        const result = validateSddTree({
          rules: config.rules,
          projectType: config.projectType,
          scopeSubsystem: subsystem,
          recursive: recursive ?? true,
        });
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

  reg<{ kind: 'system' | 'subsystem' | 'component' | 'interface' | 'implementation' | 'type'; id: string }>(server,
    'sdd_get_spec',
    {
      description: 'Get/read the parsed JSON contents of a specific spec from the spec tree. Returns structural contents without file system path searching.',
      inputSchema: {
        kind: z.enum(['system', 'subsystem', 'component', 'interface', 'implementation', 'type']).describe('The kind of specification'),
        id: z.string().describe('The identifier of the spec to fetch (the L0 system spec is a singleton — pass the system name or "system")'),
      },
    },
    ({ kind, id }) => {
      try {
        const specs = requireSpecs();
        let result: unknown = null;
        switch (kind) {
          case 'system':         result = specs.loadSystemSpec(); break;
          case 'subsystem':      result = specs.loadSubsystemSpec(id); break;
          case 'component':      result = specs.loadComponentSpec(id); break;
          case 'interface':      result = specs.loadInterfaceSpec(id); break;
          case 'implementation': result = specs.loadImplementationSpec(id); break;
          case 'type':           result = specs.loadTypeSpec(id); break;
        }
        if (!result) return errText(`Spec of kind "${kind}" with ID "${id}" does not exist.`);
        return json(result);
      } catch (e) {
        return errText(String(e));
      }
    }
  );

  reg<{ kind: 'subsystem' | 'component' | 'interface' | 'implementation' | 'type'; id: string }>(server,
    'sdd_delete_spec',
    {
      description: 'Delete a specification file from the spec tree and clean up any empty parent directories.',
      inputSchema: {
        kind: z.enum(['subsystem', 'component', 'interface', 'implementation', 'type']).describe('The kind of spec to delete'),
        id: z.string().describe('The ID of the spec to delete'),
      },
    },
    ({ kind, id }) => {
      try {
        const specs = requireSpecs();
        let deleted = false;
        switch (kind) {
          case 'subsystem':      deleted = specs.deleteSubsystemSpec(id); break;
          case 'component':      deleted = specs.deleteComponentSpec(id); break;
          case 'interface':      deleted = specs.deleteInterfaceSpec(id); break;
          case 'implementation': deleted = specs.deleteImplementationSpec(id); break;
          case 'type':           deleted = specs.deleteTypeSpec(id); break;
        }
        if (!deleted) return errText(`Spec of kind "${kind}" with ID "${id}" could not be deleted (file may not exist).`);
        return text(`Successfully deleted ${kind} spec "${id}".`);
      } catch (e) {
        return errText(String(e));
      }
    }
  );

  reg<{ kind: 'system' | 'subsystem' | 'component' | 'interface' | 'implementation' | 'type'; id: string; delta: Record<string, any> }>(server,
    'sdd_update_spec',
    {
      description: 'Update/patch an existing SDD specification (subsystem, component, interface, implementation, or type) using a granular delta. Updates fields, appends/merges array elements, or inserts/deletes narrative steps.',
      inputSchema: {
        kind: z.enum(['system', 'subsystem', 'component', 'interface', 'implementation', 'type']).describe('The spec kind to update (system = the singleton L0 — vision, boundaries, globalRequirements, databases, and publicInterfaces: the project gateway surface, each entry {id, name, subsystem, component, type, details, audience: project|department|instance|partner|external}; id is informational)'),
        id: z.string().describe('The ID of the spec to update (namespaced if needed)'),
        delta: z.record(z.any()).describe('The partial fields to merge into the spec. For arrays (like methods or fields), elements are matched by "name" (or "id") and merged/upserted. Add "action: \'delete\'" (or "remove: true") to delete a named element. Dispatch tables upsert by "capability" and lifecycle entrypoints by phase+component+method (use "action: \'delete\'" to remove an entry). For narrative steps, match by "stepNumber" and use "action: \'insert\'" (shifts subsequent steps up) or "action: \'delete\'" (shifts subsequent steps down and removes it). Renumbering RELOCATES every flow jump field (onTrueStep/onFalseStep/cases.step/defaultStep/endStep/catches.step/finallyStep/toStep) in the same narrative; deleting a step that is a jump target is rejected until the referrers are retargeted. Inserting AT a jump target relocates those jumps past the inserted step by default (a NOTICE is returned) — add "captureJumps": true on the inserted step to retarget entry jumps onto it (loop/try endStep region tails always relocate with the body and are never captured). Reference ids in deltas may use LOCAL names — they are qualified against the spec\'s namespace exactly as the loader would. Per-spec lint suppression: set "lint: { allow: [{ code, reason }] }" to silence a WARNING code on this spec only (errors always surface; stale allows are flagged).'),
      },
    },
    ({ kind, id, delta }) => {
      try {
        const specs = requireSpecs();
        const notices = specs.updateSpec(kind, id, delta);
        const noticeBlock = notices.length ? `\n\nNOTICE:\n- ${notices.join('\n- ')}` : '';
        return text(`Successfully updated ${kind} spec "${id}".${noticeBlock}`);
      } catch (e) {
        return errText(String(e));
      }
    }
  );

  reg<{ subsystem?: string; recursive?: boolean }>(server,
    'sdd_get_status',
    {
      description: 'Get the completeness status dashboard of the SDD spec tree. Supports scoping and recursion controls.',
      inputSchema: {
        subsystem: z.string().optional().describe('Only show status for the specified subsystem'),
        recursive: z.boolean().optional().describe('Whether to recursively load subprojects (default: true)'),
      },
    },
    ({ subsystem, recursive }) => {
      try {
        const { getStatusReport } = require('../commands/status.js') as typeof import('../commands/status.js');
        return text(getStatusReport({
          subsystem,
          recursive: recursive ?? true,
        }));
      } catch (e) {
        return errText(String(e));
      }
    },
  );

  reg<Record<string, never>>(server,
    'sdd_list_external_interfaces',
    {
      description: 'List the bound project\'s consumable external surfaces (parent family, siblings, foreign imports) as discovery entries with origin, provenance, and freshness — the tool an agent inside a subproject uses to SEE its outward world instead of discovering it by failed reference resolution. Full contracts stay in the vendored snapshots (.wai/surfaces/); each entry summarizes the interface ids it exposes.',
    },
    () => {
      try {
        return json(listExternalInterfaces());
      } catch (e) {
        return errText(String(e));
      }
    },
  );

  // ── Built-in SDD skills as read-only MCP resources ────────────────────────
  registerSkillResources(server);

  // ── Chained-subproject bind-time announcement ─────────────────────────────
  // When the bound root is a chained subproject, announce it on the startup
  // log (stderr — stdout is the JSON-RPC channel): the parent project root,
  // the mounting subsystem id, and how many vendored external surfaces are
  // discoverable. An agent bound inside a subproject KNOWS its world is a
  // subtree from the first line, instead of learning it incidentally from
  // validate warnings. Detection or discovery failures are swallowed — the
  // announcement must never break server startup.
  try {
    const chainingParent = resolveChainingParent();
    if (chainingParent) {
      let externalSurfaceCount = 0;
      try {
        externalSurfaceCount = listExternalInterfaces().length;
      } catch { /* count stays 0 — the announcement itself still fires */ }
      process.stderr.write(
        `[wairon mcp] chained subproject: this root is mounted as subsystem "${chainingParent.subsystemId}" ` +
        `of the parent project at ${chainingParent.parentRoot} — ${externalSurfaceCount} vendored external ` +
        `surface(s) discoverable via sdd_list_external_interfaces\n`,
      );
    }
  } catch { /* chaining detection must never break server startup */ }

  // ── Hosted data-plane tool ADVERTISEMENT (discovery only) ─────────────────
  // Execution is intercepted upstream by the hosting request orchestrator;
  // these registrations make the tools visible in tools/list so agents can
  // find them. The handlers only fire outside a hosted request.
  if (options.hostedTools) {
    const hostedStub = (): CallToolResult =>
      errText('This hosted tool is dispatched by the hosting data plane before reaching the MCP server; it is unavailable outside a hosted request.');

    reg<Record<string, never>>(server, 'sdd_host_lock_project', {
      description: 'Hosted project lifecycle (execute-primary): LOCK the bound project (validate-as-complete gate + commit-scoped lock record). Executes directly when your resolved permission is yes and returns the completed outcome; when it is approval, a pending approval request is created instead (await it with sdd_host_await_approval).',
      inputSchema: {},
    }, hostedStub);
    reg<Record<string, never>>(server, 'sdd_host_promote_project', {
      description: 'Hosted project lifecycle (execute-primary): PROMOTE the bound, locked project after a StateId re-check. Executes directly when your resolved permission is yes; when it is approval, a pending approval request is created instead.',
      inputSchema: {},
    }, hostedStub);
    reg<{ id: string; ownerUnitId: string }>(server, 'sdd_host_initialize_project', {
      description: 'Hosted project lifecycle (execute-primary): initialize a new hosted project into its REQUIRED owner organization unit (with an optional profile selection). Executes directly when your resolved permission is yes; when it is approval, a pending approval request is created instead.',
      inputSchema: {
        id: z.string().describe('Requested project id'),
        displayName: z.string().optional(),
        description: z.string().optional(),
        ownerUnitId: z.string().describe('REQUIRED organization unit that owns the new project (every project is placed at creation)'),
        environment: z.string().optional(),
      },
    }, hostedStub);
    reg<{ requestId: string }>(server, 'sdd_host_get_approval_status', {
      description: 'Hosted project lifecycle: read the status of one of your approval requests.',
      inputSchema: { requestId: z.string() },
    }, hostedStub);
    reg<{ requestId: string; timeoutSeconds?: number }>(server, 'sdd_host_await_approval', {
      description: 'Hosted project lifecycle: long-poll one of YOUR approval requests until it is decided (approved requests auto-execute, so an approval resolves as completed) or the timeout elapses. Returns the request in its current state.',
      inputSchema: {
        requestId: z.string(),
        timeoutSeconds: z.number().optional().describe('How long to wait server-side (clamped; 0 returns the current state immediately)'),
      },
    }, hostedStub);
    reg<Record<string, never>>(server, 'sdd_landscape_list_reachable_projects', {
      description: 'Hosted landscape: the projects reachable from the BOUND project through ACTIVE cross-project relations (directional, relations-only), each with the relation ids/kinds and target public interface ids.',
      inputSchema: {},
    }, hostedStub);
    reg<{ projectId: string }>(server, 'sdd_landscape_list_reachable_project_interfaces', {
      description: 'Hosted landscape: redacted, audience-filtered public interface summaries of one reachable target project (Forbidden outside the reachable set; private by default).',
      inputSchema: { projectId: z.string().describe('The reachable target project id') },
    }, hostedStub);
    reg<Record<string, never>>(server, 'sdd_landscape_list_visible_surfaces', {
      description: 'Hosted landscape: the visibility-resolved discovery catalog for the BOUND project — every target the organization unit graph exposes to it (open-within-tenant, closed groups hidden, exposeTo grants honored), with audience distance and audience-filtered summaries. No relation required.',
      inputSchema: {},
    }, hostedStub);
    reg<{ projectId: string }>(server, 'sdd_landscape_get_project_surface', {
      description: 'Hosted landscape: fetch a visible target project\'s CONTRACT-GRADE surface snapshot (full method contracts, dispatch tables, type closure) at your audience-distance ceiling, origin "exchanged" — save it under .wai/surfaces/ (wairon surface import) so your adapters validate against the declared contract.',
      inputSchema: { projectId: z.string().describe('The visible target project id') },
    }, hostedStub);
    reg<Record<string, never>>(server, 'sdd_host_pack_list', {
      description: 'Hosted project ops: list the BOUND project\'s registered extension packs (requires project:read over it).',
      inputSchema: {},
    }, hostedStub);
    reg<{ name: string; content: string }>(server, 'sdd_host_pack_install', {
      description: 'Hosted project ops: install a DECLARATIVE extension pack (profiles + language/platform tables — never rule/code packs) into the BOUND project (requires project:admin over it).',
      inputSchema: {
        name: z.string().describe('Pack name (letters, digits, dot, underscore, hyphen)'),
        content: z.string().describe('The declarative pack YAML content'),
      },
    }, hostedStub);
    reg<Record<string, never>>(server, 'sdd_host_policy_evaluate', {
      description: 'Hosted project ops: evaluate the BOUND project\'s packs and profile selection against the instance pack policy — compliance without side effects (requires project:write over it).',
      inputSchema: {},
    }, hostedStub);
    reg<Record<string, never>>(server, 'sdd_host_policy_reconcile', {
      description: 'Hosted project ops: reconcile the BOUND project against the instance pack policy — under auto_reconcile enforcement the missing required/default declarative packs are applied (requires project:write over it).',
      inputSchema: {},
    }, hostedStub);
    reg<{ target: string }>(server, 'sdd_host_produce', {
      description: 'Hosted project ops: run a configured producer projection (Notion/Miro) of the BOUND project to the named target (requires project:admin over it).',
      inputSchema: { target: z.string().describe('The configured producer target (e.g. notion, miro)') },
    }, hostedStub);
    reg<{ subsystem?: string; message?: string }>(server, 'sdd_host_commit_project', {
      description: 'Hosted project ops: publish a DELIBERATE, .wai/-scoped commit+push of the BOUND project\'s specs to its bound repository (commit = local save, push = the actual backup; a clean scope publishes nothing). The data plane binds ONE project, so there is no project argument. Requires project:write over it.',
      inputSchema: {
        subsystem: z.string().optional().describe('Narrow staging to .wai/specs/<subsystem>/ (a convenience — git history stays per-repo)'),
        message: z.string().optional().describe('Commit message; defaults to a timestamped wairon message'),
      },
    }, hostedStub);
  }

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
