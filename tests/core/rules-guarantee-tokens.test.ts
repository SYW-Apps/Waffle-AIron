import { describe, it, expect, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { validateSddTree } from '../../src/core/validation.js';
import { invalidateSpecCache } from '../../src/core/specs.js';

// ---------------------------------------------------------------------------
// Guarantee-token vocabulary — the guarantee field is an OPEN string so packs
// can extend the builtin set; UNKNOWN_GUARANTEE catches everything that is
// neither builtin nor pack-declared (a token nobody declares can never be
// matched by the consistency checks, so it is almost certainly a typo).
// ---------------------------------------------------------------------------

function createTempProject(packs: string[] = []) {
  invalidateSpecCache();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-guarantee-test-'));

  const waiDir = path.join(tempDir, '.wai');
  fs.mkdirSync(waiDir);
  fs.writeFileSync(path.join(waiDir, 'project.yaml'), JSON.stringify({
    schemaVersion: '1.0.0',
    name: 'test-project',
    projectType: 'backend',
    targets: [{ type: 'claude', outputDir: '.claude/agents', enabled: true }],
    rules: {},
    ...(packs.length ? { extensions: { packs, useGlobalPacks: false } } : {}),
    createdAt: '2026-07-18T10:00:00Z',
    updatedAt: '2026-07-18T10:00:00Z',
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

  const writeFile = (rel: string, content: string) => {
    const p = path.join(tempDir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  };

  writeSpec('system', 'system', 'schemaVersion: 1.0.0\nname: TestSystem\nvision: testing');
  writeSpec('subsystem', 'sub-a', 'schemaVersion: 1.0.0\nid: sub-a\nname: SubA\ndescription: d\nparentSystem: TestSystem');

  return {
    writeSpec,
    writeFile,
    // Orchestrator calling a Store method — the shape every scenario reuses.
    scenario: (opts: { methodGuarantees?: string[]; stepAsserts?: string[] }) => {
      writeSpec('component', 'flow-orch', 'schemaVersion: 1.0.0\nid: flow-orch\nname: flow-orch\ndescription: d\nsubsystem: sub-a\ncomponentType: Orchestrator\ndependsOn: [record-store]');
      writeSpec('component', 'record-store', 'schemaVersion: 1.0.0\nid: record-store\nname: record-store\ndescription: d\nsubsystem: sub-a\ncomponentType: Store\ndurability: ram-projection');
      writeSpec('interface', 'irecord-store', [
        'schemaVersion: 1.0.0',
        'id: irecord-store',
        'name: IRecordStore',
        'description: d',
        'component: record-store',
        'methods:',
        '  - name: putRecord',
        '    description: Upserts the record into held state, replacing any previous revision.',
        '    signature: "putRecord(id: string): void"',
        '    returns: "void"',
        ...(opts.methodGuarantees?.length ? [`    guarantees: [${opts.methodGuarantees.join(', ')}]`] : []),
      ].join('\n'));
      writeSpec('interface', 'iflow-orch', [
        'schemaVersion: 1.0.0',
        'id: iflow-orch',
        'name: IFlowOrch',
        'description: d',
        'component: flow-orch',
        'methods:',
        '  - name: ingest',
        '    description: Ingests one record end to end and reports the outcome plainly.',
        '    signature: "ingest(id: string): void"',
        '    returns: "void"',
      ].join('\n'));
      writeSpec('implementation', 'impl-flow-orch', [
        'schemaVersion: 1.0.0',
        'id: impl-flow-orch',
        'name: ImplFlowOrch',
        'description: d',
        'contract: iflow-orch',
        'methods:',
        '  - name: ingest',
        '    narrative:',
        '      - stepNumber: 1',
        '        description: Persist the record through the store',
        '        type: call',
        '        targetComponent: record-store',
        '        targetMethod: putRecord',
        ...(opts.stepAsserts?.length ? [`        assertsGuarantees: [${opts.stepAsserts.join(', ')}]`] : []),
      ].join('\n'));
    },
    activate: () => { vi.spyOn(process, 'cwd').mockReturnValue(tempDir); },
    cleanup: () => {
      invalidateSpecCache();
      vi.restoreAllMocks();
      try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* win file locks */ }
    },
  };
}

const GUARANTEE_PACK = `name: saga-pack
guarantees:
  - compensating
  - at-least-once
`;

const unknownIssues = (res: { issues: { code: string; specId?: string; message: string; severity: string }[] }) =>
  res.issues.filter(i => i.code === 'UNKNOWN_GUARANTEE');

describe('guarantee-token vocabulary — open schema, validator-checked', () => {
  it('accepts builtin tokens on both sides without findings', () => {
    const proj = createTempProject();
    proj.scenario({ methodGuarantees: ['idempotent'], stepAsserts: ['idempotent'] });
    proj.activate();
    try {
      const res = validateSddTree();
      expect(unknownIssues(res)).toHaveLength(0);
      expect(res.issues.filter(i => i.code === 'NARRATIVE_SEMANTIC_UNBACKED')).toHaveLength(0);
    } finally { proj.cleanup(); }
  });

  it('flags an undeclared token on an L3 method (UNKNOWN_GUARANTEE, warning, on the interface)', () => {
    const proj = createTempProject();
    proj.scenario({ methodGuarantees: ['idempotnet'] });
    proj.activate();
    try {
      const found = unknownIssues(validateSddTree());
      expect(found).toHaveLength(1);
      expect(found[0].severity).toBe('warning');
      expect(found[0].specId).toBe('irecord-store');
      expect(found[0].message).toContain('"idempotnet"');
      expect(found[0].message).toContain('guarantees');
    } finally { proj.cleanup(); }
  });

  it('flags an undeclared token asserted by a narrative step (on the implementation)', () => {
    const proj = createTempProject();
    proj.scenario({ methodGuarantees: ['atomic'], stepAsserts: ['atomical'] });
    proj.activate();
    try {
      const found = unknownIssues(validateSddTree());
      expect(found).toHaveLength(1);
      expect(found[0].specId).toBe('impl-flow-orch');
      expect(found[0].message).toContain('"atomical"');
    } finally { proj.cleanup(); }
  });

  it('accepts a pack-declared token end to end (vocabulary + consistency both work)', () => {
    const proj = createTempProject(['.wai/packs/saga.yaml']);
    proj.writeFile('.wai/packs/saga.yaml', GUARANTEE_PACK);
    proj.scenario({ methodGuarantees: ['compensating'], stepAsserts: ['compensating'] });
    proj.activate();
    try {
      const res = validateSddTree();
      expect(unknownIssues(res)).toHaveLength(0);
      expect(res.issues.filter(i => i.code === 'NARRATIVE_SEMANTIC_UNBACKED')).toHaveLength(0);
    } finally { proj.cleanup(); }
  });

  it('still runs the consistency check on pack tokens: asserting one the contract does not declare is NARRATIVE_SEMANTIC_UNBACKED', () => {
    const proj = createTempProject(['.wai/packs/saga.yaml']);
    proj.writeFile('.wai/packs/saga.yaml', GUARANTEE_PACK);
    proj.scenario({ methodGuarantees: [], stepAsserts: ['compensating'] });
    proj.activate();
    try {
      const res = validateSddTree();
      expect(unknownIssues(res)).toHaveLength(0);
      const unbacked = res.issues.filter(i => i.code === 'NARRATIVE_SEMANTIC_UNBACKED');
      expect(unbacked).toHaveLength(1);
      expect(unbacked[0].message).toContain('"compensating"');
    } finally { proj.cleanup(); }
  });

  it('a pack token from a SECOND pack merges into the vocabulary (dedup across packs)', () => {
    const proj = createTempProject(['.wai/packs/saga.yaml', '.wai/packs/saga2.yaml']);
    proj.writeFile('.wai/packs/saga.yaml', GUARANTEE_PACK);
    proj.writeFile('.wai/packs/saga2.yaml', 'name: saga2-pack\nguarantees:\n  - compensating\n  - monotonic\n');
    proj.scenario({ methodGuarantees: ['monotonic'], stepAsserts: ['monotonic'] });
    proj.activate();
    try {
      expect(unknownIssues(validateSddTree())).toHaveLength(0);
    } finally { proj.cleanup(); }
  });
});
