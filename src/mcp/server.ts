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
import { readYamlFile } from '../utils/yaml.js';
import { ProjectNotInitializedError } from '../utils/errors.js';
// mcp_core_adapter's completeness report (icore_portal getStatusReport) and the
// lock's verdict on the tree (icore_portal approvalVerdict), taken from the core
// barrel like every other core call this file makes. The report used to come out
// of src/commands/status.ts — sdd_mcp reaching into an sdd_cli command file for a
// report that was never CLI-specific — and the verdict used to live there as a
// PRIVATE helper, which is why this server could only ever answer with silence
// about a tree that had drifted from its approval. Both are taken BY IDENTITY,
// unrenamed: each is a method this file's mcp_core_adapter contract names, and a
// renamed binding would leave the narrative's call site pointing at a symbol the
// contract does not carry.
import { getStatusReport, approvalVerdict } from '../core/index.js';
import type { ProjectConfig } from '../models/project.js';
// mcp_core_adapter's project configuration read (icore_portal loadProjectConfig,
// null when the project has none) and the renames (icore_portal
// renameComponent / renameMethod). STATIC, not lazily required: same reasoning
// as requireValidation below — a static binding stays correct per bound project, and
// a lazy require of a relative path does not resolve under the test runner or
// inside the bundled hosted server.
import {
  loadProjectConfig as coreLoadProjectConfig,
  renameComponent as coreRenameComponent,
  renameMethod as coreRenameMethod,
  type ComponentRename,
  type MethodRename,
} from '../core/index.js';
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
import * as pathsModule from '../config/paths.js';
import * as validationModule from '../core/validation.js';
import * as provisionModule from '../core/provision.js';
// Through the core Portal, like every other sdd_core call this server makes —
// ../core/domains.js is a member of the topology Repository, and naming it here
// reached two subsystems deep for a read the Portal already publishes.
import { resolveDomains } from '../core/index.js';
// The gated authoring seam — shared by every access path (see core/authoring.ts).
// Statically imported for the same reason as the core adapters below: it reads
// the request-scoped project root at CALL time.
import { addComponent, updateSpecGated, moveMethods } from '../core/authoring.js';
import type { SpecChange, SpecChangeReport } from '../core/specs.js';
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
// Through the Portal, not the module: the registry shape this server hands to
// the registry validator is sdd_core's to publish, and icore_portal names it.
import { loadRegistry as coreLoadRegistry } from '../core/index.js';
import { summarize } from '../models/execution.js';
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

/**
 * The family context sdd_get_status opens with (mcp_orchestrator getStatus step
 * 5): where the bound root sits among chained projects, told in-band, because a
 * connected agent never sees the startup log. The parent appears only within the
 * request's reach (resolveChainingParent); the mounts listed are this root's
 * own. A detection failure leaves the header out rather than break the report.
 */
export function statusFamilyContext(): string {
  const lines: string[] = [];
  try {
    const parent = resolveChainingParent();
    if (parent) {
      let parentName: string | undefined;
      try {
        const system = readYamlFile(pathsModule.aiPathsAt(parent.parentRoot).specsSystem()) as { name?: unknown } | null;
        if (typeof system?.name === 'string') parentName = system.name;
      } catch { /* the parent's name stays unknown */ }
      lines.push(
        `Family: this project is a chained subproject, mounted as subsystem "${parent.subsystemId}" of ` +
          `${parentName ? `the parent project "${parentName}"` : 'its parent project'} — ` +
          'the surfaces it can consume are listed by sdd_list_external_interfaces.',
      );
    }
    const mounts = specsModule.loadSubsystemSpecs().filter((s) => s.projectPath && !s.id.includes('::'));
    if (mounts.length > 0) {
      lines.push(`Family: chained subprojects mounted here — ${mounts.map((s) => `${s.id} (${s.projectPath})`).join(', ')}.`);
    }
  } catch { /* the family context must never break the status report */ }
  return lines.length > 0 ? `${lines.join('\n')}\n\n` : '';
}

// STATIC, not lazily required — for the reason spelled out on requireSpecs
// below: these modules read the request-scoped project root at CALL time, so a
// static binding stays correct per bound project, while a lazy
// `require('../config/loader.js')` fails to resolve both under the test runner
// AND inside the bundled hosted server (the bundle's directory has no such
// file). Every sdd_* tool built on them then answered "Cannot find module"
// instead of running.
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

// mcp_core_adapter.loadProjectConfig — the same forward for the project
// configuration read (null when the project has none). validateTopology,
// getProjectConfig, and sdd_validate_tree all call this rather than the
// statically-imported binding directly, so the contract method has its own
// realized function at the anchored conformance tier.
function loadProjectConfig(): ProjectConfig | null {
  return coreLoadProjectConfig();
}

// mcp_core_adapter.renameComponent — the same forward for a component rename:
// core moves the component with the interface and implementation named after
// it, rewrites every reference to it in the bound tree, and reports both.
function renameComponent(componentId: string, newId: string): ComponentRename {
  return coreRenameComponent(componentId, newId);
}

// mcp_core_adapter.renameMethod — the same forward for a contract-method
// rename: core moves the method on the component's contracts and their
// implementations, retargets every reference to it, and reports what it moved,
// what it retargeted and what still merely names it.
function renameMethod(componentId: string, methodName: string, newName: string, pinSymbol?: boolean): MethodRename {
  return coreRenameMethod(componentId, methodName, newName, pinSymbol);
}

/**
 * mcp_orchestrator.renameComponent and .renameMethod step 1 — the component id
 * a tool's id names in the bound tree: the id itself when a component holds it,
 * a root-anchored `::id` as its bare id, and a bare id naming exactly one chained component as
 * that component's qualified id, so core refuses it as a chained component
 * rather than a missing one. Any other id is passed on as given, for core to
 * refuse.
 */
function qualifiedComponentId(id: string): string {
  const ids = loadComponentSpecs().map((c) => c.id);
  if (ids.includes(id)) return id;
  const bare = id.startsWith('::') ? id.slice(2) : id;
  if (ids.includes(bare)) return bare;
  const chained = ids.filter((known) => known.endsWith(`::${bare}`));
  return chained.length === 1 ? chained[0] : id;
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

/**
 * What an author may write where a type goes, said once and attached to every
 * such field. A type string is TOKENIZED rather than parsed as a type
 * expression, so a union needs no special syntax — and an author who does not
 * know that writes `Invoice` where `Invoice | null` is the truth. The full
 * grammar, and the tests pinning it, live on src/models/type-references.ts.
 */
const TYPE_REF_GRAMMAR = (what: string): string =>
  `${what}: a primitive/builtin or a defined type id (qualified across subsystems, e.g. `
  + '"billing.Invoice" or "billing::Invoice"). Generics, arrays and UNIONS are all read, at any depth: '
  + '"Invoice | null" (the commonest shape there is), "Invoice | undefined", "Invoice | Receipt", '
  + '"Promise<Invoice | null>", "Map<string, Invoice | null>", "Invoice[] | null", "(Invoice | null)[]". '
  + 'Every identifier the string names must resolve — a union of two defined types means BOTH must exist. '
  + 'A union of string literals ("read" | "write") names no type and resolves to nothing.';

// ---------------------------------------------------------------------------
// Structured results
//
// Every tool answered in one text block, so an agent that wanted to know what a
// write DID had to parse English — and several waves went into making those
// sentences trustworthy precisely because prose was the only channel. A tool
// that declares an `outputSchema` answers with `structuredContent` as well,
// under a shape a client can read off tools/list before it ever calls.
//
// The text block never changes. A client that understands no structured content
// must see exactly what it saw before, so the helpers here ADD a field beside
// the content array and never touch it; tests/mcp/structured-results.test.ts
// pins that byte for byte.
//
// Per the MCP specification a tool declaring an outputSchema MUST return
// structuredContent validating against it — on every non-error result. A
// refusal (`isError`) is exempt, both in the SDK's server-side check and in the
// client's, which is what lets errText stay a text-only result: a refusal
// carries no report to structure, and inventing an empty one would be the very
// "nothing happened, reported as something" this surface exists to end.
// ---------------------------------------------------------------------------

/** A result carrying both channels: the sentence, and the same outcome as data. */
function structured(content: string, data: object): CallToolResult {
  return { content: [{ type: 'text', text: content }], structuredContent: data as Record<string, unknown> };
}

/** The same for a tool whose text block already IS the JSON of its answer. */
function jsonStructured(value: object): CallToolResult {
  return structured(JSON.stringify(value, null, 2), value);
}

/**
 * The stale-build warning as a FIELD, so the guard survives an agent moving to
 * structured reading. The banner below is appended to the text block; a reader
 * that only looks at structuredContent would never see it, and this is the
 * warning that twice stopped a stale process from silently stripping fields.
 * Declared by every outputSchema this module registers.
 */
const staleServerOutput = {
  staleServer: z.boolean().optional().describe(
    'True when the wairon build on disk changed after this server started — the structured twin of '
    + 'the text answer\'s STALE SERVER banner. Writes through a stale process can silently drop fields '
    + 'a newer schema introduced: restart the MCP session before editing further.',
  ),
};

/**
 * A write's answer, as the caller needs to read it: what changed, addressed
 * path by path — or that nothing did and nothing was written.
 *
 * "Successfully updated" was the same sentence whether a delta rewrote a
 * narrative or landed nowhere at all, so an edit that never happened read
 * exactly like one that did.
 */
function renderChangeReport(report: SpecChangeReport): string {
  const lines = [report.dryRun ? `DRY RUN — nothing was written. ${report.summary}` : report.summary];
  for (const change of report.changes) {
    const to = change.after === undefined ? '' : `: ${JSON.stringify(change.after)}`;
    const from = change.before === undefined ? '' : ` (was ${JSON.stringify(change.before)})`;
    lines.push(`- ${change.path} ${report.dryRun ? `would be ${change.change}` : change.change}${to}${from}`);
  }
  // The half a permissive delta cannot refuse at the boundary: say what landed
  // nowhere, by path, rather than let a typo read as a completed edit.
  if (report.ineffective.length) {
    lines.push('', 'NO EFFECT:', ...report.ineffective.map(i => `- ${i}`));
  }
  if (report.notices.length) lines.push('', 'NOTICE:', ...report.notices.map(n => `- ${n}`));
  // The tests this write just invalidated. A structured field nobody renders
  // is a field nobody reads, and the whole point is that the change which
  // creates the collision is the one that says so.
  if (report.testsToRevisit.length) {
    lines.push('', 'TESTS TO REVISIT:');
    for (const entry of report.testsToRevisit) {
      lines.push(`- ${entry.method} (searched as "${entry.symbol}")`);
      if (entry.imported.length) lines.push(`  imports it: ${entry.imported.join(', ')}`);
      if (entry.mentioned.length) lines.push(`  names it: ${entry.mentioned.join(', ')}`);
      if (entry.indiscriminate) {
        lines.push('  names it: withheld — the bare name matches more than a tenth of the suite, so the list carries no signal.');
      }
    }
  }
  return lines.join('\n');
}

/** The kinds a spec write addresses, as the receipt and the change report name them. */
const SPEC_KINDS = ['system', 'subsystem', 'component', 'interface', 'implementation', 'type'] as const;

/** The lifecycle statuses, weakest first (the policy that reads them: "Status at create", below). */
const STATUS_ORDER = ['draft', 'design', 'complete'] as const;
type StatedStatus = typeof STATUS_ORDER[number];

/**
 * sdd_mcp::SpecWriteReceipt — what a create tool answers with as data.
 *
 * A create is an UPSERT, so "added" and "re-authored in place" are two outcomes
 * of the same call. The sentence has always said which; this says it in a field,
 * because a caller that has to read English to find out is a caller that
 * eventually stops checking.
 */
type SpecWriteReceipt = {
  kind: typeof SPEC_KINDS[number];
  id: string;
  name: string;
  replacedExisting: boolean;
  status?: StatedStatus;
  notices: string[];
  scaffoldedProjectPath?: string;
};

const specWriteReceiptOutput = {
  kind: z.enum(SPEC_KINDS).describe('The spec kind written.'),
  id: z.string().describe('The id the spec is stored under; "system" for the L0 singleton.'),
  name: z.string().describe('The spec\'s display name as written.'),
  replacedExisting: z.boolean().describe(
    'True when a spec already held this id and the call re-authored it in place rather than adding one. '
    + 'The notices then say what was carried forward, removed or cleared by the restatement.',
  ),
  status: z.enum(STATUS_ORDER).optional().describe(
    'The lifecycle status written. Absent for a type, which carries none.',
  ),
  notices: z.array(z.string()).describe(
    'The notice lines the text answer lists, one per entry: what was carried forward, what a restatement '
    + 'removed, what an omission cleared, and every gate warning the write raised. Empty for a clean create.',
  ),
  scaffoldedProjectPath: z.string().optional().describe(
    'The child project directory a chained subsystem\'s create scaffolded; absent for every other write.',
  ),
  ...staleServerOutput,
} satisfies Record<keyof SpecWriteReceipt | keyof typeof staleServerOutput, z.ZodTypeAny>;

/**
 * A create's answer: the sentence it has always given, with the NOTICE block
 * composed from the receipt's own notices, and the receipt itself beside it.
 * One list feeds both channels, so the prose can never report a notice the data
 * omits.
 */
function writeReceipt(sentence: string, receipt: SpecWriteReceipt): CallToolResult {
  const noticeBlock = receipt.notices.length ? `\n\nNOTICE:\n- ${receipt.notices.join('\n- ')}` : '';
  return structured(`${sentence}${noticeBlock}`, receipt);
}

/** ONE change a write made, field for field as core reports it. */
const specChangeOutput = {
  path: z.string().describe('The dotted path the change addresses, with names and indexes.'),
  change: z.enum(['set', 'added', 'removed', 'cleared']).describe('What happened at that path.'),
  before: z.string().optional().describe('The previous value, summarized; absent when there was none.'),
  after: z.string().optional().describe('The new value, summarized; absent when there is none.'),
} satisfies Record<keyof SpecChange, z.ZodTypeAny>;

const specChangeReportOutput = {
  kind: z.enum(SPEC_KINDS).describe('The spec kind written.'),
  id: z.string().describe('The stored spec\'s id.'),
  written: z.boolean().describe('False when the merged spec equals what is stored: nothing reached disk.'),
  dryRun: z.boolean().describe(
    'True when the caller asked what the delta WOULD do. `written` is false for a dry run exactly as it is '
    + 'for a delta that changed nothing, and only this field tells the two apart.',
  ),
  changes: z.array(z.object(specChangeOutput)).describe(
    'Every change the write made; empty exactly when `written` is false.',
  ),
  ineffective: z.array(z.string()).describe(
    'Every path the delta named that the write did not act on, each with why. Read it: a nested typo the '
    + 'permissive delta cannot refuse shows up here and nowhere else.',
  ),
  notices: z.array(z.string()).describe('Store placement notices, gate warnings and delta notices.'),
  summary: z.string().describe('One line for people.'),
  testsToRevisit: z.array(z.object({
    method: z.string().describe('The contract method this write changed or deleted.'),
    symbol: z.string().describe('The code-level name searched for: the method\'s `symbol` when it declares one, else its name.'),
    imported: z.array(z.string()).describe('Test files that IMPORT that symbol — the high-confidence list, because an import is a binding and not a coincidence.'),
    mentioned: z.array(z.string()).describe('Test files that name the symbol without importing it — usually a test driving it through a portal. Empty when `indiscriminate` is true.'),
    indiscriminate: z.boolean().describe('True when the bare name matched more than a tenth of the test suite, so the mention list was withheld as noise.'),
  })).describe(
    'The tests that encode a method this write changed or deleted, one entry per such method. Empty when the '
    + 'write touched no method, when the project declares no `rules.conformance.testRoots`, or when nothing '
    + 'references them. Read it before promising that existing tests still pass.',
  ),
  ...staleServerOutput,
} satisfies Record<keyof SpecChangeReport | keyof typeof staleServerOutput, z.ZodTypeAny>;

/** One finding, field for field as the validator raises it. */
const validationIssueOutput = {
  severity: z.enum(['error', 'warning']).describe('The finding\'s severity after project overrides.'),
  code: z.string().describe('The rule code, UPPER_SNAKE — the stable handle to filter and suppress by.'),
  message: z.string().describe('What is wrong, named.'),
  agentId: z.string().optional().describe('The agent the finding concerns, when it concerns one.'),
  specId: z.string().optional().describe('The spec the finding concerns, when it concerns one.'),
  draftContext: z.boolean().optional().describe(
    'True when the finding was raised against a draft/design spec — what the --ci gate waives.',
  ),
  surfaceResolved: z.boolean().optional().describe(
    'True when the finding was verified against a vendored surface snapshot, so it is a contract verdict '
    + 'rather than a resolution failure.',
  ),
} satisfies Record<keyof ValidationIssue, z.ZodTypeAny>;

const validateTreeOutput = {
  valid: z.boolean().describe('False when the tree holds at least one error.'),
  errors: z.array(z.object(validationIssueOutput)).describe('Every finding of severity error.'),
  warnings: z.array(z.object(validationIssueOutput)).describe('Every finding of severity warning.'),
  resolvedThrough: z.object({
    root: z.string().describe('The top root that was validated.'),
    scope: z.string().describe('The mount chain the verdict was scoped to.'),
  }).optional().describe(
    'Present when a chained subproject\'s verdict was resolved through its parent; absent when the tree '
    + 'was validated on its own.',
  ),
  ...staleServerOutput,
};

const getSpecOutput = {
  kind: z.enum(SPEC_KINDS).describe('The kind of spec read.'),
  id: z.string().describe('The id it was read by.'),
  spec: z.record(z.unknown()).describe(
    'The stored spec, exactly as the text block renders it — minus the two derived markers below, which '
    + 'the text folds in and this answer keeps separate so nothing derived can be mistaken for stored.',
  ),
  partialResult: z.object({
    shown: z.array(z.string()).describe('The method names this answer carries.'),
    omitted: z.number().describe('How many of the spec\'s methods are NOT in it.'),
    warning: z.string().describe('Why it must never be re-authored from.'),
  }).optional().describe(
    'Present only when `methods` filtered the read. A filtered spec is a partial one: sdd_define_interface '
    + 'and sdd_write_narrative REPLACE the method list, so re-authoring from it would delete every method '
    + 'left out.',
  ),
  variantGuidance: z.object({
    variant: z.string().describe('The variant id the component declares.'),
    base: z.string().describe('The core stereotype it specializes.'),
    guidance: z.string().describe('How to implement a component of this variant.'),
    siblings: z.array(z.string()).describe('Other components of the same variant, to implement alike.'),
    target: z.string().optional().describe('The target language the variant scopes itself to, if any.'),
    profile: z.string().optional().describe('The architectural profile it scopes itself to, if any.'),
  }).optional().describe(
    'Derived, read-only guidance for a variant-tagged component — resolved from the variant registry, not '
    + 'part of the spec. Never write it back.',
  ),
  ...staleServerOutput,
};

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

/**
 * A result carrying the stale-build warning in BOTH channels — the banner on
 * the text block, and `staleServer: true` on the structured content when the
 * tool has any. Half a warning protects half the readers: an agent that reads
 * only structuredContent would never see the banner, and this is the warning
 * that has twice stopped a stale process from silently stripping fields.
 *
 * Unconditional, so the marking can be tested on its own; the guard below
 * decides WHEN to apply it.
 */
export function markStale(result: CallToolResult): CallToolResult {
  const marked: CallToolResult = result.structuredContent
    ? { ...result, structuredContent: { ...result.structuredContent, staleServer: true } }
    : result;
  const first = marked.content?.[0];
  if (first && first.type === 'text') {
    return {
      ...marked,
      content: [{ ...first, text: `${first.text}${STALE_SERVER_WARNING}` }, ...marked.content.slice(1)],
    };
  }
  return marked;
}

function withStaleWarning(result: CallToolResult): CallToolResult {
  return isBuildStale(SERVER_BUILD_STAMP) ? markStale(result) : result;
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
  'sdd_rename_component',
  'sdd_rename_method',
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
  config: {
    description: string;
    inputSchema?: Record<string, z.ZodTypeAny>;
    /**
     * The shape of this tool's `structuredContent`. Declaring it obliges every
     * non-error result to carry one (the SDK enforces it on both sides), so a
     * tool gains this only together with the code that fills it.
     *
     * Deliberately NOT made strict, unlike inputSchema: a strict output would
     * turn a good write into a tool error the day a report grew a field, which
     * is the opposite of what a guard should do. Output drift is caught at
     * COMPILE time instead — each shape below is `satisfies
     * Record<keyof <the report type>, z.ZodTypeAny>`, so a field added to the
     * report and not to the schema fails `tsc`.
     */
    outputSchema?: Record<string, z.ZodTypeAny>;
  },
  cb: (args: Args) => CallToolResult,
): void {
  const guarded = (args: Args): CallToolResult => {
    const result = withStaleWarning(cb(args));
    // A SUCCESSFUL spec write just changed the derived agent topology — tell
    // the connected session its resources/prompts lists are stale.
    if (result.isError !== true && SPEC_WRITE_TOOLS.has(name)) listChangedEmitters.get(server)?.();
    return result;
  };
  // A raw shape is parsed by the SDK as a NON-strict z.object, which silently
  // DROPS any key it does not know. A caller writing `dependson` instead of
  // `dependsOn` was told "Successfully added" while nothing was set, and the
  // tree validated clean afterwards because nothing had changed — the write
  // never happened and nothing said so.
  //
  // Handing the SDK a strict object instead refuses the unknown key by name.
  // It also tightens the advertised JSON Schema to additionalProperties:false,
  // which steers a model away from inventing the field in the first place —
  // cheaper than catching it after the fact.
  //
  // The same rule is applied to every SHAPED object nested inside a tool's
  // input — a method, a param, a narrative step, a finding, an endpoint. This
  // wrapper only reaches the top level, so `{"methods":[{"descriptoin": "…"}]}`
  // still merged, was stripped at write time, and was never mentioned: the same
  // silent drop one depth lower. The one deliberate exception is
  // sdd_update_spec's `delta`, which stays a permissive record because the
  // shapes below it nest further than any hand-copied schema here should
  // restate; that surface names what it dropped instead (SpecChangeReport's
  // `ineffective`), which is the only honest answer where a schema cannot help.
  const strictConfig = config.inputSchema
    ? { ...config, inputSchema: z.object(config.inputSchema).strict() }
    : config;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (server as any).registerTool(name, strictConfig as any, guarded as any);
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

// ---------------------------------------------------------------------------
// Status at create
//
// Every create tool used to hardcode 'draft', so a spec authored at a level the
// author already considered settled needed a follow-up sdd_update_spec that is
// easy to forget — and a whole tree of them is easy to forget twice. The four
// levels that HAVE a status take one; the L0 and a type have no status field at
// all, so the argument would be a lie there and they do not offer it.
//
// Omitting it keeps the same OUTCOME it always had: a new spec is born draft, a
// re-authored one keeps the status it is stored at. It used to reach that
// outcome by handing the store 'draft' and letting the store's no-demotion guard
// turn it back — which meant this boundary did not KNOW the status the spec
// would end up at, and so could not report it. The receipt has to, so the status
// already stored is resolved here and written as itself; the store's guard stays
// as the backstop for every other caller.
//
// What an explicit status must never do is undo a lock quietly, and the store
// cannot help there — it cannot tell a stated 'draft' from the default one. Only
// this boundary knows, so the rule lives here: a stated status may raise a
// spec's level or restate it, never lower it.
// ---------------------------------------------------------------------------

const statusInput = z.enum(STATUS_ORDER).optional().describe(
  'The spec\'s lifecycle status. Omitted means draft for a NEW spec and the status already stored for a '
  + 're-authoring, so a restatement never reopens a frozen spec. State it to author straight at design or '
  + 'complete instead of promoting afterwards. A status that would LOWER the stored one is refused — reopening '
  + 'a spec for revision is sdd_update_spec\'s job, which sets the demotion deliberately.',
);

/**
 * The status this create WRITES — the one the spec will actually hold — or the
 * refusal that stops it.
 *
 * `status` absent answers the status already stored, or 'draft' for a spec that
 * does not exist yet: a new spec is born draft and a re-authored one keeps what
 * it had. A stated status is written as stated, unless it would take the spec
 * backwards, which is refused by name rather than applied or silently ignored.
 *
 * Answering the stored status rather than a bare 'draft' is what lets the write
 * receipt state the status truthfully. Reporting the status ASKED FOR would be a
 * lie on exactly the call that matters — a restatement of a complete spec, which
 * keeps its status and would have been reported as draft.
 */
function statusForCreate(
  label: string,
  stated: StatedStatus | undefined,
  existing: { status?: string } | null | undefined,
): { status: StatedStatus } | { refusal: string } {
  // A stored status the lifecycle does not know (a legacy value) is no status
  // to keep and none to be lowered from: it reads as "nothing held".
  const stored = existing?.status as StatedStatus | undefined;
  const held = stored !== undefined && STATUS_ORDER.includes(stored) ? stored : undefined;
  if (stated === undefined) return { status: held ?? 'draft' };
  if (held === undefined) return { status: stated };
  const rank = (s: StatedStatus): number => STATUS_ORDER.indexOf(s);
  if (rank(stated) < rank(held)) {
    return {
      refusal:
        `Refusing to re-author ${label} at status "${stated}": it is stored at "${held}", and a create tool `
        + 'never lowers a spec\'s status — a restatement that reopened a frozen spec would undo a lock without '
        + `saying so. Nothing was written. To reopen it deliberately, use sdd_update_spec with `
        + `{"status": "${stated}"}; to keep the level it has, leave status out.`,
    };
  }
  return { status: stated };
}

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
      ...summarize(brief.budget, brief.profile),
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
        const registry = coreLoadRegistry();
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
        const registry = coreLoadRegistry();
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
        // Static import (see requireValidation): a lazy require never resolves in
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
        const { validateRegistry } = requireValidation();
        let registry = coreLoadRegistry();
        if (subsystem) {
          registry = {
            ...registry,
            agents: registry.agents.filter((a) => a.domainRoot === subsystem || a.domainRoot?.startsWith(`${subsystem}::`)),
          };
        }
        // A missing config errored before (the loader's loadProjectConfig threw);
        // keep that outcome now that the adapter reads null instead of throwing.
        const config = loadProjectConfig();
        if (!config) throw new ProjectNotInitializedError();
        const result = validateRegistry(registry, config.rules);
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
        const config = loadProjectConfig();
        // A missing config errored before (the loader's loadProjectConfig threw);
        // keep that outcome now that the adapter reads null instead of throwing.
        if (!config) throw new ProjectNotInitializedError();
        return json(config);
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
    boundaries: z.array(z.union([z.string(), z.object({ name: z.string(), description: z.string().optional() }).strict()])).optional().describe('System boundary rules or scope statements (strings or name/description objects)'),
    globalRequirements: z.array(z.union([z.string(), z.object({ description: z.string() }).strict()])).optional().describe('Global functional and non-functional requirements (strings or description objects)'),
    targetLanguage: z.string().optional().describe('Default implementation language for the system (e.g. "typescript", "rust", "python"). Subsystems may override. Enables language-aware validation.'),
  };
  const systemInputFields = Object.keys(systemInput);

  reg<{ name: string; vision: string; boundaries?: any[]; globalRequirements?: any[]; targetLanguage?: string }>(server,
    'sdd_initialize_system',
    {
      description: 'Initialize the L0 System Specification (system.yaml). Re-running it on an existing system RE-AUTHORS it: the fields above are replaced, and everything this tool cannot express (databases, the project gateway publicInterfaces, diagram defaults) is carried forward. The answer carries a write receipt as structured content beside the sentence — what was written, and whether a system spec already existed — so a caller never has to read English to find out.',
      inputSchema: systemInput,
      outputSchema: specWriteReceiptOutput,
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
        // The L0 is a singleton, read back by the id "system" — the same handle
        // sdd_get_spec takes for it.
        return writeReceipt(
          `Successfully ${existing ? 're-authored' : 'initialized'} L0 System Spec for "${name}".`,
          { kind: 'system', id: 'system', name, replacedExisting: Boolean(existing), notices },
        );
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
        }).strict()).optional().describe('Public entrypoints exposed by this subsystem, each bound to a realizing component'),
        projectPath: z.string().optional().describe('Relative path to external project root for subsystem chaining'),
        targetLanguage: z.string().optional().describe('Override of the system-level targetLanguage for this subsystem'),
        profile: z.string().optional().describe('Architectural profile override for this subsystem (built-ins: backend, frontend-reactive, frontend-controller, lowlevel-os, game-ecs, realtime-embedded, plc-cyclic; extension packs may add more — unknown names get UNKNOWN_PROFILE)'),
        designDepth: z.enum(['components', 'interfaces', 'implementations', 'narratives']).optional().describe('How deep THIS subsystem commits to designing (overrides project rules.designDepth; default narratives = full depth). Expectation checks below the depth are gated — soundness of authored content always applies.'),
        trustedLinks: z.array(z.object({
          subsystem: z.string().describe('Peer subsystem id'),
          reason: z.string().describe('Why the coupling is sanctioned (e.g. "dispatch latency fast lane")'),
        }).strict()).optional().describe('Sanctioned tight couplings with peers — required to acknowledge a mutual subsystem dependency; the Adapter → published Portal shape still applies.'),
        lifecycle: z.array(z.object({
          phase: z.enum(['init', 'shutdown', 'cyclic', 'interrupt', 'scheduled']).describe('Which lifecycle/execution flow this roots (cyclic = every scan/tick, interrupt = hardware/OS interrupt, scheduled = timer/cron)'),
          component: z.string().describe('Component id whose method the runtime invokes at this phase'),
          method: z.string().describe('Method name on that component\'s interface'),
          description: z.string().optional(),
        }).strict()).optional().describe('Declared execution-flow roots — reachability entrypoints alongside Portals/Observers. Only init flows feed the durable-Store hydration check (MISSING_HYDRATION); cyclic/interrupt/scheduled root non-request/response execution models (PLC scan, ISR, cron).'),
    status: statusInput,
  };
  const subsystemInputFields = [...Object.keys(subsystemInput), 'parentSystem'];

  reg<{ id: string; name: string; description: string; publicInterfaces?: { type: 'REST' | 'GraphQL' | 'MessageBus' | 'RPC' | 'Custom'; details: string; component?: string; interface?: string }[]; projectPath?: string; targetLanguage?: string; profile?: string; designDepth?: 'components' | 'interfaces' | 'implementations' | 'narratives'; trustedLinks?: { subsystem: string; reason: string }[]; lifecycle?: { phase: 'init' | 'shutdown' | 'cyclic' | 'interrupt' | 'scheduled'; component: string; method: string; description?: string }[]; status?: StatedStatus }>(server,
    'sdd_add_subsystem',
    {
      description: 'Add an L1 Subsystem / Service under the system boundary. publicInterfaces should bind each entry to the component that realizes it (the subsystem\'s published surface); if components do not exist yet, add them later with sdd_set_public_interfaces. Re-running it on an existing id RE-AUTHORS it: the fields above are replaced, lint/ext are carried forward, and the stored status is kept unless this input states a higher one. The answer carries a write receipt as structured content beside the sentence — the status written, whether a spec already held the id, and the child project directory a chained subsystem scaffolded.',
      inputSchema: subsystemInput,
      outputSchema: specWriteReceiptOutput,
    },
    ({ id, name, description, publicInterfaces, projectPath, targetLanguage, profile, designDepth, trustedLinks, lifecycle, status }) => {
      try {
        const { loadSystemSpec, loadSubsystemSpec, saveSubsystemSpec } = requireSpecs();
        const system = loadSystemSpec();
        if (!system) return errText('System spec must be initialized (sdd_initialize_system) first.');
        const now = new Date().toISOString();
        const existing = loadSubsystemSpec(id);
        const resolved = statusForCreate(`subsystem "${id}"`, status, existing);
        if ('refusal' in resolved) return errText(resolved.refusal);
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
          status: resolved.status,
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
        const receipt: SpecWriteReceipt = {
          kind: 'subsystem', id, name, replacedExisting: Boolean(existing), status: resolved.status, notices,
        };
        // External (chained) subsystem: also scaffold the child project so the
        // projectPath never points at an empty directory.
        if (projectPath && projectPath.trim() !== '') {
          const { createChainedSubsystem } = requireProvision();
          createChainedSubsystem(spec, name);
          return writeReceipt(
            `Successfully added external subsystem "${name}" (${id}) and scaffolded its child project at ${projectPath}.`,
            { ...receipt, scaffoldedProjectPath: projectPath },
          );
        }
        saveSubsystemSpec(spec);
        return writeReceipt(`Successfully added L1 Subsystem Spec "${name}" (${id}).`, receipt);
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
        }).strict()).describe('The full replacement list of public interfaces for this subsystem'),
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

  reg<{ id: string; newId: string }>(server,
    'sdd_rename_component',
    {
      description: 'Rename a component and rewrite every reference to it in the bound tree: dependsOn, owns and dispatch entries, lifecycle entrypoints, published interfaces at L1 and L0, narrative call/dispatch/register targets, an interface\'s component, an implementation\'s contract and an entity\'s componentClass. The interface named i<id> and the implementation named <id>_impl move to the new ids and files; interfaces and implementations named otherwise keep their ids. Display names are left as they are. Refuses, writing nothing: a component that does not exist (component-missing), one inside a chained subproject (chained-component — rename it from that project\'s own root), a new id that is not a lowercase identifier without a namespace separator (invalid-id), and a new id — or i<newId> or <newId>_impl — already in use (id-taken). Returns the specs moved, each with its old and new id, and the ids of the other specs rewritten.',
      inputSchema: {
        id: z.string().describe('The component to rename (namespaced if needed)'),
        newId: z.string().describe('Its new id: a lowercase identifier with no namespace separator'),
      },
    },
    ({ id, newId }) => {
      try {
        // mcp_orchestrator.renameComponent: resolve the id in the bound tree,
        // rename through the core adapter, and return the report as the result.
        return json(renameComponent(qualifiedComponentId(id), newId));
      } catch (e) {
        return errText(String(e));
      }
    },
  );

  reg<{ id: string; method: string; newName: string; pinSymbol?: boolean }>(server,
    'sdd_rename_method',
    {
      description: 'Rename a contract method and retarget every reference to it in the bound tree. The method moves on every interface of the component that declares it — its name, and the name inside its signature — and on the implementations of those contracts, carrying narrative, sourcePath, symbol, detail, intent and findings unchanged; an implementation that declared no symbol is pinned to the old name unless pinSymbol is false, so the function it already binds to keeps binding. Narrative call, register and dispatch steps naming this component and method, dispatch-table bindings and lifecycle entrypoints are retargeted. Prose is never rewritten and a gRPC endpoint binding keeps its wire method — renaming a contract method must not silently rename an RPC; both are reported as mentions. Refuses, writing nothing: a component that does not exist (component-missing), one inside a chained subproject (chained-component — rename its method from that project\'s own root), a new name that is not a camel-case identifier (invalid-name), a method the component does not declare (method-missing), and a name a moving contract already declares (name-taken). Returns the specs the method moved in, the specs retargeted, the specs whose prose still names it, and the pinned symbol when one was set.',
      inputSchema: {
        id: z.string().describe('The component whose method is renamed (namespaced if needed)'),
        method: z.string().describe('The method name as it stands'),
        newName: z.string().describe('Its new name: a camel-case identifier'),
        pinSymbol: z.boolean().optional().describe('Whether an implementation that declares no symbol is pinned to the old name so its function still binds; true when omitted'),
      },
    },
    ({ id, method, newName, pinSymbol }) => {
      try {
        // mcp_orchestrator.renameMethod: resolve the id in the bound tree,
        // rename through the core adapter, and return the report as the result.
        return json(renameMethod(qualifiedComponentId(id), method, newName, pinSymbol));
      } catch (e) {
        return errText(String(e));
      }
    },
  );

  reg<{ from: string; to: string; methods: string[]; dryRun?: boolean }>(server,
    'sdd_move_methods',
    {
      description: 'Move contract methods from one component to another, carrying each method\'s narrative, calls and bindings, and re-pointing every reference that named the old home: narrative call/register/dispatch steps, dispatch-table bindings, lifecycle entrypoints and `calls` entries. The target gains the dependencies the moved narratives call. ONE all-or-nothing gated write: if a rule refuses the move nothing is written and the report names the rule plus where these methods could live instead, cheapest legal home first, with the requested target among them so its shortfall reads beside the others. Prose is never rewritten and a wire endpoint keeps its address — moving a method between components must not silently re-address an RPC; both are reported as mentions. Refuses before the first write (unmovable request): a component or method that does not exist, a method name already declared on the target, a source and target that are the same component, and a component inside a chained subproject (move it from that project\'s own root). A dry run runs the whole move, gate included, and reports what it would have done.',
      inputSchema: {
        from: z.string().describe('The component the methods belong to (namespaced if needed)'),
        to: z.string().describe('The component that should receive them (namespaced if needed)'),
        methods: z.array(z.string()).describe('The method names to move; every one must exist on the source contract'),
        dryRun: z.boolean().optional().describe('Answer with what the move would do and write nothing'),
      },
    },
    ({ from, to, methods, dryRun }) => {
      try {
        // mcp_orchestrator.moveMethods steps 1-2: both components are resolved
        // and read HERE, so a mistyped id reads as a mistyped id rather than as
        // a rule refusing the design.
        const { loadComponentSpec } = requireSpecs();
        const source = qualifiedComponentId(from);
        const target = qualifiedComponentId(to);
        if (!loadComponentSpec(source)) return errText(`no component has the id "${from}".`);
        if (!loadComponentSpec(target)) return errText(`no component has the id "${to}".`);
        // Step 3: hand it to the authoring gate, which judges the move as a
        // whole and writes all of it or none of it.
        return json(moveMethods(source, target, methods, dryRun));
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
        componentType: z.enum(['Portal', 'Orchestrator', 'Supervisor', 'Actor', 'Store', 'Index', 'Query', 'Registry', 'Adapter', 'Observer', 'Repository']).describe('The building block, or the pattern Repository. Specialist and Gateway are retired and cannot be authored: logic is an Orchestrator with a dependencyClass, a gateway is a Portal with the gateway variant'),
        owns: z.array(z.string()).optional().describe('Member block ids privately owned by this component (patterns only)'),
        dependsOn: z.array(z.string()).optional().describe('IDs of other components this collaborates with (facades or standalone blocks)'),
        portalType: z.enum(['HTTP_API', 'gRPC', 'GraphQL', 'MessageBus', 'CLI', 'NamedPipe', 'IPC', 'Custom']).optional().describe('Portal-only, and expected on every Portal. OMIT IT on any other componentType — passing it there is refused at the write (UNEXPECTED_PORTAL_FIELD), nothing is saved.'),
        basePath: z.string().optional().describe('Portal-only: base path/prefix all the portal\'s endpoints mount under. OMIT IT on any other componentType — passing it there is refused at the write (UNEXPECTED_PORTAL_FIELD), nothing is saved.'),
        dispatch: z.array(z.object({
          capability: z.string().describe('Capability name exactly as dispatched at runtime (e.g. "shadow_module.get")'),
          component: z.string().describe('Component id serving this capability (must also appear under dependsOn/owns)'),
          method: z.string().describe('Method name on the serving component\'s interface'),
          description: z.string().optional(),
        }).strict()).optional().describe('Portal-only: capability → component.method dispatch table for generic-handle portals. Gives the reachability walker real edges and is validated against target interfaces (UNSERVED_CAPABILITY).'),
        mounts: z.array(z.object({
          portal: z.string().describe('The mounted Portal\'s component id'),
          prefixes: z.array(z.string()).describe('The path prefixes this listener routes to the portal. A path lies under a prefix when it equals it or continues it past a slash, so "/" covers only the root itself'),
          via: z.string().optional().describe('The router entry the listener calls to hand the portal its request, exported by the PORTAL\'s own file (held to it: UNREALIZED_EXPORT_HANDLE). Omit when the listener calls the portal\'s contract methods directly, route by route'),
        }).strict()).optional().describe('Portal-only: the portals this LISTENER serves, each under its path prefixes and through its router entry. Declaring the field — even as an empty array — marks this portal as a listener, the one kind of portal nothing else needs to mount. Checked by portal-mounts: a mount must name a Portal (MOUNT_TARGET_NOT_PORTAL), every HTTP endpoint of a mounted portal must lie under one of its prefixes (ENDPOINT_OUTSIDE_MOUNT), and a portal with HTTP endpoints that is neither a listener nor mounted by one is reported (UNMOUNTED_PORTAL).'),
        durability: z.enum(['ram-projection', 'durable', 'read-through', 'cache']).optional().describe('Store-only — OMIT IT on any other componentType, where it is refused at the write (DURABILITY_ON_NON_STORE) and nothing is saved. Every Store should declare one (MISSING_DURABILITY): durable = persisted RAM projection (hydration read-back from a lifecycle init entrypoint required — MISSING_HYDRATION); read-through = persisted with no RAM copy (every read is the read-back, hydration exempt); ram-projection = rebuilt not restored; cache = evictable loss-safe memo state.'),
        dependencyClass: z.enum(['pure', 'read']).optional().describe('Orchestrator-only — OMIT IT on any other componentType, where it is refused at the write (DEPENDENCY_CLASS_ON_NON_ORCHESTRATOR) and nothing is saved. Declares what logic may depend on, enforced as a Store\'s durability is (DEPENDENCY_CLASS_VIOLATION): pure = depends only on pure Orchestrators (a computation over the values it is handed, e.g. an arbiter or codec); read = also on read Orchestrators, Repositories, Indexes and Adapters, never calling their write methods; unset = a workflow.'),
        emits: z.array(z.object({
          topic: z.string().describe('Topic/channel name exactly as used on the bus'),
          event: z.string().optional().describe('Optional event name within the topic (informational; pairing is by topic)'),
          description: z.string().optional(),
        }).strict()).optional().describe('Topics this component publishes — every emitted topic needs a subscriber somewhere in the tree (UNCONSUMED_TOPIC).'),
        subscribesTo: z.array(z.object({
          topic: z.string().describe('Topic/channel name exactly as used on the bus'),
          event: z.string().optional(),
          description: z.string().optional(),
        }).strict()).optional().describe('Topics this component consumes (typical on Observers) — every subscription needs an emitter somewhere in the tree (UNSOURCED_SUBSCRIPTION).'),
        ext: z.record(z.unknown()).optional().describe('Opaque pack/tool extension data (namespaced keys, e.g. "mypack:priority") — preserved verbatim, never validated or interpreted by the core'),
    status: statusInput,
  };
  const componentInputFields = Object.keys(componentInput);

  reg<{ id: string; name: string; description: string; subsystem: string; componentType: 'Portal' | 'Orchestrator' | 'Supervisor' | 'Actor' | 'Store' | 'Index' | 'Query' | 'Registry' | 'Adapter' | 'Observer' | 'Repository'; owns?: string[]; dependsOn?: string[]; portalType?: 'HTTP_API' | 'gRPC' | 'GraphQL' | 'MessageBus' | 'CLI' | 'NamedPipe' | 'IPC' | 'Custom'; basePath?: string; dispatch?: { capability: string; component: string; method: string; description?: string }[]; mounts?: { portal: string; prefixes: string[]; via?: string }[]; durability?: 'ram-projection' | 'durable' | 'read-through' | 'cache'; dependencyClass?: 'pure' | 'read'; emits?: { topic: string; event?: string; description?: string }[]; subscribesTo?: { topic: string; event?: string; description?: string }[]; ext?: Record<string, unknown>; status?: StatedStatus }>(server,
    'sdd_add_component',
    {
      description: 'Add an L2 Component under a subsystem. componentType is a building block (Portal, Orchestrator, Supervisor, Actor, Store, Index, Query, Registry, Adapter, Observer) or the pattern Repository. Specialist and Gateway are retired (STEREOTYPE_RETIRED) and cannot be authored: logic is an Orchestrator with a dependencyClass (pure | read; unset = a workflow), and a gateway is a Portal with the gateway variant (set variant with sdd_update_spec). Patterns set "owns" (their private member blocks); all components set "dependsOn" (collaborators — facades or standalone blocks). Held/persisted state (configs, permissions, sessions, caches): model the Repository recipe — a Store + Registry (write) + Index (read), plus a Query for computed reads over the Store, owned by a Repository facade consumers depend on; a deliberately standalone Store is the sanctioned lightweight form (workflow-layer consumers + lint.allow on UNOWNED_STORE). Never hold state as fields inside an Orchestrator because a Store link was refused. Re-running it on an existing id RE-AUTHORS it: the fields above are replaced (an omitted array is CLEARED), while lint.allow, a Portal\'s auth, variant, patterns and externalLinks are carried forward — edit those with sdd_update_spec. The stored status is kept unless this input states a higher one. The answer carries a write receipt as structured content beside the sentence — the status written, whether a spec already held the id, and every gate notice the write raised, each as its own entry.',
      inputSchema: componentInput,
      outputSchema: specWriteReceiptOutput,
    },
    ({ id, name, description, subsystem, componentType, owns, dependsOn, portalType, basePath, dispatch, mounts, durability, dependencyClass, emits, subscribesTo, ext, status }) => {
      try {
        const { loadSubsystemSpec, loadComponentSpec } = requireSpecs();
        const sub = loadSubsystemSpec(subsystem);
        if (!sub) return errText(`Parent subsystem "${subsystem}" does not exist.`);
        const now = new Date().toISOString();
        // Loaded BEFORE the candidate is built: the status a create may write
        // depends on the one already stored.
        const existing = loadComponentSpec(id);
        const resolved = statusForCreate(`component "${id}"`, status, existing);
        if ('refusal' in resolved) return errText(resolved.refusal);
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
          // An EMPTY list is kept: declaring the field is what marks a listener.
          ...(mounts ? { mounts } : {}),
          ...(durability ? { durability } : {}),
          ...(dependencyClass ? { dependencyClass } : {}),
          ...(emits ? { emits } : {}),
          ...(subscribesTo ? { subscribesTo } : {}),
          ...(ext ? { ext } : {}),
          status: resolved.status,
          createdAt: now,
          updatedAt: now,
        };

        // Re-adding an existing component used to erase everything this input
        // cannot express — lint.allow above all, whose only symptom is the
        // suppressed warning silently coming back. Carry it, and say so.
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
        return writeReceipt(
          `Successfully ${existing ? 're-authored' : 'added'} L2 Component Spec "${name}" (${id}, ${componentType}).`,
          { kind: 'component', id, name, replacedExisting: Boolean(existing), status: resolved.status, notices },
        );
      } catch (e) {
        return errText(String(e));
      }
    },
  );

  const interfaceMethodShape = {
          name: z.string(),
          description: z.string(),
          signature: z.string(),
          returns: z.string().describe(TYPE_REF_GRAMMAR('The type the method answers with')),
          params: z.array(z.object({
            name: z.string(),
            type: z.string().describe(TYPE_REF_GRAMMAR('The parameter\'s type')),
            description: z.string().optional(),
            optional: z.boolean().optional().describe(
              'Whether the parameter may be OMITTED by a caller. It is not nullability: a parameter that must be '
              + 'passed but may be passed as nothing is a required parameter whose type is a union — '
              + '"ProjectConfig | null". Say whichever is true; they are different contracts.',
            ),
          }).strict()).optional().describe('Structured parameters — authoritative for type checking (the prose signature becomes display-only). Strongly preferred.'),
          guarantees: z.array(z.string().min(1)).optional().describe('Semantic guarantees the method promises (combinable); any guarantee a narrative step asserts must be declared here. Builtin tokens: idempotent | atomic | transactional | exactly-once; extension packs may declare more (any other token is UNKNOWN_GUARANTEE)'),
          effect: z.enum(['read', 'write']).optional().describe('State-effect direction on the component\'s held state — required on a durable Store\'s contract methods so the durability round-trip rule can pair writes with hydration read-backs'),
          invokedBy: z.object({
            kind: z.enum(['runtime', 'external', 'sibling-subsystem']).describe('Who owns the out-of-graph invocation: runtime (timer/signal/shutdown hook), external (a system outside this project), sibling-subsystem (a modeled sibling whose edge is not narrated here)'),
            caller: z.string().optional().describe('WHO invokes it and when, as reviewable prose — missing or placeholder-thin prose is INVOKED_BY_UNDESCRIBED'),
          }).strict().optional().describe('Typed acknowledgment of a real caller OUTSIDE the modeled narrative graph. Unused-detection seeds the method as an entrypoint so reachability propagates through its narrative (unlike lint.allow); a method the internal walk already reaches is flagged stale (INVOKED_BY_REDUNDANT). Prefer a `register` narrative step when the wiring is internal.'),
          findings: z.array(z.object({
            code: z.string().describe('UPPER_SNAKE finding code, unique within the method; a pack\'s codes carry the pack prefix (<PACK>_<CODE>)'),
            severity: z.enum(['error', 'warning']).describe('Default severity, before project severity overrides and draft-context downgrades'),
            summary: z.string().describe('One line saying what the finding means'),
          }).strict()).optional().describe('The finding codes this method can report, each with its default severity and summary. Each declared code must be anchored in the method\'s source file, as a string literal or a property-access name (UNREALIZED_FINDING). A code is declared once per method; sdd_update_spec upserts and deletes findings by code.'),
          ext: z.record(z.unknown()).optional().describe('Opaque pack/tool extension data for this method (namespaced keys) — preserved verbatim'),
  };
  const interfaceMethodInputFields = Object.keys(interfaceMethodShape);
  const interfaceInput = {
    id: z.string().describe('Lowercase identifier prefixed with "i", e.g. "istorage"'),
    name: z.string().describe('Human-readable contract name'),
    description: z.string().describe('Contract description and obligations'),
    component: z.string().describe('The L2 component ID this interface belongs to'),
    methods: z.array(z.object(interfaceMethodShape).strict()).optional().describe('List of method signature contracts'),
    status: statusInput,
  };
  const interfaceInputFields = Object.keys(interfaceInput);

  reg<{ id: string; name: string; description: string; component: string; methods?: { name: string; description: string; signature: string; returns: string; params?: { name: string; type: string; description?: string; optional?: boolean }[]; guarantees?: string[]; effect?: 'read' | 'write'; invokedBy?: { kind: 'runtime' | 'external' | 'sibling-subsystem'; caller?: string }; findings?: { code: string; severity: 'error' | 'warning'; summary: string }[]; ext?: Record<string, unknown> }[]; status?: StatedStatus }>(server,
    'sdd_define_interface',
    {
      description: 'Define an L3 Contract / Interface with method signatures for a component. Prefer supplying structured `params` per method — they are the authoritative source for type checking (the free-form signature string then becomes display-only and is never heuristically parsed). A method declares the finding codes it reports in `findings` ({code, severity, summary}); each code must be anchored in the method\'s source file, as a string literal or a property-access name (UNREALIZED_FINDING). Re-defining an existing id REPLACES the method list: a method left out of the input is REMOVED (and reported); spec-level lint/ext and each method\'s endpoint binding are carried forward, and the stored status is kept unless this input states a higher one. The answer carries a write receipt as structured content beside the sentence — the status written, whether a spec already held the id, and the notices a restatement raised, each as its own entry.',
      inputSchema: interfaceInput,
      outputSchema: specWriteReceiptOutput,
    },
    ({ id, name, description, component, methods, status }) => {
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
        const resolved = statusForCreate(`interface "${id}"`, status, existing);
        if ('refusal' in resolved) return errText(resolved.refusal);
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
          status: resolved.status,
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
        return writeReceipt(
          `Successfully ${existing ? 're-authored' : 'defined'} L3 Interface Contract "${name}" (${id}).`,
          { kind: 'interface', id, name, replacedExisting: Boolean(existing), status: resolved.status, notices },
        );
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
        }).strict()).describe('One binding per method'),
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
    auth: z.object({ from: z.string(), note: z.string().optional() }).strict().optional().describe('call/dispatch: the credential this step presents to an AUTHED callee Portal and WHERE it loads from (`from`). Opaque form (env:API_KEY, a config key, vault:path) = a design note wairon never resolves; modeled form `component:<id>` references the Adapter/Store that provides the secret and is validated (must resolve, be an Adapter/Store, and be wired to the presenter). Absence on a call into a Portal whose auth ≠ none warns (PORTAL_AUTH_UNMET). The authenticated call itself should be made by an Adapter (AUTH_PRESENTER_NOT_ADAPTER).'),
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
    cases: z.array(z.object({ value: z.string(), step: stepNo().optional(), label: labelRef().optional() }).strict()).optional().describe('switch: required; each case targets its region by step number or label'),
    defaultStep: stepNo().optional().describe('switch: default = next step'),
    defaultLabel: labelRef().optional().describe('switch: symbolic alternative to defaultStep'),
    loopKind: z.enum(['forEach', 'for', 'while', 'doWhile']).optional().describe('loop: default forEach when "over" is set, else while'),
    over: z.string().optional().describe('loop forEach/for: iteration source'),
    endStep: stepNo().optional().describe('loop/try: last step of the body region (required, or endLabel)'),
    endLabel: labelRef().optional().describe('loop/try: symbolic alternative to endStep'),
    catches: z.array(z.object({ error: z.string(), step: stepNo().optional(), label: labelRef().optional() }).strict()).optional().describe('try: handler regions, each targeted by step number or label'),
    finallyStep: stepNo().optional().describe('try: first step of the always-runs region'),
    finallyLabel: labelRef().optional().describe('try: symbolic alternative to finallyStep'),
    branches: z.array(z.object({ step: stepNo().optional(), label: labelRef().optional(), name: z.string().optional() }).strict()).optional().describe('parallel: >= 2 arm entries (step number or label), ascending, first = the step after the header; arms are contiguous sub-regions of body next..endStep, joining after endStep once ALL complete'),
    toStep: stepNo().optional().describe('jump: required (break/continue/rejoin), or toLabel'),
    toLabel: labelRef().optional().describe('jump: symbolic alternative to toStep — resolves to the labeled step at write time'),
    outcome: z.string().optional().describe('return: e.g. "success", "not found"'),
    error: z.string().optional().describe('throw: the raised error'),
  }).strict();
  type NarrativeStepIn = z.infer<typeof narrativeStepInput>;
  const detailEnum = z.enum(['full', 'calls-only', 'intent']);

  const conformanceEnum = z.enum(['declared', 'anchored', 'off']);
  const implMethodShape = {
    name: z.string(),
    sourcePath: z.string().optional().describe('Optional: the source file realizing THIS method when it is not the implementation\'s sourcePath (e.g. a command whose body lives in its own file); the implementation\'s sourcePath is the default. Relative to project root — for a chained subproject\'s implementation (qualified id), relative to that subproject\'s root; a path given relative to this root that lands inside the subproject is re-expressed for you'),
    detail: detailEnum.optional().describe('Detail level for this method (overrides the spec default)'),
    intent: z.string().optional().describe('detail: intent — behavioral prose (what it does and how it fails); substitute for a narrative'),
    conformance: conformanceEnum.optional().describe('Conformance tier for this method (overrides the spec default)'),
    symbol: z.string().optional().describe('Code-level name realizing this contract method in the sourcePath file, when it legitimately differs from the intent-language contract name (e.g. put realized by saveSnapshot)'),
    exportedVia: z.string().optional().describe('The exported binding a consumer imports to REACH this method, when the realization is published as a value that composes it rather than exported in its own right (a rule module publishes callConformanceRule, and the method is the check inside it). Not symbol, which names the function itself: this names the route to it, so the surface check reads that export as promised. A handle the method\'s own source file does not actually export is reported (UNREALIZED_EXPORT_HANDLE) and allows nothing'),
    ext: z.record(z.unknown()).optional().describe('Opaque pack/tool extension data for this method (namespaced keys) — preserved verbatim'),
    narrative: z.array(narrativeStepInput).optional(),
    calls: z.array(z.string().min(1)).optional().describe('The calls this method makes, when its narrative does not show them (detail: intent, or calls-only with no steps authored) — each as "<component>.<method>", the spelling the debt register and lint allows name a unit with. The narrative walk takes exactly these edges and no others, so an undeclared collaborator is NOT reached: this is what keeps unused-detection honest at a lower detail dial. Each entry is validated like a call step (the component resolves, this component declares it, the method is on its contract). Refused beside a non-empty narrative — add the call step there instead'),
  };
  const implMethodInputFields = Object.keys(implMethodShape);
  const implInput = {
    id: z.string().describe('Lowercase identifier, e.g. "vfs_storage"'),
    name: z.string().describe('Human-readable implementation name'),
    description: z.string().describe('Implementation details'),
    contract: z.string().describe('The L3 Interface contract ID this implements'),
    sourcePath: z.string().optional().describe('Optional: target source code file path relative to project root — for a chained subproject\'s implementation (qualified id), relative to that subproject\'s root; a path given relative to this root that lands inside the subproject is re-expressed for you'),
    simPath: z.string().optional().describe('Optional: the committed integration-sim harness file (project-relative; N:1 sharing allowed). The validator proves it exists and its import graph wires the REAL modules (this component + each direct dependency; technology adapters may stay faked) — running it is CI\'s job. Declaring the first simPath in a subsystem activates MISSING_INTEGRATION_SIM for its other complete non-leaf implementations'),
    technologies: z.array(z.string()).optional().describe('External technologies this implementation binds to (e.g. ["mysql"]) — declares this component\'s ownership tree as the technology\'s home; references outside it are flagged (TECH_LEAKAGE) and contract identifiers must stay intent-language. Only for Adapter/Store/Registry/Index components.'),
    injectedParams: z.array(z.string()).optional().describe('The parameter names this realization takes BEFORE the ones its contract declares — a config object, a data root, the transport handles a portal is handed. Supplied by whatever wires the component up, never by the caller the contract describes, which is why they belong here and not to the contract: another realization may hold them as fields instead. Declared rather than guessed, because a leading parameter the contract does not name cannot be told from one it named under a different name (`seed(config)` realized as `bootstrapInstance(cfg)`); a leading parameter this list does not name is reported (UNDECLARED_PARAM). Only a LEADING run is dropped — one of these names appearing after the contract\'s own parameters is an argument in the middle of the caller\'s list, not wiring'),
    detail: detailEnum.optional().describe('Spec-level narrative detail default for all methods'),
    conformance: conformanceEnum.optional().describe('Spec-level conformance tier default: declared | anchored | off (omitted = stereotype default: Portal → anchored, else declared)'),
    methods: z.array(z.object(implMethodShape).strict()).optional().describe('Method implementations containing L5 narratives'),
    status: statusInput,
  };
  const implInputFields = Object.keys(implInput);

  reg<{ id: string; name: string; description: string; contract: string; sourcePath?: string; simPath?: string; technologies?: string[]; injectedParams?: string[]; detail?: 'full' | 'calls-only' | 'intent'; conformance?: 'declared' | 'anchored' | 'off'; methods?: { name: string; sourcePath?: string; detail?: 'full' | 'calls-only' | 'intent'; intent?: string; conformance?: 'declared' | 'anchored' | 'off'; symbol?: string; exportedVia?: string; ext?: Record<string, unknown>; narrative?: NarrativeStepIn[]; calls?: string[] }[]; status?: StatedStatus }>(server,
    'sdd_write_narrative',
    {
      description: 'Write L4 Concrete Implementation spec containing L5 method narratives. Narratives are a FLAT ordered step list; flow steps (branch/switch/loop/try/parallel/jump/return/throw) jump by step number — blocks are just skipped regions. Steps may declare a `label` anchor, and every jump field has a *Label twin (toLabel, onTrueLabel, endLabel, …) resolved to step numbers at write time — prefer labels over hand-counted numbers; an unresolvable label rejects the write. Detail dial per method: full (narrative required) | calls-only (call choreography suffices) | intent (prose instead of steps); omitted = stereotype default (Portal/Observer/Adapter: calls-only, Store/Index/Registry: intent, else full). A method whose narrative shows no steps declares the calls it makes in `calls` (one "<component>.<method>" each): the reachability walk takes exactly those edges and no others, so an intent-level method that reaches a collaborator must name it or that collaborator is reported unused. Conformance dial per method or spec: declared | anchored | off — how strictly structural conformance requires contract methods to be realized in their source file (omitted = Portal: anchored, else declared). A method whose body lives in its own file names it in the method\'s sourcePath; the implementation\'s sourcePath is the default for every method that names none. Parameters the realization takes BEFORE its contract\'s own — a config object, a data root, a portal\'s transport handles — are wiring, and are declared once for the spec in injectedParams; a leading parameter it does not name is reported against the contract (UNDECLARED_PARAM). Re-authoring an existing id REPLACES the method list: a method left out of the input is REMOVED together with its narrative (and reported); spec-level lint/ext are carried forward, and the stored status is kept unless this input states a higher one. The answer carries a write receipt as structured content beside the sentence — the status written, whether a spec already held the id, and the notices a restatement raised, each as its own entry.',
      inputSchema: implInput,
      outputSchema: specWriteReceiptOutput,
    },
    ({ id, name, description, contract, sourcePath, simPath, technologies, injectedParams, detail, conformance, methods, status }) => {
      try {
        const { loadInterfaceSpec, loadImplementationSpec, saveImplementationSpec } = requireSpecs();
        const intf = loadInterfaceSpec(contract);
        if (!intf) return errText(`Interface contract "${contract}" does not exist.`);
        // Re-authoring an EXISTING implementation replaces what the input
        // expresses — but the input cannot express spec-level lint/ext and may
        // omit per-method ext. Carry those forward from the previous version
        // (createdAt likewise) instead of silently dropping them.
        const existing = loadImplementationSpec(id);
        const resolved = statusForCreate(`implementation "${id}"`, status, existing);
        if ('refusal' in resolved) return errText(resolved.refusal);
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
          injectedParams,
          detail,
          conformance,
          // Post-resolution every cases/catches entry has its numeric step —
          // the *Label twins exist only in the input type, not the spec's.
          methods: resolvedMethods as Parameters<typeof saveImplementationSpec>[0]['methods'],
          status: resolved.status,
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
        return writeReceipt(
          `Successfully saved L4 Implementation Spec "${name}" (${id}) with method narratives.`,
          { kind: 'implementation', id, name, replacedExisting: Boolean(existing), status: resolved.status, notices },
        );
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
          type: z.string().describe(TYPE_REF_GRAMMAR('The field\'s type')),
          description: z.string().optional(),
          optional: z.boolean().optional(),
          key: z.enum(['primary', 'unique', 'foreign']).optional().describe('Identity marker (PK/unique/FK) for ERD and database schema derivation'),
          references: z.string().optional().describe('For foreign keys, the referenced type/table id and optional field, e.g. "invoice.id"'),
        }).strict()).optional().describe('Data fields (type is a primitive or a qualified type id, e.g. "billing.Invoice")'),
        methods: z.array(z.object({
          name: z.string(),
          signature: z.string(),
          returns: z.string().describe(TYPE_REF_GRAMMAR('The type the method answers with')),
          description: z.string().optional(),
          sourcePath: z.string().optional().describe('Source file realizing this method when the type\'s own sourcePath does not hold it — a pure type method often lives apart from the declaration'),
          symbol: z.string().optional().describe('Code-level name realizing this method when it differs from the method name, e.g. narrative_step.foreignFields realized by narrativeStepForeignFields'),
        }).strict()).optional().describe('Pure intrinsic methods only'),
        componentClass: z.string().optional().describe('Optional component id that implements or owns this logical entity'),
        invariants: z.array(z.object({
          id: z.string().describe('Stable invariant id, unique within the entity'),
          description: z.string().describe('The property that must hold, stated precisely'),
        }).strict()).optional().describe('Declared domain invariants (entities): every write-effect method of the componentClass must carry a narrative step asserting each (assertsInvariants) — declarations checked, enforcement never proven'),
        database: z.string().optional().describe('Optional database id for table-schema types'),
        table: z.string().optional().describe('Optional database table name for table-schema types'),
        linkedEntity: z.string().optional().describe('Optional logical entity id represented by this table-schema type'),
        sourcePath: z.string().optional().describe('Source file holding the declaration of this type (project-relative). Naming one turns the type into a claim on code: the file must resolve and the declaration must be anchored in it (UNREALIZED_TYPE)'),
        symbol: z.string().optional().describe('Code-level name realizing the declaration when it differs from name, e.g. a type named "Invoice Line" declared as InvoiceLine'),
  };
  const typeInputFields = Object.keys(typeInput);

  reg<{ kind: 'entity' | 'value-object'; id: string; name: string; description?: string; subsystem?: string; group?: string; fields?: { name: string; type: string; description?: string; optional?: boolean; key?: 'primary' | 'unique' | 'foreign'; references?: string }[]; methods?: { name: string; signature: string; returns: string; description?: string; sourcePath?: string; symbol?: string }[]; componentClass?: string; invariants?: { id: string; description: string }[]; database?: string; table?: string; linkedEntity?: string; sourcePath?: string; symbol?: string }>(server,
    'sdd_add_type',
    {
      description: 'Define an entity or value-object type (the data components operate on). Entities are owned by a subsystem; shared value objects omit subsystem (system-level). Fields are data; methods are PURE intrinsic behaviour only — anything needing a collaborator belongs on a component, taking the entity as an argument. A type may also CLAIM code: sourcePath names the file holding its declaration (and each method may name its own), symbol binds the code-level name when it differs — the file must then resolve and the declaration must be anchored in it. Re-defining an existing id REPLACES fields/methods/invariants and restates sourcePath/symbol (an omitted list or path is CLEARED, and a dropped member is reported); lint/ext are carried forward. The answer carries a write receipt as structured content beside the sentence — whether a spec already held the id, and the notices a restatement raised, each as its own entry. A type carries no lifecycle status, so the receipt states none.',
      inputSchema: typeInput,
      outputSchema: specWriteReceiptOutput,
    },
    ({ kind, id, name, description, subsystem, group, fields, methods, componentClass, invariants, database, table, linkedEntity, sourcePath, symbol }) => {
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
          ...(sourcePath ? { sourcePath } : {}),
          ...(symbol ? { symbol } : {}),
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
        // `kind` here is the type's OWN kind (entity | value-object); the
        // receipt's kind is the spec level, which for this tool is always a type.
        return writeReceipt(
          `Successfully ${existing ? 're-authored' : 'defined'} ${kind} type "${name}" (${id}).`,
          { kind: 'type', id, name, replacedExisting: Boolean(existing), notices },
        );
      } catch (e) {
        return errText(String(e));
      }
    },
  );

  reg<{ subsystem?: string; recursive?: boolean }>(server,
    'sdd_validate_tree',
    {
      description: 'Validate the SDD spec tree, checking parent references, contract compatibility, narratives, and component type boundaries. Supports scoping and recursion controls. Findings come back as structured content too, under the schema this tool declares — errors and warnings already split, each with its code, severity, message and the spec it concerns — so a caller filters them as objects instead of parsing the JSON text block and hoping its shape holds.',
      inputSchema: {
        subsystem: z.string().optional().describe('Only validate the specified subsystem (granular)'),
        recursive: z.boolean().optional().describe('Whether to recursively validate subprojects (default: true)'),
      },
      outputSchema: validateTreeOutput,
    },
    ({ subsystem, recursive }) => {
      try {
        const config = loadProjectConfig();
        // A missing config errored before (the loader's loadProjectConfig threw);
        // keep that outcome now that the adapter reads null instead of throwing.
        if (!config) throw new ProjectNotInitializedError();
        const { validateSddTree } = requireValidation();
        const result = validateSddTree({
          rules: config.rules,
          projectType: config.projectType,
          scopeSubsystem: subsystem,
          recursive: recursive ?? true,
        });
        // The text block is the same JSON it has always been; the structured
        // twin is that very object, so the two can never disagree.
        return jsonStructured({
          valid: result.valid,
          errors: result.issues.filter((i) => i.severity === 'error'),
          warnings: result.issues.filter((i) => i.severity === 'warning'),
          ...(result.resolvedThrough ? { resolvedThrough: result.resolvedThrough } : {}),
        });
      } catch (e) {
        return errText(String(e));
      }
    },
  );

  reg<{ kind: 'system' | 'subsystem' | 'component' | 'interface' | 'implementation' | 'type'; id: string; methods?: string[] }>(server,
    'sdd_get_spec',
    {
      description: 'Get/read the parsed JSON contents of a specific spec from the spec tree. Returns structural contents without file system path searching. Pass "methods" to read only the named methods of a contract, an implementation or a type — a 45-method spec fetched whole to look at one of them is the read side of the same waste a restatement is on the write side; the answer then carries a "partialResult" marker naming what was left out, and must never be re-authored from. For a variant-tagged COMPONENT the result also carries a derived, read-only "variantGuidance" (the variant\'s base, its implementation guidance, and the same-variant sibling components to implement alike) — it is resolved from the variant registry, not part of the spec, so never write it back. The structured content carries the same answer with the two derived markers KEPT SEPARATE from the stored spec ({kind, id, spec, partialResult?, variantGuidance?}), so nothing derived can be mistaken for something stored; the text block folds them in as it always has.',
      inputSchema: {
        kind: z.enum(['system', 'subsystem', 'component', 'interface', 'implementation', 'type']).describe('The kind of specification'),
        id: z.string().describe('The identifier of the spec to fetch (the L0 system spec is a singleton — pass the system name or "system")'),
        methods: z.array(z.string().min(1)).optional().describe('Return only these methods by name; every other field of the spec comes back unchanged. Only an interface, an implementation or a type declares methods — asking for one elsewhere is refused, as is a name the spec does not declare (the answer names the ones it does). Omit it for the whole spec.'),
      },
      outputSchema: getSpecOutput,
    },
    ({ kind, id, methods }) => {
      try {
        const specs = requireSpecs();
        let result: unknown = null;
        /** The filter marker, when `methods` narrowed the read; null when it read whole. */
        let partial: { shown: string[]; omitted: number; warning: string } | null = null;
        switch (kind) {
          case 'system':         result = specs.loadSystemSpec(); break;
          case 'subsystem':      result = specs.loadSubsystemSpec(id); break;
          case 'component':      result = specs.loadComponentSpec(id); break;
          case 'interface':      result = specs.loadInterfaceSpec(id); break;
          case 'implementation': result = specs.loadImplementationSpec(id); break;
          case 'type':           result = specs.loadTypeSpec(id); break;
        }
        if (!result) return errText(`Spec of kind "${kind}" with ID "${id}" does not exist.`);
        // A filter that quietly returned nothing, or quietly returned everything,
        // would be the same silent drop this surface exists to end — so a name the
        // spec does not declare is refused, and a partial answer says it is one.
        if (methods !== undefined) {
          const declared = (result as { methods?: { name?: string }[] }).methods;
          if (!Array.isArray(declared)) {
            return errText(
              `A ${kind} spec declares no methods, so "methods" cannot filter it. Drop the argument to read `
              + `"${id}" whole; methods live on an interface, an implementation and a type.`,
            );
          }
          const names = declared.map((m) => String(m?.name));
          const unknown = methods.filter((n) => !names.includes(n));
          if (unknown.length > 0) {
            return errText(
              `${kind} "${id}" does not declare ${unknown.map((n) => `"${n}"`).join(', ')}. It declares: `
              + `${names.join(', ')}. Nothing was returned, so a misspelled name never reads as a method with no content.`,
            );
          }
          const kept = declared.filter((m) => methods.includes(String(m?.name)));
          partial = {
            shown: kept.map((m) => String(m?.name)),
            omitted: names.length - kept.length,
            warning:
              `PARTIAL: ${names.length - kept.length} of this spec's ${names.length} methods are not in this answer. `
              + 'Never re-author from it — sdd_define_interface and sdd_write_narrative REPLACE the method list, '
              + 'so every method missing here would be removed from the spec.',
          };
          result = { ...(result as object), methods: kept };
        }
        // A variant carries implementation guidance that attaches to the component
        // an implementer is holding — the right hook for platform guidance, with no
        // doctrine duplication. It reached only GENERATED agent files, so a hosted
        // agent never saw it; attach it here as a clearly-derived read-only field.
        const guidance = kind === 'component'
          ? resolveComponentVariantGuidance(result as { id: string; variant?: string })
          : null;
        // Two renderings of ONE answer. The text block folds both derived markers
        // into the spec, exactly as it always has — a client reading only text
        // sees no change. The structured twin keeps `spec` to what is STORED and
        // the markers beside it, so nothing derived can be re-authored by
        // accident.
        const folded = {
          ...(result as object),
          ...(partial ? { partialResult: partial } : {}),
          ...(guidance ? { variantGuidance: guidance } : {}),
        };
        return structured(JSON.stringify(folded, null, 2), {
          kind,
          id,
          spec: result as Record<string, unknown>,
          ...(partial ? { partialResult: partial } : {}),
          ...(guidance ? { variantGuidance: guidance } : {}),
        });
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

  reg<{ kind: 'system' | 'subsystem' | 'component' | 'interface' | 'implementation' | 'type'; id: string; delta: Record<string, any>; dryRun?: boolean }>(server,
    'sdd_update_spec',
    {
      description: 'Update/patch an existing SDD specification (subsystem, component, interface, implementation, or type) using a granular delta. Updates fields, appends/merges array elements, or inserts/deletes narrative steps. Answers with exactly what changed, and with every path the delta named that the write did not act on. Pass dryRun to be told what it would do without writing it.',
      inputSchema: {
        kind: z.enum(['system', 'subsystem', 'component', 'interface', 'implementation', 'type']).describe('The spec kind to update (system = the singleton L0 — vision, boundaries, globalRequirements, databases, and publicInterfaces: the project gateway surface, each entry {id, name, subsystem, component, type, details, audience: project|department|instance|partner|external}; id is informational)'),
        id: z.string().describe('The ID of the spec to update (namespaced if needed)'),
        delta: z.record(z.any()).describe('The partial fields to merge into the spec. ARRAYS UPSERT, they do not replace: an array whose elements carry an identity is merged element-by-element, so a delta naming ONE element leaves the others intact. Identity is "name" or "id" by default, and per field: dispatch by "capability", a listener\'s mounts by "portal", lifecycle by phase+component+method, emits/subscribesTo by topic+event, trustedLinks by "subsystem", invariants and patterns by "id", lint.allow by "code" AND "at" (an allow covers one occurrence, so several may share a code on one spec), an interface method\'s findings by "code", boundaries by "name", globalRequirements by "description", switch cases by "value", try catches by "error". Identity merging applies at EVERY depth, including an array INSIDE an element (a method\'s params, a step\'s catches). Add "action: \'delete\'" (or "remove: true") alongside that identity to REMOVE an element — including a stale lint allow. Arrays of plain STRINGS (owns, dependsOn, guarantees) carry no per-element identity and are replaced wholesale; pass [] to clear any array outright. To REMOVE an optional field entirely, list it in "unset": e.g. {"unset": ["basePath", "variant"]} — passing null/undefined means "no change" (they are skipped), and writing "" would leave the field present but empty, which is a different and usually wrong spec. Unsetting a required field is refused by schema validation, which names it. For narrative steps, match by "stepNumber" and use "action: \'insert\'" (shifts subsequent steps up) or "action: \'delete\'" (shifts subsequent steps down and removes it). Step entries apply in ASCENDING stepNumber order, each against the numbering the earlier entries of the SAME delta left behind — delete step 3 and step 7 becomes step 6 — so prefer labels, and restate the step\'s "label" or "description" on a delete to have it checked against the step actually addressed. Renumbering RELOCATES every flow jump field (onTrueStep/onFalseStep/cases.step/defaultStep/endStep/catches.step/finallyStep/toStep) in the same narrative. A delete is REJECTED when the narrative has no such step, when a jump still targets it (retarget the referrers first), when a restated label/description does not match, or when it is a loop/try/parallel header whose body would be left standing (retype the header first to dissolve the region, then delete it). Changing a step\'s "type" REBUILDS it for the new type: its description and label are kept and every field the new type cannot carry is dropped (returned as a NOTICE); a delta that retypes AND sets such a field is refused. A step delta is also refused when it carries a marker the merge does not recognise: a non-boolean "remove", an "action" that is neither "insert" nor "delete", a "captureJumps" outside an insert, or no "stepNumber" to address. Inserting AT a jump target relocates those jumps past the inserted step by default (a NOTICE is returned) — add "captureJumps": true on the inserted step to retarget entry jumps onto it (loop/try endStep region tails always relocate with the body and are never captured). Every jump field has a "*Label" twin (toLabel, onFalseLabel, endLabel, …, and "label" on a cases/catches entry) resolved against step labels AFTER the merge, so a delta may anchor on a label only pre-existing steps carry; a label the delta supplies REPLACES the stored number it twins, while setting the number and its label together in one delta is refused as a contradiction. Reference ids in deltas may use LOCAL names — they are qualified against the spec\'s namespace exactly as the loader would. Per-spec lint suppression: set "lint: { allow: [{ code, at, covers, reason }] }" to silence a WARNING code on this spec only (errors always surface; stale allows are flagged). An allow covers EXACTLY the occurrence it names: "at" is the site the finding names (a contract method, an import edge "from -> to", a declared edge "component -> target") and is REQUIRED for a code whose findings report one, while a finding that reports no site is covered only by an allow that names none; "covers" lists the units an aggregating finding reports, and the allow silences it only when every one is listed. This delta is deliberately OPEN below its top level — the shapes nest further than a schema here should restate — so a key that is not a field at its depth is not refused, it is NAMED BACK under NO EFFECT in the answer, together with any value the spec already held and any "unset" that removed nothing. Read that list: it is where a nested typo shows up.'),
        dryRun: z.boolean().optional().describe('Ask what this delta WOULD do instead of doing it. The whole write runs, the candidate gate included, and the answer is the change report it would have produced — marked DRY RUN, with nothing stamped and not one byte of the stored file moved. Use it before a delta that renumbers a long narrative.'),
      },
      outputSchema: specChangeReportOutput,
    },
    ({ kind, id, delta, dryRun }) => {
      try {
        // The change report was ALREADY a structure; only the rendering was
        // prose. Both channels now carry it, from the one report.
        const report = updateSpecGated(kind, id, delta, dryRun);
        return structured(renderChangeReport(report), report);
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
        // runtime require of a relative path resolves against the BUNDLE's
        // directory — where the module does not exist. This report was lazily
        // required from src/commands/status.ts once: it worked from the CLI
        // (whose bundle happened to contain that file) and failed on the HOSTED
        // data plane, where sdd_get_status answered "Cannot find module" instead
        // of the dashboard. The source module moved; the reason it must be bound
        // at the top of the file did not.
        const report = getStatusReport({
          subsystem,
          recursive: recursive ?? true,
        });
        // The text goes out whether or not the tree loaded. A client asking
        // after status most needs to hear that it will NOT load, and unlike
        // the terminal this tool has no exit code to spend on it — so the
        // report's `failed` fact belongs to `wairon status`, and the
        // explanation belongs here.
        // Step 2: which trees this answer spans.
        const family = statusFamilyContext();
        // Step 3: what the lock says about the tree as it stands. An agent
        // reading this tool is deciding whether it may write code against these
        // specs, so a tree that has drifted from its approval is the single most
        // important thing this answer can carry — and silence reads exactly like
        // being current, which is what this tool used to answer.
        const verdict = approvalVerdict();
        return text(`${family}${report.text}${verdict.text}`);
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
  advertiseHostedTools(server, options);

  return server;
}

// ---------------------------------------------------------------------------
// mcp_portal.advertiseHostedTools — ONE method for the sixteen sdd_host_* and
// sdd_landscape_* entries, because publishing a discovery list is one job.
// Execution is intercepted upstream by the hosting request orchestrator, which
// owns their contracts; these registrations exist so an MCP client can FIND the
// tools, and the stub handler only fires outside a hosted request, where they
// are unsupported by design. The local stdio server advertises none of them.
// ---------------------------------------------------------------------------
function advertiseHostedTools(server: McpServer, options: McpServerOptions): void {
  if (options.hostedTools) {
    const hostedStub = (): CallToolResult =>
      errText('This hosted tool is dispatched by the hosting data plane before reaching the MCP server; it is unavailable outside a hosted request.');

    reg<Record<string, never>>(server, 'sdd_host_lock_project', {
      description: 'Hosted project lifecycle (execute-primary): LOCK the bound project (validate-as-complete gate + commit-scoped lock record). Executes directly when your resolved permission is yes and returns the completed outcome; when it is approval, a pending approval request is created instead (await it with sdd_host_await_approval).',
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
    reg<{ allowPartial?: boolean }>(server, 'sdd_host_export_tree', {
      description: 'Hosted spec-tree transfer: pack the BOUND project\'s WHOLE spec tree — its own .wai plus every chained subproject — into a .waitree archive, returned as base64 with its roots, file count and state id. The migration counterpart of an import: use it to take a hosted project local, or to move it to another instance. Requires project:read over the project. Bounded by the data-plane body cap; a very large tree exports through the web download route instead. Refuses when a chained mount cannot be packed (escaping, missing, cyclic, too deep, or holding no .wai), naming every one and why, unless allowPartial is set — then the archive is built anyway and the result lists what was skipped.',
      inputSchema: {
        allowPartial: z.boolean().optional().describe('Build the archive even when some chained mounts cannot be packed, listing them as skipped; default false (refuse and name them)'),
      },
    }, hostedStub);
    reg<{ archiveBase64: string; replaceExisting?: boolean }>(server, 'sdd_host_import_tree', {
      description: 'Hosted spec-tree transfer: REPLACE the BOUND project\'s spec tree from a base64 .waitree archive. Requires project:admin over the project (strictly above project:write — this replaces the whole design, not one spec). Refuses an occupied destination unless replaceExisting is set, always refuses executable entries (rule/code packs install only through the trusted filesystem), and moves the previous tree aside to a backup whose path is returned.',
      inputSchema: {
        archiveBase64: z.string().describe('The .waitree archive bytes, base64-encoded'),
        replaceExisting: z.boolean().optional().describe('Replace a tree already present (backed up first); without it an occupied destination is refused'),
      },
    }, hostedStub);
  }
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
