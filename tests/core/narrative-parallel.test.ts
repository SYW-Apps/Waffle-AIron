import { describe, it, expect, vi, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { validateSddTree } from '../../src/core/validation.js';
import { invalidateSpecCache, updateSpec, saveSubsystemSpec, saveInterfaceSpec, saveImplementationSpec, loadImplementationSpec } from '../../src/core/specs.js';
import { setProjectRoot } from '../../src/utils/fs.js';
import { stepGraph } from '../../src/core/rules/narrative-flow.js';
import type { NarrativeStep } from '../../src/models/index.js';

const now = new Date().toISOString();

// ---------------------------------------------------------------------------
// parallel fan-out/join + detach. A parallel body is covered by contiguous
// ordered arms; the join is implicit after endStep once ALL arms complete —
// an arm's last step continues at the join, never into its neighbor arm.
// ---------------------------------------------------------------------------

const step = (o: Partial<NarrativeStep> & { stepNumber: number; type: NarrativeStep['type'] }): NarrativeStep =>
  ({ description: `step ${o.stepNumber}`, ...o } as NarrativeStep);

describe('stepGraph parallel successor semantics', () => {
  const steps: NarrativeStep[] = [
    step({ stepNumber: 1, type: 'parallel', branches: [{ step: 2 }, { step: 4 }], endStep: 5 }),
    step({ stepNumber: 2, type: 'local' }),
    step({ stepNumber: 3, type: 'local' }), // arm 1 end
    step({ stepNumber: 4, type: 'local' }),
    step({ stepNumber: 5, type: 'local' }), // arm 2 end = endStep
    step({ stepNumber: 6, type: 'return' }),
  ];

  it('fans out to every arm entry plus the join continuation', () => {
    const g = stepGraph(steps);
    expect(g.successorsOf(1).sort()).toEqual([2, 4, 6]);
  });

  it('an arm-end falls through to the JOIN, never into the neighbor arm', () => {
    const g = stepGraph(steps);
    expect(g.successorsOf(3)).toEqual([6]); // not 4
    expect(g.successorsOf(5)).toEqual([6]);
  });

  it('nested parallel whose endStep is an outer arm end joins through the outer mapping', () => {
    const nested: NarrativeStep[] = [
      step({ stepNumber: 1, type: 'parallel', branches: [{ step: 2 }, { step: 6 }], endStep: 6 }),
      step({ stepNumber: 2, type: 'parallel', branches: [{ step: 3 }, { step: 4 }], endStep: 5 }),
      step({ stepNumber: 3, type: 'local' }),
      step({ stepNumber: 4, type: 'local' }),
      step({ stepNumber: 5, type: 'local' }), // inner arm 2 end; inner endStep; ALSO outer arm-1 end
      step({ stepNumber: 6, type: 'local' }), // outer arm 2
      step({ stepNumber: 7, type: 'return' }),
    ];
    const g = stepGraph(nested);
    // Outer arm 1 spans 2..5 (its end 5 maps to outer join 7); the inner
    // parallel's own join = fallNext(5) = 7 as well.
    expect(g.successorsOf(3)).toEqual([7]);
    expect(g.successorsOf(5)).toEqual([7]);
    expect(g.successorsOf(6)).toEqual([7]);
    expect(g.successorsOf(2).sort()).toEqual([3, 4, 7]);
  });
});

describe('narrative-flow parallel/detach soundness (via validateSddTree)', () => {
  let proj: string | undefined;
  afterEach(() => {
    invalidateSpecCache();
    vi.restoreAllMocks();
    if (proj) { try { fs.rmSync(proj, { recursive: true, force: true }); } catch { /* win */ } }
    proj = undefined;
  });

  function tempProject(narrativeYaml: string[]) {
    invalidateSpecCache();
    proj = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-parallel-test-'));
    const waiDir = path.join(proj, '.wai');
    fs.mkdirSync(waiDir);
    fs.writeFileSync(path.join(waiDir, 'project.yaml'), JSON.stringify({
      schemaVersion: '1.0.0', name: 'test-project',
      targets: [{ type: 'claude', outputDir: '.claude/agents', enabled: true }],
      rules: {},
    }));
    const specsDir = path.join(waiDir, 'specs');
    for (const d of ['subsystems', 'components', 'interfaces', 'implementations', 'types']) {
      fs.mkdirSync(path.join(specsDir, d), { recursive: true });
    }
    const stamp = "createdAt: '2026-07-19T10:00:00Z'\nupdatedAt: '2026-07-19T10:00:00Z'";
    const writeSpec = (type: string, name: string, content: string) => {
      const p = type === 'system' ? path.join(specsDir, '.index.yaml') : path.join(specsDir, `${type}s`, `${name}.yaml`);
      fs.writeFileSync(p, `${content}\n${stamp}\n`);
    };
    writeSpec('system', 'system', 'schemaVersion: 1.0.0\nname: TestSystem\nvision: testing');
    writeSpec('subsystem', 'sub-a', 'schemaVersion: 1.0.0\nid: sub-a\nname: SubA\ndescription: d\nparentSystem: TestSystem');
    writeSpec('component', 'fan-orch', 'schemaVersion: 1.0.0\nid: fan-orch\nname: fan-orch\ndescription: d\nsubsystem: sub-a\ncomponentType: Orchestrator\ndependsOn: [side-a, side-b]');
    writeSpec('component', 'side-a', 'schemaVersion: 1.0.0\nid: side-a\nname: side-a\ndescription: d\nsubsystem: sub-a\ncomponentType: Specialist');
    writeSpec('component', 'side-b', 'schemaVersion: 1.0.0\nid: side-b\nname: side-b\ndescription: d\nsubsystem: sub-a\ncomponentType: Specialist');
    writeSpec('interface', 'iside-a', 'schemaVersion: 1.0.0\nid: iside-a\nname: ISideA\ndescription: d\ncomponent: side-a\nmethods:\n  - name: workA\n    description: Performs the A-side work and reports the outcome plainly.\n    signature: "workA(): void"\n    returns: "void"');
    writeSpec('interface', 'iside-b', 'schemaVersion: 1.0.0\nid: iside-b\nname: ISideB\ndescription: d\ncomponent: side-b\nmethods:\n  - name: workB\n    description: Performs the B-side work and reports the outcome plainly.\n    signature: "workB(): void"\n    returns: "void"');
    writeSpec('interface', 'ifan-orch', 'schemaVersion: 1.0.0\nid: ifan-orch\nname: IFanOrch\ndescription: d\ncomponent: fan-orch\nmethods:\n  - name: fanOut\n    description: Runs both sides concurrently and reports when both have completed.\n    signature: "fanOut(): void"\n    returns: "void"');
    writeSpec('implementation', 'impl-fan-orch', [
      'schemaVersion: 1.0.0', 'id: impl-fan-orch', 'name: ImplFanOrch', 'description: d', 'contract: ifan-orch',
      'methods:',
      '  - name: fanOut',
      '    narrative:',
      ...narrativeYaml,
    ].join('\n'));
    vi.spyOn(process, 'cwd').mockReturnValue(proj);
  }

  const flowIssues = (codes: string[]) => {
    const res = validateSddTree();
    return res.issues.filter(i => codes.includes(i.code));
  };

  const VALID_PARALLEL = [
    '      - stepNumber: 1',
    '        description: Fan out both sides',
    '        type: parallel',
    '        branches: [{ step: 2 }, { step: 3 }]',
    '        endStep: 3',
    '      - stepNumber: 2',
    '        description: Run side A',
    '        type: call',
    '        targetComponent: side-a',
    '        targetMethod: workA',
    '      - stepNumber: 3',
    '        description: Run side B',
    '        type: call',
    '        targetComponent: side-b',
    '        targetMethod: workB',
    '      - stepNumber: 4',
    '        description: Both sides done',
    '        type: return',
  ];

  it('accepts a sound parallel fan-out (no flow findings, all steps reachable)', () => {
    tempProject(VALID_PARALLEL);
    expect(flowIssues(['MALFORMED_FLOW_STEP', 'INVALID_STEP_JUMP', 'UNREACHABLE_STEP'])).toHaveLength(0);
  });

  it('rejects a single-arm parallel (sequential flow in disguise)', () => {
    tempProject([
      '      - stepNumber: 1',
      '        description: Fan out',
      '        type: parallel',
      '        branches: [{ step: 2 }]',
      '        endStep: 2',
      '      - stepNumber: 2',
      '        description: only arm',
      '        type: local',
    ]);
    const found = flowIssues(['MALFORMED_FLOW_STEP']);
    expect(found.some(i => i.message.includes('at least two arms'))).toBe(true);
  });

  it('rejects a first arm that skips body steps, and entries beyond endStep', () => {
    tempProject([
      '      - stepNumber: 1',
      '        description: Fan out',
      '        type: parallel',
      '        branches: [{ step: 3 }, { step: 4 }]',
      '        endStep: 3',
      '      - stepNumber: 2',
      '        description: orphan',
      '        type: local',
      '      - stepNumber: 3',
      '        description: arm',
      '        type: local',
      '      - stepNumber: 4',
      '        description: outside',
      '        type: local',
    ]);
    const found = flowIssues(['MALFORMED_FLOW_STEP']);
    expect(found.some(i => i.message.includes('first arm must start'))).toBe(true);
    expect(found.some(i => i.message.includes('within the body'))).toBe(true);
  });

  it('flags a dangling branch entry as INVALID_STEP_JUMP', () => {
    tempProject([
      '      - stepNumber: 1',
      '        description: Fan out',
      '        type: parallel',
      '        branches: [{ step: 2 }, { step: 9 }]',
      '        endStep: 3',
      '      - stepNumber: 2',
      '        description: arm A',
      '        type: local',
      '      - stepNumber: 3',
      '        description: arm B',
      '        type: local',
    ]);
    const found = flowIssues(['INVALID_STEP_JUMP']);
    expect(found.some(i => i.message.includes('branches[1].step'))).toBe(true);
  });

  it('accepts detach on a call step; rejects it on a local step', () => {
    tempProject([
      '      - stepNumber: 1',
      '        description: Fire the A side and move on',
      '        type: call',
      '        targetComponent: side-a',
      '        targetMethod: workA',
      '        detach: true',
      '      - stepNumber: 2',
      '        description: cleanup',
      '        type: local',
      '        detach: true',
      '      - stepNumber: 3',
      '        description: done',
      '        type: return',
    ]);
    const found = flowIssues(['MALFORMED_FLOW_STEP']);
    expect(found).toHaveLength(1);
    expect(found[0].message).toContain('step 2');
    expect(found[0].message).toContain('detach');
  });
});

describe('updateSpec relocation + labels for parallel branches', () => {
  let proj: string;
  afterEach(() => {
    setProjectRoot(null);
    invalidateSpecCache();
    if (proj) fs.rmSync(proj, { recursive: true, force: true });
  });

  function setup() {
    proj = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-parallel-upd-'));
    fs.mkdirSync(path.join(proj, '.wai', 'specs'), { recursive: true });
    setProjectRoot(proj);
    saveSubsystemSpec({
      schemaVersion: '1.0.0', id: 'sub-a', name: 'SubA', description: 'd',
      parentSystem: 'TS', publicInterfaces: [], createdAt: now, updatedAt: now,
    });
    saveInterfaceSpec({
      id: 'ifan', name: 'IFan', description: 'd', component: 'fan-comp',
      methods: [{ name: 'fanOut', signature: 'fanOut()', returns: 'void', description: 'fans out' }],
      createdAt: now, updatedAt: now,
    });
    saveImplementationSpec({
      id: 'fan-impl', name: 'FanImpl', description: 'd', contract: 'ifan',
      methods: [{
        name: 'fanOut',
        narrative: [
          { stepNumber: 1, description: 'fan out', type: 'parallel', branches: [{ step: 2 }, { step: 3 }], endStep: 3 },
          { stepNumber: 2, description: 'arm A', type: 'local', label: 'arm-a' },
          { stepNumber: 3, description: 'arm B', type: 'local' },
          { stepNumber: 4, description: 'done', type: 'return' },
        ],
      }],
      createdAt: now, updatedAt: now,
    });
  }

  it('inserting a step inside the body relocates branch entries and endStep', () => {
    setup();
    updateSpec('implementation', 'fan-impl', {
      methods: [{
        name: 'fanOut',
        narrative: [{ stepNumber: 3, action: 'insert', description: 'arm A part two', type: 'local' }],
      }],
    });
    const steps = loadImplementationSpec('fan-impl')!.methods[0].narrative;
    const par = steps.find(s => s.type === 'parallel')!;
    expect(par.branches).toEqual([{ step: 2 }, { step: 4 }]);
    expect(par.endStep).toBe(4);
  });

  it('refuses to delete a step that is a branch entry target', () => {
    setup();
    expect(() => updateSpec('implementation', 'fan-impl', {
      methods: [{ name: 'fanOut', narrative: [{ stepNumber: 3, action: 'delete' }] }],
    })).toThrow(/branches\[1\]\.step/);
  });

  it('branch entries resolve from labels', () => {
    setup();
    updateSpec('implementation', 'fan-impl', {
      methods: [{
        name: 'fanOut',
        narrative: [{ stepNumber: 1, type: 'parallel', description: 'fan out', branches: [{ label: 'arm-a' }, { step: 3 }], endStep: 3 }],
      }],
    });
    const steps = loadImplementationSpec('fan-impl')!.methods[0].narrative;
    expect(steps.find(s => s.type === 'parallel')!.branches).toEqual([{ step: 2 }, { step: 3 }]);
  });
});

describe('language gating of parallel/detach via pack tables', () => {
  it('a pack language can gate parallel and detach (LANGUAGE_FOREIGN_FLOW)', () => {
    invalidateSpecCache();
    const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-parallel-lang-'));
    try {
      const waiDir = path.join(proj, '.wai');
      fs.mkdirSync(waiDir);
      fs.writeFileSync(path.join(waiDir, 'project.yaml'), JSON.stringify({
        schemaVersion: '1.0.0', name: 'test-project', projectType: 'backend',
        targets: [{ type: 'claude', outputDir: '.claude/agents', enabled: true }],
        rules: {},
        extensions: { packs: ['.wai/packs/plc.yaml'], useGlobalPacks: false },
        createdAt: now, updatedAt: now,
      }));
      fs.mkdirSync(path.join(waiDir, 'packs'), { recursive: true });
      fs.writeFileSync(path.join(waiDir, 'packs', 'plc.yaml'), [
        'name: plc-pack',
        'languages:',
        '  structured-text:',
        '    unsupportedFlow:',
        '      parallel: a scan cycle is single-threaded — model concurrent duties as separate cyclic programs',
        '      detach: fire-and-forget has no meaning inside a deterministic scan — hand the work to another program via a flag',
      ].join('\n'));
      const specsDir = path.join(waiDir, 'specs');
      for (const d of ['subsystems', 'components', 'interfaces', 'implementations', 'types']) {
        fs.mkdirSync(path.join(specsDir, d), { recursive: true });
      }
      const stamp = "createdAt: '2026-07-19T10:00:00Z'\nupdatedAt: '2026-07-19T10:00:00Z'";
      const w = (type: string, name: string, content: string) => {
        const p = type === 'system' ? path.join(specsDir, '.index.yaml') : path.join(specsDir, `${type}s`, `${name}.yaml`);
        fs.writeFileSync(p, `${content}\n${stamp}\n`);
      };
      w('system', 'system', 'schemaVersion: 1.0.0\nname: TestSystem\nvision: testing\ntargetLanguage: structured-text');
      w('subsystem', 'sub-a', 'schemaVersion: 1.0.0\nid: sub-a\nname: SubA\ndescription: d\nparentSystem: TestSystem');
      w('component', 'orch', 'schemaVersion: 1.0.0\nid: orch\nname: orch\ndescription: d\nsubsystem: sub-a\ncomponentType: Orchestrator\ndependsOn: [helper]');
      w('component', 'helper', 'schemaVersion: 1.0.0\nid: helper\nname: helper\ndescription: d\nsubsystem: sub-a\ncomponentType: Specialist');
      w('interface', 'ihelper', 'schemaVersion: 1.0.0\nid: ihelper\nname: IHelper\ndescription: d\ncomponent: helper\nmethods:\n  - name: assist\n    description: Assists with the auxiliary duty and reports completion.\n    signature: "assist(): void"\n    returns: "void"');
      w('interface', 'iorch', 'schemaVersion: 1.0.0\nid: iorch\nname: IOrch\ndescription: d\ncomponent: orch\nmethods:\n  - name: run\n    description: Runs one full pass of the coordinated duty cycle.\n    signature: "run(): void"\n    returns: "void"');
      w('implementation', 'impl-orch', [
        'schemaVersion: 1.0.0', 'id: impl-orch', 'name: ImplOrch', 'description: d', 'contract: iorch',
        'methods:',
        '  - name: run',
        '    narrative:',
        '      - stepNumber: 1',
        '        description: fan out',
        '        type: parallel',
        '        branches: [{ step: 2 }, { step: 3 }]',
        '        endStep: 3',
        '      - stepNumber: 2',
        '        description: fire the helper without waiting',
        '        type: call',
        '        targetComponent: helper',
        '        targetMethod: assist',
        '        detach: true',
        '      - stepNumber: 3',
        '        description: main duty',
        '        type: local',
      ].join('\n'));
      vi.spyOn(process, 'cwd').mockReturnValue(proj);
      const res = validateSddTree();
      const foreign = res.issues.filter(i => i.code === 'LANGUAGE_FOREIGN_FLOW');
      expect(foreign.some(i => i.message.includes('parallel step'))).toBe(true);
      expect(foreign.some(i => i.message.includes('fire-and-forget'))).toBe(true);
    } finally {
      invalidateSpecCache();
      vi.restoreAllMocks();
      try { fs.rmSync(proj, { recursive: true, force: true }); } catch { /* win */ }
    }
  });
});
