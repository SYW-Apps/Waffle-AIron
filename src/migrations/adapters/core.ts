// ---------------------------------------------------------------------------
// migration_core_adapter — sdd_migrations' client hop into sdd_core.
//
// Identity re-exports of the core portals under the adapter's contract names:
// the family graph and export tables, each project's configuration and lock
// record, and the configuration, reference and member writes the verbs make —
// each at whatever project root the caller has bound, which during a rehearsal
// is the rehearsal copy's. The migrations import THIS module, so every call
// they make into core lands here and resolves to the portal's function.
//
// The reads and the verbs' own writes
// (renameId, renameAlias, declareMember, removeMember, repointExternal,
// removeExternal, rewriteReferences, externalizeSubsystem, internalizeMember).
// ---------------------------------------------------------------------------
export {
  // spec_tree_portal: the family graph, the export tables and the specs.
  resolveChainingParent,
  // spec_tree_portal: each owner's spec-tree write lock, held across a commit.
  lockTree,
  unlockTree,
  projectFamily,
  resolveProjectExports,
  resolveSubsystemExports,
  loadSpec,
  // project_config_portal: the configuration and the writes of the verbs.
  loadProjectConfig,
  setId,
  declareExternal,
  importNames,
  // project_config_portal: the verbs' configuration writes.
  renameId,
  renameAlias,
  declareMember,
  removeMember,
  repointExternal,
  removeExternal,
  // approval_portal: a project's lock record, and what moved past it.
  approvalRecord,
  diffAgainstApproval,
  // spec_maintenance_portal: a reference respelled at its parsed position, and
  // a subsystem turned into a member or a member folded back in.
  rewriteReferences,
  externalizeSubsystem,
  internalizeMember,
  // spec_maintenance_portal (stage 8): a part made a project in place, and back.
  promoteMember,
  demoteMember,
} from '../../core/index.js';
