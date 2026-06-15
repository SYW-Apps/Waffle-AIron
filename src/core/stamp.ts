import { WAIRON_VERSION } from '../config/defaults.js';

// ---------------------------------------------------------------------------
// Version stamp
//
// Generated files (the injected guide, the .wai/context guides, the global
// Antigravity plugin skill) carry a stamp with the wairon version that wrote
// them. `wairon doctor` reads the stamp and warns when a file was produced by
// an older wairon than the one currently installed — i.e. it is stale and
// should be refreshed with `wairon generate`.
// ---------------------------------------------------------------------------

/** An HTML-comment stamp embedding the current wairon version. */
export function versionStamp(): string {
  return `<!-- wairon-version: ${WAIRON_VERSION} -->`;
}

const STAMP_RE = /<!--\s*wairon-version:\s*([^\s]+)\s*-->/;

/** Extract the wairon version stamped in generated content, or null if absent. */
export function readStampVersion(content: string): string | null {
  const m = content.match(STAMP_RE);
  return m ? m[1] : null;
}
