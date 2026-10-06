import { describe, it, expect, vi, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { validateProject } from '../../src/core/validation.js';
import { invalidateSpecCache } from '../../src/core/specs.js';

// ---------------------------------------------------------------------------
// A key a schema does not know is dropped by the parse — so `exports:` written
// into the L0 (the export table is `publicInterfaces`) or a misspelt setting in
// project.yaml (`requireCod`) silently meant nothing. Both are reported.
// ---------------------------------------------------------------------------

let dir: string | undefined;
afterEach(() => {
  invalidateSpecCache();
  vi.restoreAllMocks();
  try { if (dir) fs.rmSync(dir, { recursive: true, force: true }); } catch { /* win locks */ }
  dir = undefined;
});

function project(config: Record<string, unknown>, l0Extra: string): string {
  invalidateSpecCache();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-unknown-keys-'));
  fs.mkdirSync(path.join(root, '.wai', 'specs', 'components'), { recursive: true });
  fs.writeFileSync(path.join(root, '.wai', 'project.yaml'), JSON.stringify({
    schemaVersion: '1.0.0', name: 'keys', targets: [], rules: {}, createdAt: '2026-10-05T10:00:00.000Z', updatedAt: '2026-10-05T10:00:00.000Z', ...config,
  }));
  const stamp = "createdAt: '2026-10-05T10:00:00Z'\nupdatedAt: '2026-10-05T10:00:00Z'";
  fs.writeFileSync(path.join(root, '.wai', 'specs', '.index.yaml'), `schemaVersion: 1.0.0\nname: Keys\nvision: testing\n${l0Extra}${stamp}\n`);
  fs.writeFileSync(path.join(root, '.wai', 'specs', 'components', 'store.yaml'),
    `id: store\nname: Store\ndescription: d\nsubsystem: dom\ncomponentType: Store\nownz: [x]\n${stamp}\n`);
  vi.spyOn(process, 'cwd').mockReturnValue(root);
  return root;
}

describe('unknown keys are reported, never silently ignored', () => {
  it('an `exports:` table in the L0 names publicInterfaces; a misspelt component key is named too', () => {
    dir = project({}, 'exports:\n  - from: dom\n');
    const issues = validateProject().issues.filter((i) => i.code === 'UNKNOWN_SPEC_KEY');
    const l0 = issues.find((i) => i.message.includes('.index.yaml'));
    expect(l0?.severity).toBe('warning');
    expect(l0?.message).toContain('exports');
    expect(l0?.message).toContain('publicInterfaces');
    expect(issues.some((i) => i.message.includes('ownz'))).toBe(true);
  });

  it('an unknown project.yaml setting warns', () => {
    dir = project({ requireCod: true }, '');
    const issue = validateProject().issues.find((i) => i.code === 'UNKNOWN_CONFIG_KEY');
    expect(issue?.severity).toBe('warning');
    expect(issue?.message).toContain('requireCod');
  });

  it('a clean tree reports neither', () => {
    dir = project({}, '');
    const codes = validateProject().issues.map((i) => i.code);
    expect(codes).not.toContain('UNKNOWN_CONFIG_KEY');
    expect(codes.filter((c) => c === 'UNKNOWN_SPEC_KEY')).toHaveLength(1); // the component's `ownz`
  });
});
