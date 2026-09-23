import * as path from 'path';
import { logger } from '../utils/logger.js';
import { WaironError } from '../utils/errors.js';
import { getProjectRoot } from '../utils/fs.js';
// Every sdd_core call goes through the core portal's barrel, never a core module directly.
import {
  loadSystemSpec as coreLoadSystemSpec,
  createChainedSubsystem as coreCreateChainedSubsystem,
  moveSubsystemProject,
  externalizeSubsystem,
  internalizeSubsystem,
  retireSpecialists as coreRetireSpecialists,
  repairForeignStepFields as coreRepairForeignStepFields,
  composeAgentBrief as coreComposeAgentBrief,
  exportSpecTree as coreExportSpecTree,
  importSpecTree as coreImportSpecTree,
  loadProjectConfig as coreLoadProjectConfig,
  createProjectConfig as coreCreateProjectConfig,
  setExecutionTier as coreSetExecutionTier,
  projectConfigExists as coreProjectConfigExists,
  resolveAgentTopology as coreResolveAgentTopology,
  ensureProjectInitialized as coreEnsureProjectInitialized,
  listDirectChainedSubprojects as coreListDirectChainedSubprojects,
  defaultPackSelections as coreDefaultPackSelections,
  renderDiagram as coreRenderDiagram,
  generateAll as coreGenerateAll,
  resolveExpectedOutputPaths as coreResolveExpectedOutputPaths,
  resolveDomains as coreResolveDomains,
  addDomain as coreAddDomain,
  removeDomain as coreRemoveDomain,
  detectDomainCandidates as coreDetectDomainCandidates,
  deriveExecutionProfile as coreDeriveExecutionProfile,
  resolveBudget as coreResolveBudget,
  globalGuideFilePath as coreGlobalGuideFilePath,
  localGuideFilePath as coreLocalGuideFilePath,
  injectGuide as coreInjectGuide,
  writeRootGuideDelegator as coreWriteRootGuideDelegator,
  reinjectLocalGuides as coreReinjectLocalGuides,
  readStampVersion as coreReadStampVersion,
  syncContextFiles as coreSyncContextFiles,
  hasContext as coreHasContext,
  derivedDocPaths as coreDerivedDocPaths,
  getStatusReport as coreGetStatusReport,
  approvalVerdict as coreApprovalVerdict,
} from '../core/index.js';
import type { ApprovalVerdict, GenerateOptions, GenerateSummary, StatusDecor, StatusOptions, SyncResult } from '../core/index.js';
import { readLockState as coreReadLockState, type LockStatus, type StateId } from '../core/index.js';
import type { ForeignFieldRepair, SpecialistRetirement, TreeExportResult, TreeImportOptions, TreeImportResult } from '../core/index.js';
import type {
  AgentBrief,
  AgentRecord,
  DetectedDomainCandidate,
  Domain,
  PackSelection,
  ProjectConfig,
  SubsystemSpec,
  SystemSpec,
} from '../models/index.js';
// The execution vocabulary is a type spec's, not a component's: shared value
// shapes, so naming them here is vocabulary rather than a reach into sdd_core.
import type { ExecutionBudget, ExecutionConfig, ExecutionProfile } from '../models/execution.js';

// ---------------------------------------------------------------------------
// subsystem command — create/relocate external (chained) subprojects
//
// The AI authors in-tree subsystems through the sdd_* tools; this CLI surface is
// specifically for the *external* case, where a subsystem lives in its own
// sibling wairon project wired by `projectPath`. Both actions delegate to the
// core chained-subsystem helpers so the parent link and the child project stay
// in sync.
// ---------------------------------------------------------------------------

// cli_core_adapter.composeAgentBrief — 1:1 forward of the live delegation-brief
// composition to the core portal; backs `wairon agent brief` and the
// `wairon agent customize` scaffold seed. Composed against the CURRENT spec
// tree on every call (a re-lock changes the next call).
export function composeAgentBrief(agentId: string): AgentBrief {
  return coreComposeAgentBrief(agentId);
}

// cli_core_adapter.exportSpecTree / importSpecTree — 1:1 forwards of the whole
// spec-tree transfer to the core portal, backing `wairon remote push|pull`.
//
// The import deliberately does NOT set the executable-entry guard: a developer
// extracting an archive from an instance they chose to trust is the
// trusted-filesystem tier — the same tier `wairon packs add` installs code packs
// through. Refusing a bundled code pack here would make a hosted project
// unpullable, while the hosted import (which accepts archives from anyone with
// project:admin) always applies it.
export function exportSpecTree(includeDerived?: boolean, allowPartial?: boolean): TreeExportResult {
  return coreExportSpecTree(includeDerived, allowPartial);
}

export function importSpecTree(archive: Uint8Array, options: TreeImportOptions): TreeImportResult {
  return coreImportSpecTree(archive, options);
}

// cli_core_adapter's project configuration methods — 1:1 forwards to the core
// portal, the only way sdd_cli reaches .wai/project.yaml. A read answers null for
// a project without a configuration; every write is an intent the core names.
export function loadProjectConfig(): ProjectConfig | null {
  return coreLoadProjectConfig();
}

export function createProjectConfig(config: ProjectConfig): void {
  coreCreateProjectConfig(config);
}

export function setExecutionTier(tier: string): void {
  coreSetExecutionTier(tier);
}

export function projectConfigExists(): boolean {
  return coreProjectConfigExists();
}

// cli_core_adapter.loadSystemSpec / createChainedSubsystem — 1:1 forwards to the
// core portal: the bound project's system spec, and wiring a chained subsystem in
// the parent together with its scaffolded child project.
export function loadSystemSpec(): SystemSpec | null {
  return coreLoadSystemSpec();
}

export function createChainedSubsystem(subsystem: SubsystemSpec, projectName: string): void {
  coreCreateChainedSubsystem(subsystem, projectName);
}

// cli_core_adapter.resolveAgentTopology — 1:1 forward: the live agent records
// `wairon list`, `show` and `generate` work from; empty without a system spec.
export function resolveAgentTopology(): AgentRecord[] {
  return coreResolveAgentTopology();
}

// cli_core_adapter.ensureProjectInitialized / listDirectChainedSubprojects —
// 1:1 forwards backing `wairon init`'s L0 bootstrap and `wairon generate`'s
// cascade into each direct chained subproject. The bootstrap completes only what
// is missing and reports what it wrote.
export function ensureProjectInitialized(fallbackName: string): { wroteConfig: boolean; wroteSystem: boolean } {
  return coreEnsureProjectInitialized(fallbackName);
}

export function listDirectChainedSubprojects(projectRoot: string): { dir: string; subsystemId: string }[] {
  return coreListDirectChainedSubprojects(projectRoot);
}

// cli_core_adapter.retireSpecialists — 1:1 forward backing `wairon doctor`: the
// migration off the retired Specialist stereotype, planned, and with apply
// written — each Specialist retyped as an Orchestrator with the dependencyClass
// its dependencies decide, and each Specialist-based project variant rebased.
export function retireSpecialists(apply: boolean): SpecialistRetirement {
  return coreRetireSpecialists(apply);
}

// cli_core_adapter.repairForeignStepFields — 1:1 forward backing `wairon doctor`:
// every narrative step carrying a field its own type cannot have, planned, and
// with apply written — the fields dropped, the step otherwise untouched.
export function repairForeignStepFields(apply: boolean): ForeignFieldRepair[] {
  return coreRepairForeignStepFields(apply);
}

// cli_core_adapter.defaultPackSelections — 1:1 forward: the store packs that
// apply by default, seeded into a configuration `wairon init` composes.
export function defaultPackSelections(): PackSelection[] {
  return coreDefaultPackSelections();
}

// cli_core_adapter.readLockState — 1:1 forward: the lock verdict (unlocked,
// locked or stale) against the gate identity the caller computed now through
// the validator adapter.
export function readLockState(current: StateId): LockStatus {
  return coreReadLockState(current);
}

// cli_core_adapter.renderDiagram — 1:1 forward: the spec tree rendered into one
// of the four formats (canvas | mermaid | drawio | excalidraw) and handed back
// as the artifact string, for the command to write wherever it was asked to.
//
// `wairon diagram` used to build the artifact itself, out of ../core/canvas.js,
// ../core/diagram-export.js, ../core/diagram.js and ../core/validation.js — four
// sdd_core modules reached from a command, past the Portal that already publishes
// exactly this call. It is the fourth time that crossing has been found in two
// days (movedChildren, diffSize and settledSpecPaths were the first three), and
// it closes the same way every time: the boundary is crossed HERE, once.
export function renderDiagram(format: string): string {
  return coreRenderDiagram(format);
}

// The rest of the diagram surface `wairon diagram` needs, republished by
// identity rather than wrapped.
//
// These are NOT on icli_core_adapter: the contract names renderDiagram alone,
// because runDiagram's narrative models only the four-format path. The command
// also has --all, --sequence and --subsystem — scopes DiagramOptions models as
// fields while no method takes them — and those need generateDiagramSet,
// generateSequenceDiagram, generateComponentDiagram and the set's index. That
// gap belongs in the spec, and it is reported rather than papered over; what is
// NOT open to interpretation is where the crossing happens, and it happens here,
// on the one component whose whole job is to cross into sdd_core.
//
// buildCanvasDataModel is the model as DATA, the JSON sibling of
// renderDiagram('canvas'): `wairon host demo` counts what it just seeded rather
// than drawing it, and a count is not an artifact.
export {
  generateComponentDiagram,
  generateSequenceDiagram,
  generateDiagramSet,
  diagramSetIndex,
  toMarkdown,
  loadSpecGraph,
  buildCanvasDataModel,
} from '../core/index.js';

// cli_core_adapter.generateAll / resolveExpectedOutputPaths — 1:1 forwards to
// the core portal: write every agent's file for every configured target, and
// say which paths such a run would own without writing any of them.
//
// `wairon generate` used to call both straight out of ../exporters/generate.js
// — sdd_cli reaching into an sdd_core module, past the Portal that publishes
// exactly these two calls. It is the fifth time that crossing has been found in
// two days (movedChildren, diffSize, settledSpecPaths and the four modules
// `wairon diagram` built its artifacts out of were the first four), and it
// closes the way it always does: here, on the one component whose whole job is
// to cross into sdd_core.
export function generateAll(
  agents: AgentRecord[],
  config: ProjectConfig,
  options?: GenerateOptions,
): GenerateSummary[] {
  return coreGenerateAll(agents, config, options);
}

export function resolveExpectedOutputPaths(
  agents: AgentRecord[],
  config: ProjectConfig,
): Set<string> {
  return coreResolveExpectedOutputPaths(agents, config);
}

// cli_core_adapter.resolveDomains / addDomain / removeDomain /
// detectDomainCandidates — 1:1 forwards to the core portal, backing the whole
// `wairon domains` family: read every domain (derived and registered alike),
// register a free-standing one, unregister one, and propose the directories
// nobody has registered yet.
//
// `wairon domains` used to call resolveDomains, addFreeStandingDomain,
// removeFreeStandingDomain and findDomain straight out of ../core/domains.js,
// and detectDomainCandidates out of ../core/detection.js — sdd_cli reaching
// into two sdd_core modules, past the Portal that publishes exactly these
// calls. It is the sixth time that crossing has been found (movedChildren,
// diffSize and settledSpecPaths out of ./approval.js, the four modules `wairon
// diagram` built its artifacts out of, and the generator `wairon generate`
// wrote through were the first five), and it closes the way it always does:
// here, on the one component whose whole job is to cross into sdd_core.
//
// There is no `findDomain` on the contract and none is wanted: a lookup is one
// `resolveDomains().find(…)` at the call site, and publishing a second read
// that answers a subset of the first is how two spellings of "which domains are
// there" start to disagree.
export function resolveDomains(): Domain[] {
  return coreResolveDomains();
}

export function addDomain(domain: Domain): void {
  coreAddDomain(domain);
}

export function removeDomain(id: string): void {
  coreRemoveDomain(id);
}

export function detectDomainCandidates(
  projectRoot: string,
  trackedPaths?: Set<string>,
  trackedIds?: Set<string>,
): DetectedDomainCandidate[] {
  return coreDetectDomainCandidates(projectRoot, trackedPaths, trackedIds);
}

// cli_core_adapter.deriveExecutionProfile / resolveBudget — 1:1 forwards to the
// core portal, backing `wairon execution show`: what an agent's work is like,
// and what that work earns under the project's dial (nothing at all when the
// dial is off).
//
// `wairon execution` used to call them straight out of ../core/execution_profile.js
// and ../core/budget_policy.js, and resolve its topology out of
// ../core/agent_resolver.js — sdd_cli reaching into three sdd_core modules, past
// the Portal that publishes all three calls. It is the seventh time that
// crossing has been found, and it closes the way it always does: here, on the
// one component whose whole job is to cross into sdd_core.
export function deriveExecutionProfile(agent: AgentRecord): ExecutionProfile {
  return coreDeriveExecutionProfile(agent);
}

export function resolveBudget(
  profile: ExecutionProfile,
  config: ExecutionConfig,
  agentId: string,
): ExecutionBudget | undefined {
  return coreResolveBudget(profile, config, agentId);
}

// cli_core_adapter's guide and stamp methods — 1:1 forwards to the core portal,
// backing `wairon init` (write the guides a new project gets), `wairon generate`
// (refresh them, so a guide never goes on describing an older wairon than the
// one installed) and `wairon doctor` (find them, refresh them, and read the
// stamp that says how old they are).
//
// All three used to call straight out of ../utils/ai-guide.js and
// ../core/stamp.js — sdd_cli reaching into two sdd_core modules, past the Portal
// that publishes all six calls. It is the eighth time that crossing has been
// found, and it closes the way it always does: here, on the one component whose
// whole job is to cross into sdd_core.
//
// `wairon generate` reached through a lazy `require` rather than an import,
// which hid the crossing from a reader and would have broken the call outright
// once the CLI is bundled — ../core/context.ts carries the note saying exactly
// that about exactly this form. It is a normal import now.
export function globalGuideFilePath(target: string): string | null {
  return coreGlobalGuideFilePath(target);
}

export function localGuideFilePath(projectRoot: string, target: string): string | null {
  return coreLocalGuideFilePath(projectRoot, target);
}

export function injectGuide(filePath: string, scope: 'global' | 'local'): void {
  coreInjectGuide(filePath, scope);
}

export function writeRootGuideDelegator(projectRoot: string, target: string): void {
  coreWriteRootGuideDelegator(projectRoot, target);
}

export function reinjectLocalGuides(projectRoot: string, targets: string[]): string[] {
  return coreReinjectLocalGuides(projectRoot, targets);
}

export function readStampVersion(content: string): string | null {
  return coreReadStampVersion(content);
}

// cli_core_adapter's context methods — 1:1 forwards to the core portal, backing
// `wairon generate` (ask whether the project has been described, then rebuild
// the derived pair), `wairon init` (seed them) and `wairon doctor` (rebuild them
// under --fix, and ask where they live so the staleness check reports on the
// generated pair and never on the two a person wrote).
//
// All three used to call straight out of ../core/context.js — sdd_cli reaching
// into an sdd_core module, past the Portal that publishes exactly these three
// calls. It is the ninth time that crossing has been found, and it closes the
// way it always does: here, on the one component whose whole job is to cross
// into sdd_core.
//
// `CONTEXT_PATHS` is not forwarded and is not on any contract. `wairon doctor`
// was reaching for two of its entries by name to build its staleness list,
// which is the module's internal layout leaking into a command; `derivedDocPaths`
// answers the question it was actually asking. The layout of `.wai/context/`
// stays stated once, in the store.
export function syncContextFiles(): SyncResult {
  return coreSyncContextFiles();
}

export function hasContext(): boolean {
  return coreHasContext();
}

export function derivedDocPaths(): string[] {
  return coreDerivedDocPaths();
}

// cli_core_adapter.getStatusReport / approvalVerdict — 1:1 forwards to the core
// portal, the two reads `wairon status` is now made of. The dashboard used to
// render the completeness map itself, a second copy of ../core/status.ts that
// differed from it only in a heading, the verdict line and twenty-one chalk
// calls; the verdict was the difference that shipped, because one copy carried
// it and the other did not. The report takes the terminal's colours as
// `StatusDecor` roles, which is why one renderer can serve both readers without
// sdd_core ever learning what a terminal is.
//
// `wairon status` also reached straight into ../core/specs.js for the tree — the
// tenth time that crossing has been found, and it closes the way it always does:
// here, on the one component whose whole job is to cross into sdd_core.
export function getStatusReport(options: StatusOptions, decor?: StatusDecor): string {
  return coreGetStatusReport(options, decor);
}

export function approvalVerdict(): ApprovalVerdict {
  return coreApprovalVerdict();
}

interface SubsystemAddOptions {
  projectPath?: string;
  name?: string;
}

interface SubsystemMoveOptions {
  projectPath?: string;
}

export async function runSubsystemAdd(id: string, options: SubsystemAddOptions = {}): Promise<void> {
  logger.header('wairon subsystem add');

  if (!projectConfigExists()) {
    throw new WaironError('Not inside an initialized wairon project. Run `wairon init` first.');
  }
  if (!options.projectPath) {
    throw new WaironError(
      '--project-path is required (use the sdd_add_subsystem MCP tool for in-tree subsystems).',
    );
  }

  const system = loadSystemSpec();
  if (!system) {
    throw new WaironError('System spec is missing. Run `wairon init` first.');
  }

  const displayName = options.name ?? id;
  const now = new Date().toISOString();
  const subsystem: SubsystemSpec = {
    id,
    name: displayName,
    description: `External subsystem ${displayName}`,
    parentSystem: system.name,
    publicInterfaces: [],
    projectPath: options.projectPath,
    trustedLinks: [],
    status: 'draft',
    createdAt: now,
    updatedAt: now,
  };

  createChainedSubsystem(subsystem, displayName);

  const childDir = path.resolve(getProjectRoot(), options.projectPath);
  logger.success(`Added external subsystem "${id}" → ${options.projectPath}`);
  logger.info(`Scaffolded child project at ${path.relative(process.cwd(), childDir) || '.'}`);
  logger.info(`Design its spec tree from this parent using namespaced ids (e.g. ${id}::<component>).`);
}

export async function runSubsystemMove(id: string, options: SubsystemMoveOptions = {}): Promise<void> {
  logger.header('wairon subsystem move');

  if (!projectConfigExists()) {
    throw new WaironError('Not inside an initialized wairon project.');
  }
  if (!options.projectPath) {
    throw new WaironError('--project-path (the new location) is required.');
  }

  moveSubsystemProject(id, options.projectPath);
  logger.success(`Moved subsystem "${id}" → ${options.projectPath}`);
}

export async function runSubsystemExternalize(id: string, options: SubsystemAddOptions = {}): Promise<void> {
  logger.header('wairon subsystem externalize');

  if (!projectConfigExists()) {
    throw new WaironError('Not inside an initialized wairon project.');
  }
  if (!options.projectPath) {
    throw new WaironError('--project-path (the subproject destination) is required.');
  }

  externalizeSubsystem(id, options.projectPath);

  const childDir = path.resolve(getProjectRoot(), options.projectPath);
  logger.success(`Externalized subsystem "${id}" → ${options.projectPath}`);
  logger.info(`Moved its specs into ${path.relative(process.cwd(), childDir) || '.'} (now a standalone subproject).`);
  logger.info('Move the source code there yourself, then run `wairon validate` to confirm the tree.');
}

export async function runSubsystemInternalize(id: string): Promise<void> {
  logger.header('wairon subsystem internalize');

  if (!projectConfigExists()) {
    throw new WaironError('Not inside an initialized wairon project.');
  }

  internalizeSubsystem(id);
  logger.success(`Internalized subsystem "${id}" back into this project.`);
  logger.info('Its child .wai project was removed. Run `wairon validate` to confirm the tree.');
}
