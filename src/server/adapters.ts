import { computeStateId } from '../core/statehash.js';
import { readLockRecord, writeLockRecord } from '../core/lockfile.js';
import { loadSystemSpec, loadSubsystemSpecs, buildProjectGraph } from '../core/specs.js';
import { provisionProject, promoteAllComplete } from '../core/provision.js';
import { validateAsComplete } from '../core/validation.js';
import { renderDiagram, buildCanvasDataModel } from '../core/diagram.js';
import { loadProjectConfig } from '../config/loader.js';
import { globalPacksDir, discoverPacks, loadExtensionPacks, DeclarativePackSchema } from '../core/extensions.js';
import { createMcpServer } from '../mcp/server.js';
import * as gitPortal from '../git/index.js';
import * as producerPortal from '../producers/index.js';
import * as surfacePortal from '../core/surfaces.js';
import * as sdkPortal from '@wairon/sdk';
import type { PackArchiveInfo, PackExtractionLimits, PackExtractionResult } from '@wairon/sdk';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

// ---------------------------------------------------------------------------
// Host client adapters (sdd_host)
//
// The sanctioned Adapter → remote-Portal hops that let the hosting control and
// data planes reuse sdd_core / sdd_validator / sdd_mcp unchanged, scoped to the
// already-bound project root. Kept intentionally thin (pure forwarding).
// ---------------------------------------------------------------------------

// host_core_adapter → sdd_core (core_portal)
export const hostCore = {
  provisionProject,
  computeStateId,
  readLockRecord,
  writeLockRecord,
  promoteAllComplete,
  renderDiagram,
  // The full CanvasModel as data (the JSON sibling of renderDiagram('canvas')) —
  // consumed by the web app's in-React canvas renderer.
  buildCanvasDataModel,
  // L0/L1 reads used by the landscape plane to project a redacted public-surface
  // snapshot; thin forwarders to the core spec reads (request-scoped root).
  loadSystemSpec,
  loadSubsystemSpecs,
  // Level-of-detail project-tier graph for the web UI, forwarded to core_portal.
  buildProjectGraph,
  // Extension-pack loading forwarded to sdd_core — used by the hosted pack store
  // (pack_registry) and the policy plane's required/default-pack application.
  globalPacksDir,
  discoverPacks,
  loadExtensionPacks,
  /** Validate a parsed manifest as a declarative pack; returns the first error message, or null when valid. */
  checkDeclarativePack: (raw: unknown): string | null => {
    const result = DeclarativePackSchema.safeParse(raw);
    return result.success ? null : (result.error.issues[0]?.message ?? 'shape mismatch');
  },
};

// host_validator_adapter → sdd_validator (validator_portal)
export function validateProjectAsComplete() {
  const config = loadProjectConfig();
  return validateAsComplete({ rules: config.rules, projectType: config.projectType });
}

// host_mcp_adapter → sdd_mcp (mcp_portal): reuse the sdd_* tool surface in-scope,
// with the hosted data-plane tools ADVERTISED for discovery (their execution is
// intercepted by the request orchestrator before reaching the server).
export function createScopedServer(): McpServer {
  return createMcpServer({ hostedTools: true });
}

// host_git_adapter → sdd_git (git_portal). publish forwards the SCOPED subpath
// (default .wai/) so staging never touches a shared repository's own code.
export const hostGit = {
  enable: gitPortal.enable,
  disable: gitPortal.disable,
  sync: gitPortal.sync,
  publish: gitPortal.publish,
  status: gitPortal.status,
  configureSync: gitPortal.configureSync,
};

// host_producer_adapter → sdd_producers (producer_portal)
export const hostProducer = {
  configure: producerPortal.configure,
  produce: producerPortal.produce,
  remove: producerPortal.remove,
  list: producerPortal.list,
};

// host_surfaces_adapter → sdd_surfaces (surface_portal): surface-artifact
// generation against the CURRENTLY BOUND project root (callers bind via
// runWithProjectRoot, exactly like hostCore reads).
export const hostSurfaces = {
  exportBoundSurface: surfacePortal.exportSurface,
};

// host_sdk_adapter → sdd_sdk (sdk_portal): the hosted client edge onto the
// published @wairon/sdk surface for ZIP (.wpack) pack handling. Thin forwarding
// so the pack store never depends on the SDK's internals — inspect the envelope
// (used to reject code packs BEFORE any bytes touch disk) and safely extract a
// .wpack into a destination directory under caller-supplied hosted-strict limits.
export const hostSdk = {
  /** Forward to sdk_portal.inspectArchive — read + verify the envelope without extracting. */
  inspectArchive: (archive: Uint8Array): PackArchiveInfo => sdkPortal.inspectArchive(archive),
  /** Forward to sdk_portal.extractPack — safely extract into destDir under the given limits. */
  extractArchive: (archive: Uint8Array, destDir: string, limits?: PackExtractionLimits): PackExtractionResult =>
    sdkPortal.extractPack(archive, destDir, limits),
};
