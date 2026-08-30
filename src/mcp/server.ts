import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import {
  RootsListChangedNotificationSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
  McpError,
  ErrorCode,
} from '@modelcontextprotocol/sdk/types.js';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { setProjectRoot } from '../utils/fs.js';
import { getStatusReport } from '../commands/status.js';
import { WAIRON_VERSION } from '../config/defaults.js';
import type { ValidationIssue } from '../core/validation.js';
import { resolveNarrativeLabels } from '../core/narrative-labels.js';
import { EndpointSchema, type Endpoint, type SubsystemSpec, type SystemSpec, type TypeSpec, type InterfaceSpec, type MethodSignature } from '../models/specs.js';
import {
  listResources as coreListSkillResources,
  readResource as coreReadSkillResource,
  buildServerInstructions as coreBuildServerInstructions,
  type SkillResourceDescriptor,
} from '../core/skills.js';
import { resolveChainingParent, loadComponentSpecs } from '../core/specs.js';
import * as specsModule from '../core/specs.js';
import * as loaderModule from '../config/loader.js';
import * as validationModule from '../core/validation.js';
import * as provisionModule from '../core/provision.js';
import { resolveDomains } from '../core/domains.js';
// The gated authoring seam — shared by every access path (see core/authoring.ts).
// Statically imported for the same reason as the core adapters below: it reads
// the request-scoped project root at CALL time.
import { addComponent, updateSpecGated } from '../core/authoring.js';
import type { ComponentSpec } from '../models/specs.js';
// Statically imported for the same reason as the skills adapter: these read the
// request-scoped project root at CALL time, so a static binding stays correct per
// bound project — and a lazy require of a relative path does not resolve under the
// test runner, which silently turned this hop into a tool error.
import { loadProjectVariants, resolveVariantGuidance } from '../core/variants.js';
import {
  composeAgentBrief as coreComposeAgentBrief,
  resolveAgentTopology as coreResolveAgentTopology,
} from '../core/agent_resolver.js';
import { describeBudget } from '../core/budget_policy.js';
import type { AgentBrief, AgentRecord } from '../models/agent.js';
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

// STATIC, not lazily required — for the reason spelled out on requireSpecs
// below: these modules read the request-scoped project root at CALL time, so a
// static binding stays correct per bound project, while a lazy
// `require('../config/loader.js')` fails to resolve both under the test runner
// AND inside the bundled hosted server (the bundle's directory has no such
// file). Every sdd_* tool built on them then answered "Cannot find module"
// instead of running.
function requireLoader() {
  return loaderModule;
}

function requireValidation() {
  return validationModule;
}

/**
 * The core spec surface. STATIC, not lazily required: the loaders read the
 * request-scoped project root at call time, so a static binding stays correct per
 * bound project (this module already imports core/specs.js eagerly for
 * resolveChainingParent, so nothing is loaded that was not loaded before).
 *
 * It matters because a lazy `require('../core/specs.js')` does not resolve under
 * the test runner — which made every sdd_* tool built on it fail with a module
 * error instead of running, so none of them could be driven end-to-end from a
 * test through an MCP client.
 */
function requireSpecs(): typeof specsModule {
  return specsModule;
}

function requireProvision() {
  return provisionModule;
}

/**
 * mcp_core_adapter — resolve a component's variant guidance across the boundary
 * into sdd_core. Lazily required like the other project-root-sensitive core hops:
 * the variant registry is read per bound project.
 */
function resolveComponentVariantGuidance(component: { id: string; variant?: string }) {
  if (!component.variant) return null;
  const byId = new Map(loadProjectVariants().map((v) => [v.id, v]));
  return resolveVariantGuidance(component, loadComponentSpecs(), byId);
}

// mcp_surfaces_adapter — thin forwarder across the boundary into the surface
// portal. Statically imported (like the skills adapter below, not lazily
// required): the portal function reads the request-scoped project root at
// call time, so a static binding stays correct per bound project.
function listExternalInterfaces(): ExternalSurfaceEntry[] {
  return coreListExternalInterfaces();
}

// mcp_core_adapter.composeAgentBrief — forward the live delegation-brief
// composition to the core portal. Statically imported like the other core hops:
// it resolves against the request-scoped project root at call time, so every
// call sees the CURRENT topology (a re-lock changes the next call).
function composeAgentBrief(agentId: string): AgentBrief {
  return coreComposeAgentBrief(agentId);
}

// mcp_core_adapter.resolveAgentTopology — the same forward for the topology
// read backing the wairon-agent:// resource listing.
function resolveAgentTopology(): AgentRecord[] {
  return coreResolveAgentTopology();
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

// Spec WRITES go through core/authoring.ts, never straight to the store: the
// candidate gate (and anything else that decides what may be written) lives
// there so the CLI, this stdio server, the hosted MCP dispatch, and the hosted
// web interface all share one behaviour. This module is a transport.

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

// The definitive spec-WRITE tool set: every tool that persists a change to the
// spec tree. The agent topology (and therefore the wairon-agent:// brief
// resources) is derived live from these specs, so a successful call to any of
// them is what makes the long-lived stdio session emit resources/prompts
// list-changed notifications (see emitListsChanged in createMcpServer).
const SPEC_WRITE_TOOLS = new Set([
  'sdd_initialize_system',
  'sdd_add_subsystem',
  'sdd_set_public_interfaces',
  'sdd_set_subsystem_project_path',
  'sdd_move_subsystem_project',
  'sdd_externalize_subsystem',
  'sdd_internalize_subsystem',
  'sdd_add_component',
  'sdd_define_interface',
  'sdd_set_endpoints',
  'sdd_write_narrative',
  'sdd_add_type',
  'sdd_delete_spec',
  'sdd_update_spec',
]);

// Per-server list-changed emitter, registered ONLY for the long-lived stdio
// server (the stateless hosted per-request server never emits — it advertises
// no listChanged and stays correct-on-poll). Keyed per instance because the
// hosted path creates many servers from this same factory.
const listChangedEmitters = new WeakMap<McpServer, () => void>();

function reg<Args extends Record<string, unknown>>(
  server: McpServer,
  name: string,
  config: { description: string; inputSchema?: Record<string, z.ZodTypeAny> },
  cb: (args: Args) => CallToolResult,
): void {
  const guarded = (args: Args): CallToolResult => {
    const result = withStaleWarning(cb(args));
    // A SUCCESSFUL spec write just changed the derived agent topology — tell
    // the connected session its resources/prompts lists are stale.
    if (result.isError !== true && SPEC_WRITE_TOOLS.has(name)) listChangedEmitters.get(server)?.();
    return result;
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (server as any).registerTool(name, config, guarded as any);
}

// ---------------------------------------------------------------------------
// Re-authoring semantics: REPLACE what the input expresses, CARRY what it cannot
//
// Every sdd_initialize_*/sdd_add_*/sdd_define_*/sdd_write_* tool is an UPSERT:
// calling it with an id that already exists rewrites that spec. Each tool's input
// schema is a hand-maintained SUBSET of the canonical zod schema
// (src/models/specs.ts), so any field the input cannot express — lint.allow, ext,
// a Portal's auth, variant, patterns, externalLinks, the system's databases —
// would be erased by a restatement that never mentioned it. That loss is silent:
// the tool answers "Successfully added", and a suppressed warning coming back
// days later is the only tell.
//
// So the boundary carries forward everything the input does not express, and says
// so. The complementary half matters just as much: for fields the input DOES
// express, replace stays the contract — an author who restates a spec means the
// restatement. But a restatement that empties something is REPORTED, because
// "the array I forgot to repeat is now gone" is precisely the accident this seam
// exists to catch. Reporting costs a line of output; the alternative costs a
// silent deletion.
//
// Why here and not in core/specs.ts: the store receives a whole spec object and
// cannot distinguish "the caller cleared this" from "the caller never mentioned
// it". Only the tool boundary, where an argument is observably absent, can tell
// those apart — so this is the layer that owes the guarantee.
//
// tests/mcp/schema-field-coverage.test.ts holds the invariant that no canonical
// field escapes this seam: every one is expressed, carried, or store-managed.
// ---------------------------------------------------------------------------

/** Fields the STORE decides on every write — never carried here, never reported. */
const STORE_MANAGED_FIELDS = new Set(['status', 'updatedAt']);

/**
 * Fields carried whenever the input omits them, EVEN THOUGH the input could have
 * expressed them. `ext` is opaque pack/tool data the authoring agent does not own
 * and has no way to know it must restate — the schema promises it is "preserved
 * verbatim", and replace semantics would break that promise on every re-author.
 * Everything else expressed keeps replace semantics.
 */
const ALWAYS_CARRIED_FIELDS = new Set(['ext']);

function isEmptyValue(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === 'string') return value.trim() === '';
  if (typeof value === 'object') return Object.keys(value as object).length === 0;
  return false;
}

/**
 * Copy every field the tool's input cannot express from the previous version onto
 * the spec about to be written. MUTATES `next`; returns the carried field names.
 *
 * Driven by the tool's own inputSchema keys, so a field added to a tool starts
 * being replaced, and a field added only to the canonical schema starts being
 * carried — both without anyone remembering to edit this list.
 */
function carryUnexpressed<T extends Record<string, unknown>>(
  existing: T | null | undefined,
  next: T,
  expressed: readonly string[],
): string[] {
  if (!existing) return [];
  const carried: string[] = [];
  for (const [field, value] of Object.entries(existing)) {
    if (value === undefined) continue;
    if (STORE_MANAGED_FIELDS.has(field)) continue;
    if (expressed.includes(field) && !ALWAYS_CARRIED_FIELDS.has(field)) continue;
    if (next[field] !== undefined) continue;
    (next as Record<string, unknown>)[field] = value;
    carried.push(field);
  }
  return carried;
}

/**
 * Expressed fields this restatement emptied. Never rewrites anything — replace
 * is the contract for what the input CAN say; this only makes the loss visible.
 */
function clearedByOmission<T extends Record<string, unknown>>(
  existing: T | null | undefined,
  next: T,
  expressed: readonly string[],
): string[] {
  if (!existing) return [];
  const cleared: string[] = [];
  for (const field of expressed) {
    const before = existing[field];
    if (STORE_MANAGED_FIELDS.has(field) || ALWAYS_CARRIED_FIELDS.has(field)) continue;
    if (isEmptyValue(before) || !isEmptyValue(next[field])) continue;
    cleared.push(Array.isArray(before) ? `${field} (had ${before.length})` : field);
  }
  return cleared;
}

/** Named members present before and absent now — methods dropped by a restatement. */
function removedByName(
  before: ReadonlyArray<{ name: string }> | undefined,
  after: ReadonlyArray<{ name: string }> | undefined,
): string[] {
  if (!before?.length) return [];
  const kept = new Set((after ?? []).map((m) => m.name));
  return before.map((m) => m.name).filter((n) => !kept.has(n));
}

/**
 * The re-authoring notices, in the order a reader wants them: what happened,
 * what survived, what was deleted, what was emptied.
 */
function rewriteNotices(opts: {
  /** e.g. `Component "graphics"` */
  label: string;
  carried: string[];
  cleared: string[];
  removed: string[];
  /** Noun for removed members, singular (default "method"). */
  removedNoun?: string;
  /** Appended to the removal line — e.g. " (and its narrative)". */
  removedSuffix?: string;
}): string[] {
  const notices = [`${opts.label} already existed — re-authored in place; this input REPLACES what it expresses.`];
  if (opts.carried.length) {
    notices.push(`Carried forward (not expressible through this tool): ${opts.carried.join(', ')}.`);
  }
  if (opts.removed.length) {
    const noun = opts.removedNoun ?? 'method';
    const plural = opts.removed.length === 1 ? noun : `${noun}s`;
    notices.push(
      `REMOVED by this restatement: ${plural} ${opts.removed.map((n) => `"${n}"`).join(', ')}`
      + `${opts.removedSuffix ?? ''} — absent from the input, so no longer in the spec. `
      + `Restate them to keep them, or use sdd_update_spec to edit one member at a time.`,
    );
  }
  if (opts.cleared.length) {
    notices.push(
      `CLEARED by omission: ${opts.cleared.join(', ')} — the argument was not repeated, so the previous value is gone. `
      + `Use sdd_update_spec if you meant to leave it untouched.`,
    );
  }
  return notices;
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
/**
 * mcp_skills_adapter.buildServerInstructions — the composed briefing the server
 * returns on `initialize`. Unlike the two forwarders above, this one DOES read
 * the request-scoped project root (it reports the bound project's profile and
 * packs); resolving it per createMcpServer call is what keeps the hosted
 * per-request scoped server correct.
 */
function buildServerInstructions(): string {
  return coreBuildServerInstructions();
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

// ── Live agent-brief resources (wairon-agent://) ────────────────────────────

const AGENT_BRIEF_SCHEME = 'wairon-agent://';

/**
 * One wairon-agent:// descriptor per record in the CURRENT topology, via the
 * core client adapter (statically imported like the other core hops — it reads
 * the request-scoped project root at call time, and a lazy require does not
 * resolve under the test runner). Recomputed on every list call (live, no
 * cache), so a re-lock is visible on the next list. A root with no resolvable
 * project contributes no entries: the skill surface stays listable regardless.
 */
function listAgentBriefResources(): { uri: string; name: string; description: string; mimeType: string }[] {
  try {
    return resolveAgentTopology().map((a) => ({
      uri: `${AGENT_BRIEF_SCHEME}${a.id}`,
      name: a.name,
      description: a.description,
      mimeType: SKILL_RESOURCE_MIME,
    }));
  } catch {
    return [];
  }
}

/** Render an AgentBrief as the wairon-agent:// resource's markdown content. */
function renderAgentBriefMarkdown(brief: AgentBrief): string {
  const lines = [
    `# Agent brief: ${brief.agentId}`,
    '',
    `- **Name**: ${brief.name}`,
    `- **Template**: ${brief.template}`,
    ...(brief.domainRoot ? [`- **Domain root**: ${brief.domainRoot}`] : []),
    `- **Owned paths**: ${brief.ownedPaths.join(', ')}`,
    ...(brief.readPaths?.length ? [`- **Read paths**: ${brief.readPaths.join(', ')}`] : []),
    '',
    '## Instructions',
    '',
    brief.instructions,
  ];
  // Variant guidance is normally folded into the rendered instructions by the
  // template; carry it as its own section only when the template did not.
  if (brief.variantGuidance && !brief.instructions.includes(brief.variantGuidance)) {
    lines.push('', '## Variant guidance', '', brief.variantGuidance);
  }
  // Present only when the project opted into a budget tier. Advisory: the
  // caller spawning from this brief is what actually applies it.
  if (brief.budget && brief.profile) {
    lines.push(
      '',
      '## Execution budget',
      '',
      ...describeBudget(brief.profile, brief.budget),
      '',
      'Advisory — apply these when spawning. Map the capability tier onto your host tool\'s models; a tool that cannot express a field should ignore it rather than approximate it.',
    );
  }
  return `${lines.join('\n')}\n`;
}

/**
 * Register the resources/list + resources/read endpoints on the SDK server so
 * both the stdio server and the hosted per-project scoped server (which reuse
 * this same factory) publish the built-in SDD skills PLUS one live agent-brief
 * resource per agent in the current topology. Reads route on the URI scheme:
 * wairon-agent:// composes that agent's live brief; everything else stays the
 * skill path, where an unknown URI surfaces the not-found message as an MCP
 * error. `listChanged` is declared ONLY by the long-lived stdio server, which
 * actually emits list-changed after topology-altering spec writes; the
 * stateless hosted per-request server advertises none and stays correct-on-poll.
 */
function registerSkillResources(server: McpServer, listChanged: boolean): void {
  server.server.registerCapabilities({ resources: listChanged ? { listChanged: true } : {} });

  server.server.setRequestHandler(ListResourcesRequestSchema, () => ({
    resources: [
      ...listSkillResources().map((d) => ({
        uri: d.resourceUri,
        name: d.name,
        description: d.description,
        mimeType: SKILL_RESOURCE_MIME,
      })),
      ...listAgentBriefResources(),
    ],
  }));

  server.server.setRequestHandler(ReadResourceRequestSchema, (request) => {
    const uri = request.params.uri;
    if (uri.startsWith(AGENT_BRIEF_SCHEME)) {
      try {
        const brief = composeAgentBrief(uri.slice(AGENT_BRIEF_SCHEME.length));
        return { contents: [{ uri, mimeType: SKILL_RESOURCE_MIME, text: renderAgentBriefMarkdown(brief) }] };
      } catch (e) {
        // UnknownAgentError names the known ids — surface that message as-is.
        throw new McpError(ErrorCode.InvalidParams, e instanceof Error ? e.message : String(e));
      }
    }
    try {
      const content = readSkillResource(skillIdFromResourceUri(uri));
      return { contents: [{ uri, mimeType: SKILL_RESOURCE_MIME, text: content }] };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      throw new McpError(ErrorCode.InvalidParams, message);
    }
  });
}

/**
 * Publish the same skill set as MCP PROMPTS.
 *
 * Resources are pull-only: a client must already know to fetch
 * `wairon-skill://…`. Prompts are what makes a skill *discoverable* — clients
 * surface them as slash commands or attachable context, so a human driving an
 * agent can reach `sdd-architect` or `appenser-make-implementer` directly.
 *
 * Deliberately mirrored from the SAME descriptor list the resources use, so the
 * two surfaces can never drift: one skill set, two ways in.
 */
function registerSkillPrompts(server: McpServer, listChanged: boolean): void {
  server.server.registerCapabilities({ prompts: listChanged ? { listChanged: true } : {} });

  server.server.setRequestHandler(ListPromptsRequestSchema, () => ({
    prompts: listSkillResources().map((d) => ({
      name: d.id,
      title: d.name,
      description: d.description,
    })),
  }));

  server.server.setRequestHandler(GetPromptRequestSchema, (request) => {
    const name = request.params.name;
    try {
      const content = readSkillResource(name);
      return {
        description: `The wairon "${name}" skill.`,
        messages: [{ role: 'user' as const, content: { type: 'text' as const, text: content } }],
      };
    } catch (e) {
      throw new McpError(ErrorCode.InvalidParams, e instanceof Error ? e.message : String(e));
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
  // The protocol's own "how to use this server" channel, which clients inject
  // into the agent's system prompt. Composed BEFORE construction because it is a
  // constructor option, and composed per call so the hosted per-request scoped
  // server reports ITS bound project's profile and packs, not a stale snapshot.
  const server = new McpServer({
    name: 'wairon',
    version: WAIRON_VERSION,
  }, {
    instructions: buildServerInstructions(),
  });

  // Truthful listChanged: ONLY the long-lived stdio session declares it, so
  // ONLY that session emits. Fired by reg() after a successful SPEC_WRITE_TOOLS
  // call — the derived agent topology (and its wairon-agent:// briefs) just
  // changed. A no-op before a transport is connected, and never allowed to
  // throw into a tool result.
  if (!options.hostedTools) {
    listChangedEmitters.set(server, () => {
      try {
        void server.server.sendResourceListChanged().catch(() => { /* transport gone mid-send */ });
        void server.server.sendPromptListChanged().catch(() => { /* transport gone mid-send */ });
      } catch { /* not connected yet — nothing to notify */ }
    });
  }

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
        // Static import (see requireLoader): a lazy require never resolves in
        // the bundled server, so listDomains failed there instead of answering.
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

  // Hoisted so the handler can drive carry-forward from the tool's OWN input keys
  // (see the re-authoring seam above) — one source of truth, no parallel list.
  const systemInput = {
    name: z.string().describe('Overarching name of the project/system'),
    vision: z.string().describe('Vision, mission, and core goals of the system'),
    boundaries: z.array(z.union([z.string(), z.object({ name: z.string(), description: z.string().optional() })])).optional().describe('System boundary rules or scope statements (strings or name/description objects)'),
    globalRequirements: z.array(z.union([z.string(), z.object({ description: z.string() })])).optional().describe('Global functional and non-functional requirements (strings or description objects)'),
    targetLanguage: z.string().optional().describe('Default implementation language for the system (e.g. "typescript", "rust", "python"). Subsystems may override. Enables language-aware validation.'),
  };
  const systemInputFields = Object.keys(systemInput);

  reg<{ name: string; vision: string; boundaries?: any[]; globalRequirements?: any[]; targetLanguage?: string }>(server,
    'sdd_initialize_system',
    {
      description: 'Initialize the L0 System Specification (system.yaml). Re-running it on an existing system RE-AUTHORS it: the fields above are replaced, and everything this tool cannot express (databases, the project gateway publicInterfaces, diagram defaults) is carried forward.',
      inputSchema: systemInput,
    },
    ({ name, vision, boundaries, globalRequirements, targetLanguage }) => {
      try {
        const { loadSystemSpec, saveSystemSpec } = requireSpecs();
        const now = new Date().toISOString();
        // Re-initializing used to hard-reset databases to [] and drop the gateway
        // publicInterfaces + diagram defaults, under a "Successfully initialized"
        // banner. Carry them; only a genuinely new system gets the defaults.
        const existing = loadSystemSpec();
        const next: Partial<SystemSpec> = {
          name,
          vision,
          boundaries: boundaries ?? [],
          globalRequirements: globalRequirements ?? [],
          ...(targetLanguage ? { targetLanguage } : {}),
        };
        const carried = carryUnexpressed(existing, next as Record<string, unknown>, systemInputFields);
        const cleared = clearedByOmission(existing, next as Record<string, unknown>, systemInputFields);
        next.schemaVersion ??= '1.0.0';
        next.databases ??= [];
        next.createdAt ??= now;
        next.updatedAt = now;
        saveSystemSpec(next as SystemSpec);
        const notices = existing
          ? rewriteNotices({ label: `System spec "${existing.name}"`, carried, cleared, removed: [] })
          : [];
        const noticeBlock = notices.length ? `\n\nNOTICE:\n- ${notices.join('\n- ')}` : '';
        return text(`Successfully ${existing ? 're-authored' : 'initialized'} L0 System Spec for "${name}".${noticeBlock}`);
      } catch (e) {
        return errText(String(e));
      }
    },
  );

  const subsystemInput = {
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
  };
  const subsystemInputFields = [...Object.keys(subsystemInput), 'parentSystem'];

  reg<{ id: string; name: string; description: string; publicInterfaces?: { type: 'REST' | 'GraphQL' | 'MessageBus' | 'RPC' | 'Custom'; details: string; component?: string; interface?: string }[]; projectPath?: string; targetLanguage?: string; profile?: string; designDepth?: 'components' | 'interfaces' | 'implementations' | 'narratives'; trustedLinks?: { subsystem: string; reason: string }[]; lifecycle?: { phase: 'init' | 'shutdown' | 'cyclic' | 'interrupt' | 'scheduled'; component: string; method: string; description?: string }[] }>(server,
    'sdd_add_subsystem',
    {
      description: 'Add an L1 Subsystem / Service under the system boundary. publicInterfaces should bind each entry to the component that realizes it (the subsystem\'s published surface); if components do not exist yet, add them later with sdd_set_public_interfaces. Re-running it on an existing id RE-AUTHORS it: the fields above are replaced, lint/ext are carried forward.',
      inputSchema: subsystemInput,
    },
    ({ id, name, description, publicInterfaces, projectPath, targetLanguage, profile, designDepth, trustedLinks, lifecycle }) => {
      try {
        const { loadSystemSpec, loadSubsystemSpec, saveSubsystemSpec } = requireSpecs();
        const system = loadSystemSpec();
        if (!system) return errText('System spec must be initialized (sdd_initialize_system) first.');
        const now = new Date().toISOString();
        const existing = loadSubsystemSpec(id);
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
        // parentSystem is derived from the L0 spec, not carried; everything else
        // this input cannot say (lint, ext) survives the re-authoring.
        const carried = carryUnexpressed(existing, spec as unknown as Record<string, unknown>, subsystemInputFields);
        const cleared = clearedByOmission(existing, spec as unknown as Record<string, unknown>, subsystemInputFields);
        if (existing) spec.createdAt = existing.createdAt;
        const notices = existing
          ? rewriteNotices({ label: `Subsystem "${id}"`, carried: ['createdAt', ...carried], cleared, removed: [] })
          : [];
        const noticeBlock = notices.length ? `\n\nNOTICE:\n- ${notices.join('\n- ')}` : '';
        // External (chained) subsystem: also scaffold the child project so the
        // projectPath never points at an empty directory.
        if (projectPath && projectPath.trim() !== '') {
          const { createChainedSubsystem } = requireProvision();
          createChainedSubsystem(spec, name);
          return text(`Successfully added external subsystem "${name}" (${id}) and scaffolded its child project at ${projectPath}.${noticeBlock}`);
        }
        saveSubsystemSpec(spec);
        return text(`Successfully added L1 Subsystem Spec "${name}" (${id}).${noticeBlock}`);
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

  const componentInput = {
        id: z.string().describe('Lowercase identifier for the component'),
        name: z.string().describe('Human-readable display name'),
        description: z.string().describe('Responsibility / internal architecture details'),
        subsystem: z.string().describe('The L1 subsystem ID this component belongs to'),
        componentType: z.enum(['Portal', 'Orchestrator', 'Supervisor', 'Actor', 'Store', 'Index', 'Registry', 'Adapter', 'Observer', 'Specialist', 'Repository', 'Gateway']).describe('The building block, or pattern (Repository/Gateway)'),
        owns: z.array(z.string()).optional().describe('Member block ids privately owned by this component (patterns only)'),
        dependsOn: z.array(z.string()).optional().describe('IDs of other components this collaborates with (facades or standalone blocks)'),
        portalType: z.enum(['HTTP_API', 'gRPC', 'GraphQL', 'MessageBus', 'CLI', 'NamedPipe', 'IPC', 'Custom']).optional().describe('Portal-only, and expected on every Portal. OMIT IT on any other componentType — passing it there is refused at the write (UNEXPECTED_PORTAL_FIELD), nothing is saved.'),
        basePath: z.string().optional().describe('Portal-only: base path/prefix all the portal\'s endpoints mount under. OMIT IT on any other componentType — passing it there is refused at the write (UNEXPECTED_PORTAL_FIELD), nothing is saved.'),
        dispatch: z.array(z.object({
          capability: z.string().describe('Capability name exactly as dispatched at runtime (e.g. "shadow_module.get")'),
          component: z.string().describe('Component id serving this capability (must also appear under dependsOn/owns)'),
          method: z.string().describe('Method name on the serving component\'s interface'),
          description: z.string().optional(),
        })).optional().describe('Portal-only: capability → component.method dispatch table for generic-handle portals. Gives the reachability walker real edges and is validated against target interfaces (UNSERVED_CAPABILITY).'),
        durability: z.enum(['ram-projection', 'durable', 'read-through', 'cache']).optional().describe('Store-only — OMIT IT on any other componentType, where it is refused at the write (DURABILITY_ON_NON_STORE) and nothing is saved. Every Store should declare one (MISSING_DURABILITY): durable = persisted RAM projection (hydration read-back from a lifecycle init entrypoint required — MISSING_HYDRATION); read-through = persisted with no RAM copy (every read is the read-back, hydration exempt); ram-projection = rebuilt not restored; cache = evictable loss-safe memo state.'),
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
  };
  const componentInputFields = Object.keys(componentInput);

  reg<{ id: string; name: string; description: string; subsystem: string; componentType: 'Portal' | 'Orchestrator' | 'Supervisor' | 'Actor' | 'Store' | 'Index' | 'Registry' | 'Adapter' | 'Observer' | 'Specialist' | 'Repository' | 'Gateway'; owns?: string[]; dependsOn?: string[]; portalType?: 'HTTP_API' | 'gRPC' | 'GraphQL' | 'MessageBus' | 'CLI' | 'NamedPipe' | 'IPC' | 'Custom'; basePath?: string; dispatch?: { capability: string; component: string; method: string; description?: string }[]; durability?: 'ram-projection' | 'durable' | 'read-through' | 'cache'; emits?: { topic: string; event?: string; description?: string }[]; subscribesTo?: { topic: string; event?: string; description?: string }[]; ext?: Record<string, unknown> }>(server,
    'sdd_add_component',
    {
      description: 'Add an L2 Component under a subsystem. componentType is a building block (Portal, Orchestrator, Supervisor, Actor, Store, Index, Registry, Adapter, Observer, Specialist) or a pattern (Repository, Gateway). Patterns set "owns" (their private member blocks); all components set "dependsOn" (collaborators — facades or standalone blocks). Held/persisted state (configs, permissions, sessions, caches): model the Repository recipe — a Store + Registry (write) + Index (read) owned by a Repository facade consumers depend on; a deliberately standalone Store is the sanctioned lightweight form (workflow-layer consumers + lint.allow on UNOWNED_STORE). Never hold state as fields inside an Orchestrator/Specialist because a Store link was refused. Re-running it on an existing id RE-AUTHORS it: the fields above are replaced (an omitted array is CLEARED), while lint.allow, a Portal\'s auth, variant, patterns and externalLinks are carried forward — edit those with sdd_update_spec.',
      inputSchema: componentInput,
    },
    ({ id, name, description, subsystem, componentType, owns, dependsOn, portalType, basePath, dispatch, durability, emits, subscribesTo, ext }) => {
      try {
        const { loadSubsystemSpec, loadComponentSpec } = requireSpecs();
        const sub = loadSubsystemSpec(subsystem);
        if (!sub) return errText(`Parent subsystem "${subsystem}" does not exist.`);
        const now = new Date().toISOString();
        const candidate: ComponentSpec = {
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
        };

        // Re-adding an existing component used to erase everything this input
        // cannot express — lint.allow above all, whose only symptom is the
        // suppressed warning silently coming back. Carry it, and say so.
        const existing = loadComponentSpec(id);
        const carried = carryUnexpressed(existing, candidate as unknown as Record<string, unknown>, componentInputFields);
        const cleared = clearedByOmission(existing, candidate as unknown as Record<string, unknown>, componentInputFields);
        if (existing) candidate.createdAt = existing.createdAt;

        // addComponent gates the candidate before persisting it: a field that
        // contradicts componentType is refused while it is still only an
        // argument, so nothing reaches disk and the fix is to retry the call.
        // Carrying happens FIRST so the gate judges the spec that will actually
        // be written — retyping a Portal to an Orchestrator carries its `auth`
        // and surfaces AUTH_ON_NON_PORTAL, instead of the field vanishing unseen.
        const notices = addComponent(candidate);
        if (existing) {
          notices.push(...rewriteNotices({
            label: `Component "${id}"`,
            carried: ['createdAt', ...carried],
            cleared,
            removed: [],
          }));
        }
        const noticeBlock = notices.length ? `\n\nNOTICE:\n- ${notices.join('\n- ')}` : '';
        return text(`Successfully ${existing ? 're-authored' : 'added'} L2 Component Spec "${name}" (${id}, ${componentType}).${noticeBlock}`);
      } catch (e) {
        return errText(String(e));
      }
    },
  );

  const interfaceMethodShape = {
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
          invokedBy: z.object({
            kind: z.enum(['runtime', 'external', 'sibling-subsystem']).describe('Who owns the out-of-graph invocation: runtime (timer/signal/shutdown hook), external (a system outside this project), sibling-subsystem (a modeled sibling whose edge is not narrated here)'),
            caller: z.string().optional().describe('WHO invokes it and when, as reviewable prose — missing or placeholder-thin prose is INVOKED_BY_UNDESCRIBED'),
          }).optional().describe('Typed acknowledgment of a real caller OUTSIDE the modeled narrative graph. Unused-detection seeds the method as an entrypoint so reachability propagates through its narrative (unlike lint.allow); a method the internal walk already reaches is flagged stale (INVOKED_BY_REDUNDANT). Prefer a `register` narrative step when the wiring is internal.'),
          ext: z.record(z.unknown()).optional().describe('Opaque pack/tool extension data for this method (namespaced keys) — preserved verbatim'),
  };
  const interfaceMethodInputFields = Object.keys(interfaceMethodShape);
  const interfaceInput = {
    id: z.string().describe('Lowercase identifier prefixed with "i", e.g. "istorage"'),
    name: z.string().describe('Human-readable contract name'),
    description: z.string().describe('Contract description and obligations'),
    component: z.string().describe('The L2 component ID this interface belongs to'),
    methods: z.array(z.object(interfaceMethodShape)).optional().describe('List of method signature contracts'),
  };
  const interfaceInputFields = Object.keys(interfaceInput);

  reg<{ id: string; name: string; description: string; component: string; methods?: { name: string; description: string; signature: string; returns: string; params?: { name: string; type: string; description?: string; optional?: boolean }[]; guarantees?: string[]; effect?: 'read' | 'write'; invokedBy?: { kind: 'runtime' | 'external' | 'sibling-subsystem'; caller?: string }; ext?: Record<string, unknown> }[] }>(server,
    'sdd_define_interface',
    {
      description: 'Define an L3 Contract / Interface with method signatures for a component. Prefer supplying structured `params` per method — they are the authoritative source for type checking (the free-form signature string then becomes display-only and is never heuristically parsed). Re-defining an existing id REPLACES the method list: a method left out of the input is REMOVED (and reported); spec-level lint/ext and each method\'s endpoint binding are carried forward.',
      inputSchema: interfaceInput,
    },
    ({ id, name, description, component, methods }) => {
      try {
        const { loadComponentSpec, loadInterfaceSpec, saveInterfaceSpec } = requireSpecs();
        const comp = loadComponentSpec(component);
        if (!comp) return errText(`Component "${component}" does not exist.`);
        const now = new Date().toISOString();
        // Redefining an EXISTING interface replaces what the input expresses —
        // but the input cannot express spec-level lint/ext or per-method endpoint
        // bindings (sdd_set_endpoints), and may omit per-method ext. Carry those
        // forward instead of silently dropping them, at BOTH levels: the same
        // rule applied per method, keyed off the method input's own field list.
        const existing = loadInterfaceSpec(id);
        const carried: string[] = [];
        const specMethods = (methods ?? []).map((m) => {
          const prev = existing?.methods.find((p) => p.name === m.name);
          const next = { ...m } as unknown as Record<string, unknown>;
          for (const field of carryUnexpressed(prev as unknown as Record<string, unknown>, next, interfaceMethodInputFields)) {
            carried.push(`${field} (${m.name})`);
          }
          return next as unknown as MethodSignature;
        });
        const spec: InterfaceSpec = {
          id,
          name,
          description,
          component,
          methods: specMethods,
          status: 'draft',
          createdAt: now,
          updatedAt: now,
        };
        carried.push(...carryUnexpressed(existing, spec as unknown as Record<string, unknown>, interfaceInputFields));
        const cleared = clearedByOmission(existing, spec as unknown as Record<string, unknown>, interfaceInputFields);
        if (existing) spec.createdAt = existing.createdAt;
        const notices = saveInterfaceSpec(spec);
        if (existing) {
          notices.push(...rewriteNotices({
            label: `Interface "${id}"`,
            carried: ['createdAt', ...carried],
            cleared,
            removed: removedByName(existing.methods, specMethods),
            removedSuffix: ' (endpoint bindings included)',
          }));
        }
        const noticeBlock = notices.length ? `\n\nNOTICE:\n- ${notices.join('\n- ')}` : '';
        return text(`Successfully ${existing ? 're-authored' : 'defined'} L3 Interface Contract "${name}" (${id}).${noticeBlock}`);
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
    type: z.enum(['local', 'call', 'dispatch', 'register', 'branch', 'switch', 'loop', 'try', 'parallel', 'jump', 'return', 'throw']),
    targetComponent: z.string().optional().describe('call/register/dispatch: L2 component id (for dispatch, the Portal routed through)'),
    targetMethod: z.string().optional().describe('call/register: method name on the target. A register step hands the target method to the runtime as a callback (timer, event listener, shutdown hook): reachability follows the edge, but it is never an invocation — exempt from call-graph conformance, call-cycle detection, and the durability boot walk'),
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
  const implMethodShape = {
    name: z.string(),
    detail: detailEnum.optional().describe('Detail level for this method (overrides the spec default)'),
    intent: z.string().optional().describe('detail: intent — behavioral prose (what it does and how it fails); substitute for a narrative'),
    conformance: conformanceEnum.optional().describe('Conformance tier for this method (overrides the spec default)'),
    symbol: z.string().optional().describe('Code-level name realizing this contract method in the sourcePath file, when it legitimately differs from the intent-language contract name (e.g. put realized by saveSnapshot)'),
    ext: z.record(z.unknown()).optional().describe('Opaque pack/tool extension data for this method (namespaced keys) — preserved verbatim'),
    narrative: z.array(narrativeStepInput).optional(),
  };
  const implMethodInputFields = Object.keys(implMethodShape);
  const implInput = {
    id: z.string().describe('Lowercase identifier, e.g. "vfs_storage"'),
    name: z.string().describe('Human-readable implementation name'),
    description: z.string().describe('Implementation details'),
    contract: z.string().describe('The L3 Interface contract ID this implements'),
    sourcePath: z.string().optional().describe('Optional: target source code file path relative to project root'),
    simPath: z.string().optional().describe('Optional: the committed integration-sim harness file (project-relative; N:1 sharing allowed). The validator proves it exists and its import graph wires the REAL modules (this component + each direct dependency; technology adapters may stay faked) — running it is CI\'s job. Declaring the first simPath in a subsystem activates MISSING_INTEGRATION_SIM for its other complete non-leaf implementations'),
    technologies: z.array(z.string()).optional().describe('External technologies this implementation binds to (e.g. ["mysql"]) — declares this component\'s ownership tree as the technology\'s home; references outside it are flagged (TECH_LEAKAGE) and contract identifiers must stay intent-language. Only for Adapter/Store/Registry/Index components.'),
    detail: detailEnum.optional().describe('Spec-level narrative detail default for all methods'),
    conformance: conformanceEnum.optional().describe('Spec-level structural-conformance tier default: declared | anchored | off (omitted = stereotype default: Portal → anchored, else declared)'),
    methods: z.array(z.object(implMethodShape)).optional().describe('Method implementations containing L5 narratives'),
  };
  const implInputFields = Object.keys(implInput);

  reg<{ id: string; name: string; description: string; contract: string; sourcePath?: string; simPath?: string; technologies?: string[]; detail?: 'full' | 'calls-only' | 'intent'; conformance?: 'declared' | 'anchored' | 'off'; methods?: { name: string; detail?: 'full' | 'calls-only' | 'intent'; intent?: string; conformance?: 'declared' | 'anchored' | 'off'; symbol?: string; ext?: Record<string, unknown>; narrative?: NarrativeStepIn[] }[] }>(server,
    'sdd_write_narrative',
    {
      description: 'Write L4 Concrete Implementation spec containing L5 method narratives. Narratives are a FLAT ordered step list; flow steps (branch/switch/loop/try/parallel/jump/return/throw) jump by step number — blocks are just skipped regions. Steps may declare a `label` anchor, and every jump field has a *Label twin (toLabel, onTrueLabel, endLabel, …) resolved to step numbers at write time — prefer labels over hand-counted numbers; an unresolvable label rejects the write. Detail dial per method: full (narrative required) | calls-only (call choreography suffices) | intent (prose instead of steps); omitted = stereotype default (Portal/Observer/Adapter: calls-only, Store/Index/Registry: intent, else full). Conformance dial per method or spec: declared | anchored | off — how strictly structural conformance requires contract methods to be realized in the sourcePath file (omitted = Portal: anchored, else declared). Re-authoring an existing id REPLACES the method list: a method left out of the input is REMOVED together with its narrative (and reported); spec-level lint/ext are carried forward.',
      inputSchema: implInput,
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
        const resolvedMethods = (methods ?? []).map(m => {
          const prev = existing?.methods.find(p => p.name === m.name);
          const next = {
            ...m,
            narrative: (m.narrative ?? []).map((s, i) => ({ ...s, stepNumber: s.stepNumber ?? i + 1 })),
          } as unknown as Record<string, unknown>;
          for (const field of carryUnexpressed(prev as unknown as Record<string, unknown>, next, implMethodInputFields)) {
            carried.push(`${field} (${m.name})`);
          }
          return next as unknown as { name: string; narrative: NarrativeStepIn[] };
        });
        // Symbolic *Label references resolve to step numbers before the spec
        // is saved; an unresolvable reference rejects the whole write.
        const labelErrors = resolvedMethods.flatMap(m => resolveNarrativeLabels(m.name, m.narrative));
        if (labelErrors.length) return errText(`Unresolved narrative label references — nothing was saved:\n- ${labelErrors.join('\n- ')}`);
        const now = new Date().toISOString();
        const spec = {
          id,
          name,
          description,
          contract,
          sourcePath,
          simPath,
          technologies,
          detail,
          conformance,
          // Post-resolution every cases/catches entry has its numeric step —
          // the *Label twins exist only in the input type, not the spec's.
          methods: resolvedMethods as Parameters<typeof saveImplementationSpec>[0]['methods'],
          status: 'draft' as const,
          createdAt: now,
          updatedAt: now,
        };
        carried.push(...carryUnexpressed(existing, spec as unknown as Record<string, unknown>, implInputFields));
        const cleared = clearedByOmission(existing, spec as unknown as Record<string, unknown>, implInputFields);
        if (existing) spec.createdAt = existing.createdAt;
        const notices = saveImplementationSpec(spec);
        if (existing) {
          notices.push(...rewriteNotices({
            label: `Implementation "${id}"`,
            carried: ['createdAt', ...carried],
            cleared,
            removed: removedByName(existing.methods, resolvedMethods as unknown as { name: string }[]),
            removedSuffix: ' (L5 narratives included)',
          }));
        }
        const noticeBlock = notices.length ? `\n\nNOTICE:\n- ${notices.join('\n- ')}` : '';
        return text(`Successfully saved L4 Implementation Spec "${name}" (${id}) with method narratives.${noticeBlock}`);
      } catch (e) {
        return errText(String(e));
      }
    },
  );

  const typeInput = {
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
  };
  const typeInputFields = Object.keys(typeInput);

  reg<{ kind: 'entity' | 'value-object'; id: string; name: string; description?: string; subsystem?: string; group?: string; fields?: { name: string; type: string; description?: string; optional?: boolean; key?: 'primary' | 'unique' | 'foreign'; references?: string }[]; methods?: { name: string; signature: string; returns: string; description?: string }[]; componentClass?: string; invariants?: { id: string; description: string }[]; database?: string; table?: string; linkedEntity?: string }>(server,
    'sdd_add_type',
    {
      description: 'Define an entity or value-object type (the data components operate on). Entities are owned by a subsystem; shared value objects omit subsystem (system-level). Fields are data; methods are PURE intrinsic behaviour only — anything needing a collaborator belongs on a component, taking the entity as an argument. Re-defining an existing id REPLACES fields/methods/invariants (an omitted list is CLEARED, and a dropped member is reported); lint/ext are carried forward.',
      inputSchema: typeInput,
    },
    ({ kind, id, name, description, subsystem, group, fields, methods, componentClass, invariants, database, table, linkedEntity }) => {
      try {
        const { loadTypeSpec, saveTypeSpec } = requireSpecs();
        const now = new Date().toISOString();
        const existing = loadTypeSpec(id);
        const spec: TypeSpec = {
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
        };
        const carried = carryUnexpressed(existing, spec as unknown as Record<string, unknown>, typeInputFields);
        const cleared = clearedByOmission(existing, spec as unknown as Record<string, unknown>, typeInputFields);
        if (existing) spec.createdAt = existing.createdAt;
        const notices = saveTypeSpec(spec);
        if (existing) {
          notices.push(...rewriteNotices({
            label: `Type "${id}"`,
            carried: ['createdAt', ...carried],
            cleared,
            removed: [
              ...removedByName(existing.fields, spec.fields).map((n) => `field ${n}`),
              ...removedByName(existing.methods, spec.methods).map((n) => `method ${n}`),
            ],
            removedNoun: 'member',
          }));
        }
        const noticeBlock = notices.length ? `\n\nNOTICE:\n- ${notices.join('\n- ')}` : '';
        return text(`Successfully ${existing ? 're-authored' : 'defined'} ${kind} type "${name}" (${id}).${noticeBlock}`);
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
      description: 'Get/read the parsed JSON contents of a specific spec from the spec tree. Returns structural contents without file system path searching. For a variant-tagged COMPONENT the result also carries a derived, read-only "variantGuidance" (the variant\'s base, its implementation guidance, and the same-variant sibling components to implement alike) — it is resolved from the variant registry, not part of the spec, so never write it back.',
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
        // A variant carries implementation guidance that attaches to the component
        // an implementer is holding — the right hook for platform guidance, with no
        // doctrine duplication. It reached only GENERATED agent files, so a hosted
        // agent never saw it; attach it here as a clearly-derived read-only field.
        if (kind === 'component') {
          const guidance = resolveComponentVariantGuidance(result as { id: string; variant?: string });
          if (guidance) return json({ ...(result as object), variantGuidance: guidance });
        }
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
        delta: z.record(z.any()).describe('The partial fields to merge into the spec. ARRAYS UPSERT, they do not replace: an array whose elements carry an identity is merged element-by-element, so a delta naming ONE element leaves the others intact. Identity is "name" or "id" by default, and per field: dispatch by "capability", lifecycle by phase+component+method, emits/subscribesTo by topic+event, trustedLinks by "subsystem", invariants and patterns by "id", lint.allow by "code", boundaries by "name", globalRequirements by "description". Add "action: \'delete\'" (or "remove: true") alongside that identity to REMOVE an element — including a stale lint allow. Arrays of plain STRINGS (owns, dependsOn, guarantees) carry no per-element identity and are replaced wholesale; pass [] to clear any array outright. To REMOVE an optional field entirely, list it in "unset": e.g. {"unset": ["basePath", "variant"]} — passing null/undefined means "no change" (they are skipped), and writing "" would leave the field present but empty, which is a different and usually wrong spec. Unsetting a required field is refused by schema validation, which names it. For narrative steps, match by "stepNumber" and use "action: \'insert\'" (shifts subsequent steps up) or "action: \'delete\'" (shifts subsequent steps down and removes it). Renumbering RELOCATES every flow jump field (onTrueStep/onFalseStep/cases.step/defaultStep/endStep/catches.step/finallyStep/toStep) in the same narrative; deleting a step that is a jump target is rejected until the referrers are retargeted. Inserting AT a jump target relocates those jumps past the inserted step by default (a NOTICE is returned) — add "captureJumps": true on the inserted step to retarget entry jumps onto it (loop/try endStep region tails always relocate with the body and are never captured). Reference ids in deltas may use LOCAL names — they are qualified against the spec\'s namespace exactly as the loader would. Per-spec lint suppression: set "lint: { allow: [{ code, reason }] }" to silence a WARNING code on this spec only (errors always surface; stale allows are flagged).'),
      },
    },
    ({ kind, id, delta }) => {
      try {
        const notices = updateSpecGated(kind, id, delta);
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
        // STATIC import, not a lazy require: the server is bundled (tsup), and a
        // runtime `require('../commands/status.js')` resolves against the bundle's
        // directory — where that file does not exist. It worked from the CLI
        // (whose bundle happened to contain it) and failed on the HOSTED data
        // plane, where sdd_get_status answered "Cannot find module" instead of
        // the dashboard.
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

  reg<{ agentId: string }>(server,
    'sdd_get_agent_brief',
    {
      description: 'Compose the LIVE delegation brief for one resolved agent: the fully rendered instruction body plus the ownedPaths/readPaths scope fence — the dynamic replacement for generated per-component agent files. Fetch a brief and spawn a generic subagent with it: always fresh after a re-lock, no session restart needed. List agent ids via listAgents or resources/list (the wairon-agent:// entries).',
      inputSchema: {
        agentId: z.string().describe('The resolved agent id (list via listAgents or resources/list)'),
      },
    },
    ({ agentId }) => {
      try {
        return json(composeAgentBrief(agentId));
      } catch (e) {
        return errText(String(e));
      }
    },
  );

  // ── Built-in SDD skills + live agent briefs as read-only MCP resources ────
  registerSkillResources(server, !options.hostedTools);

  // ── The same skills as MCP prompts (discoverable, not merely fetchable) ────
  registerSkillPrompts(server, !options.hostedTools);

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
    reg<Record<string, never>>(server, 'sdd_host_export_tree', {
      description: 'Hosted spec-tree transfer: pack the BOUND project\'s WHOLE spec tree — its own .wai plus every chained subproject — into a .waitree archive, returned as base64 with its roots, file count and state id. The migration counterpart of an import: use it to take a hosted project local, or to move it to another instance. Requires project:read over the project. Bounded by the data-plane body cap; a very large tree exports through the web download route instead.',
      inputSchema: {},
    }, hostedStub);
    reg<{ archiveBase64: string; replaceExisting?: boolean }>(server, 'sdd_host_import_tree', {
      description: 'Hosted spec-tree transfer: REPLACE the BOUND project\'s spec tree from a base64 .waitree archive. Requires project:admin over the project (strictly above project:write — this replaces the whole design, not one spec). Refuses an occupied destination unless replaceExisting is set, always refuses executable entries (rule/code packs install only through the trusted filesystem), and moves the previous tree aside to a backup whose path is returned.',
      inputSchema: {
        archiveBase64: z.string().describe('The .waitree archive bytes, base64-encoded'),
        replaceExisting: z.boolean().optional().describe('Replace a tree already present (backed up first); without it an occupied destination is refused'),
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
