// ---------------------------------------------------------------------------
// surface_portal — sdd_surfaces' published entry point: one-to-one forwards to
// the surface orchestrator's workflows in ./surfaces.ts.
//
// A module of its own so the portal -> orchestrator hop is a real import edge.
// When the portal's methods were the orchestrator's own functions, every
// collaborator those functions reached counted as an undeclared hop of the
// portal. Client adapters import from here, never from ./surfaces.ts.
//
// The family migrations' pin maintenance (renamePin, unpin, listFamilyPins) is
// NOT here: it is pin_maintenance_portal (./pin-maintenance-portal.ts), an
// internal portal published to sdd_migrations only, so this one — published on
// the package's library entry — never offers a pin carried without re-pinning.
// ---------------------------------------------------------------------------
import * as surfaceOrchestrator from './surfaces.js';
// external_declarations: declaring one external is a workflow of its own.
import * as externalDeclarations from './external-declarations.js';
import type { SurfaceDiff, SurfaceExportResult } from './surfaces.js';
import type {
  DesignApproval,
  DesignExport,
  ExternalAddition,
  ExternalConsumer,
  ExternalRemoval,
  ExternalUseChange,
  ExternalUseRequest,
  ExternalRequest,
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

export function pinExternals(aliases?: string[]): ExternalPin[] {
  return surfaceOrchestrator.pinExternals(aliases);
}

/** isurface_portal.getExternalsStatus — each declared external's pin against its live producer; offline, no producer is read over the network. */
export function getExternalsStatus(offline?: boolean): ExternalStatus[] {
  return surfaceOrchestrator.getExternalsStatus(offline);
}

export function listExternals(): ExternalListing[] {
  return surfaceOrchestrator.listExternals();
}

export function listPinnedExternals(): PinnedExternal[] {
  return surfaceOrchestrator.listPinnedExternals();
}

/**
 * isurface_portal.declareExternal — declare one external of the bound project
 * (`wairon externals add`, sdd_add_external): refused in one sentence naming
 * the accepted form, checked against the producer it reaches, pinned when
 * asked. Dispatched to the external-declarations workflow.
 */
export function declareExternal(request: ExternalRequest): ExternalAddition {
  return externalDeclarations.declare(request);
}

/** isurface_portal.pinnedParent — a part's pinned parent, from its own .wai/externals files only (stage 8); null at a project. */
export function pinnedParent(): PinnedParent | null {
  return surfaceOrchestrator.pinnedParent();
}

/** isurface_portal.removeExternal — remove one external of the bound project and its pin (`wairon externals remove`, sdd_remove_external). Dispatched to the external-declarations workflow. */
export function removeExternal(alias: string, dryRun?: boolean): ExternalRemoval {
  return externalDeclarations.remove(alias, dryRun);
}

/** isurface_portal.updateExternalUse — add and remove `use` imports of one declared external (`wairon externals use`, sdd_update_external). Dispatched to the external-declarations workflow. */
export function updateExternalUse(request: ExternalUseRequest): ExternalUseChange {
  return externalDeclarations.updateUse(request);
}

/** isurface_portal.listConsumers — the family projects in reach that consume the bound project, and every project root in the searched folders declaring it as an external (`wairon externals consumers [--search <dir>…]`, sdd_list_consumers). Read-only. */
export function listConsumers(search?: string[]): ExternalConsumer[] {
  return surfaceOrchestrator.listConsumers(search);
}

/** isurface_portal.diffSurface — the bound project's public-surface changelog since its last committed approval, a named revision or a saved snapshot (`wairon surface diff`, sdd_surface_diff). Read-only. */
export function diffSurface(against?: string): SurfaceDiff {
  return surfaceOrchestrator.diff(against);
}
