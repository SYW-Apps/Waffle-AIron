import { describe, it, expect, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { validateSddTree } from '../../src/core/validation.js';
import { invalidateSpecCache } from '../../src/core/specs.js';

// ---------------------------------------------------------------------------
// Facade forwarding (§7): a Repository/Gateway facade method with an authored
// narrative must be exactly one call step to an owned member. Dogfooded at
// zero cost — all 63 narrated facade methods in wairon's own tree already
// conform, so the standard's "mechanically enforceable" claim ships as a rule.
// ---------------------------------------------------------------------------

function createTempProject() {
  invalidateSpecCache();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-facade-test-'));

  const waiDir = path.join(tempDir, '.wai');
  fs.mkdirSync(waiDir);
  fs.writeFileSync(path.join(waiDir, 'project.yaml'), JSON.stringify({
    schemaVersion: '1.0.0',
    name: 'test-project',
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
  writeSpec('subsystem', 'sub-a', 'schemaVersion: 1.0.0\nid: sub-a\nname: SubA\ndescription: d\nparentSystem: TestSystem');

  // A Repository facade owning store+registry, with a workflow consumer.
  writeSpec('component', 'record-repository', 'schemaVersion: 1.0.0\nid: record-repository\nname: record-repository\ndescription: d\nsubsystem: sub-a\ncomponentType: Repository\nowns: [record-store, record-registry]');
  writeSpec('component', 'record-store', 'schemaVersion: 1.0.0\nid: record-store\nname: record-store\ndescription: d\nsubsystem: sub-a\ncomponentType: Store\ndurability: ram-projection');
  writeSpec('component', 'record-registry', 'schemaVersion: 1.0.0\nid: record-registry\nname: record-registry\ndescription: d\nsubsystem: sub-a\ncomponentType: Registry\ndependsOn: [record-store]');
  writeSpec('component', 'other-specialist', 'schemaVersion: 1.0.0\nid: other-specialist\nname: other-specialist\ndescription: d\nsubsystem: sub-a\ncomponentType: Specialist');
  writeSpec('interface', 'irecord-registry', [
    'schemaVersion: 1.0.0',
    'id: irecord-registry',
    'name: IRecordRegistry',
    'description: d',
    'component: record-registry',
    'methods:',
    '  - name: storeRecord',
    '    description: Validates and persists the record through the backing store faithfully.',
    '    signature: "storeRecord(id: string): void"',
    '    returns: "void"',
  ].join('\n'));
  writeSpec('interface', 'iother-specialist', [
    'schemaVersion: 1.0.0',
    'id: iother-specialist',
    'name: IOtherSpecialist',
    'description: d',
    'component: other-specialist',
    'methods:',
    '  - name: transform',
    '    description: Transforms the record into its canonical wire representation for export.',
    '    signature: "transform(id: string): string"',
    '    returns: "string"',
  ].join('\n'));

  return {
    facadeContract: () => writeSpec('interface', 'irecord-repository', [
      'schemaVersion: 1.0.0',
      'id: irecord-repository',
      'name: IRecordRepository',
      'description: d',
      'component: record-repository',
      'methods:',
      '  - name: saveRecord',
      '    description: Persists one record through the pattern, delegating entirely to members.',
      '    signature: "saveRecord(id: string): void"',
      '    returns: "void"',
    ].join('\n')),
    facadeImpl: (narrativeLines: string[]) => writeSpec('implementation', 'impl-record-repository', [
      'schemaVersion: 1.0.0',
      'id: impl-record-repository',
      'name: ImplRecordRepository',
      'description: d',
      'contract: irecord-repository',
      'methods:',
      '  - name: saveRecord',
      '    narrative:',
      ...narrativeLines,
    ].join('\n')),
    activate: () => { vi.spyOn(process, 'cwd').mockReturnValue(tempDir); },
    cleanup: () => {
      invalidateSpecCache();
      vi.restoreAllMocks();
      try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* win file locks */ }
    },
  };
}

const facadeIssues = (res: { issues: { code: string; specId?: string; message: string; severity: string }[] }) =>
  res.issues.filter(i => i.code === 'FACADE_FORWARDING');

describe('facade-forwarding — §7 pure 1:1 forwarding on Repository/Gateway facades', () => {
  it('accepts a single call step to an owned member', () => {
    const proj = createTempProject();
    proj.facadeContract();
    proj.facadeImpl([
      '      - stepNumber: 1',
      '        description: Forward to the registry write face',
      '        type: call',
      '        targetComponent: record-registry',
      '        targetMethod: storeRecord',
    ]);
    proj.activate();
    try {
      expect(facadeIssues(validateSddTree())).toHaveLength(0);
    } finally { proj.cleanup(); }
  });

  it('accepts a facade method with NO narrative (the detail dial owns that)', () => {
    const proj = createTempProject();
    proj.facadeContract();
    proj.facadeImpl([]);
    proj.activate();
    try {
      expect(facadeIssues(validateSddTree())).toHaveLength(0);
    } finally { proj.cleanup(); }
  });

  it('flags a multi-step facade narrative (warning, on the implementation)', () => {
    const proj = createTempProject();
    proj.facadeContract();
    proj.facadeImpl([
      '      - stepNumber: 1',
      '        description: Normalize the record id before storing',
      '        type: local',
      '      - stepNumber: 2',
      '        description: Forward to the registry write face',
      '        type: call',
      '        targetComponent: record-registry',
      '        targetMethod: storeRecord',
    ]);
    proj.activate();
    try {
      const found = facadeIssues(validateSddTree());
      expect(found).toHaveLength(1);
      expect(found[0].severity).toBe('warning');
      expect(found[0].specId).toBe('impl-record-repository');
      expect(found[0].message).toContain('2 steps');
    } finally { proj.cleanup(); }
  });

  it('flags a single non-call step (local = logic on the facade)', () => {
    const proj = createTempProject();
    proj.facadeContract();
    proj.facadeImpl([
      '      - stepNumber: 1',
      '        description: Write the record into a private map held on the facade',
      '        type: local',
    ]);
    proj.activate();
    try {
      const found = facadeIssues(validateSddTree());
      expect(found).toHaveLength(1);
      expect(found[0].message).toContain('"local"');
    } finally { proj.cleanup(); }
  });

  it('flags a single call that leaves the pattern (target not owned)', () => {
    const proj = createTempProject();
    proj.facadeContract();
    proj.facadeImpl([
      '      - stepNumber: 1',
      '        description: Forward to an outside specialist',
      '        type: call',
      '        targetComponent: other-specialist',
      '        targetMethod: transform',
    ]);
    proj.activate();
    try {
      const found = facadeIssues(validateSddTree());
      expect(found).toHaveLength(1);
      expect(found[0].message).toContain('other-specialist');
    } finally { proj.cleanup(); }
  });

  it('is suppressible via lint.allow on the implementation', () => {
    const proj = createTempProject();
    proj.facadeContract();
    proj.facadeImpl([
      '      - stepNumber: 1',
      '        description: Normalize the record id before storing',
      '        type: local',
      '      - stepNumber: 2',
      '        description: Forward to the registry write face',
      '        type: call',
      '        targetComponent: record-registry',
      '        targetMethod: storeRecord',
      'lint:',
      '  allow:',
      '    - code: FACADE_FORWARDING',
      '      reason: transitional — normalization moves into the registry next pass',
    ]);
    proj.activate();
    try {
      expect(facadeIssues(validateSddTree())).toHaveLength(0);
    } finally { proj.cleanup(); }
  });
});
