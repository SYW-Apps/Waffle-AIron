import { describe, it, expect, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { validateSddTree } from '../../src/core/validation.js';
import { invalidateSpecCache } from '../../src/core/specs.js';
import { assertionFullCode } from '../../src/core/extensions.js';

// ---------------------------------------------------------------------------
// Declarative rule assertions: packs contribute INSTANCES of closed kinds
// (forbid-edge / require-field / endpoint-shape) — data, never logic — so
// hosted declarative-only packs carry real doctrine. Codes surface namespaced
// (<PACK>_<CODE>) and behave like builtins for lint.allow / severity.
// ---------------------------------------------------------------------------

function createTempProject(packYaml?: string) {
  invalidateSpecCache();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-assert-test-'));

  const waiDir = path.join(tempDir, '.wai');
  fs.mkdirSync(waiDir);
  fs.writeFileSync(path.join(waiDir, 'project.yaml'), JSON.stringify({
    schemaVersion: '1.0.0',
    name: 'test-project',
    projectType: 'backend',
    targets: [{ type: 'claude', outputDir: '.claude/agents', enabled: true }],
    rules: {},
    ...(packYaml ? { extensions: { packs: ['.wai/packs/doctrine.yaml'], useGlobalPacks: false } } : {}),
    createdAt: '2026-07-19T10:00:00Z',
    updatedAt: '2026-07-19T10:00:00Z',
  }));
  if (packYaml) {
    fs.mkdirSync(path.join(waiDir, 'packs'), { recursive: true });
    fs.writeFileSync(path.join(waiDir, 'packs', 'doctrine.yaml'), packYaml);
  }

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
  writeSpec('subsystem', 'sub-a', 'schemaVersion: 1.0.0\nid: sub-a\nname: SubA\ndescription: d\nparentSystem: TestSystem');

  return {
    writeSpec,
    activate: () => { vi.spyOn(process, 'cwd').mockReturnValue(tempDir); },
    cleanup: () => {
      invalidateSpecCache();
      vi.restoreAllMocks();
      try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* win file locks */ }
    },
  };
}

describe('assertionFullCode', () => {
  it('namespaces and normalizes', () => {
    expect(assertionFullCode('make-automation-pack', 'no-direct-store')).toBe('MAKE_AUTOMATION_PACK_NO_DIRECT_STORE');
  });
});

describe('declarative assertions', () => {
  it('forbid-edge fires with the namespaced code and the pack reason', () => {
    const proj = createTempProject([
      'name: doctrine-pack',
      'assertions:',
      '  - kind: forbid-edge',
      '    code: no-specialist-store',
      '    reason: reach data through the facade',
      '    from: { componentType: [Orchestrator] }',
      '    to: { componentType: [Store] }',
      '    relation: [dependsOn]',
    ].join('\n'));
    proj.writeSpec('component', 'orch-a', 'schemaVersion: 1.0.0\nid: orch-a\nname: orch-a\ndescription: d\nsubsystem: sub-a\ncomponentType: Orchestrator\ndependsOn: [store-b]');
    proj.writeSpec('component', 'store-b', 'schemaVersion: 1.0.0\nid: store-b\nname: store-b\ndescription: d\nsubsystem: sub-a\ncomponentType: Store\ndurability: ram-projection');
    proj.activate();
    try {
      const res = validateSddTree();
      const found = res.issues.filter(i => i.code === 'DOCTRINE_PACK_NO_SPECIALIST_STORE');
      expect(found).toHaveLength(1);
      expect(found[0].severity).toBe('warning');
      expect(found[0].specId).toBe('orch-a');
      expect(found[0].message).toContain('reach data through the facade');
      expect(found[0].message).toContain('[pack "doctrine-pack"]');
    } finally { proj.cleanup(); }
  });

  it('require-field checks ext.* paths and closed value sets', () => {
    const proj = createTempProject([
      'name: doctrine-pack',
      'assertions:',
      '  - kind: require-field',
      '    code: region-declared',
      '    reason: every store pins its residency region',
      '    on: { componentType: [Store] }',
      '    level: implementation',
      '    field: ext.doctrine.region',
      '    values: [eu, us]',
    ].join('\n'));
    proj.writeSpec('component', 'store-a', 'schemaVersion: 1.0.0\nid: store-a\nname: store-a\ndescription: d\nsubsystem: sub-a\ncomponentType: Store\ndurability: ram-projection');
    proj.writeSpec('component', 'store-b', 'schemaVersion: 1.0.0\nid: store-b\nname: store-b\ndescription: d\nsubsystem: sub-a\ncomponentType: Store\ndurability: ram-projection');
    proj.writeSpec('interface', 'istore-a', 'schemaVersion: 1.0.0\nid: istore-a\nname: IA\ndescription: d\ncomponent: store-a\nmethods: []');
    proj.writeSpec('interface', 'istore-b', 'schemaVersion: 1.0.0\nid: istore-b\nname: IB\ndescription: d\ncomponent: store-b\nmethods: []');
    proj.writeSpec('implementation', 'impl-a', 'schemaVersion: 1.0.0\nid: impl-a\nname: A\ndescription: d\ncontract: istore-a\next:\n  doctrine:\n    region: eu\nmethods: []');
    proj.writeSpec('implementation', 'impl-b', 'schemaVersion: 1.0.0\nid: impl-b\nname: B\ndescription: d\ncontract: istore-b\next:\n  doctrine:\n    region: mars\nmethods: []');
    proj.activate();
    try {
      const found = validateSddTree().issues.filter(i => i.code === 'DOCTRINE_PACK_REGION_DECLARED');
      expect(found).toHaveLength(1);
      expect(found[0].specId).toBe('impl-b');
      expect(found[0].message).toContain('"mars"');
    } finally { proj.cleanup(); }
  });

  it('endpoint-shape enforces transport allowlist and address pattern', () => {
    const proj = createTempProject([
      'name: doctrine-pack',
      'assertions:',
      '  - kind: endpoint-shape',
      '    code: webhook-paths',
      '    reason: webhooks mount under /hooks',
      '    on: { componentType: [Portal] }',
      '    transport: [HTTP]',
      "    pathPattern: '^/hooks/[a-z0-9-]+$'",
    ].join('\n'));
    proj.writeSpec('component', 'portal-a', 'schemaVersion: 1.0.0\nid: portal-a\nname: portal-a\ndescription: d\nsubsystem: sub-a\ncomponentType: Portal\nportalType: HTTP_API');
    proj.writeSpec('interface', 'iportal-a', [
      'schemaVersion: 1.0.0',
      'id: iportal-a',
      'name: IPortalA',
      'description: d',
      'component: portal-a',
      'methods:',
      '  - name: onOrder',
      '    description: Receives the order webhook and forwards it inward faithfully.',
      '    signature: "onOrder(): void"',
      '    returns: "void"',
      '    endpoint: { transport: HTTP, method: POST, path: /hooks/order-created }',
      '  - name: onLegacy',
      '    description: Receives the legacy webhook on its historical route.',
      '    signature: "onLegacy(): void"',
      '    returns: "void"',
      '    endpoint: { transport: HTTP, method: POST, path: /legacy/hook }',
    ].join('\n'));
    proj.activate();
    try {
      const found = validateSddTree().issues.filter(i => i.code === 'DOCTRINE_PACK_WEBHOOK_PATHS');
      expect(found).toHaveLength(1);
      expect(found[0].message).toContain('/legacy/hook');
    } finally { proj.cleanup(); }
  });

  it('assertion codes are lint.allow-able like builtins', () => {
    const proj = createTempProject([
      'name: doctrine-pack',
      'assertions:',
      '  - kind: forbid-edge',
      '    code: no-specialist-store',
      '    reason: reach data through the facade',
      '    from: { componentType: [Orchestrator] }',
      '    to: { componentType: [Store] }',
    ].join('\n'));
    proj.writeSpec('component', 'orch-a', [
      'schemaVersion: 1.0.0\nid: orch-a\nname: orch-a\ndescription: d\nsubsystem: sub-a\ncomponentType: Orchestrator\ndependsOn: [store-b]',
      'lint:',
      '  allow:',
      '    - code: DOCTRINE_PACK_NO_SPECIALIST_STORE',
      '      reason: transitional wiring, facade lands next sprint',
    ].join('\n'));
    proj.writeSpec('component', 'store-b', 'schemaVersion: 1.0.0\nid: store-b\nname: store-b\ndescription: d\nsubsystem: sub-a\ncomponentType: Store\ndurability: ram-projection');
    proj.activate();
    try {
      const res = validateSddTree();
      expect(res.issues.filter(i => i.code === 'DOCTRINE_PACK_NO_SPECIALIST_STORE')).toHaveLength(0);
      // and the allow is recognized, not flagged as unknown
      expect(res.issues.filter(i => i.code === 'UNKNOWN_LINT_ALLOW_CODE')).toHaveLength(0);
    } finally { proj.cleanup(); }
  });

  it('an unknown assertion kind fails the pack load loudly (EXTENSION_LOAD_ERROR)', () => {
    const proj = createTempProject([
      'name: doctrine-pack',
      'assertions:',
      '  - kind: teleport-check',
      '    code: nope',
      '    reason: from the future',
    ].join('\n'));
    proj.activate();
    try {
      const res = validateSddTree();
      expect(res.issues.some(i => i.code === 'EXTENSION_LOAD_ERROR')).toBe(true);
    } finally { proj.cleanup(); }
  });
});
