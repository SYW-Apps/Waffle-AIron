// ---------------------------------------------------------------------------
// validator_core_adapter — sdd_validator's client hop into sdd_core.
//
// Identity re-exports of the core portals, under the adapter's contract names.
// The validator imports THIS module, so every call it makes into core lands
// here and resolves to the portal's function, not to a wrapper in the
// validator's own file.
//
// The owner's gate never walks up to a parent, so nothing here climbs.
// ---------------------------------------------------------------------------
export {
  loadSystemSpec,
  loadSubsystemSpecs,
  loadComponentSpecs,
  loadInterfaceSpecs,
  loadImplementationSpecs,
  loadTypeSpecs,
  dryRunSerializeSpecs,
  loadProjectExtensions,
  loadProjectConfig,
  // The bound project's OWN content identity (the gate identity's content
  // half) and another root's lock record (a direct member's, for its
  // composition subject; a member's parent's, for its pin).
  computeOwnStateId,
  approvalRecord,
  consumedContractInputs,
  settledSpecPaths,
  readLockRecord,
  getLoaderIssues,
  clearLoaderIssues,
  scanAllSpecs,
  loadProjectVariants,
  // The resolved export tables the export-tables rule judges.
  resolveSubsystemExports,
  resolveProjectExports,
  // The project graph and the export usages the family rules judge.
  projectFamily,
  exportUsage,
  // The pack loader over a candidate configuration, and one entry's manifest:
  // what the pack impact's dry run and the family's adoption checks read.
  loadExtensionsFor,
  packManifest,
} from '../index.js';
