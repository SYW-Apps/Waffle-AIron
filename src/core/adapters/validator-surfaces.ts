// ---------------------------------------------------------------------------
// validator_surfaces_adapter — sdd_validator's client hop into sdd_surfaces.
//
// Identity re-exports of the surface portal: the bound root's own foreign
// surface snapshots and its pinned externals for the owner's gate, and the
// externals status a family run composes from.
// ---------------------------------------------------------------------------
import * as path from 'path';
import { files } from '../../io/index.js';
import { aiDir } from '../../utils/fs.js';
import { parseYaml } from '../../utils/yaml.js';
import type { LockedPack } from '../../models/specs.js';

export { listSnapshots, listPinnedExternals, getExternalsStatus, pinnedParent, unrecordedUses, memberApprovedSurfaces, memberStatuses } from '../surface-portal.js';

/**
 * validator_surfaces_adapter.lockedPacks — the packs the bound root's inputs
 * lock (.wai/inputs.lock.yaml `packs`) records, by name. Absent or unreadable
 * records none.
 *
 * v7 wave 2: sdd_surfaces owns the inputs lock; this seam reads the one `packs`
 * key directly until its repository serves it, and is replaced by an identity
 * re-export of the surface portal's lockedPacks.
 */
export function lockedPacks(): Record<string, LockedPack> {
  try {
    const document = parseYaml(files.readText(path.join(aiDir(), 'inputs.lock.yaml'))) as { packs?: Record<string, LockedPack> } | null;
    return document?.packs && typeof document.packs === 'object' ? document.packs : {};
  } catch {
    return {};
  }
}
