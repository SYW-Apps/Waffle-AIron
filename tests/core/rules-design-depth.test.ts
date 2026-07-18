import { describe, it, expect, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { validateSddTree, type ValidationIssue } from '../../src/core/validation.js';
import { invalidateSpecCache } from '../../src/core/specs.js';
import { buildRuleContext } from '../../src/core/rules/index.js';
import { RulesConfigSchema } from '../../src/models/project.js';
import { emptyExtensions } from '../../src/core/extensions.js';

// ---------------------------------------------------------------------------
// designDepth — teams choose how deep they design (components | interfaces |
// implementations | narratives). Expectation checks below the effective depth
// are gated; SOUNDNESS of whatever is authored always applies. Default stays
// narratives (full depth) — shallowness is a choice, never the default.
// ---------------------------------------------------------------------------

function createTempProject(projectRules: Record<string, unknown> = {}) {
  invalidateSpecCache();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-depth-test-'));

  const waiDir = path.join(tempDir, '.wai');
  fs.mkdirSync(waiDir);
  fs.writeFileSync(path.join(waiDir, 'project.yaml'), JSON.stringify({
    schemaVersion: '1.0.0',
    name: 'test-project',
    targets: [{ type: 'claude', outputDir: '.claude/agents', enabled: true }],
    rules: { noOverlappingOwnership: true, requireOwnedPaths: true, metaAgentTags: ['meta'], enforceReproducibility: true, ...projectRules },
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
    contract: (compId: string, methods: string[]) =>
      writeSpec('interface', `i${compId}`, [
        'schemaVersion: 1.0.0',
        `id: i${compId}`,
        `name: I${compId}`,
        'description: contract',
        `component: ${compId}`,
        'methods:',
        ...methods.map(m => [
          `  - name: ${m}`,
          `    description: ${m} does its one thing, carefully and observably`,
          `    signature: "${m}(): void"`,
          '    returns: "void"',
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

const codes = (res: { issues: { code: string }[] }) => res.issues.map(i => i.code);

// A component whose contract has a method but no implementation at all — at
// full depth this trips implementation/narrative expectations + reachability.
function interfacesOnlyTree(proj: ReturnType<typeof createTempProject>, sub = 'sub-a', subExtra = '') {
  proj.subsystem(sub, subExtra);
  proj.component(`orch-${sub}`, sub, 'Orchestrator');
  proj.contract(`orch-${sub}`, ['runFlow']);
}

describe('designDepth gates expectation checks', () => {
  it('default (narratives): an interfaces-only tree trips deeper expectations', () => {
    const proj = createTempProject();
    interfacesOnlyTree(proj);
    proj.activate();
    try {
      const found = codes(validateSddTree());
      expect(found).toContain('UNUSED_COMPONENT'); // no narrative edges reach it
    } finally { proj.cleanup(); }
  });

  it('project designDepth: interfaces silences implementation/narrative expectations', () => {
    const proj = createTempProject();
    interfacesOnlyTree(proj);
    proj.activate();
    try {
      const found = codes(validateSddTree({ rules: RulesConfigSchema.parse({ designDepth: 'interfaces' }) }));
      for (const gated of ['UNUSED_METHOD', 'UNUSED_COMPONENT', 'MISSING_NARRATIVE', 'MISSING_SOURCE_PATH', 'MISSING_IMPLEMENTATION_METHOD', 'INTENT_FLOOR']) {
        expect(found).not.toContain(gated);
      }
    } finally { proj.cleanup(); }
  });

  it('depth gates expectations, never soundness: a malformed narrative still errors at interfaces depth', () => {
    const proj = createTempProject();
    interfacesOnlyTree(proj);
    proj.impl('orch-sub-a', [
      'methods:',
      '  - name: runFlow',
      '    narrative:',
      '      - { stepNumber: 1, description: Branch with no config, type: branch }',
    ].join('\n'));
    proj.activate();
    try {
      const found = codes(validateSddTree({ rules: RulesConfigSchema.parse({ designDepth: 'interfaces' }) }));
      expect(found).toContain('MALFORMED_FLOW_STEP');
    } finally { proj.cleanup(); }
  });

  it('subsystem override beats the project default in both directions', () => {
    const proj = createTempProject();
    interfacesOnlyTree(proj, 'shallow');
    interfacesOnlyTree(proj, 'deep', 'designDepth: narratives');
    proj.activate();
    try {
      const issues = validateSddTree({ rules: RulesConfigSchema.parse({ designDepth: 'interfaces' }) })
        .issues.filter(i => i.code === 'UNUSED_COMPONENT');
      const ids = issues.map(i => i.specId);
      expect(ids).toContain('orch-deep');
      expect(ids).not.toContain('orch-shallow');
    } finally { proj.cleanup(); }
  });

  it('depth components also gates the L3 expectations (e.g. MISSING_ENDPOINT)', () => {
    const proj = createTempProject();
    proj.subsystem('sub-a');
    proj.component('front-portal', 'sub-a', 'Portal', 'portalType: HTTP_API\ndependsOn: [orch-sub-a]');
    proj.component('orch-sub-a', 'sub-a', 'Orchestrator');
    proj.contract('front-portal', ['handle']);
    proj.activate();
    try {
      expect(codes(validateSddTree({ rules: RulesConfigSchema.parse({ designDepth: 'components' }) }))).not.toContain('MISSING_ENDPOINT');
    } finally { proj.cleanup(); }

    const deep = createTempProject();
    deep.subsystem('sub-a');
    deep.component('front-portal', 'sub-a', 'Portal', 'portalType: HTTP_API\ndependsOn: [orch-sub-a]');
    deep.component('orch-sub-a', 'sub-a', 'Orchestrator');
    deep.contract('front-portal', ['handle']);
    deep.activate();
    try {
      expect(codes(validateSddTree())).toContain('MISSING_ENDPOINT');
    } finally { deep.cleanup(); }
  });

  it('a pack profile can set the depth default, and explicit config still wins', () => {
    const stamp = { createdAt: '2026-07-18T10:00:00Z', updatedAt: '2026-07-18T10:00:00Z' };
    const issues: ValidationIssue[] = [];
    const ext = emptyExtensions();
    ext.profiles['shallow-profile'] = {
      family: 'neutral', forbiddenStereotypes: [], discouragedStereotypes: [],
      rules: { designDepth: 'interfaces' },
    };
    const ctx = buildRuleContext({
      system: { schemaVersion: '1.0.0', name: 'S', vision: 'v', ...stamp } as never,
      subsystems: [{ id: 'sub-a', name: 'A', description: 'd', parentSystem: 'S', publicInterfaces: [], trustedLinks: [], profile: 'shallow-profile', status: 'complete', ...stamp } as never],
      components: [{ id: 'orch-a', name: 'o', description: 'd', subsystem: 'sub-a', componentType: 'Orchestrator', owns: [], dependsOn: [], status: 'complete', ...stamp } as never],
      interfaces: [],
      implementations: [],
      types: [],
      projectType: 'backend',
      extensions: ext,
      issues,
    });
    // Pack-profile depth (interfaces) gates the narrative-level expectation…
    ctx.addIssue('warning', 'MISSING_NARRATIVE', 'gated?', 'orch-a');
    expect(issues).toHaveLength(0);
    // …while ungated codes still pass through.
    ctx.addIssue('warning', 'UNOWNED_STORE', 'not gated', 'orch-a');
    expect(issues).toHaveLength(1);

    // Explicit project config overrides the pack profile.
    const issues2: ValidationIssue[] = [];
    const ctx2 = buildRuleContext({
      system: { schemaVersion: '1.0.0', name: 'S', vision: 'v', ...stamp } as never,
      subsystems: [{ id: 'sub-a', name: 'A', description: 'd', parentSystem: 'S', publicInterfaces: [], trustedLinks: [], profile: 'shallow-profile', status: 'complete', ...stamp } as never],
      components: [{ id: 'orch-a', name: 'o', description: 'd', subsystem: 'sub-a', componentType: 'Orchestrator', owns: [], dependsOn: [], status: 'complete', ...stamp } as never],
      interfaces: [],
      implementations: [],
      types: [],
      rules: RulesConfigSchema.parse({ designDepth: 'narratives' }),
      projectType: 'backend',
      extensions: ext,
      issues: issues2,
    });
    ctx2.addIssue('warning', 'MISSING_NARRATIVE', 'not gated at explicit narratives depth', 'orch-a');
    expect(issues2).toHaveLength(1);
  });
});
