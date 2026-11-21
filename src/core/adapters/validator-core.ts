// ---------------------------------------------------------------------------
// validator_core_adapter — sdd_validator's client hop into sdd_core.
//
// Identity re-exports of the core portals, under the adapter's contract names.
// The validator imports THIS module, so every call it makes into core lands
// here and resolves to the portal's function, not to a wrapper in the
// validator's own file.
//
// The owner's gate never walks up to a parent; only the derived networking's
// member view reads one (resolveChainingParent), to compose its family.
// ---------------------------------------------------------------------------
export {
  loadSystemSpec,
  loadSubsystemSpecs,
  holdsDesign,
  loadComponentSpecs,
  loadInterfaceSpecs,
  loadImplementationSpecs,
  loadTypeSpecs,
  // The type group tree the type-groups rule judges.
  loadGroupSpecs,
  dryRunSerializeSpecs,
  loadProjectExtensions,
  loadProjectConfig,
  // The bound project's OWN design identity — the design half of the
  // approval identity.
  computeOwnDesignId,
  // The own spec files that moved since the approval.
  diffAgainstApproval,
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
  // The bound root's chaining parent: read by the derived networking alone,
  // to compose a member's view from its enclosing family (the owner's gate
  // itself never climbs).
  resolveChainingParent,
  exportUsage,
  // What the scan's signature resolution recorded, and the resolution itself
  // for specs read outside the scan (a part's pinned parent excerpt).
  signatureFacts,
  resolveSignatures,
  // What the scan's type canonicalisation recorded: the stored aliases and
  // the positions that are not canonical.
  typeSpellingFacts,
  // The pack loader over a candidate configuration, and one entry's manifest:
  // what the pack impact's dry run and the family's adoption checks read.
  loadExtensionsFor,
  packManifest,
} from '../index.js';
