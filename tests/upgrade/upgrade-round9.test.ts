import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

import * as upgrade from '../../src/upgrade/index.js';
import { setProjectRoot } from '../../src/utils/fs.js';
import { invalidateSpecCache } from '../../src/core/specs.js';
import { listRules } from '../../src/core/validation.js';
import { readLockJson, tempRoot, writeProject, writeV6Lock } from '../helpers/v6-project.js';

// ---------------------------------------------------------------------------
// QA round 9: the approval carried by the per-spec digests alone (the
// whole-tree design part is not compared across the majors), the lock record
// keeping its key order, and the findings the new major's design rules report
// on the upgraded copy, foretold in the plan.
// ---------------------------------------------------------------------------

const roots: string[] = [];

afterEach(() => {
  setProjectRoot(null);
  invalidateSpecCache();
  for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true });
});

function project(): string {
  const root = tempRoot('wairon-r9-');
  roots.push(root);
  writeProject(root, 'shop');
  return root;
}

describe('the approval carried by the per-spec digests', () => {
  it('carries a record whose whole-tree design part differs when every per-spec digest matches', () => {
    const root = project();
    writeV6Lock(root, { tamperPart: { name: 'design', digest: 'e'.repeat(64) } });
    const plan = upgrade.plan(root);
    try {
      expect(plan.steps[0].changes.some((c) => c.description.includes('the approval carried'))).toBe(true);
      expect(plan.steps[0].changes.every((c) => !c.design)).toBe(true);
      expect(plan.steps[0].reported).toEqual([]);
      expect(upgrade.apply(plan).relock).toEqual([]);
    } finally {
      upgrade.discard(plan);
    }
    const lock = readLockJson(root);
    expect(Object.keys(lock.parts as object).length).toBeGreaterThan(0);
    expect(lock.upgraded).toMatchObject({ carried: true, compared: ['specs', 'rules', 'composition', 'network'] });
  });

  it('names the part and what it covers when a shared part differs', () => {
    const root = project();
    writeV6Lock(root, { tamperPart: { name: 'network', digest: 'f'.repeat(64) } });
    const plan = upgrade.plan(root);
    try {
      expect(plan.steps[0].reported.join('\n')).toContain('the network part: its declared network differs');
    } finally {
      upgrade.discard(plan);
    }
  });
});

describe('the lock record key order', () => {
  it('keeps the keys the record had in their order and puts the new ones after them', () => {
    const root = project();
    writeV6Lock(root);
    const plan = upgrade.plan(root);
    expect(upgrade.apply(plan).committed).toBe(true);
    // v6 order: format, stateId, lockedAt, lockedBy, validatorVersion, validationResult, status, specs, (dropped keys); then the new ones.
    expect(Object.keys(readLockJson(root))).toEqual([
      'format', 'stateId', 'lockedAt', 'lockedBy', 'validatorVersion', 'validationResult', 'status', 'specs', 'parts', 'upgraded',
    ]);
  });
});

describe('the findings foretold in the plan', () => {
  it('shows a warning and an error the upgraded copy raises, under the live root', () => {
    const root = project();
    const file = path.join(root, '.wai', 'specs', 'shop-core', 'shop-orch', '.index.yaml');
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('dependsOn: []', 'dependsOn: [ghost]'));
    writeV6Lock(root);
    const plan = upgrade.plan(root);
    try {
      expect(plan.findings).toHaveLength(1);
      expect(plan.findings[0].project).toBe(root);
      const lines = plan.findings[0].findings;
      expect(lines.some((l) => l.startsWith('error INVALID_DEPENDENCY_REFERENCE [shop-orch]'))).toBe(true);
      expect(lines.some((l) => l.startsWith('warning UNUSED_COMPONENT [shop-orch]'))).toBe(true);
    } finally {
      upgrade.discard(plan);
    }
  });

  it('leaves out a project with none, and sets aside the findings of the rules that judge code', () => {
    const root = project();
    writeV6Lock(root);
    const plan = upgrade.plan(root);
    try {
      const codeCodes = new Set(listRules().filter((r) => r.judges === 'code').flatMap((r) => r.codes.map((c) => c.code)));
      for (const f of plan.findings) for (const line of f.findings) expect(codeCodes.has(line.split(' ')[1])).toBe(false);
    } finally {
      upgrade.discard(plan);
    }
  });

  it('is empty for a current family', () => {
    const root = project();
    writeV6Lock(root);
    upgrade.apply(upgrade.plan(root));
    expect(upgrade.plan(root).findings).toEqual([]);
  });
});
