import * as fs from 'fs';
import * as path from 'path';
import { WAIRON_VERSION } from '../../config/defaults.js';
import type { ReleaseNote } from '../types.js';

// ---------------------------------------------------------------------------
// installed_release_adapter — the installed wairon package's version and its
// bundled release notes.
//
// The notes are one markdown file per release under the package's
// `release-notes/` folder, named by version (`6.1.0.md`); a release's
// highlights are the file's bullet lines, at most a handful. The folder is
// found beside the built code the way the templates are (`dist/cli` and the
// library entry both sit one or two levels under the package root; a packaged
// binary carries it as an asset), and a missing or unreadable folder answers
// no notes.
// ---------------------------------------------------------------------------

/** The most highlights one release carries. */
const MAX_HIGHLIGHTS = 5;

/** Where the package's release-notes folder may be, nearest first. */
function candidateDirs(): string[] {
  return [
    path.resolve(__dirname, '..', '..', 'release-notes'),        // dist/cli -> <package>/release-notes
    path.resolve(__dirname, '..', 'release-notes'),              // dist (library entry)
    path.resolve(__dirname, '..', '..', '..', 'release-notes'),  // src/upgrade/adapters (tsx, ts-jest)
  ];
}

/** A version's [major, minor, patch]; a prerelease suffix is ignored, a missing part reads 0. */
function parts(version: string): number[] {
  const core = version.split(/[-+]/)[0].split('.');
  return [0, 1, 2].map((i) => Number.parseInt(core[i] ?? '0', 10) || 0);
}

/** Whether version a is newer than b. */
function newer(a: string, b: string): boolean {
  const [pa, pb] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] > pb[i];
  return false;
}

/** The notes the markdown files of a folder hold, newest version first. Exported as the test seam. */
export function notesIn(dir: string): ReleaseNote[] {
  let files: string[];
  try {
    files = fs.readdirSync(dir).filter((f) => /^\d+\.\d+\.\d+.*\.md$/.test(f));
  } catch {
    return [];
  }
  const notes: ReleaseNote[] = [];
  for (const file of files) {
    try {
      const text = fs.readFileSync(path.join(dir, file), 'utf-8');
      const highlights = text.split(/\r?\n/)
        .map((l) => /^\s*[-*]\s+(.*\S)\s*$/.exec(l)?.[1])
        .filter((l): l is string => !!l)
        .slice(0, MAX_HIGHLIGHTS);
      notes.push({ version: file.replace(/\.md$/, ''), highlights });
    } catch {
      // An unreadable file is no note.
    }
  }
  return notes.sort((a, b) => (newer(a.version, b.version) ? -1 : newer(b.version, a.version) ? 1 : 0));
}

/** iinstalled_release_adapter.notes — every bundled release note, newest version first. */
export function notes(): ReleaseNote[] {
  const dir = candidateDirs().find((d) => fs.existsSync(d));
  return dir ? notesIn(dir) : [];
}

/** iinstalled_release_adapter.version — the installed package's version. */
export function version(): string {
  return WAIRON_VERSION;
}
