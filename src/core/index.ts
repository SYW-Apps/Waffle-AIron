import { projectConfigRepository } from '../config/project-config.js';
import type { ProjectConfig } from '../models/project.js';
import type { Domain } from '../models/domain.js';
import * as projector from './domain_projector.js';
import * as curator from './domain_curator.js';

// ---------------------------------------------------------------------------
// What these Portals publish — and nothing else.
//
// This one file realizes seven capability portals (N:1): spec_tree_portal,
// spec_store_portal, spec_maintenance_portal, approval_portal,
// project_config_portal, extension_portal and agent_context_portal. Every
// runtime name below is declared on one of their contracts, or is the shared
// rule vocabulary, or is one of the reported exceptions named where it is
// exported.
//
// This file used to carry seventeen `export * from` lines. Sixteen of them
// republished modules realizing 39 components: 240 runtime names on a surface
// whose contract names 97 methods, and 438 on `@wairon/cli`, which re-exports
// this file. A star export says nothing about which of a module's functions
// the Portal means, so every consumer could reach any member and bypass the
// facade — which is why the sdd_cli→sdd_core crossings the comments below
// record kept reappearing one symbol at a time. Each one was closed by naming a
// single forward; the hole they kept coming through was this block.
//
// Every forward here is an IDENTITY re-export — `export { foo } from './bar.js'`
// — never a wrapper. The Portal method and the component's function are the
// same function, which is what lets the conformance analysis resolve the call
// by identity instead of reading a second implementation.
//
// The rule barrel is the one star that stays: ./rules/index.js realizes no
// component. It is sdd_validator's shared vocabulary — rule types, the context
// builder, the registry — imported through here by 93 modules, with no contract
// for it to overshoot.
export * from './rules/index.js';

// The spec tree itself — 1:1 forwards to the core orchestrator, which owns
// every read and every write of a spec file. Published because sdd_cli, sdd_mcp
// and sdd_host all read through these Portals and none of them may import
// ../core/specs.js.
//
// spec_tree_portal: every read of the tree (loadSystemSpec … specPathsInScope).
// spec_store_portal: the raw, UNGATED writes — saveSpec, deleteSpec,
// updateSpec, moveMethods and, below, createChainedSubsystem — published to
// the authoring seam alone, which gates every authored write before it lands
// here. The typed save*/delete* writes are not on any contract any more:
// after the seam took every authored write nothing called them through a
// Portal, so they stay core's own internals.
export {
  loadSystemSpec,
  loadSubsystemSpecs,
  loadSubsystemSpec,
  loadComponentSpecs,
  loadComponentSpec,
  loadInterfaceSpecs,
  loadInterfaceSpec,
  loadImplementationSpecs,
  loadImplementationSpec,
  loadTypeSpecs,
  loadTypeSpec,
  // Kind-generic access (spec_tree_portal loadSpec; spec_store_portal
  // saveSpec / deleteSpec / updateSpec / moveMethods), for a caller that holds
  // the kind as data — the authoring seam above all.
  loadSpec,
  saveSpec,
  deleteSpec,
  updateSpec,
  moveMethods,
  dryRunSerializeSpecs,
  specPathsInScope,
  consumedContractInputs,
  buildProjectGraph,
  resolveChainingParent,
  resolveSubprojectForNamespace,
  computeStateIdAt,
  readLockState,
  // The loader's own reads (spec_tree_portal scanAllSpecs / getLoaderIssues /
  // clearLoaderIssues): the index relating each spec to its file, and the
  // diagnostics a read of the tree recorded. The validator needs both to run.
  scanAllSpecs,
  getLoaderIssues,
  clearLoaderIssues,
  // spec_tree_portal findChainingParent: the walk up from a root the caller
  // names. Not gated on any request's reach — resolveChainingParent above is —
  // so a caller gates on its own reach before it calls this one.
  findChainingParent,
  // spec_tree_portal assertContainedProjectPath: a mount's projectPath resolved
  // within its root.
  assertContainedProjectPath,
  // spec_maintenance_portal findLegacySpecFiles: what `doctor` and `validate`
  // report before a migration.
  findLegacySpecFiles,
} from './specs.js';
export type { LockStatus, SpecIndex, SpecScanOptions, LegacySpecFile } from './specs.js';

// Project provisioning and the chained-subproject wiring
// (spec_maintenance_portal provisionProject … internalizeSubsystem;
// spec_tree_portal listDirectChainedSubprojects; spec_store_portal
// createChainedSubsystem, the seam's raw write) — 1:1 forwards to the core
// orchestrator. `wairon init` and `wairon subsystem` are sdd_cli commands and
// the scaffolding is sdd_core's, so the boundary is crossed here.
export {
  provisionProject,
  ensureProjectInitialized,
  listDirectChainedSubprojects,
  createChainedSubsystem,
  moveSubsystemProject,
  externalizeSubsystem,
  internalizeSubsystem,
  // spec_maintenance_portal findChainingSubprojectsMissingConfig /
  // backfillChainedSubprojectConfigs: what `wairon doctor` reports and repairs.
  findChainingSubprojectsMissingConfig,
  backfillChainedSubprojectConfigs,
} from './provision.js';

// The tree's identity (approval_portal computeStateId) — what a lock is taken
// against, and what a staleness check compares to.
export { computeStateId } from './statehash.js';
export type { StateId } from './statehash.js';

// The lock record itself (approval_portal readLockRecord / writeLockRecord).
// `wairon lock` writes one and `wairon status` reads one; neither is allowed to
// know where the file lives.
export { readLockRecord, writeLockRecord } from './lockfile.js';
export type { LockRecord } from './lockfile.js';

// The rendered architecture diagram (spec_tree_portal renderDiagram) — one string
// for `wairon diagram`, which is the only thing that command needs from the
// four core modules it used to build its artifacts out of.
export { renderDiagram } from './diagram.js';

// The same canvas as data (spec_tree_portal buildCanvasDataModel), for a client
// that mounts the shared renderer itself — the hosted web app and share
// snapshots.
export { buildCanvasDataModel } from './diagram.js';

// THE REST OF THE DIAGRAM SURFACE — NOT contract methods, and reported as a
// gap rather than papered over.
//
// `ispec_tree_portal` names `renderDiagram`; `iarchitecture_diagrams` names `render`
// and `buildGraphModel`. These seven are none of those, and no spec anywhere
// names them — yet `wairon diagram --all|--sequence|--subsystem` and
// `wairon host demo` are built out of them, and cli_core_adapter depends on
// core's portals alone, so this barrel is the only route that does not make
// sdd_cli import an sdd_core module.
//
// They are published here under their own heading, separate from the contract
// above, so the gap is legible instead of hiding inside a star export: the
// honest fix is to model them (on this contract or on a diagram portal of their
// own), not to keep the star that concealed that they were never designed. The
// barrel-surface test carries this list as a shrink-only ratchet — a new name
// cannot join it without a spec.
export {
  generateComponentDiagram,
  generateSequenceDiagram,
  generateDiagramSet,
  diagramSetIndex,
  toMarkdown,
  loadSpecGraph,
} from './diagram.js';

// Domain detection (agent_context_portal detectDomainCandidates) — the detector is its
// own component, published by identity rather than wrapped. It proposes
// candidates and never registers one; the registration lives with the curator
// below.
export { detectDomainCandidates } from './detection.js';

// The extension packs governing this project (extension_portal
// loadProjectExtensions … uninstallPack) — 1:1 forwards to the extension
// orchestrator, which fronts the pack store so no consumer has to know its
// layout. Two components legitimately expose a `loadProjectExtensions`:
// sdd_core's real pack loader (extensions.js) and sdd_skills' thin client
// adapter onto it (skills.js, named for the contract method it realizes). On
// the PUBLIC core surface the loader is the one callers mean.
//
// The two WRITES are why the forwards come from the orchestrator and not from
// ../core/packstore.js: installing and removing a pack is an effect, and a
// Portal that reached the store adapter for it would be taking the persistence
// shortcut the standard names by code. `wairon packs` goes through here.
export { loadProjectExtensions, defaultPackSelections } from './extensions.js';

// The pack sources and entries (extension_portal globalPacksDir …
// pinInstalledPacksAsSelections): where machine-wide packs live, what a
// directory holds, a pack loaded on its own, a manifest judged as declarative,
// what a configured entry resolves to and is called, and the doctor's pack
// diagnosis and its one repair. The sdd_cli pack commands, `wairon doctor` and
// sdd_host's pack plane all read these; before, each imported them straight out
// of ./extensions.js.
export {
  globalPacksDir,
  discoverPacks,
  packDirEntry,
  loadExtensionPacks,
  checkDeclarativePack,
  packEntryRef,
  packEntryLabel,
  globalPacksEnabled,
  diagnoseProjectPacks,
  pinInstalledPacksAsSelections,
} from './extensions.js';
export type { LoadedExtensions, LoadedPackSkill, PackRef, PackScope, PackDiagnosis } from './extensions.js';

// The component-variant registry (extension_portal loadProjectVariants /
// resolveVariantGuidance): the variant rules judge against it, and the MCP
// server attaches a component's guidance to its spec.
export { loadProjectVariants, resolveVariantGuidance } from './variants.js';

// The machine's pack store (extension_portal packStoreDir … uninstallPack) —
// forwarded from the module that HOLDS them, which is the store adapter. The
// extension orchestrator binds the same five functions (see ./extensions.js)
// and publishes the two writes, so this Portal method, the orchestrator's
// method and the store's function are one function under three names — the
// identity the forward is worth having.
export {
  packStoreDir,
  listInstalledPacks,
  resolveInstalledPack,
  installPackFromDirectory,
  uninstallPack,
} from './packstore.js';
export type { InstalledPack } from './packstore.js';

// The agent topology as the spec tree and the registry describe it (agent_context_portal
// composeAgentBrief / resolveAgentTopology / loadRegistry) — 1:1 forwards to the
// agent resolver. The brief is composed against the CURRENT tree on every call,
// which is why nothing here caches it.
export { composeAgentBrief, resolveAgentTopology, loadRegistry } from './agent_resolver.js';

// Agent FILE generation (agent_context_portal generateAll / resolveExpectedOutputPaths)
// — pure 1:1 forwards to the agent file generator, published here because
// `wairon generate` is an sdd_cli command and the generator is an sdd_core
// component: the command importing ../exporters/generate.js directly is exactly
// the crossing this Portal exists to prevent. That reach has now been found
// five times in two days — movedChildren, diffSize and settledSpecPaths out of
// ./approval.js, and the four core modules `wairon diagram` was building its
// artifacts out of, were the first four — and it closes the same way every
// time: the boundary is crossed HERE, once, by identity.
//
// The path enumeration is published beside the write for the reason the
// contract separates them: `generate` needs to know which files it owns before
// it decides to render anything, and a caller that can be handed a summary from
// here must be able to ask for the paths from here, or it is back to importing
// the module.
export { generateAll, resolveExpectedOutputPaths } from '../exporters/generate.js';
export type { GenerateOptions, GenerateSummary } from '../exporters/generate.js';

// Spec-tree transfer (spec_tree_portal exportSpecTree / spec_maintenance_portal importSpecTree) — pure 1:1
// forwards to the tree transfer orchestrator, stated explicitly for the same
// anchored conformance check.
export { exportSpecTree, importSpecTree } from './treetransfer.js';
export type { TreeExportResult, TreeImportOptions, TreeImportResult } from './treetransfer.js';

// The agent topology (agent_context_portal resolveDomains / addDomain / removeDomain) —
// 1:1 forwards to the two Orchestrators above the topology Repository, which is
// all this Portal knows about the domains. The READ goes to `domain_projector`,
// which answers across the spec tree and the configuration alike; both WRITES
// go to `domain_curator`, never to the facade, because a Portal reaching a
// write-effect facade method is the shortcut the standard names by code.
//
// This file used to `export * from './domains.js'`, republishing the whole raw
// surface of a member — `findDomain`, `listFreeStandingDomains`,
// `deriveSubsystemDomains` and the two mutators — from a Portal that names four
// domain operations on its contract. A star export says nothing about which of
// those the Portal means, and it let every consumer keep depending on the
// member rather than on the facade, which is the difference between a
// Repository and two modules with a label. `detectDomainCandidates` stays a
// star export from ./detection.js: the detector is its own component, published
// by identity rather than wrapped.
//
// Each collaborator is bound as a namespace so the call SITE names the contract
// method it reaches — `curator.registerDomain(…)`, not a renamed
// `addTopologyDomain()` that reads like a second implementation and tells
// neither a reader nor the conformance analysis which method was called.
export function resolveDomains(): Domain[] {
  return projector.resolveDomains();
}

export function addDomain(domain: Domain): void {
  curator.registerDomain(domain);
}

export function removeDomain(id: string): void {
  curator.unregisterDomain(id);
}

// Component rename, contract-method rename and Specialist retirement
// (spec_maintenance_portal renameComponent / renameMethod / retireSpecialists) — pure 1:1
// forwards to the core orchestrator, stated explicitly for the same anchored
// conformance check.
export { renameComponent, renameMethod } from './provision.js';
export type { ComponentRename, MethodRename } from './provision.js';
export { retireSpecialists } from './stereotype-migration.js';
export type { SpecialistRetirement, SpecialistRetype } from './stereotype-migration.js';
export { repairForeignStepFields } from './narrative-repair.js';
export type { ForeignFieldRepair } from './narrative-repair.js';

// The approval (approval_portal captureApprovedSpecs … movedChildren) — the
// per-spec digests a lock RECORDS instead of writing statuses into the tree.
// Published on the portal because both the local lock and the hosted admin
// plane (through host_core_adapter) approve through it.
//
// `movedChildren` is here for exactly that reason: `wairon lock` and `wairon
// status` were importing it — and `diffSize` — straight out of ./approval.js,
// which is sdd_cli reaching past this Portal into another subsystem's module.
// The comment above already said where they belonged; the imports had just
// never been moved.
//
// `diffSize` is not a Portal method and is not claimed as one: it is the
// `ApprovalDiff` value object's own arithmetic, realized as a free function
// over the value. It ships beside the type because a method travels with its
// type — a caller that can receive an `ApprovalDiff` from here must be able to
// count one from here, or it is back to importing the module.
export {
  captureApprovedSpecs,
  currentChildPins,
  approvalRecord,
  diffAgainstApproval,
  movedChildren,
  diffSize,
  // The validator needs it to tell an approved spec from an unapproved one, and
  // was importing it straight from ./approval.js - the same reach past this
  // Portal that movedChildren and diffSize were making.
  settledSpecPaths,
  // What the lock says about the tree as it stands. Republished by IDENTITY,
  // like getStatusReport below: the Portal method and the Orchestrator function
  // are the same function. Every presenter needs the same answer — the terminal,
  // the MCP status tool, anything else — and `wairon status` used to keep a
  // private copy of it, which is how sdd_get_status came to say nothing at all
  // about a tree that had drifted from its approval.
  approvalVerdict,
} from './approval.js';
export type { ApprovalDiff, ChildPinDrift, ApprovalVerdict } from './approval.js';
// Who to record as the approver on a machine with no wairon account — resolved
// through the portal like everything else sdd_cli reaches in sdd_core.
export { localApprover } from './approver.js';

// Project configuration (project_config_portal loadProjectConfig … markSelectionsBundled).
// Reads go straight through the project config Repository. Writes are routed
// through the core orchestrator (specs.js), which writes through the Repository.
// No other subsystem reaches .wai/project.yaml any other way.

/** The bound project's configuration, or null when it has none. */
export function loadProjectConfig(): ProjectConfig | null {
  return projectConfigRepository.load();
}

/** Whether the bound project has a configuration file. */
export function projectConfigExists(): boolean {
  return projectConfigRepository.exists();
}

/** Whether the bound project's configuration sets `extensions.useGlobalPacks` explicitly. */
export function declaresGlobalPacks(): boolean {
  return projectConfigRepository.declaresGlobalPacks();
}

export {
  createProjectConfig,
  upsertPackSelection,
  removePackSelection,
  registerPackRef,
  deregisterPackRef,
  markSelectionsBundled,
  setProjectType,
  recordProfileSelection,
  setExecutionTier,
} from './specs.js';

// The project_config type's own behaviour, for callers deriving from a loaded configuration.
export { declaredPackNames, declaredProfileIds } from '../models/project.js';

// What an agent's work is LIKE, and what that work earns (agent_context_portal
// deriveExecutionProfile / resolveBudget) — pure 1:1 forwards to the execution
// profiler and the budget policy, republished by identity rather than wrapped,
// so this Portal method and the Orchestrator's function are the same function.
//
// Published because `wairon execution show` is an sdd_cli command while both
// derivations are sdd_core components: the command importing
// ../core/execution_profile.js and ../core/budget_policy.js directly is
// exactly the crossing this Portal exists to prevent. That reach has now been
// found seven times — movedChildren, diffSize and settledSpecPaths out of
// ./approval.js, the four modules `wairon diagram` built its artifacts out of,
// the generator `wairon generate` wrote through, and the two domain modules
// `wairon domains` read — and it closes the way it always does: the boundary
// is crossed HERE, once.
//
// The two stay separate methods because they answer separate questions: the
// profile describes the work and names no model, tool or host, and the budget
// maps that shape onto an allowance. A caller that only wants to SAY what an
// agent's work is like should not have to resolve a budget to find out.
export { deriveExecutionProfile } from './execution_profile.js';
export { resolveBudget } from './budget_policy.js';

// The guide wairon writes into another tool's configuration file, and the stamp
// that says which build wrote it (agent_context_portal globalGuideFilePath …
// readStampVersion) — pure 1:1 forwards to the tool guide and the version
// stamp, republished by identity rather than wrapped, so each Portal method and
// the function behind it are the same function.
//
// Published because `wairon init`, `wairon generate` and `wairon doctor` are
// sdd_cli commands while the guide and the stamp are sdd_core components: those
// three importing ../utils/ai-guide.js and ../core/stamp.js directly is exactly
// the crossing this Portal exists to prevent. That reach has now been found
// eight times — movedChildren, diffSize and settledSpecPaths out of
// ./approval.js, the four modules `wairon diagram` built its artifacts out of,
// the generator `wairon generate` wrote through, the two domain modules `wairon
// domains` read, and the two derivations `wairon execution` resolved were the
// first seven — and it closes the way it always does: the boundary is crossed
// HERE, once.
//
// `stripGuideSection` stays unpublished on purpose. It is the guide's own
// internal seam — inject strips before it appends, which is what makes
// injection idempotent — and no command outside sdd_core has ever needed to
// take a section out without putting one back. A Portal that republished it
// would be offering a half-write nobody asked for.
export {
  globalGuideFilePath,
  localGuideFilePath,
  injectGuide,
  writeRootGuideDelegator,
  reinjectLocalGuides,
} from '../utils/ai-guide.js';
export { readStampVersion } from './stamp.js';

// The shared context documents (agent_context_portal syncContextFiles / hasContext /
// derivedDocPaths) — 1:1 forwards to the context composer, republished by
// identity rather than wrapped, so each Portal method and the Orchestrator's
// function are the same function.
//
// This file used to `export * from './context.js'`, republishing a whole
// module — `contextDir`, `CONTEXT_PATHS`, both renderers and both human-file
// readers — from a Portal whose contract names three context operations. It is
// the same thing the `export * from './domains.js'` above it was: a star export
// says nothing about which of those the Portal means, and it lets a consumer
// keep depending on the module rather than on the facade. Three commands were
// doing exactly that, importing ../core/context.js straight out of sdd_cli.
//
// Only the derived PAIR is published. There is no write for the two documents a
// person writes, here or anywhere: nothing in wairon should be able to
// overwrite what somebody wrote about their own system, and the two functions
// that could (`writeProjectContext`, `writeArchitectureContext`) are gone
// rather than merely unpublished.
export { syncContextFiles, hasContext, derivedDocPaths } from './context.js';
export type { SyncResult } from './context.js';

// The completeness report (spec_tree_portal getStatusReport) — a 1:1 forward to the
// project status, republished by identity rather than wrapped, so the Portal
// method and the Orchestrator function are the same function.
//
// sdd_mcp was importing this out of ../commands/status.js: the MCP server
// reaching into an sdd_cli command file for a report that was never
// CLI-specific, which put sdd_mcp behind sdd_cli for its own status tool. The
// terminal, the MCP server and two test files all want the same report; this is
// where they get it.
//
// `StatusDecor` rides the same forward because it is how a caller asks for the
// report to be marked up: `wairon status` passes chalk in through it, and that
// is the whole of what the terminal dashboard now does. It is a vocabulary of
// ROLES, not colours, so the renderer behind this never learns what a terminal
// is — which is the only reason one renderer can serve both readers.
//
// `StatusReport` rides it for the opposite reason: the report answers a FACT
// beside the text — whether the tree could be read at all — and a presenter
// that cannot see that fact has to recognise the prose instead. `wairon status`
// did not, so it exited 0 over a tree that would not parse.
export { getStatusReport } from './status.js';
export type { StatusDecor, StatusOptions, StatusReport } from './status.js';
