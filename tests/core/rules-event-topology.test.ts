import { describe, it, expect, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { validateSddTree } from '../../src/core/validation.js';
import { invalidateSpecCache } from '../../src/core/specs.js';

// ---------------------------------------------------------------------------
// Event topology — bipartite completeness of the declared pub/sub graph
// (emits/subscribesTo declarations + MessageBus endpoint directions), and the
// open entrypoint kinds (cyclic/interrupt/scheduled) as reachability roots.
// ---------------------------------------------------------------------------

function createTempProject() {
  invalidateSpecCache();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-event-top-test-'));

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

const byCode = (res: { issues: { code: string; specId?: string; message: string; severity: string }[] }, code: string) =>
  res.issues.filter(i => i.code === code);

const EMITTER = 'emits:\n  - topic: orders.events\n    event: order-placed';
const SUBSCRIBER = 'subscribesTo:\n  - topic: orders.events';

describe('event-topology — every topic needs both ends', () => {
  it('a request/response tree with no event edges sees nothing', () => {
    const proj = createTempProject();
    proj.subsystem('sub-a');
    proj.component('flow-orch', 'sub-a', 'Orchestrator');
    proj.activate();
    try {
      const res = validateSddTree();
      expect(byCode(res, 'UNCONSUMED_TOPIC')).toHaveLength(0);
      expect(byCode(res, 'UNSOURCED_SUBSCRIPTION')).toHaveLength(0);
    } finally { proj.cleanup(); }
  });

  it('flags an emitted topic nobody subscribes to', () => {
    const proj = createTempProject();
    proj.subsystem('sub-a');
    proj.component('flow-orch', 'sub-a', 'Orchestrator', EMITTER);
    proj.activate();
    try {
      const found = byCode(validateSddTree(), 'UNCONSUMED_TOPIC');
      expect(found).toHaveLength(1);
      expect(found[0].severity).toBe('warning');
      expect(found[0].message).toContain('orders.events');
    } finally { proj.cleanup(); }
  });

  it('flags a subscription nothing emits', () => {
    const proj = createTempProject();
    proj.subsystem('sub-a');
    proj.component('order-observer', 'sub-a', 'Observer', `${SUBSCRIBER}\ndependsOn: [flow-orch]`);
    proj.component('flow-orch', 'sub-a', 'Orchestrator');
    proj.activate();
    try {
      const found = byCode(validateSddTree(), 'UNSOURCED_SUBSCRIPTION');
      expect(found).toHaveLength(1);
      expect(found[0].message).toContain('orders.events');
    } finally { proj.cleanup(); }
  });

  it('a matched emit/subscribe pair is silent, across declaration kinds', () => {
    const proj = createTempProject();
    proj.subsystem('sub-a');
    proj.component('flow-orch', 'sub-a', 'Orchestrator', EMITTER);
    proj.component('order-observer', 'sub-a', 'Observer', `${SUBSCRIBER}\ndependsOn: [flow-orch]`);
    proj.activate();
    try {
      const res = validateSddTree();
      expect(byCode(res, 'UNCONSUMED_TOPIC')).toHaveLength(0);
      expect(byCode(res, 'UNSOURCED_SUBSCRIPTION')).toHaveLength(0);
    } finally { proj.cleanup(); }
  });

  it('MessageBus endpoints count as ends: a publish endpoint satisfies a subscribesTo', () => {
    const proj = createTempProject();
    proj.subsystem('sub-a');
    proj.component('bus-portal', 'sub-a', 'Portal', 'portalType: MessageBus\ndependsOn: [flow-orch]');
    proj.component('flow-orch', 'sub-a', 'Orchestrator');
    proj.component('order-observer', 'sub-a', 'Observer', `${SUBSCRIBER}\ndependsOn: [flow-orch]`);
    const specsDir = path.join(proj.tempDir, '.wai', 'specs');
    fs.writeFileSync(path.join(specsDir, 'interfaces', 'ibus-portal.yaml'), [
      'schemaVersion: 1.0.0',
      'id: ibus-portal',
      'name: IBusPortal',
      'description: contract',
      'component: bus-portal',
      'methods:',
      '  - name: announceOrder',
      '    description: announces a placed order onto the bus for downstream consumers',
      '    signature: "announceOrder(): void"',
      '    returns: "void"',
      '    endpoint:',
      '      transport: MessageBus',
      '      topic: orders.events',
      '      event: order-placed',
      '      direction: publish',
      "createdAt: '2026-07-18T10:00:00Z'",
      "updatedAt: '2026-07-18T10:00:00Z'",
    ].join('\n'));
    proj.activate();
    try {
      const res = validateSddTree();
      expect(byCode(res, 'UNSOURCED_SUBSCRIPTION')).toHaveLength(0);
      expect(byCode(res, 'UNCONSUMED_TOPIC')).toHaveLength(0);
    } finally { proj.cleanup(); }
  });

  it('is silenceable per spec via lint.allow (external consumer)', () => {
    const proj = createTempProject();
    proj.subsystem('sub-a');
    proj.component('flow-orch', 'sub-a', 'Orchestrator', `${EMITTER}\nlint:\n  allow:\n    - code: UNCONSUMED_TOPIC\n      reason: consumed by the external billing platform, not by this tree`);
    proj.activate();
    try {
      expect(byCode(validateSddTree(), 'UNCONSUMED_TOPIC')).toHaveLength(0);
    } finally { proj.cleanup(); }
  });
});

describe('open entrypoint kinds — cyclic/interrupt/scheduled root the walker', () => {
  it('a cyclic entrypoint keeps a scan-model component reachable (no UNUSED storm)', () => {
    const proj = createTempProject();
    proj.subsystem('sub-a', [
      'lifecycle:',
      '  - phase: cyclic',
      '    component: scan-orch',
      '    method: runScan',
      '    description: invoked every 10ms scan',
    ].join('\n'));
    proj.component('scan-orch', 'sub-a', 'Orchestrator');
    proj.contract('scan-orch', ['runScan']);
    proj.impl('scan-orch', [
      'methods:',
      '  - name: runScan',
      '    narrative:',
      '      - { stepNumber: 1, description: Read the input image, execute the program, write outputs, type: local }',
      '      - { stepNumber: 2, description: Done for this scan, type: return, outcome: scan complete }',
    ].join('\n'));
    proj.activate();
    try {
      const res = validateSddTree();
      expect(byCode(res, 'UNUSED_COMPONENT')).toHaveLength(0);
      expect(byCode(res, 'INVALID_LIFECYCLE_ENTRYPOINT')).toHaveLength(0);
    } finally { proj.cleanup(); }
  });

  it('a dangling scheduled entrypoint is still an error', () => {
    const proj = createTempProject();
    proj.subsystem('sub-a', [
      'lifecycle:',
      '  - phase: scheduled',
      '    component: gone',
      '    method: tick',
    ].join('\n'));
    proj.component('flow-orch', 'sub-a', 'Orchestrator');
    proj.activate();
    try {
      expect(byCode(validateSddTree(), 'INVALID_LIFECYCLE_ENTRYPOINT').length).toBeGreaterThan(0);
    } finally { proj.cleanup(); }
  });
});
