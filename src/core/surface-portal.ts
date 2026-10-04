// ---------------------------------------------------------------------------
// surface_portal — sdd_surfaces' published entry point: one-to-one forwards to
// the surface orchestrator's workflows in ./surfaces.ts.
//
// A module of its own so the portal -> orchestrator hop is a real import edge.
// When the portal's methods were the orchestrator's own functions, every
// collaborator those functions reached counted as an undeclared hop of the
// portal. Client adapters import from here, never from ./surfaces.ts.
// ---------------------------------------------------------------------------
import * as surfaceOrchestrator from './surfaces.js';
// The two pin writes of the family migrations live beside the externals
// repository they edit (surface_orchestrator's renamePin and unpin).
import * as pinWrites from './externals.js';
import type { FamilyPin, SurfaceExportResult } from './surfaces.js';
import type {
  DesignApproval,
  DesignExport,
  ExternalListing,
  ExternalPin,
  ExternalStatus,
  PinnedExternal,
  PinnedParent,
  SurfaceOrigin,
  SurfaceSnapshot,
} from '../models/index.js';

export function exportSurface(maxAudience: string, format: string, outPath?: string, portalId?: string): SurfaceExportResult {
  return surfaceOrchestrator.exportSurface(maxAudience, format, outPath, portalId);
}

/**
 * isurface_portal.exportDesign — the bound project's design export, written to
 * outPath when given; the approval is the lock-check state the caller decided
 * (unjudged when omitted). Published on the package's library entry as
 * `exportDesign()`.
 */
export function exportDesign(outPath?: string, approval?: DesignApproval): DesignExport {
  return surfaceOrchestrator.exportDesign(outPath, approval);
}

export function importSurface(sourcePath: string, origin: SurfaceOrigin): SurfaceSnapshot {
  return surfaceOrchestrator.importSurface(sourcePath, origin);
}

export function listSnapshots(): SurfaceSnapshot[] {
  return surfaceOrchestrator.listSnapshots();
}

export function getSnapshot(projectName: string): SurfaceSnapshot | null {
  return surfaceOrchestrator.getSnapshot(projectName);
}

export function removeSnapshot(projectName: string): boolean {
  return surfaceOrchestrator.removeSnapshot(projectName);
}

export function listFamilyPins(): FamilyPin[] {
  return surfaceOrchestrator.listFamilyPins();
}

export function pinExternals(aliases?: string[]): ExternalPin[] {
  return surfaceOrchestrator.pinExternals(aliases);
}

export function getExternalsStatus(): ExternalStatus[] {
  return surfaceOrchestrator.getExternalsStatus();
}

export function listExternals(): ExternalListing[] {
  return surfaceOrchestrator.listExternals();
}

export function listPinnedExternals(): PinnedExternal[] {
  return surfaceOrchestrator.listPinnedExternals();
}

/** isurface_portal.renamePin — carry the bound project's pin of one external to a new alias or producer id, digest unchanged. */
export function renamePin(alias: string, newAlias: string, project: string): boolean {
  return pinWrites.renamePin(alias, newAlias, project);
}

/** isurface_portal.unpin — remove the bound project's pin of one alias. */
export function unpin(alias: string): boolean {
  return pinWrites.unpin(alias);
}

/** isurface_portal.pinnedParent — a part's pinned parent, from its own .wai/externals files only (stage 8); null at a project. */
export function pinnedParent(): PinnedParent | null {
  return surfaceOrchestrator.pinnedParent();
}
