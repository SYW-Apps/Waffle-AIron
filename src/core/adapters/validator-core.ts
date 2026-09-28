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
  computeStateId,
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
} from '../index.js';
