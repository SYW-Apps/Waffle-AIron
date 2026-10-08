import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { setProjectRoot } from '../../src/utils/fs.js';
import { saveSystemSpec, saveSpec, invalidateSpecCache, findOrphanedSpecFiles } from '../../src/core/specs.js';
import { getStatusReport } from '../../src/core/status.js';
import { checkApproval } from '../../src/commands/lock.js';
import type { SubsystemSpec } from '../../src/models/index.js';

// ---------------------------------------------------------------------------
// Round 6 (tinkerer M2): a corrupt, empty, null or schema-invalid L0 with
// specs below it turned plain lock-check off ("No SDD spec tree here …
// nothing is gated", exit 0), while a deleted L0 already failed closed.
// Status dumped the raw schema error, twice; status and lock called a tree
// with a missing L0 "not started" / "no spec tree".
// ---------------------------------------------------------------------------

const now = '2026-10-08T10:00:00.000Z';
let root = '';

function tree(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-l0-'));
  fs.mkdirSync(path.join(dir, '.wai', 'specs'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.wai', 'project.yaml'), JSON.stringify({
    schemaVersion: '1.0.0', name: 'l0', projectType: 'backend',
    targets: [{ type: 'claude', outputDir: '.claude/agents', enabled: true }], rules: {}, createdAt: now, updatedAt: now,
  }));
  setProjectRoot(dir);
  saveSystemSpec({ schemaVersion: '1.0.0', name: 'l0', vision: 'fixture', boundaries: [], globalRequirements: [], createdAt: now, updatedAt: now });
  saveSpec('subsystem', {
    id: 'dom', name: 'dom', description: 'the domain', parentSystem: 'l0',
    publicInterfaces: [], trustedLinks: [], status: 'draft', createdAt: now, updatedAt: now,
  } as SubsystemSpec);
  invalidateSpecCache();
  return dir;
}

function breakL0(text: string): void {
  fs.writeFileSync(path.join(root, '.wai', 'specs', '.index.yaml'), text);
  invalidateSpecCache();
}

afterEach(() => {
  setProjectRoot(null);
  invalidateSpecCache();
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* windows locks */ }
});

describe('an unreadable L0 fails closed exactly like a missing one (round 6, M2)', () => {
  for (const [what, text] of [['not YAML', 'x: ['], ['empty', ''], ['null', 'null\n'], ['schema-invalid', 'name: 5\n']] as const) {
    it(`plain lock-check refuses an L0 that is ${what}, naming the L0 and the specs below it`, () => {
      root = tree();
      breakL0(text);
      expect(findOrphanedSpecFiles().length).toBeGreaterThan(0);
      for (const strict of [false, true]) {
        const check = checkApproval(strict);
        expect(check.approved).toBe(false);
        expect(check.message).toContain('cannot be read as an L0');
        expect(check.message).not.toContain('No SDD spec tree here');
      }
    });
  }

  it('status says it in one line, once — never a raw schema dump', () => {
    root = tree();
    breakL0('');
    const report = getStatusReport();
    expect(report.failed).toBe(true);
    expect(report.text).toContain('The L0 System spec (.wai/specs/.index.yaml) cannot be read: the file is empty');
    expect(report.text).not.toContain('"code"');
    expect(report.text.match(/cannot be read/g)).toHaveLength(1);
  });

  it('status names a missing L0 with specs below it as a root that is gone, never "not started"', () => {
    root = tree();
    fs.rmSync(path.join(root, '.wai', 'specs', '.index.yaml'));
    invalidateSpecCache();
    const report = getStatusReport();
    expect(report.failed).toBe(true);
    expect(report.text).toContain('is missing, but 1 spec file(s) remain below it');
    expect(report.text).not.toContain('has not been started');
  });
});
