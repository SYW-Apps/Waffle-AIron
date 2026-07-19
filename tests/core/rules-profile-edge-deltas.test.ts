import { describe, it, expect, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { validateSddTree } from '../../src/core/validation.js';
import { invalidateSpecCache } from '../../src/core/specs.js';

// ---------------------------------------------------------------------------
// Profile edge-deltas (the ALLOW half of the matrix mechanism; DENY half =
// forbid-edge assertions): a pack profile licenses intra-subsystem edges the
// builtin stereotype matrix refuses — its platform idiom, with a reason.
// Boundary rules and un-governed subsystems stay untouched.
// ---------------------------------------------------------------------------

const ECS_PACK = `name: ecs-pack
profiles:
  game-ecs-real:
    family: backend-like
    allowedEdges:
      - from: [Specialist]
        to: [Store]
        reason: ECS systems iterate component arrays directly — the zero-cost idiom of the domain
`;

function createTempProject() {
  invalidateSpecCache();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-edgedelta-test-'));

  const waiDir = path.join(tempDir, '.wai');
  fs.mkdirSync(waiDir);
  fs.writeFileSync(path.join(waiDir, 'project.yaml'), JSON.stringify({
    schemaVersion: '1.0.0',
    name: 'test-project',
    projectType: 'backend',
    targets: [{ type: 'claude', outputDir: '.claude/agents', enabled: true }],
    rules: {},
    extensions: { packs: ['.wai/packs/ecs.yaml'], useGlobalPacks: false },
    createdAt: '2026-07-19T10:00:00Z',
    updatedAt: '2026-07-19T10:00:00Z',
  }));
  fs.mkdirSync(path.join(waiDir, 'packs'), { recursive: true });
  fs.writeFileSync(path.join(waiDir, 'packs', 'ecs.yaml'), ECS_PACK);

  const specsDir = path.join(waiDir, 'specs');
  for (const d of ['subsystems', 'components', 'interfaces', 'implementations', 'types']) {
    fs.mkdirSync(path.join(specsDir, d), { recursive: true });
  }

  const stamp = "createdAt: '2026-07-19T10:00:00Z'\nupdatedAt: '2026-07-19T10:00:00Z'";
  const writeSpec = (type: string, name: string, content: string) => {
    const filePath = type === 'system'
      ? path.join(specsDir, '.index.yaml')
      : path.join(specsDir, `${type}s`, `${name}.yaml`);
    fs.writeFileSync(filePath, `${content}\n${stamp}\n`);
  };

  writeSpec('system', 'system', 'schemaVersion: 1.0.0\nname: TestSystem\nvision: testing');
  writeSpec('subsystem', 'sim', 'schemaVersion: 1.0.0\nid: sim\nname: Sim\ndescription: d\nparentSystem: TestSystem\nprofile: game-ecs-real');
  writeSpec('subsystem', 'billing', 'schemaVersion: 1.0.0\nid: billing\nname: Billing\ndescription: d\nparentSystem: TestSystem');

  return {
    writeSpec,
    component: (id: string, type: string, sub: string, extra = '') =>
      writeSpec('component', id, `schemaVersion: 1.0.0\nid: ${id}\nname: ${id}\ndescription: d\nsubsystem: ${sub}\ncomponentType: ${type}\n${extra}`),
    activate: () => { vi.spyOn(process, 'cwd').mockReturnValue(tempDir); },
    cleanup: () => {
      invalidateSpecCache();
      vi.restoreAllMocks();
      try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* win file locks */ }
    },
  };
}

describe('profile edge-deltas — allowedEdges license matrix exceptions', () => {
  it('licenses the declared edge under the governing profile', () => {
    const proj = createTempProject();
    proj.component('physics-system', 'Specialist', 'sim', 'dependsOn: [position-store]');
    proj.component('position-store', 'Store', 'sim', 'durability: ram-projection\nlint:\n  allow:\n    - code: UNOWNED_STORE\n      reason: deliberate standalone ECS component array');
    proj.activate();
    try {
      const res = validateSddTree();
      expect(res.issues.filter(i => i.code === 'ARCHITECTURE_VIOLATION_SPECIALIST_DEP')).toHaveLength(0);
    } finally { proj.cleanup(); }
  });

  it('the same edge in an un-governed subsystem still violates the matrix', () => {
    const proj = createTempProject();
    proj.component('tax-calc', 'Specialist', 'billing', 'dependsOn: [rate-store]');
    proj.component('rate-store', 'Store', 'billing', 'durability: ram-projection\nlint:\n  allow:\n    - code: UNOWNED_STORE\n      reason: test fixture');
    proj.activate();
    try {
      const res = validateSddTree();
      expect(res.issues.filter(i => i.code === 'ARCHITECTURE_VIOLATION_SPECIALIST_DEP')).toHaveLength(1);
    } finally { proj.cleanup(); }
  });

  it('does NOT license edges outside the declared from/to pair', () => {
    const proj = createTempProject();
    // View -> Store is not in the delta; still refused under the profile.
    proj.component('hud-view', 'View', 'sim', 'dependsOn: [position-store]');
    proj.component('position-store', 'Store', 'sim', 'durability: ram-projection\nlint:\n  allow:\n    - code: UNOWNED_STORE\n      reason: deliberate standalone ECS component array');
    proj.activate();
    try {
      const res = validateSddTree();
      expect(res.issues.some(i => i.code === 'ARCHITECTURE_VIOLATION_VIEW_DEP')).toBe(true);
    } finally { proj.cleanup(); }
  });

  it('never relaxes cross-subsystem boundary rules', () => {
    const proj = createTempProject();
    // Specialist crossing into another subsystem's Store: boundary rules fire
    // regardless of the profile's allowedEdges.
    proj.component('physics-system', 'Specialist', 'sim', 'dependsOn: [rate-store]');
    proj.component('rate-store', 'Store', 'billing', 'durability: ram-projection\nlint:\n  allow:\n    - code: UNOWNED_STORE\n      reason: test fixture');
    proj.activate();
    try {
      const res = validateSddTree();
      expect(res.issues.some(i => i.code === 'CROSS_SUBSYSTEM_NON_ADAPTER')).toBe(true);
    } finally { proj.cleanup(); }
  });
});
