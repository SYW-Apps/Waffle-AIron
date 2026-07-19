import { describe, it, expect, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { validateSddTree } from '../../src/core/validation.js';
import { invalidateSpecCache } from '../../src/core/specs.js';

// ---------------------------------------------------------------------------
// FeatureComponent containment — 1 Orchestrator + 1..N Views. A feature slice
// often carries several UI faces (list/detail/form) over one logic component;
// the old exactly-2 arity forced artificial slices per view.
// ---------------------------------------------------------------------------

function createTempProject() {
  invalidateSpecCache();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-featcomp-test-'));

  const waiDir = path.join(tempDir, '.wai');
  fs.mkdirSync(waiDir);
  fs.writeFileSync(path.join(waiDir, 'project.yaml'), JSON.stringify({
    schemaVersion: '1.0.0',
    name: 'test-project',
    projectType: 'frontend-reactive',
    targets: [{ type: 'claude', outputDir: '.claude/agents', enabled: true }],
    rules: {},
  }));

  const specsDir = path.join(waiDir, 'specs');
  for (const d of ['subsystems', 'components', 'interfaces', 'implementations', 'types']) {
    fs.mkdirSync(path.join(specsDir, d), { recursive: true });
  }

  const stamp = "createdAt: '2026-07-18T10:00:00Z'\nupdatedAt: '2026-07-18T10:00:00Z'";
  const writeSpec = (type: string, name: string, content: string) => {
    const filePath = type === 'system'
      ? path.join(specsDir, '.index.yaml')
      : path.join(specsDir, `${type}s`, `${name}.yaml`);
    fs.writeFileSync(filePath, `${content}\n${stamp}\n`);
  };

  writeSpec('system', 'system', 'schemaVersion: 1.0.0\nname: TestSystem\nvision: testing');
  writeSpec('subsystem', 'sub-a', 'schemaVersion: 1.0.0\nid: sub-a\nname: SubA\ndescription: d\nparentSystem: TestSystem\nprofile: frontend-reactive');

  return {
    component: (id: string, type: string, extra = '') =>
      writeSpec('component', id, `schemaVersion: 1.0.0\nid: ${id}\nname: ${id}\ndescription: d\nsubsystem: sub-a\ncomponentType: ${type}\n${extra}`),
    activate: () => { vi.spyOn(process, 'cwd').mockReturnValue(tempDir); },
    cleanup: () => {
      invalidateSpecCache();
      vi.restoreAllMocks();
      try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* win file locks */ }
    },
  };
}

const featureIssues = (res: { issues: { code: string; specId?: string }[] }) =>
  res.issues.filter(i => i.code === 'FEATURE_COMPONENT_CONTAINMENT');

describe('FeatureComponent containment — 1 Orchestrator + 1..N Views', () => {
  it('accepts one Orchestrator + one View (the classic pair)', () => {
    const proj = createTempProject();
    proj.component('billing-feature', 'FeatureComponent', 'owns: [billing-logic, billing-view]');
    proj.component('billing-logic', 'Orchestrator');
    proj.component('billing-view', 'View');
    proj.activate();
    try {
      expect(featureIssues(validateSddTree())).toHaveLength(0);
    } finally { proj.cleanup(); }
  });

  it('accepts one Orchestrator + several Views (list/detail/form faces)', () => {
    const proj = createTempProject();
    proj.component('billing-feature', 'FeatureComponent', 'owns: [billing-logic, billing-list, billing-detail, billing-form]');
    proj.component('billing-logic', 'Orchestrator');
    proj.component('billing-list', 'View');
    proj.component('billing-detail', 'View');
    proj.component('billing-form', 'View');
    proj.activate();
    try {
      expect(featureIssues(validateSddTree())).toHaveLength(0);
    } finally { proj.cleanup(); }
  });

  it('rejects a slice with no View at all', () => {
    const proj = createTempProject();
    proj.component('billing-feature', 'FeatureComponent', 'owns: [billing-logic]');
    proj.component('billing-logic', 'Orchestrator');
    proj.activate();
    try {
      const found = featureIssues(validateSddTree());
      expect(found).toHaveLength(1);
      expect(found[0].specId).toBe('billing-feature');
    } finally { proj.cleanup(); }
  });

  it('rejects two Orchestrators (a second Orchestrator is a second feature)', () => {
    const proj = createTempProject();
    proj.component('billing-feature', 'FeatureComponent', 'owns: [billing-logic, billing-logic2, billing-view]');
    proj.component('billing-logic', 'Orchestrator');
    proj.component('billing-logic2', 'Orchestrator');
    proj.component('billing-view', 'View');
    proj.activate();
    try {
      expect(featureIssues(validateSddTree())).toHaveLength(1);
    } finally { proj.cleanup(); }
  });

  it('rejects a foreign member type inside the slice (Store)', () => {
    const proj = createTempProject();
    proj.component('billing-feature', 'FeatureComponent', 'owns: [billing-logic, billing-view, billing-cache]');
    proj.component('billing-logic', 'Orchestrator');
    proj.component('billing-view', 'View');
    proj.component('billing-cache', 'Store', 'durability: ram-projection');
    proj.activate();
    try {
      expect(featureIssues(validateSddTree())).toHaveLength(1);
    } finally { proj.cleanup(); }
  });
});
