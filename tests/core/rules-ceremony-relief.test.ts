import { describe, it, expect, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { validateSddTree } from '../../src/core/validation.js';
import { invalidateSpecCache } from '../../src/core/specs.js';

// ---------------------------------------------------------------------------
// Ceremony relief: (a) a trustedLink on the SOURCE subsystem licenses a
// direct in-process cross-subsystem edge (target must still be the published
// Portal); (b) Portals may read through Repository/Index faces, with writes
// still forced through the workflow layer (PORTAL_WRITE_SHORTCUT).
// ---------------------------------------------------------------------------

function createTempProject() {
  invalidateSpecCache();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-ceremony-test-'));

  const waiDir = path.join(tempDir, '.wai');
  fs.mkdirSync(waiDir);
  fs.writeFileSync(path.join(waiDir, 'project.yaml'), JSON.stringify({
    schemaVersion: '1.0.0',
    name: 'test-project',
    targets: [{ type: 'claude', outputDir: '.claude/agents', enabled: true }],
    rules: { noOverlappingOwnership: true, requireOwnedPaths: true, metaAgentTags: ['meta'], enforceReproducibility: true },
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

  return {
    tempDir,
    subsystem: (id: string, extra = '') =>
      writeSpec('subsystem', id, `schemaVersion: 1.0.0\nid: ${id}\nname: ${id}\ndescription: d\nparentSystem: TestSystem\n${extra}`),
    component: (id: string, sub: string, type: string, extra = '') =>
      writeSpec('component', id, `schemaVersion: 1.0.0\nid: ${id}\nname: ${id}\ndescription: d\nsubsystem: ${sub}\ncomponentType: ${type}\n${extra}`),
    contract: (compId: string, methods: { name: string; effect?: string }[]) =>
      writeSpec('interface', `i${compId}`, [
        'schemaVersion: 1.0.0',
        `id: i${compId}`,
        `name: I${compId}`,
        'description: contract',
        `component: ${compId}`,
        'methods:',
        ...methods.map(m => [
          `  - name: ${m.name}`,
          `    description: ${m.name} does its one thing, carefully and observably`,
          `    signature: "${m.name}(): void"`,
          '    returns: "void"',
          ...(m.effect ? [`    effect: ${m.effect}`] : []),
        ].join('\n')),
      ].join('\n')),
    impl: (compId: string, body: string) =>
      writeSpec('implementation', `impl-${compId}`, `schemaVersion: 1.0.0\nid: impl-${compId}\nname: Impl${compId}\ndescription: impl\ncontract: i${compId}\n${body}`),
    activate: () => { vi.spyOn(process, 'cwd').mockReturnValue(tempDir); },
    cleanup: () => {
      invalidateSpecCache();
      vi.restoreAllMocks();
      try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* win file locks */ }
    },
  };
}

const byCode = (res: { issues: { code: string; specId?: string; message: string; severity: string }[] }, code: string) =>
  res.issues.filter(i => i.code === code);

function twoSubsystems(proj: ReturnType<typeof createTempProject>, sourceExtra = '') {
  proj.subsystem('front', sourceExtra);
  proj.subsystem('billing', 'publicInterfaces:\n  - type: REST\n    details: /api/billing\n    component: billing-portal');
  proj.component('billing-portal', 'billing', 'Portal', 'portalType: HTTP_API\ndependsOn: [billing-orch]');
  proj.component('billing-orch', 'billing', 'Orchestrator');
}

describe('trustedLinks license direct in-process cross-subsystem edges', () => {
  it('without a trustedLink, a non-Adapter crossing is still the error it was', () => {
    const proj = createTempProject();
    twoSubsystems(proj);
    proj.component('front-orch', 'front', 'Orchestrator', 'dependsOn: [billing-portal]');
    proj.activate();
    try {
      const found = byCode(validateSddTree(), 'CROSS_SUBSYSTEM_NON_ADAPTER');
      expect(found).toHaveLength(1);
      expect(found[0].message).toContain('trustedLink');
    } finally { proj.cleanup(); }
  });

  it('a trustedLink on the SOURCE subsystem licenses the direct edge to the published Portal', () => {
    const proj = createTempProject();
    twoSubsystems(proj, 'trustedLinks:\n  - subsystem: billing\n    reason: in-process modular monolith - no network seam wanted between these two');
    proj.component('front-orch', 'front', 'Orchestrator', 'dependsOn: [billing-portal]');
    proj.activate();
    try {
      expect(byCode(validateSddTree(), 'CROSS_SUBSYSTEM_NON_ADAPTER')).toHaveLength(0);
    } finally { proj.cleanup(); }
  });

  it('the license never waives the published-Portal target requirements', () => {
    const proj = createTempProject();
    twoSubsystems(proj, 'trustedLinks:\n  - subsystem: billing\n    reason: sanctioned direct edge');
    proj.component('front-orch', 'front', 'Orchestrator', 'dependsOn: [billing-orch]'); // internal target
    proj.activate();
    try {
      expect(byCode(validateSddTree(), 'CROSS_SUBSYSTEM_NON_ADAPTER')).toHaveLength(0); // licensed
      expect(byCode(validateSddTree(), 'CROSS_SUBSYSTEM_PRIVATE_ACCESS').length).toBeGreaterThan(0); // still guarded
    } finally { proj.cleanup(); }
  });

  it('a trustedLink on the TARGET side alone licenses nothing', () => {
    const proj = createTempProject();
    proj.subsystem('front');
    proj.subsystem('billing', [
      'publicInterfaces:',
      '  - type: REST',
      '    details: /api/billing',
      '    component: billing-portal',
      'trustedLinks:',
      '  - subsystem: front',
      '    reason: acknowledged mutual coupling only',
    ].join('\n'));
    proj.component('billing-portal', 'billing', 'Portal', 'portalType: HTTP_API\ndependsOn: [billing-orch]');
    proj.component('billing-orch', 'billing', 'Orchestrator');
    proj.component('front-orch', 'front', 'Orchestrator', 'dependsOn: [billing-portal]');
    proj.activate();
    try {
      expect(byCode(validateSddTree(), 'CROSS_SUBSYSTEM_NON_ADAPTER')).toHaveLength(1);
    } finally { proj.cleanup(); }
  });
});

describe('Portal read-face access — reads may shortcut, writes may not', () => {
  function portalWithRepo(proj: ReturnType<typeof createTempProject>, narrative: string[]) {
    proj.subsystem('sub-a');
    proj.component('front-portal', 'sub-a', 'Portal', 'portalType: HTTP_API\ndependsOn: [rec-repository, flow-orch]');
    proj.component('flow-orch', 'sub-a', 'Orchestrator', 'dependsOn: [rec-repository]');
    proj.component('rec-store', 'sub-a', 'Store', 'durability: ram-projection');
    proj.component('rec-registry', 'sub-a', 'Registry', 'dependsOn: [rec-store]');
    proj.component('rec-index', 'sub-a', 'Index', 'dependsOn: [rec-store]');
    proj.component('rec-repository', 'sub-a', 'Repository', 'owns: [rec-store, rec-registry, rec-index]');
    proj.contract('rec-repository', [{ name: 'getRecord', effect: 'read' }, { name: 'saveRecord', effect: 'write' }]);
    proj.contract('front-portal', [{ name: 'handle' }]);
    proj.impl('front-portal', ['methods:', '  - name: handle', '    narrative:', ...narrative].join('\n'));
  }

  it('Portal → Repository is no longer a forbidden edge, and read calls pass', () => {
    const proj = createTempProject();
    portalWithRepo(proj, [
      '      - { stepNumber: 1, description: Read the record for display, type: call, targetComponent: rec-repository, targetMethod: getRecord }',
      '      - { stepNumber: 2, description: Done, type: return, outcome: rendered }',
    ]);
    proj.activate();
    try {
      const res = validateSddTree();
      expect(byCode(res, 'ARCHITECTURE_VIOLATION_PORTAL_FORBIDDEN_DEP')).toHaveLength(0);
      expect(byCode(res, 'PORTAL_WRITE_SHORTCUT')).toHaveLength(0);
    } finally { proj.cleanup(); }
  });

  it('a Portal narrative calling a write-effect facade method is the error', () => {
    const proj = createTempProject();
    portalWithRepo(proj, [
      '      - { stepNumber: 1, description: Save the record straight from the wire, type: call, targetComponent: rec-repository, targetMethod: saveRecord }',
      '      - { stepNumber: 2, description: Done, type: return, outcome: saved }',
    ]);
    proj.activate();
    try {
      const found = byCode(validateSddTree(), 'PORTAL_WRITE_SHORTCUT');
      expect(found).toHaveLength(1);
      expect(found[0].severity).toBe('error');
      expect(found[0].message).toContain('READS only');
    } finally { proj.cleanup(); }
  });

  it('Portal → Store/Registry/Adapter stay forbidden edges', () => {
    const proj = createTempProject();
    proj.subsystem('sub-a');
    proj.component('front-portal', 'sub-a', 'Portal', 'portalType: HTTP_API\ndependsOn: [rec-store]');
    proj.component('rec-store', 'sub-a', 'Store', 'durability: ram-projection');
    proj.activate();
    try {
      expect(byCode(validateSddTree(), 'ARCHITECTURE_VIOLATION_PORTAL_FORBIDDEN_DEP').length).toBeGreaterThan(0);
    } finally { proj.cleanup(); }
  });
});
