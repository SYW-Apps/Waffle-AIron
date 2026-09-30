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
// Stage 6 wave A ships the reads and the writes the chaining migration makes;
// the verbs' own writes (renameId, renameAlias, declareMember, removeMember,
// repointExternal, removeExternal, rewriteReferences, externalizeSubsystem,
// internalizeMember) join with the verbs in wave B.
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
  // approval_portal: a project's lock record.
  approvalRecord,
  // spec_maintenance_portal: a legacy mount moved into `members`, and a spec's
  // references written in their canonical form.
  moveMountToMembers,
  normalizeReferences,
} from '../../core/index.js';
