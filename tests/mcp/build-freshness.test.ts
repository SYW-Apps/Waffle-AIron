import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { captureBuildStamp, isBuildStale } from '../../src/mcp/server.js';

// ---------------------------------------------------------------------------
// Stale-server guard: a long-running MCP server whose build changed on disk
// must announce itself as stale (its in-memory Zod schemas silently STRIP
// fields newer builds added — this destroyed spec data twice before the guard).
// ---------------------------------------------------------------------------

describe('MCP server build-freshness guard', () => {
  it('a stamped entry file is fresh until it changes on disk, then stale', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-stamp-'));
    try {
      const entry = path.join(dir, 'entry.js');
      fs.writeFileSync(entry, '// build A');

      const stamp = captureBuildStamp(entry);
      expect(stamp).not.toBeNull();
      expect(isBuildStale(stamp)).toBe(false);

      // A rebuild changes size (and mtime); either alone must trip the guard.
      fs.writeFileSync(entry, '// build B — one byte longer');
      expect(isBuildStale(stamp)).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails open (never warns) when the entry cannot be stat\'d — e.g. a pkg snapshot fs', () => {
    expect(captureBuildStamp('/no/such/entry/file.js')).toBeNull();
    expect(isBuildStale(null)).toBe(false);
    // A stamp whose file has since vanished also stays quiet rather than crying wolf.
    expect(isBuildStale({ path: '/no/such/entry/file.js', mtimeMs: 1, size: 1 })).toBe(false);
  });
});
