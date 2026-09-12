export * from './detection.js';
export * from './domains.js';
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

// Spec-tree transfer (icore_portal exportSpecTree / importSpecTree) — pure 1:1
// forwards to the tree transfer orchestrator, stated explicitly for the same
// anchored conformance check.
export { exportSpecTree, importSpecTree } from './treetransfer.js';

// The approval (icore_portal captureApprovedSpecs / currentChildPins) — the
// per-spec digests a lock RECORDS instead of writing statuses into the tree.
// Published on the portal because both the local lock and the hosted admin
// plane (through host_core_adapter) approve through it.
export {
  captureApprovedSpecs,
  currentChildPins,
  approvalRecord,
  diffAgainstApproval,
} from './approval.js';
// Who to record as the approver on a machine with no wairon account — resolved
// through the portal like everything else sdd_cli reaches in sdd_core.
export { localApprover } from './approver.js';
