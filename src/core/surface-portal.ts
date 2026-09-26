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
import type { ExternalSurfaceEntry, SurfaceExportResult } from './surfaces.js';
import type {
  ExternalListing,
  ExternalPin,
  ExternalStatus,
  SurfaceOrigin,
  SurfaceSnapshot,
} from '../models/index.js';

export function exportSurface(maxAudience: string, format: string, outPath?: string, portalId?: string): SurfaceExportResult {
  return surfaceOrchestrator.exportSurface(maxAudience, format, outPath, portalId);
}

export function importSurface(sourcePath: string, origin: SurfaceOrigin): SurfaceSnapshot {
  return surfaceOrchestrator.importSurface(sourcePath, origin);
}

export function listSnapshots(rootDir?: string): SurfaceSnapshot[] {
  return surfaceOrchestrator.listSnapshots(rootDir);
}

export function getSnapshot(projectName: string, rootDir?: string): SurfaceSnapshot | null {
  return surfaceOrchestrator.getSnapshot(projectName, rootDir);
}

export function removeSnapshot(projectName: string, rootDir?: string): boolean {
  return surfaceOrchestrator.removeSnapshot(projectName, rootDir);
}

export function listExternalInterfaces(): ExternalSurfaceEntry[] {
  return surfaceOrchestrator.listExternalInterfaces();
}

export function listMountSnapshots(mounts: string[]): { namespace: string; snapshots: SurfaceSnapshot[] }[] {
  return surfaceOrchestrator.listMountSnapshots(mounts);
}

export function pinFamilySurfaces(): string[] | null {
  return surfaceOrchestrator.pinFamilySurfaces();
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
