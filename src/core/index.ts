import { projectConfigRepository } from '../config/project-config.js';
import type { ProjectConfig } from '../models/project.js';
import type { Domain } from '../models/domain.js';
import * as topology from './topology.js';

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
export * from './context.js';
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
// 1:1 forwards to the topology Repository's facade in ./topology.js, which is
// the only thing this Portal knows about the domains.
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
// The facade is bound as a namespace so each call SITE names the contract
// method it reaches — `topology.resolve()`, not a renamed `resolveTopologyDomains()`
// that reads like a second implementation and tells neither a reader nor the
// conformance analysis which method was called.
export function resolveDomains(): Domain[] {
  return topology.resolve();
}

export function addDomain(domain: Domain): void {
  topology.addFreeStanding(domain);
}

export function removeDomain(id: string): void {
  topology.removeFreeStanding(id);
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
} from './approval.js';
export type { ApprovalDiff, ChildPinDrift } from './approval.js';
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
