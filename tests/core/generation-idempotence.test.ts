import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { setProjectRoot } from '../../src/utils/fs.js';
import {
  saveSystemSpec,
  saveSubsystemSpec,
  loadSubsystemSpec,
  applySpecStatus,
  invalidateSpecCache,
} from '../../src/core/specs.js';
import { renderDomainsDoc } from '../../src/core/context.js';
import type { SubsystemSpec } from '../../src/models/index.js';

// ---------------------------------------------------------------------------
// Generation is a pure function of the spec tree.
//
// A generator that reads the clock produces a different file every day from the
// SAME design, so `wairon generate` and `wairon lock` dirty the repo with
// changes that carry nothing — and a reviewer can no longer tell a freeze or a
// regeneration from an actual design change. These pin the two places that got
// that wrong: the domains doc stamped today's date, and a status promotion
// re-stamped updatedAt on a spec whose content never moved.
// ---------------------------------------------------------------------------

const now = '2026-01-01T00:00:00.000Z';
const cleanups: string[] = [];

function mkProject(systemName: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-idem-'));
  cleanups.push(dir);
  fs.mkdirSync(path.join(dir, '.wai', 'specs'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.wai', 'project.yaml'), `schemaVersion: 1.0.0\nname: ${systemName}\n`);
  setProjectRoot(dir);
  invalidateSpecCache();
  saveSystemSpec({
    schemaVersion: '1.0.0',
    name: systemName,
    vision: `vision for ${systemName}`,
    boundaries: [],
    globalRequirements: [],
    createdAt: now,
    updatedAt: now,
  });
  return dir;
}

function subsystem(id: string, parentSystem: string): SubsystemSpec {
  return {
    id,
    name: id,
    description: `subsystem ${id}`,
    parentSystem,
    publicInterfaces: [],
    trustedLinks: [],
    status: 'draft',
    createdAt: now,
    updatedAt: now,
  };
}

afterEach(() => {
  setProjectRoot(null);
  invalidateSpecCache();
  for (const dir of cleanups.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* windows file locks */
    }
  }
});

describe('generated docs are a pure function of the tree', () => {
  it('renders the domains doc identically twice, and carries no date stamp', () => {
    mkProject('Idem System');
    saveSubsystemSpec(subsystem('core', 'Idem System'));

    const first = renderDomainsDoc();
    const second = renderDomainsDoc();
    expect(second).toBe(first);
    // No wall-clock anywhere: a regeneration tomorrow must produce these bytes.
    expect(first).not.toMatch(/Last updated/);
    expect(first).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  });

  it('changes only when the domains change', () => {
    mkProject('Idem System');
    saveSubsystemSpec(subsystem('core', 'Idem System'));
    const before = renderDomainsDoc();

    saveSubsystemSpec(subsystem('billing', 'Idem System'));
    invalidateSpecCache();
    const after = renderDomainsDoc();

    expect(after).not.toBe(before);
    expect(after).toContain('billing');
  });
});

describe('a status promotion is a mechanical re-save', () => {
  it('flips status WITHOUT re-stamping updatedAt', () => {
    mkProject('Freeze System');
    saveSubsystemSpec(subsystem('core', 'Freeze System'));
    invalidateSpecCache();

    const authored = loadSubsystemSpec('core');
    expect(authored?.status).toBe('draft');
    const stampedAtAuthoring = authored!.updatedAt;

    // The lock's freeze: status only, no authored content moves.
    applySpecStatus('subsystem', 'core', 'complete');
    invalidateSpecCache();

    const frozen = loadSubsystemSpec('core');
    expect(frozen?.status).toBe('complete');
    // The whole point: a freeze must not read as an edit.
    expect(frozen?.updatedAt).toBe(stampedAtAuthoring);
  });

  it('still stamps updatedAt on a REAL edit', () => {
    mkProject('Edit System');
    saveSubsystemSpec(subsystem('core', 'Edit System'));
    invalidateSpecCache();
    const authoredStamp = loadSubsystemSpec('core')!.updatedAt;

    saveSubsystemSpec({ ...subsystem('core', 'Edit System'), description: 'genuinely changed' });
    invalidateSpecCache();

    const edited = loadSubsystemSpec('core');
    expect(edited?.description).toBe('genuinely changed');
    expect(edited?.updatedAt).not.toBe(authoredStamp);
  });
});
