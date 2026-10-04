// ---------------------------------------------------------------------------
// pin_maintenance_portal — sdd_surfaces' internal entry point for the family
// migrations: the pin writes and the stage-1 family-pin read that only a
// planned, all-or-nothing migration performs. Published to sdd_migrations
// only, never on the package's library entry. One-to-one forwards; the caller
// gates on reach itself.
// ---------------------------------------------------------------------------
import * as surfaceOrchestrator from './surfaces.js';
// The two pin writes of the family migrations live beside the externals
// repository they edit (surface_orchestrator's renamePin and unpin).
import * as pinWrites from './externals.js';
import type { FamilyPin } from './surfaces.js';

/** ipin_maintenance_portal.renamePin — carry the bound project's pin of one external to a new alias or producer id, digest unchanged. */
export function renamePin(alias: string, newAlias: string, project: string): boolean {
  return pinWrites.renamePin(alias, newAlias, project);
}

/** ipin_maintenance_portal.unpin — remove the bound project's pin of one alias. */
export function unpin(alias: string): boolean {
  return pinWrites.unpin(alias);
}

/** ipin_maintenance_portal.listFamilyPins — the stage-1 family pins the bound root still holds. */
export function listFamilyPins(): FamilyPin[] {
  return surfaceOrchestrator.listFamilyPins();
}
