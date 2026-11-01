import { http } from '../io/index.js';

// ---------------------------------------------------------------------------
// HTTP download
//
// Shared by the self-update check (fetch a release binary) and the pack store
// (fetch a .wpack from a selection's recorded source). The download itself is
// io/http's; this stays the name both callers import.
//
// Fetching only ever happens in EXPLICIT commands (`wairon update`,
// `wairon pack install <url>`, `wairon pack sync`). It is never reachable from
// validate/status/generate or an MCP tool call, because "works offline (core)"
// is a stated architectural invariant.
// ---------------------------------------------------------------------------

/** Download `url` to `dest`, following one level of redirect at a time. */
export function downloadFile(url: string, dest: string): Promise<void> {
  return http.download(url, dest);
}
