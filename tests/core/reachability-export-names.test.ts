import { describe, expect, it, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runInV5Reading, setProjectRoot } from '../../src/utils/fs.js';
import { getLoaderIssues, invalidateSpecCache, loadSystemSpec } from '../../src/core/specs.js';
import { migrate } from '../../src/core/reachability-migration.js';
import { readYamlFile, writeYamlFile } from '../../src/utils/yaml.js';
import { v5FormsIn } from '../../src/models/specs.js';

// ---------------------------------------------------------------------------
// An L0 export entry's wairon 5 names: `id` (now `as`) and `subsystem` (now
// `from`). wairon 6 reads `as` and `from`; the loader refuses an entry holding
// the old names outside the v5 reading, and `wairon upgrade` (the reachability
// migration) rewrites them.
// ---------------------------------------------------------------------------

const now = '2026-10-19T00:00:00.000Z';
let proj: string | undefined;

afterEach(() => {
  setProjectRoot(null);
  invalidateSpecCache();
  try { if (proj) fs.rmSync(proj, { recursive: true, force: true }); } catch { /* windows locks */ }
  proj = undefined;
});

const ENTRIES = [
  { id: 'payments-api', subsystem: 'shop', component: 'web', details: 'old names', audience: 'external' },
  { id: 'ignored-name', as: 'kept-name', subsystem: 'ignored-source', from: 'shop', component: 'web2', details: 'both stated' },
  { as: 'plain', from: 'shop', component: 'web3', details: 'already current' },
];

/** A project root whose L0 export table is written in the wairon 5 names. */
function oldProject(): string {
  proj = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-export-names-'));
  writeYamlFile(path.join(proj, '.wai', 'project.yaml'), {
    schemaVersion: '1.0.0', name: 'shop', targets: [], rules: {}, extensions: { packs: [], useGlobalPacks: false }, createdAt: now, updatedAt: now,
  });
  writeYamlFile(path.join(proj, '.wai', 'specs', '.index.yaml'), {
    schemaVersion: '1.0.0', name: 'Shop', vision: 'sells things', boundaries: [], globalRequirements: [],
    publicInterfaces: ENTRIES, createdAt: now, updatedAt: now,
  });
  setProjectRoot(proj);
  invalidateSpecCache();
  return proj;
}

const storedEntries = (root: string): Record<string, unknown>[] =>
  (readYamlFile(path.join(root, '.wai', 'specs', '.index.yaml')) as { publicInterfaces: Record<string, unknown>[] }).publicInterfaces;

describe('the pure reader names the L0 forms', () => {
  it('reports id and subsystem of a system entry, and only for the system', () => {
    const forms = v5FormsIn('system', { publicInterfaces: [{ id: 'a', subsystem: 's', component: 'c' }] });
    expect(forms).toEqual([
      'an L0 export entry\'s `id` is a wairon 5 form; wairon 6 reads `as`',
      'an L0 export entry\'s `subsystem` is a wairon 5 form; wairon 6 reads `from`',
    ]);
    expect(v5FormsIn('system', { publicInterfaces: [{ as: 'a', from: 's', component: 'c' }] })).toEqual([]);
    expect(v5FormsIn('subsystem', { publicInterfaces: [{ id: 'a', subsystem: 's', component: 'c' }] })).toEqual([]);
  });
});

describe('the loader fences the L0 export names', () => {
  it('refuses an L0 holding id or subsystem outside the v5 reading, naming as and from', () => {
    oldProject();
    expect(loadSystemSpec()).toBeNull();
    const issues = getLoaderIssues().map((i) => i.message).join('\n');
    expect(issues).toContain('an L0 export entry\'s `id` is a wairon 5 form; wairon 6 reads `as`');
    expect(issues).toContain('an L0 export entry\'s `subsystem` is a wairon 5 form; wairon 6 reads `from`');
  });

  it('reads them in the v5 reading', () => {
    oldProject();
    runInV5Reading(() => {
      invalidateSpecCache();
      expect(loadSystemSpec()).not.toBeNull();
    });
  });
});

describe('the reachability migration rewrites the L0 export names', () => {
  it('plans id as as and subsystem as from, writes nothing without apply, and the new name wins when both are stated', () => {
    const root = oldProject();
    const before = JSON.stringify(storedEntries(root));
    const plan = runInV5Reading(() => migrate(false));
    expect(plan.applied).toBe(false);
    expect(JSON.stringify(storedEntries(root))).toBe(before);
    expect(plan.rewrites.map((r) => `${r.specId}|${r.to}`)).toEqual([
      'system|id of "payments-api" is now as',
      'system|subsystem of "payments-api" is now from',
      'system|id of "kept-name" is now as',
      'system|subsystem of "kept-name" is now from',
    ]);
    const both = plan.rewrites.filter((r) => r.to.includes('kept-name'));
    expect(both.every((r) => r.reason.includes('wins'))).toBe(true);
  });

  it('applies the plan: current names only, then loads outside the v5 reading; an applied plan re-plans empty', () => {
    const root = oldProject();
    const applied = runInV5Reading(() => migrate(true));
    expect(applied.applied).toBe(true);
    expect(storedEntries(root)).toEqual([
      expect.objectContaining({ as: 'payments-api', from: 'shop', component: 'web', audience: 'external' }),
      expect.objectContaining({ as: 'kept-name', from: 'shop', component: 'web2' }),
      expect.objectContaining({ as: 'plain', from: 'shop', component: 'web3' }),
    ]);
    for (const entry of storedEntries(root)) {
      expect(entry).not.toHaveProperty('id');
      expect(entry).not.toHaveProperty('subsystem');
    }
    invalidateSpecCache();
    expect(loadSystemSpec()).not.toBeNull();
    expect(getLoaderIssues().map((i) => i.message).join('\n')).not.toContain('wairon 5 form');
    expect(runInV5Reading(() => migrate(false)).rewrites).toEqual([]);
  });
});
