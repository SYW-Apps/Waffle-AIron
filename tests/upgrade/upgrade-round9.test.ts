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
    // A kept key after the dropped ones (projectId) stays after the keys that take their place.
    const v6 = { ...writeV6Lock(root), projectId: 'shop' };
    fs.writeFileSync(path.join(root, '.wai', 'lock.json'), JSON.stringify(v6, null, 2) + '\n');
    const plan = upgrade.plan(root);
    expect(upgrade.apply(plan).committed).toBe(true);
    // v6 order: format, stateId, lockedAt, lockedBy, validatorVersion, validationResult, status, specs, (dropped specsReading,
    // gateParts, members, reexpressed), projectId; the new keys take the first dropped key's place.
    expect(Object.keys(readLockJson(root))).toEqual([
      'format', 'stateId', 'lockedAt', 'lockedBy', 'validatorVersion', 'validationResult', 'status', 'specs', 'parts', 'upgraded', 'projectId',
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

  it('foretells the notice on an allow of a code the new major retired, and no other notice', () => {
    const root = project();
    const file = path.join(root, '.wai', 'specs', 'shop-core', 'shop-orch', '.index.yaml');
    const text = fs.readFileSync(file, 'utf8');
    fs.writeFileSync(file, `${text.endsWith('\n') ? text : `${text}\n`}lint:\n  allow:\n    - code: UNOWNED_STORE\n      reason: a standalone store, sanctioned in wairon 6\n`);
    writeV6Lock(root);
    const plan = upgrade.plan(root);
    try {
      const lines = plan.findings.flatMap((f) => f.findings);
      expect(lines.some((l) => l.startsWith('notice RETIRED_LINT_ALLOW_CODE [shop-orch]'))).toBe(true);
      expect(lines.filter((l) => l.startsWith('notice ')).every((l) => l.startsWith('notice RETIRED_LINT_ALLOW_CODE'))).toBe(true);
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
