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
// The reads, the chaining migration's writes, and the verbs' own writes
// (renameId, renameAlias, declareMember, removeMember, repointExternal,
// removeExternal, rewriteReferences, externalizeSubsystem, internalizeMember).
// ---------------------------------------------------------------------------
export {
  // spec_tree_portal: the family graph, the export tables and the specs.
  resolveChainingParent,
  projectFamily,
  resolveProjectExports,
  resolveSubsystemExports,
  exportUsage,
  loadSpec,
  loadTypeSpecs,
  // project_config_portal: the configuration and its chaining-migration writes.
  loadProjectConfig,
  projectConfigExists,
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
  // approval_portal: a project's lock record.
  approvalRecord,
  // spec_maintenance_portal: a legacy mount moved into `members`, and a spec's
  // references written in their canonical form.
  moveMountToMembers,
  normalizeReferences,
  // spec_maintenance_portal: a reference respelled at its parsed position, and
  // a subsystem turned into a member or a member folded back in.
  rewriteReferences,
  externalizeSubsystem,
  internalizeMember,
  // spec_maintenance_portal (stage 8): a member's declaration changed — the
  // chaining migration's rewrite of a deprecated long-form `path`.
  updateMember,
  // spec_maintenance_portal (stage 8): a part made a project in place, and back.
  promoteMember,
  demoteMember,
} from '../../core/index.js';
