// ---------------------------------------------------------------------------
// validator_core_adapter — sdd_validator's client hop into sdd_core.
//
// Identity re-exports of the core portals, under the adapter's contract names.
// The validator imports THIS module, so every call it makes into core lands
// here and resolves to the portal's function, not to a wrapper in the
// validator's own file.
//
// findChainingParent is the unguarded walk: it answers for any root the caller
// names. The validator gates on the request's reach itself before it calls it.
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
  resolveChainingParent,
  findChainingParent,
  settledSpecPaths,
  readLockRecord,
  getLoaderIssues,
  clearLoaderIssues,
  scanAllSpecs,
  loadProjectVariants,
} from '../index.js';
