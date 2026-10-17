import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { setProjectRoot } from '../../src/utils/fs.js';
import { invalidateSpecCache, updateSpec } from '../../src/core/specs.js';
import { updateSpecGated } from '../../src/core/authoring.js';
import { readYamlFile } from '../../src/utils/yaml.js';

// ---------------------------------------------------------------------------
// spec_change_report.strippedKeys: a key the stored FILE carries that its
// level's schema does not know is dropped when the write re-serializes the
// spec. The parse has already lost it, so it is read from the raw document and
// named on the report — on a dry run too, which is how the chaining migration
// (wave C) shows `status: draft` on an L0 before its first gated L0 write.
// ---------------------------------------------------------------------------

let root: string | undefined;

afterEach(() => {
  setProjectRoot(null);
  invalidateSpecCache();
  if (root) fs.rmSync(root, { recursive: true, force: true });
  root = undefined;
});

/** A project whose L0 file carries `status: draft` and a nested unknown key, and a subsystem carrying one. */
function project(): { l0: string; sub: string } {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-stripped-'));
  const specs = path.join(root, '.wai', 'specs');
  fs.mkdirSync(path.join(specs, 'shop'), { recursive: true });
  fs.writeFileSync(path.join(root, '.wai', 'project.yaml'), "schemaVersion: 1.0.0\nname: shop\ntargets: []\ncreatedAt: '2026-01-01T00:00:00.000Z'\nupdatedAt: '2026-01-01T00:00:00.000Z'\n");
  const l0 = path.join(specs, '.index.yaml');
  fs.writeFileSync(l0, [
    'schemaVersion: 1.0.0',
    'name: Shop',
    'vision: sells things',
    'status: draft',
    'boundaries: []',
    'globalRequirements:',
    '  - description: fast',
    '    owner: ops',
    "createdAt: '2026-01-01T00:00:00.000Z'",
    "updatedAt: '2026-01-01T00:00:00.000Z'",
    '',
  ].join('\n'));
  const sub = path.join(specs, 'shop', '.index.yaml');
  fs.writeFileSync(sub, [
    'id: shop',
    'name: Shop',
    'description: the shop',
    'parentSystem: Shop',
    'publicInterfaces: []',
    'trustedLinks: []',
    'legacyNote: kept by hand',
    'status: draft',
    "createdAt: '2026-01-01T00:00:00.000Z'",
    "updatedAt: '2026-01-01T00:00:00.000Z'",
    '',
  ].join('\n'));
  setProjectRoot(root);
  invalidateSpecCache();
  return { l0, sub };
}

describe('strippedKeys', () => {
  it('a dry run names every key the write would drop, and moves no byte', () => {
    const { l0 } = project();
    const before = fs.readFileSync(l0);
    const report = updateSpec('system', 'system', { vision: 'sells more things' }, undefined, true);
    expect(report.dryRun).toBe(true);
    expect(report.strippedKeys).toEqual(['status: draft', 'globalRequirements[0].owner: ops']);
    expect(fs.readFileSync(l0).equals(before)).toBe(true);
  });

  it('a real write names the keys it dropped, and they are gone from the file', () => {
    const { l0 } = project();
    const report = updateSpec('system', 'system', { vision: 'sells more things' });
    expect(report.written).toBe(true);
    expect(report.strippedKeys).toEqual(['status: draft', 'globalRequirements[0].owner: ops']);
    const stored = readYamlFile(l0) as Record<string, unknown>;
    expect(stored.status).toBeUndefined();
    expect(stored.vision).toBe('sells more things');
  });

  it('the gated write reports them too, on a dry run and a real one, for any level', () => {
    const { sub } = project();
    const dry = updateSpecGated('subsystem', 'shop', { description: 'the whole shop' }, true);
    expect(dry.strippedKeys).toEqual(['legacyNote: kept by hand']);
    expect(fs.readFileSync(sub, 'utf8')).toContain('legacyNote');
    const real = updateSpecGated('subsystem', 'shop', { description: 'the whole shop' });
    expect(real.strippedKeys).toEqual(['legacyNote: kept by hand']);
    expect(fs.readFileSync(sub, 'utf8')).not.toContain('legacyNote');
  });

  it('is absent when the file carries nothing unknown, and on a write that changes nothing', () => {
    const { l0 } = project();
    updateSpec('system', 'system', { vision: 'sells more things' });
    invalidateSpecCache();
    const clean = updateSpec('system', 'system', { vision: 'sells even more things' }, undefined, true);
    expect(clean.strippedKeys).toBeUndefined();
    // Nothing to write, nothing re-serialized, nothing dropped.
    fs.writeFileSync(l0, fs.readFileSync(l0, 'utf8').replace('vision:', 'status: draft\nvision:'));
    invalidateSpecCache();
    const unchanged = updateSpec('system', 'system', { vision: 'sells more things' });
    expect(unchanged.written).toBe(false);
    expect(unchanged.strippedKeys).toBeUndefined();
  });
});
