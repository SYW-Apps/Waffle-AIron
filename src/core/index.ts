import { projectConfigRepository } from '../config/project-config.js';
import type { ProjectConfig } from '../models/project.js';
import type { Domain } from '../models/domain.js';
import * as projector from './domain_projector.js';
import * as curator from './domain_curator.js';

export * from './detection.js';
export * from './templates.js';
export * from './validation.js';
export * from './extensions.js';
export * from './variants.js';
export * from './rules/index.js';
export * from './specs.js';
export * from './provision.js';
export * from './diagram.js';
export * from './lockfile.js';
export * from './statehash.js';
export * from './agent_resolver.js';
export * from './skills.js';
export * from './surfaces.js';
export * from './openapi.js';
export * from './packstore.js';
export * from './treetransfer.js';

// Two components legitimately expose a `loadProjectExtensions`: sdd_core's real
// pack loader (extensions.js) and sdd_skills' thin client adapter onto it
// (skills.js, named for the contract method it realizes). On the PUBLIC core
// surface the loader is the one callers mean — stated explicitly so the star
// exports above are not ambiguous.
export { loadProjectExtensions } from './extensions.js';

// Live delegation-brief composition (icore_portal composeAgentBrief) — a pure
// 1:1 forward to the agent resolver, stated explicitly for the anchored
// conformance check.
export { composeAgentBrief } from './agent_resolver.js';

// Agent FILE generation (icore_portal generateAll / resolveExpectedOutputPaths)
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

// Spec-tree transfer (icore_portal exportSpecTree / importSpecTree) — pure 1:1
// forwards to the tree transfer orchestrator, stated explicitly for the same
// anchored conformance check.
export { exportSpecTree, importSpecTree } from './treetransfer.js';

// The agent topology (icore_portal resolveDomains / addDomain / removeDomain) —
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
// (icore_portal renameComponent / renameMethod / retireSpecialists) — pure 1:1
// forwards to the core orchestrator, stated explicitly for the same anchored
// conformance check.
export { renameComponent, renameMethod } from './provision.js';
export { retireSpecialists } from './stereotype-migration.js';
export type { SpecialistRetirement, SpecialistRetype } from './stereotype-migration.js';
export { repairForeignStepFields } from './narrative-repair.js';
export type { ForeignFieldRepair } from './narrative-repair.js';

// The approval (icore_portal captureApprovedSpecs … movedChildren) — the
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

// Project configuration (icore_portal loadProjectConfig … markSelectionsBundled).
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
export { declaredPackNames, declaredProfileIds } from '../config/project-config.js';

// What an agent's work is LIKE, and what that work earns (icore_portal
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
// that says which build wrote it (icore_portal globalGuideFilePath …
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

// The shared context documents (icore_portal syncContextFiles / hasContext /
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

// The completeness report (icore_portal getStatusReport) — a 1:1 forward to the
// project status, republished by identity rather than wrapped, so the Portal
// method and the Orchestrator function are the same function.
//
// sdd_mcp was importing this out of ../commands/status.js: the MCP server
// reaching into an sdd_cli command file for a report that was never
// CLI-specific, which put sdd_mcp behind sdd_cli for its own status tool. The
// terminal, the MCP server and two test files all want the same report; this is
// where they get it.
export { getStatusReport } from './status.js';
export type { StatusOptions } from './status.js';
