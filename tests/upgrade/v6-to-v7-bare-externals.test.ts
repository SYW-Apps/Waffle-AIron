import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

import * as upgrade from '../../src/upgrade/index.js';
import { setProjectRoot, runWithProjectRoot } from '../../src/utils/fs.js';
import { invalidateSpecCache } from '../../src/core/specs.js';
import { validateProject } from '../../src/core/validation.js';
import { parseYaml, writeYamlFile } from '../../src/utils/yaml.js';
import { tempRoot, writeProject } from '../helpers/v6-project.js';

// A bare external (no source) was provided by the family in wairon 6. The v7
// upgrade gives it the relative path of its family project and drops its pin,
// or keeps pin and declaration and reports it when the family cannot answer.

const roots: string[] = [];

afterEach(() => {
  setProjectRoot(null);
  invalidateSpecCache();
  for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true });
});

const pin = (name: string): Record<string, unknown> => ({ project: name, snapshot: `.wai/externals/${name}.yaml`, digest: `sha256:${name}`, used: {} });

/** A family: root with members core and shared; core declares `producer` bare and pins it. */
function family(producer: string): { root: string; core: string } {
  const root = tempRoot('wairon-v6v7-bare-');
  roots.push(root);
  writeProject(root, 'fam', { members: { core: 'core', shared: 'shared' } });
  writeProject(path.join(root, 'core'), 'core', { externals: { [producer]: { use: ['x'], description: 'kept' } } });
  writeProject(path.join(root, 'shared'), 'shared');
  const core = path.join(root, 'core');
  writeYamlFile(path.join(core, '.wai', 'externals.lock.yaml'), { externals: { [producer]: pin(producer) } });
  writeYamlFile(path.join(core, '.wai', 'externals', `${producer}.yaml`), { project: producer });
  return { root, core };
}

describe('a bare external, v6 to v7', () => {
  it('is given the relative path of its family project and its pin dropped', () => {
    const { root, core } = family('shared');
    const plan = upgrade.plan(root);
    try {
      expect(plan.refusal).toBeUndefined();
      const described = plan.steps.flatMap((s) => s.changes.map((c) => c.description));
      expect(described.some((d) => d.startsWith('shared: given its source `../shared`') && d.includes('.wai/externals/shared.yaml'))).toBe(true);
      const report = upgrade.apply(plan);
      expect(report.committed).toBe(true);
    } finally {
      upgrade.discard(plan);
    }
    const config = parseYaml(fs.readFileSync(path.join(core, '.wai', 'project.yaml'), 'utf8')) as { externals: Record<string, { source?: unknown; use?: string[]; description?: string }> };
    expect(config.externals.shared.source).toBe('../shared');
    expect(config.externals.shared.use).toEqual(['x']);
    expect(config.externals.shared.description).toBe('kept');
    expect(fs.existsSync(path.join(core, '.wai', 'externals.lock.yaml'))).toBe(false);
    expect(fs.existsSync(path.join(core, '.wai', 'externals', 'shared.yaml'))).toBe(false);
    expect(fs.existsSync(path.join(core, '.wai', 'inputs.lock.yaml'))).toBe(false);

    // The project's own gate reads it live.
    invalidateSpecCache();
    const result = runWithProjectRoot(core, () => validateProject({ recursive: false } as never));
    const codes = JSON.stringify(result);
    expect(codes).not.toContain('EXTERNAL_CHECK_UNAVAILABLE');
    expect(codes).not.toContain('EXTERNAL_UNRESOLVED');
  });

  it('keeps its pin and declaration, and reports it, when no family project answers', () => {
    const { root, core } = family('ghost');
    const plan = upgrade.plan(root);
    try {
      const reported = plan.steps.flatMap((s) => s.reported);
      expect(reported.some((r) => r.startsWith('ghost:') && r.includes('sdd_update_external') && r.includes('wairon externals use --source'))).toBe(true);
      const described = plan.steps.flatMap((s) => s.changes.map((c) => c.description));
      expect(described.some((d) => d.startsWith('ghost:'))).toBe(false);
      expect(upgrade.apply(plan).committed).toBe(true);
    } finally {
      upgrade.discard(plan);
    }
    const config = parseYaml(fs.readFileSync(path.join(core, '.wai', 'project.yaml'), 'utf8')) as { externals: Record<string, { source?: unknown }> };
    expect(config.externals.ghost.source).toBeUndefined();
    const inputs = parseYaml(fs.readFileSync(path.join(core, '.wai', 'inputs.lock.yaml'), 'utf8')) as { externals: Record<string, unknown> };
    expect(Object.keys(inputs.externals)).toEqual(['ghost']);
    expect(fs.existsSync(path.join(core, '.wai', 'externals', 'ghost.yaml'))).toBe(true);
  });
});
