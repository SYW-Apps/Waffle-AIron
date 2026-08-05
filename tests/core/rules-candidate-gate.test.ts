import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { validateComponentCandidate, formatCandidateRefusal } from '../../src/core/rules/candidate.js';
import { specScopedRules, registerBuiltinRules } from '../../src/core/rules/repository.js';
import { validateSddTree } from '../../src/core/validation.js';
import { invalidateSpecCache, loadComponentSpec, saveComponentSpec } from '../../src/core/specs.js';
import { addComponent, updateSpecGated } from '../../src/core/authoring.js';
import { setProjectRoot } from '../../src/utils/fs.js';
import type { ComponentSpec } from '../../src/models/specs.js';

// ---------------------------------------------------------------------------
// The write-boundary gate.
//
// The intrinsic rules (scope 'spec') are a pure function of one component, so
// they run against a CANDIDATE before it is written — that is what turns a
// misplaced Portal-only field from a persisted, sometimes unclearable
// validate-time error into a refused write. These tests pin both halves of the
// cut: what the gate must refuse, and what it must NOT (the authoring order
// depends on incomplete-but-legal intermediate states staying writable).
// ---------------------------------------------------------------------------

const STAMP = { createdAt: '2026-07-18T10:00:00Z', updatedAt: '2026-07-18T10:00:00Z' };

function comp(overrides: Partial<ComponentSpec> & Pick<ComponentSpec, 'componentType'>): ComponentSpec {
  return {
    id: 'c1',
    name: 'C1',
    description: 'd',
    subsystem: 'sub-a',
    componentType: overrides.componentType,
    owns: [],
    dependsOn: [],
    status: 'draft',
    ...STAMP,
    ...overrides,
  } as ComponentSpec;
}

const codes = (issues: { code: string }[]): string[] => issues.map(i => i.code);

describe('candidate gate — what it refuses', () => {
  it('refuses a Portal-only field on a non-Portal, as an error', () => {
    const verdict = validateComponentCandidate(comp({ componentType: 'Orchestrator', basePath: '/api' }));
    expect(codes(verdict.errors)).toContain('UNEXPECTED_PORTAL_FIELD');
  });

  it('refuses portalType on a non-Portal', () => {
    const verdict = validateComponentCandidate(comp({ componentType: 'Adapter', portalType: 'HTTP_API' }));
    expect(codes(verdict.errors)).toContain('UNEXPECTED_PORTAL_FIELD');
  });

  it('refuses durability on a non-Store', () => {
    const verdict = validateComponentCandidate(comp({ componentType: 'Specialist', durability: 'durable' }));
    expect(codes(verdict.errors)).toContain('DURABILITY_ON_NON_STORE');
  });

  it('names the remedy — unset — in the refusal, since removing a field is the fix agents cannot guess', () => {
    const verdict = validateComponentCandidate(comp({ componentType: 'Orchestrator', basePath: '/api' }));
    const message = formatCandidateRefusal(verdict);
    expect(message).toContain('unset');
    expect(message).toContain('UNEXPECTED_PORTAL_FIELD');
  });
});

describe('candidate gate — what it must NOT refuse', () => {
  it('passes a clean component with no intrinsic findings at all', () => {
    const verdict = validateComponentCandidate(comp({ componentType: 'Orchestrator' }));
    expect(verdict.errors).toEqual([]);
    expect(verdict.warnings).toEqual([]);
  });

  it('lets a draft Portal be created before its portalType is set — the authoring order is two calls', () => {
    const verdict = validateComponentCandidate(comp({ componentType: 'Portal' }));
    expect(verdict.errors).toEqual([]);
    expect(codes(verdict.warnings)).toContain('MISSING_PORTAL_TYPE');
  });

  it('reports a Store with no durability as a warning, never a refusal', () => {
    const verdict = validateComponentCandidate(comp({ componentType: 'Store' }));
    expect(verdict.errors).toEqual([]);
    expect(codes(verdict.warnings)).toContain('MISSING_DURABILITY');
  });

  it('runs NO tree rules: a Portal with no interfaces yet is not an endpoint violation', () => {
    const verdict = validateComponentCandidate(comp({ componentType: 'Portal', portalType: 'HTTP_API' }));
    expect(verdict.errors).toEqual([]);
    expect(codes(verdict.warnings)).not.toContain('MISSING_ENDPOINT');
  });

  it('does not fire on dependsOn naming components that do not exist — a tree concern', () => {
    const verdict = validateComponentCandidate(
      comp({ componentType: 'Orchestrator', dependsOn: ['nope', 'also-nope'] }),
    );
    expect(verdict.errors).toEqual([]);
  });

  it('honours a project severity override, so the gate is disarmable exactly like validate', () => {
    const verdict = validateComponentCandidate(
      comp({ componentType: 'Orchestrator', basePath: '/api' }),
      { rules: { sddRuleSeverity: { UNEXPECTED_PORTAL_FIELD: 'off' } } as never },
    );
    expect(verdict.errors).toEqual([]);
  });
});

describe('rule scope declarations', () => {
  it('only rules that declare scope "spec" reach the candidate path', () => {
    registerBuiltinRules();
    const names = specScopedRules().map(r => r.name).sort();
    expect(names).toEqual(['durability-declaration', 'portal-fields']);
  });

  it('the spec-scoped subset emits exactly the intrinsic codes', () => {
    registerBuiltinRules();
    const emitted = specScopedRules().flatMap(r => r.codes.map(c => c.code)).sort();
    expect(emitted).toEqual([
      'AUTH_ON_NON_PORTAL',
      'DURABILITY_ON_NON_STORE',
      'MISSING_DURABILITY',
      'MISSING_PORTAL_TYPE',
      'UNEXPECTED_PORTAL_FIELD',
    ]);
  });
});

// ---------------------------------------------------------------------------
// The split must be behaviour-preserving for a TREE run: the same codes still
// fire, from their new homes. A regression here would mean the refactor quietly
// dropped a check rather than relocating it.
// ---------------------------------------------------------------------------

function createTempProject() {
  invalidateSpecCache();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-candidate-test-'));
  const waiDir = path.join(tempDir, '.wai');
  fs.mkdirSync(waiDir);
  fs.writeFileSync(path.join(waiDir, 'project.yaml'), JSON.stringify({
    schemaVersion: '1.0.0',
    name: 'test-project',
    targets: [{ type: 'claude', outputDir: '.claude/agents', enabled: true }],
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
  writeSpec('subsystem', 'sub-a', 'schemaVersion: 1.0.0\nid: sub-a\nname: SubA\ndescription: d\nparentSystem: TestSystem');

  return { tempDir, writeSpec };
}

describe('the split is behaviour-preserving for a tree run', () => {
  it('still reports UNEXPECTED_PORTAL_FIELD and DURABILITY_ON_NON_STORE from their new rules', () => {
    const { tempDir, writeSpec } = createTempProject();
    setProjectRoot(tempDir);
    writeSpec('component', 'orch', 'schemaVersion: 1.0.0\nid: orch\nname: Orch\ndescription: d\nsubsystem: sub-a\ncomponentType: Orchestrator\nstatus: complete\nbasePath: /api');
    writeSpec('component', 'spec1', 'schemaVersion: 1.0.0\nid: spec1\nname: Spec1\ndescription: d\nsubsystem: sub-a\ncomponentType: Specialist\nstatus: complete\ndurability: durable');
    invalidateSpecCache();

    const result = validateSddTree();
    const found = result.issues.map(i => i.code);
    expect(found).toContain('UNEXPECTED_PORTAL_FIELD');
    expect(found).toContain('DURABILITY_ON_NON_STORE');
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('still reports MISSING_ENDPOINT — the tree half survived the split', () => {
    const { tempDir, writeSpec } = createTempProject();
    setProjectRoot(tempDir);
    writeSpec('component', 'api', 'schemaVersion: 1.0.0\nid: api\nname: Api\ndescription: d\nsubsystem: sub-a\ncomponentType: Portal\nstatus: complete\nportalType: HTTP_API');
    writeSpec('interface', 'iapi', [
      'schemaVersion: 1.0.0',
      'id: iapi',
      'name: IApi',
      'description: contract',
      'component: api',
      'status: complete',
      'methods:',
      '  - name: fetchThing',
      '    description: fetches the one thing it is responsible for fetching',
      '    signature: "fetchThing(): void"',
      '    returns: void',
    ].join('\n'));
    invalidateSpecCache();

    const result = validateSddTree();
    expect(result.issues.map(i => i.code)).toContain('MISSING_ENDPOINT');
    fs.rmSync(tempDir, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// The shared authoring seam. These exercise core/authoring.ts — the SAME
// functions the local MCP server, the hosted MCP dispatch, and any future CLI or
// web editor call. The gate is core behaviour, not transport behaviour, so it is
// tested at the layer every access path reaches.
// ---------------------------------------------------------------------------

describe('authoring: addComponent', () => {
  function bootstrap() {
    const { tempDir, writeSpec } = createTempProject();
    setProjectRoot(tempDir);
    invalidateSpecCache();
    return { tempDir, writeSpec };
  }

  it('refuses a misplaced field and writes nothing at all', () => {
    const { tempDir } = bootstrap();
    expect(() => addComponent(comp({ id: 'orch', componentType: 'Orchestrator', basePath: '/api' })))
      .toThrow(/UNEXPECTED_PORTAL_FIELD/);

    invalidateSpecCache();
    expect(loadComponentSpec('orch')).toBeNull();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('writes a clean component and returns intrinsic warnings as notices', () => {
    const { tempDir } = bootstrap();
    const notices = addComponent(comp({ id: 'store1', componentType: 'Store' }));
    expect(notices.some(n => n.startsWith('MISSING_DURABILITY'))).toBe(true);

    invalidateSpecCache();
    expect(loadComponentSpec('store1')?.componentType).toBe('Store');
    fs.rmSync(tempDir, { recursive: true, force: true });
  });
});

describe('authoring: updateSpecGated', () => {
  it('refuses an update that adds a Portal-only field to a non-Portal, and writes nothing', () => {
    const { tempDir, writeSpec } = createTempProject();
    setProjectRoot(tempDir);
    writeSpec('component', 'orch', 'schemaVersion: 1.0.0\nid: orch\nname: Orch\ndescription: d\nsubsystem: sub-a\ncomponentType: Orchestrator');
    invalidateSpecCache();

    expect(() => updateSpecGated('component', 'orch', { basePath: '/api' }))
      .toThrow(/UNEXPECTED_PORTAL_FIELD/);

    invalidateSpecCache();
    expect(loadComponentSpec('orch')?.basePath).toBeUndefined();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('refuses a componentType change that strands a field which was legal before', () => {
    const { tempDir, writeSpec } = createTempProject();
    setProjectRoot(tempDir);
    // Legal as a Portal. Demoting it to an Adapter strands basePath — and the
    // delta alone never says so; only the merged spec does.
    writeSpec('component', 'api', 'schemaVersion: 1.0.0\nid: api\nname: Api\ndescription: d\nsubsystem: sub-a\ncomponentType: Portal\nportalType: HTTP_API\nbasePath: /api');
    invalidateSpecCache();

    expect(() => updateSpecGated('component', 'api', { componentType: 'Adapter' }))
      .toThrow(/UNEXPECTED_PORTAL_FIELD/);

    invalidateSpecCache();
    expect(loadComponentSpec('api')?.componentType).toBe('Portal');
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('allows an unrelated update through and surfaces intrinsic warnings as notices', () => {
    const { tempDir, writeSpec } = createTempProject();
    setProjectRoot(tempDir);
    writeSpec('component', 'store1', 'schemaVersion: 1.0.0\nid: store1\nname: Store1\ndescription: d\nsubsystem: sub-a\ncomponentType: Store');
    invalidateSpecCache();

    const notices = updateSpecGated('component', 'store1', { description: 'a better description' });
    expect(notices.some(n => n.startsWith('MISSING_DURABILITY'))).toBe(true);
    invalidateSpecCache();
    expect(loadComponentSpec('store1')?.description).toBe('a better description');
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('lets unset clear the offending field, so a spec that predates the gate is repairable in place', () => {
    const { tempDir, writeSpec } = createTempProject();
    setProjectRoot(tempDir);
    // Already on disk, already violating — exactly the state the gate must not trap.
    writeSpec('component', 'orch', 'schemaVersion: 1.0.0\nid: orch\nname: Orch\ndescription: d\nsubsystem: sub-a\ncomponentType: Orchestrator\nbasePath: /api');
    invalidateSpecCache();

    updateSpecGated('component', 'orch', { unset: ['basePath'] });
    invalidateSpecCache();
    expect(loadComponentSpec('orch')?.basePath).toBeUndefined();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('leaves non-component kinds ungated', () => {
    const { tempDir } = createTempProject();
    setProjectRoot(tempDir);
    invalidateSpecCache();
    expect(() => updateSpecGated('subsystem', 'sub-a', { description: 'updated' })).not.toThrow();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });
});

describe('the store itself stays ungated, so mechanical re-saves cannot be trapped', () => {
  it('saveComponentSpec still persists a violating spec — only authoring gates', () => {
    const { tempDir } = createTempProject();
    setProjectRoot(tempDir);
    invalidateSpecCache();

    // Status promotion, layout normalization and migrations re-save through the
    // store. If the store gated, a spec that predates a rule could not be
    // promoted, relocated, or migrated — it would be permanently stuck.
    expect(() => saveComponentSpec(comp({ id: 'legacy', componentType: 'Orchestrator', basePath: '/api' })))
      .not.toThrow();
    invalidateSpecCache();
    expect(loadComponentSpec('legacy')?.basePath).toBe('/api');
    fs.rmSync(tempDir, { recursive: true, force: true });
  });
});
