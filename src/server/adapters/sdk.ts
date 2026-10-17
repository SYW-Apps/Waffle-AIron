import * as sdkPortal from '@wairon/sdk';
import type { PackArchiveInfo, PackExtractionLimits, PackExtractionResult } from '@wairon/sdk';

// ---------------------------------------------------------------------------
// host_sdk_adapter — sdd_host's client hop into sdd_sdk, the published
// @wairon/sdk surface for ZIP (.wpack) packs: read and verify an archive's
// envelope without extracting it (so a code pack is refused before any bytes
// touch disk), and extract one safely under caller-supplied limits.
//
// Forwarding functions rather than identity re-exports: sdd_sdk is a separate
// npm workspace package, and a re-export out of a package leaves this file no
// function body the conformance analysis can read as the method.
// ---------------------------------------------------------------------------

/** host_sdk_adapter.inspectArchive → sdk_portal.inspectArchive. */
export function inspectArchive(archive: Uint8Array): PackArchiveInfo {
  return sdkPortal.inspectArchive(archive);
}

/** host_sdk_adapter.extractArchive → sdk_portal.extractPack, under the given limits. */
export function extractArchive(archive: Uint8Array, destDir: string, limits?: PackExtractionLimits): PackExtractionResult {
  return sdkPortal.extractPack(archive, destDir, limits);
}
