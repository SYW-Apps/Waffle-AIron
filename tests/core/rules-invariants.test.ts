import { describe, it, expect, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { validateSddTree } from '../../src/core/validation.js';
import { invalidateSpecCache } from '../../src/core/specs.js';

// ---------------------------------------------------------------------------
// Invariant registry — the HONEST declaration+backing linter. An entity
// declares invariants; its componentClass's write-effect methods must each
// carry a narrative step asserting them. Green means "every write path
// visibly claims the property" — enforcement is never proven here.
// ---------------------------------------------------------------------------

function createTempProject() {
  invalidateSpecCache();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-invariants-test-'));

  const waiDir = path.join(tempDir, '.wai');
  fs.mkdirSync(waiDir);
  fs.writeFileSync(path.join(waiDir, 'project.yaml'), JSON.stringify({
    schemaVersion: '1.0.0',
    name: 'test-project',
    targets: [{ type: 'claude', outputDir: '.claude/agents', enabled: true }],
    rules: {
      noOverlappingOwnership: true,
      requireOwnedPaths: true,
      metaAgentTags: ['meta'],
      enforceReproducibility: true,
    },
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

  return {
    tempDir,
    writeSpec,
    component: (id: string, type: string, extra = '') =>
      writeSpec('component', id, `schemaVersion: 1.0.0\nid: ${id}\nname: ${id}\ndescription: d\nsubsystem: sub-a\ncomponentType: ${type}\n${extra}`),
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
    entity: (id: string, extra: string) =>
      writeSpec('type', id, `kind: entity\nid: ${id}\nname: ${id}\ndescription: an entity\nsubsystem: sub-a\n${extra}`),
    activate: () => { vi.spyOn(process, 'cwd').mockReturnValue(tempDir); },
    cleanup: () => {
      invalidateSpecCache();
      vi.restoreAllMocks();
      try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* win file locks */ }
    },
  };
}

const CODES = ['DUPLICATE_INVARIANT_ID', 'INVARIANT_UNANCHORED', 'UNASSERTED_INVARIANT', 'UNKNOWN_INVARIANT_REF'];
const invariantIssues = (res: { issues: { code: string; specId?: string; message: string; severity: string }[] }) =>
  res.issues.filter(i => CODES.includes(i.code));

const UNIT_INVARIANTS = [
  'componentClass: unit-registry',
  'invariants:',
  '  - id: slug-unique-among-siblings',
  '    description: A unit slug is unique among the children of its parent unit.',
].join('\n');

const ASSERTING_WRITE = (invRef: string) => [
  '  - name: createUnit',
  '    narrative:',
  '      - stepNumber: 1',
  '        description: Reject a slug that collides with any sibling under the target parent',
  '        type: local',
  `        assertsInvariants: [${invRef}]`,
  '      - stepNumber: 2',
  '        description: Persist the unit record',
  '        type: local',
].join('\n');

const SILENT_WRITE = [
  '  - name: createUnit',
  '    narrative:',
  '      - stepNumber: 1',
  '        description: Persist the unit record',
  '        type: local',
].join('\n');

describe('invariant-backing — declaration + assertion, never a proof', () => {
  it('passes when every write method carries an asserting step', () => {
    const proj = createTempProject();
    proj.component('unit-registry', 'Registry');
    proj.contract('unit-registry', [{ name: 'getUnit', effect: 'read' }, { name: 'createUnit', effect: 'write' }]);
    proj.impl('unit-registry', `methods:\n${ASSERTING_WRITE('org-unit.slug-unique-among-siblings')}`);
    proj.entity('org-unit', UNIT_INVARIANTS);
    proj.activate();
    try {
      expect(invariantIssues(validateSddTree())).toHaveLength(0);
    } finally { proj.cleanup(); }
  });

  it('flags a write method with no asserting step (UNASSERTED_INVARIANT, warning)', () => {
    const proj = createTempProject();
    proj.component('unit-registry', 'Registry');
    proj.contract('unit-registry', [{ name: 'createUnit', effect: 'write' }]);
    proj.impl('unit-registry', `methods:\n${SILENT_WRITE}`);
    proj.entity('org-unit', UNIT_INVARIANTS);
    proj.activate();
    try {
      const found = invariantIssues(validateSddTree());
      expect(found).toHaveLength(1);
      expect(found[0].code).toBe('UNASSERTED_INVARIANT');
      expect(found[0].severity).toBe('warning');
      expect(found[0].specId).toBe('impl-unit-registry');
      expect(found[0].message).toContain('slug-unique-among-siblings');
      expect(found[0].message).toContain('does not prove enforcement');
    } finally { proj.cleanup(); }
  });

  it('read-effect methods never need assertions', () => {
    const proj = createTempProject();
    proj.component('unit-registry', 'Registry');
    proj.contract('unit-registry', [{ name: 'getUnit', effect: 'read' }, { name: 'createUnit', effect: 'write' }]);
    proj.impl('unit-registry', `methods:\n${ASSERTING_WRITE('org-unit.slug-unique-among-siblings')}\n  - name: getUnit\n    intent: Reads the unit by id from held state and returns it, or null when absent at all.`);
    proj.entity('org-unit', UNIT_INVARIANTS);
    proj.activate();
    try {
      expect(invariantIssues(validateSddTree())).toHaveLength(0);
    } finally { proj.cleanup(); }
  });

  it('an entity with invariants but no componentClass is unanchored', () => {
    const proj = createTempProject();
    proj.entity('org-unit', [
      'invariants:',
      '  - id: slug-unique-among-siblings',
      '    description: A unit slug is unique among the children of its parent unit.',
    ].join('\n'));
    proj.activate();
    try {
      const found = invariantIssues(validateSddTree());
      expect(found).toHaveLength(1);
      expect(found[0].code).toBe('INVARIANT_UNANCHORED');
      expect(found[0].message).toContain('componentClass');
    } finally { proj.cleanup(); }
  });

  it('an owning component with no write-effect methods is unanchored (tag the writes)', () => {
    const proj = createTempProject();
    proj.component('unit-registry', 'Registry');
    proj.contract('unit-registry', [{ name: 'createUnit' }]); // no effect tags at all
    proj.impl('unit-registry', `methods:\n${SILENT_WRITE}`);
    proj.entity('org-unit', UNIT_INVARIANTS);
    proj.activate();
    try {
      const found = invariantIssues(validateSddTree());
      expect(found).toHaveLength(1);
      expect(found[0].code).toBe('INVARIANT_UNANCHORED');
      expect(found[0].message).toContain('effect: write');
    } finally { proj.cleanup(); }
  });

  it('a dangling assertion reference is an error (unknown entity and unknown invariant id)', () => {
    const proj = createTempProject();
    proj.component('unit-registry', 'Registry');
    proj.contract('unit-registry', [{ name: 'createUnit', effect: 'write' }]);
    proj.impl('unit-registry', `methods:\n${ASSERTING_WRITE('org-unit.no-such-invariant')}`);
    proj.entity('org-unit', UNIT_INVARIANTS);
    proj.activate();
    try {
      const found = invariantIssues(validateSddTree());
      const codes = found.map(i => i.code).sort();
      // the bad ref errors AND the real invariant stays unasserted
      expect(codes).toEqual(['UNASSERTED_INVARIANT', 'UNKNOWN_INVARIANT_REF']);
      const unknown = found.find(i => i.code === 'UNKNOWN_INVARIANT_REF')!;
      expect(unknown.severity).toBe('error');
      expect(unknown.message).toContain('org-unit.no-such-invariant');
    } finally { proj.cleanup(); }
  });

  it('duplicate invariant ids on one entity are an error', () => {
    const proj = createTempProject();
    proj.component('unit-registry', 'Registry');
    proj.contract('unit-registry', [{ name: 'createUnit', effect: 'write' }]);
    proj.impl('unit-registry', `methods:\n${ASSERTING_WRITE('org-unit.slug-unique-among-siblings')}`);
    proj.entity('org-unit', [
      'componentClass: unit-registry',
      'invariants:',
      '  - id: slug-unique-among-siblings',
      '    description: A unit slug is unique among the children of its parent unit.',
      '  - id: slug-unique-among-siblings',
      '    description: duplicated declaration',
    ].join('\n'));
    proj.activate();
    try {
      const found = invariantIssues(validateSddTree());
      expect(found.map(i => i.code)).toContain('DUPLICATE_INVARIANT_ID');
      expect(found.find(i => i.code === 'DUPLICATE_INVARIANT_ID')!.severity).toBe('error');
    } finally { proj.cleanup(); }
  });

  it('resolves subsystem-qualified references onto the same entity', () => {
    const proj = createTempProject();
    proj.component('unit-registry', 'Registry');
    proj.contract('unit-registry', [{ name: 'createUnit', effect: 'write' }]);
    proj.impl('unit-registry', `methods:\n${ASSERTING_WRITE('sub-a.org-unit.slug-unique-among-siblings')}`);
    proj.entity('org-unit', UNIT_INVARIANTS);
    proj.activate();
    try {
      expect(invariantIssues(validateSddTree())).toHaveLength(0);
    } finally { proj.cleanup(); }
  });

  it('UNASSERTED_INVARIANT is silenceable per spec via lint.allow', () => {
    const proj = createTempProject();
    proj.component('unit-registry', 'Registry');
    proj.contract('unit-registry', [{ name: 'createUnit', effect: 'write' }]);
    proj.impl('unit-registry', [
      'lint:',
      '  allow:',
      '    - code: UNASSERTED_INVARIANT',
      '      reason: uniqueness is enforced by the backing store schema, asserted in its own spec',
      'methods:',
      SILENT_WRITE,
    ].join('\n'));
    proj.entity('org-unit', UNIT_INVARIANTS);
    proj.activate();
    try {
      expect(invariantIssues(validateSddTree())).toHaveLength(0);
    } finally { proj.cleanup(); }
  });

  it('multiple invariants each need their own assertion on every write method', () => {
    const proj = createTempProject();
    proj.component('unit-registry', 'Registry');
    proj.contract('unit-registry', [{ name: 'createUnit', effect: 'write' }, { name: 'renameUnit', effect: 'write' }]);
    proj.impl('unit-registry', `methods:\n${ASSERTING_WRITE('org-unit.slug-unique-among-siblings')}`); // renameUnit has no narrative at all
    proj.entity('org-unit', [
      'componentClass: unit-registry',
      'invariants:',
      '  - id: slug-unique-among-siblings',
      '    description: A unit slug is unique among the children of its parent unit.',
      '  - id: qualified-name-stable',
      '    description: A unit qualified name always reflects its current ancestor chain.',
    ].join('\n'));
    proj.activate();
    try {
      const found = invariantIssues(validateSddTree()).filter(i => i.code === 'UNASSERTED_INVARIANT');
      // createUnit misses the second invariant; renameUnit misses both
      expect(found).toHaveLength(3);
    } finally { proj.cleanup(); }
  });
});
