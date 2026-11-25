import { getLoaderIssues as loaderIssues, scanAllSpecs } from '../../core/index.js';
import type { ValidationIssue } from '../../core/validation.js';

// ---------------------------------------------------------------------------
// upgrade_core_adapter — sdd_upgrade's client hop into sdd_core (and the
// approval identity and the packs from sdd_validator).
//
// Forwards, each at whatever root the caller bound, which during an upgrade is
// the rehearsal copy's: the legacy spec file scan, the format-4 lock record
// write, the project graph, the loader's diagnostics, the per-spec design
// digests, the approval identity, the packs as they resolve and the project
// configuration.
// ---------------------------------------------------------------------------
export {
  findLegacySpecFiles, writeLockRecord, projectFamily, captureApprovedSpecs, loadProjectConfig,
} from '../../core/index.js';
export { computeApprovalId, resolvedPacks, validateProject, listRules } from '../../core/validation.js';

/**
 * iupgrade_core_adapter.getLoaderIssues — the loader's diagnostics for the
 * bound tree. The loader records them as it reads, so the tree is read first:
 * a rehearsal copy nothing has loaded yet would answer none.
 */
export function getLoaderIssues(): ValidationIssue[] {
  scanAllSpecs();
  return loaderIssues();
}
