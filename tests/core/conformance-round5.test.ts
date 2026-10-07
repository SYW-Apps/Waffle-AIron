import { describe, it, expect, vi, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { validateProject } from '../../src/core/validation.js';
import { invalidateSpecCache } from '../../src/core/specs.js';
import { buildCodeModel } from '../../src/core/source-analysis.js';
import type { ImplementationSpec } from '../../src/models/index.js';

// ---------------------------------------------------------------------------
// The code<->spec gaps the fifth round of user trials found:
//
//   1. Unowned code was opaque: a write moved into a helper in a file no
//      component maps (or a function no component models) went unread.
//   2. A REFERENCE to a write method (Reflect.apply, a Function-typed alias,
//      a callback) was no use at all — only a call was.
//   3. A computed member on a receiver cast to an index signature was silent.
//   4. An Orchestrator's unnarrated write through `as any` was silent.
//   5. A Portal calling a workflow verb its narrative never names was silent.
//   6. Honest dependency-injection layouts (a type-only ports barrel, `export
//      *`, a store port in a shared module, a deps bag) failed `--ci` because
//      CALL_ORIGIN_UNRESOLVED and UNREALIZED_DEPENDENCY read only the import
//      graph.
//   7. A private field backing a getter read as undeclared data.
//   8. UNDECLARED_PARAM named the declared parameter an inserted one pushed.
// ---------------------------------------------------------------------------

function createTempProject() {
  invalidateSpecCache();
  const tempDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-round5-')));
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
  const stamp = "createdAt: '2026-10-07T10:00:00Z'\nupdatedAt: '2026-10-07T10:00:00Z'";
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
    component: (id: string, type: string, extra = '') =>
      writeSpec('component', id, `schemaVersion: 1.0.0\nid: ${id}\nname: ${id}\ndescription: d\nsubsystem: sub-a\ncomponentType: ${type}\n${extra}`),
    contract: (compId: string, methods: Array<[string, string?]>, params = '[{ name: id, type: string }]') =>
      writeSpec('interface', `i${compId}`, [
        'schemaVersion: 1.0.0', `id: i${compId}`, `name: I${compId}`, 'description: contract', `component: ${compId}`, 'methods:',
        ...methods.map(([m, effect]) => [
          `  - name: ${m}`,
          `    description: ${m} does its one thing, carefully and observably`,
          `    params: ${params}`,
          '    returns: string',
          ...(effect ? [`    effect: ${effect}`] : []),
        ].join('\n')),
      ].join('\n')),
    impl: (compId: string, body: string) =>
      writeSpec('implementation', `impl-${compId}`, `schemaVersion: 1.0.0\nid: impl-${compId}\nname: Impl${compId}\ndescription: impl\ncontract: i${compId}\n${body}`),
    type: (id: string, body: string) =>
      writeSpec('type', id, `schemaVersion: 1.0.0\nid: ${id}\nname: ${id}\nkind: value-object\ndescription: a record\n${body}`),
    source: (relPath: string, content: string) => {
      const abs = path.join(tempDir, relPath);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content);
    },
    activate: () => { vi.spyOn(process, 'cwd').mockReturnValue(tempDir); },
    cleanup: () => {
      invalidateSpecCache();
      vi.restoreAllMocks();
      try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* win file locks */ }
    },
  };
}

type Issue = { code: string; specId?: string; message: string; severity: string };
type Result = { issues: Issue[] };
const byCode = (res: Result, code: string) => res.issues.filter(i => i.code === code);
const codes = (res: Result) => JSON.stringify(res.issues.map(i => `${i.code}: ${i.message.slice(0, 160)}`), null, 1);
const intent = (m: string) => `  - name: ${m}\n    detail: intent\n    intent: Performs its one thing against held state; failures surface as thrown errors.`;

let proj: ReturnType<typeof createTempProject> | undefined;
afterEach(() => { proj?.cleanup(); proj = undefined; });

const TRACKER_FILE = [
  "import type { CheckinStore } from './store.js';",
  'export class HabitTracker {',
  '  constructor(private readonly checkins: CheckinStore) {}',
  '  checkIn(id: string): string { return this.checkins.record(id); }',
  '  peek(id: string): string { return this.checkins.find(id); }',
  '  archive(id: string): string { return id; }',
  '}', '',
].join('\n');

interface Shape {
  portal?: string;
  tracker?: string;
  files?: Record<string, string>;
  /** The effect the tracker's `archive` verb declares (none declared when undefined). */
  archiveEffect?: string;
  /** A narrated archive call on the Portal. */
  portalNarratesArchive?: boolean;
}

/**
 * Portal web-a -> Orchestrator tracker-a -> Store store-a (`record` write,
 * `find` read), in src/web.ts, src/tracker.ts and src/store.ts.
 */
function habitShape(p: ReturnType<typeof createTempProject>, s: Shape = {}): void {
  p.component('store-a', 'Store', 'durability: read-through\nlint:\n  allow:\n    - { code: UNOWNED_STORE, reason: one keyed table }');
  p.contract('store-a', [['record', 'write'], ['find', 'read']]);
  p.impl('store-a', `sourcePath: src/store.ts\nmethods:\n${intent('record')}\n${intent('find')}`);
  p.source('src/store.ts', 'export class CheckinStore {\n  record(id: string): string { return id; }\n  find(id: string): string { return id; }\n}\n');
  p.component('tracker-a', 'Orchestrator', 'dependsOn: [store-a]');
  p.contract('tracker-a', [['checkIn', 'write'], ['peek', 'read'], ['archive', s.archiveEffect]]);
  p.impl('tracker-a', [
    'sourcePath: src/tracker.ts', 'methods:',
    '  - name: checkIn', '    narrative:',
    '      - { stepNumber: 1, description: Record the check-in, type: call, targetComponent: store-a, targetMethod: record }',
    '      - { stepNumber: 2, description: Done, type: return, outcome: done }',
    '  - name: peek', '    narrative:',
    '      - { stepNumber: 1, description: Read the check-in, type: call, targetComponent: store-a, targetMethod: find }',
    '      - { stepNumber: 2, description: Done, type: return, outcome: done }',
    intent('archive'),
  ].join('\n'));
  p.source('src/tracker.ts', s.tracker ?? TRACKER_FILE);
  p.component('web-a', 'Portal', 'transport: InProcess\ndependsOn: [tracker-a]');
  p.contract('web-a', [['checkIn', 'write']]);
  p.impl('web-a', [
    'sourcePath: src/web.ts', 'methods:', '  - name: checkIn', '    narrative:',
    '      - { stepNumber: 1, description: Dispatch to the tracker, type: call, targetComponent: tracker-a, targetMethod: checkIn }',
    ...(s.portalNarratesArchive ? ['      - { stepNumber: 2, description: Archive it, type: call, targetComponent: tracker-a, targetMethod: archive }'] : []),
    `      - { stepNumber: ${s.portalNarratesArchive ? 3 : 2}, description: Done, type: return, outcome: done }`,
  ].join('\n'));
  p.source('src/web.ts', s.portal ?? portal(''));
  for (const [file, text] of Object.entries(s.files ?? {})) p.source(file, text);
}

/** A Portal class whose checkIn runs `body` before the narrated call; `field` is its second collaborator. */
function portal(body: string, field = 'private readonly checkins: CheckinStore', head = "import type { CheckinStore } from './store.js';", tail = '', trackerImport = "import type { HabitTracker } from './tracker.js';"): string {
  return [
    trackerImport,
    head,
    'export class HabitsApi {',
    `  constructor(private readonly tracker: HabitTracker, ${field}) {}`,
    `  checkIn(id: string): string { ${body} return this.tracker.checkIn(id); }`,
    '}',
    tail,
    '',
  ].join('\n');
}

const run = (s: Shape): Result => {
  proj = createTempProject();
  habitShape(proj, s);
  proj.activate();
  return validateProject();
};

const swapToRead = (s: Shape): Shape => ({
  ...s,
  portal: s.portal?.replace(/record/g, 'find'),
  files: s.files ? Object.fromEntries(Object.entries(s.files).map(([k, v]) => [k, v.replace(/record/g, 'find')])) : undefined,
});

describe('1. unowned code is read as part of whoever calls it', () => {
  const shapes: Array<[string, Shape, string]> = [
    ['a persistence helper in a file no component maps (platform persistOrder, solo-app D8, tinkerer bump-helper)', {
      portal: portal('persist(this.checkins, id);', undefined, "import type { CheckinStore } from './store.js';\nimport { persist } from './persist.js';"),
      files: { 'src/persist.ts': "import type { CheckinStore } from './store.js';\nexport function persist(s: CheckinStore, id: string): void { s.record(id); }\n" },
    }, 'persist (src/persist.ts)'],
    ['two unowned hops', {
      portal: portal('persist(this.checkins, id);', undefined, "import type { CheckinStore } from './store.js';\nimport { persist } from './util/persist.js';"),
      files: {
        'src/util/persist.ts': "import type { CheckinStore } from '../store.js';\nimport { write } from './write.js';\nexport function persist(s: CheckinStore, id: string): void { write(s, id); }\n",
        'src/util/write.ts': "import type { CheckinStore } from '../store.js';\nexport function write(s: CheckinStore, id: string): void { s.record(id); }\n",
      },
    }, 'persist (src/util/persist.ts) → write (src/util/write.ts)'],
    ['a helper the Store\'s own file exports but no contract models', {
      portal: portal('recordVia(this.checkins, id);', undefined, "import type { CheckinStore } from './store.js';\nimport { recordVia } from './store-helpers.js';"),
      files: { 'src/store-helpers.ts': "import type { CheckinStore } from './store.js';\nexport const recordVia = (s: CheckinStore, id: string): string => s.record(id);\n" },
    }, 'recordVia (src/store-helpers.ts)'],
  ];
  for (const [label, shape, hop] of shapes) {
    it(`${label} → PORTAL_WRITE_SHORTCUT_IN_CODE naming the path`, () => {
      const res = run(shape);
      const shortcut = byCode(res, 'PORTAL_WRITE_SHORTCUT_IN_CODE');
      expect(shortcut, codes(res)).toHaveLength(1);
      expect(shortcut[0].message).toContain('store-a.record');
      expect(shortcut[0].message).toContain(hop);
    });
    it(`control: ${label} reaching the READ → no shortcut`, () => {
      const res = run(swapToRead(shape));
      expect(byCode(res, 'PORTAL_WRITE_SHORTCUT_IN_CODE'), codes(res)).toEqual([]);
      expect(byCode(res, 'PORTAL_CALL_UNRESOLVED')).toEqual([]);
    });
  }

  it('a function of a mapped file that IS a modelled method stops the walk (the Orchestrator answers for its own calls)', () => {
    const res = run({ portal: portal('', 'private readonly unused?: number', '') });
    expect(byCode(res, 'PORTAL_WRITE_SHORTCUT_IN_CODE'), codes(res)).toEqual([]);
  });

  it("an Orchestrator's unnarrated write through an unowned helper → UNDECLARED_WRITE_CALL naming the path", () => {
    const res = run({
      tracker: TRACKER_FILE.replace("peek(id: string): string { return", "peek(id: string): string { persist(this.checkins, id); return")
        .replace("import type { CheckinStore } from './store.js';", "import type { CheckinStore } from './store.js';\nimport { persist } from './persist.js';"),
      files: { 'src/persist.ts': "import type { CheckinStore } from './store.js';\nexport function persist(s: CheckinStore, id: string): void { s.record(id); }\n" },
    });
    const found = byCode(res, 'UNDECLARED_WRITE_CALL');
    expect(found, codes(res)).toHaveLength(1);
    expect(found[0].message).toContain('"peek"');
    expect(found[0].message).toContain('store-a.record');
    expect(found[0].message).toContain('persist (src/persist.ts)');
  });

  it('the model holds the calls of an unowned file no spec names (reachedCalls)', () => {
    proj = createTempProject();
    habitShape(proj, {
      portal: portal('persist(this.checkins, id);', undefined, "import type { CheckinStore } from './store.js';\nimport { persist } from './persist.js';"),
      files: { 'src/persist.ts': "import type { CheckinStore } from './store.js';\nexport function persist(s: CheckinStore, id: string): void { s.record(id); }\n" },
    });
    const impls = ['web-a', 'tracker-a', 'store-a'].map(c => ({
      id: `impl-${c}`, contract: `i${c}`, sourcePath: { 'web-a': 'src/web.ts', 'tracker-a': 'src/tracker.ts', 'store-a': 'src/store.ts' }[c], methods: [],
    })) as unknown as ImplementationSpec[];
    const model = buildCodeModel(impls, [], proj.tempDir);
    const reached = model.reachedCalls?.['src/persist.ts'];
    expect(reached?.some(c => c.enclosing === 'persist' && c.targets.some(t => t.path === 'src/store.ts' && t.member === 'record'))).toBe(true);
  });
});

describe('2. a reference to a write method is a use', () => {
  const shapes: Array<[string, Shape]> = [
    ['Reflect.apply on the method', { portal: portal('Reflect.apply(this.checkins.record, this.checkins, [id]);') }],
    ['a Function-typed alias invoked with call()', { portal: portal('const fn: Function = this.checkins.record; fn.call(this.checkins, id);') }],
    ['the method passed as a callback', { portal: portal('[id].forEach(this.checkins.record);') }],
    ['the method bound and kept', { portal: portal('const bound = this.checkins.record.bind(this.checkins); void bound;') }],
    ['Reflect.apply through a port the Portal declares itself, no store import (platform N17)', {
      portal: portal('Reflect.apply(this.checkins.record, this.checkins, [id]);', 'private readonly checkins: Sink', 'interface Sink { record(id: string): string }'),
    }],
  ];
  for (const [label, shape] of shapes) {
    it(`${label} → PORTAL_WRITE_SHORTCUT_IN_CODE`, () => {
      const res = run(shape);
      const shortcut = byCode(res, 'PORTAL_WRITE_SHORTCUT_IN_CODE');
      expect(shortcut, codes(res)).toHaveLength(1);
      expect(shortcut[0].message).toContain('store-a.record');
    });
    it(`control: ${label}, the READ method → no shortcut`, () => {
      const res = run(swapToRead(shape));
      expect(byCode(res, 'PORTAL_WRITE_SHORTCUT_IN_CODE'), codes(res)).toEqual([]);
    });
  }

  it("an Orchestrator handing a write method on as a callback, unnarrated → UNDECLARED_WRITE_CALL", () => {
    const res = run({ tracker: TRACKER_FILE.replace('peek(id: string): string { return', 'peek(id: string): string { [id].forEach(this.checkins.record); return') });
    const found = byCode(res, 'UNDECLARED_WRITE_CALL');
    expect(found, codes(res)).toHaveLength(1);
    expect(found[0].message).toContain('taken as a value');
  });
});

describe('3. a computed member on a data component fails closed', () => {
  it('a template key through a cast to Record<string, fn> → PORTAL_CALL_UNRESOLVED naming the store\'s writes', () => {
    const res = run({ portal: portal('(this.checkins as unknown as Record<string, (x: string) => string>)[`rec${\'ord\'}`](id);') });
    const found = byCode(res, 'PORTAL_CALL_UNRESOLVED');
    expect(found, codes(res)).toHaveLength(1);
    expect(found[0].severity).toBe('warning');
    expect(found[0].message).toContain('store-a.record');
    expect(found[0].message).toContain('before the cast');
  });

  it('a literal key through the same cast → PORTAL_CALL_UNRESOLVED under that name', () => {
    const res = run({ portal: portal("(this.checkins as unknown as Record<string, (x: string) => string>)['record'](id);") });
    expect(byCode(res, 'PORTAL_CALL_UNRESOLVED').map(i => i.message).join('\n'), codes(res)).toContain('store-a.record');
  });

  it('control: a computed key on a receiver that never was a data component → nothing', () => {
    const res = run({ portal: portal('const table: Record<string, (x: string) => string> = { a: (x) => x }; table[`${id}`](id);', 'private readonly unused?: number', '') });
    expect(byCode(res, 'PORTAL_CALL_UNRESOLVED'), codes(res)).toEqual([]);
  });

  it('control: the literal READ key through the cast → nothing', () => {
    const res = run({ portal: portal("(this.checkins as unknown as Record<string, (x: string) => string>)['find'](id);") });
    expect(byCode(res, 'PORTAL_CALL_UNRESOLVED'), codes(res)).toEqual([]);
  });
});

describe("4. an Orchestrator's unnarrated write through an unresolvable receiver fails closed", () => {
  const tracker = (body: string): string => TRACKER_FILE.replace('peek(id: string): string { return', `peek(id: string): string { ${body} return`);

  it('`(this.checkins as any).record(id)` in a read-narrated method → CALL_ORIGIN_UNRESOLVED (warning)', () => {
    const res = run({ tracker: tracker('(this.checkins as any).record(id);') });
    const found = byCode(res, 'CALL_ORIGIN_UNRESOLVED');
    expect(found, codes(res)).toHaveLength(1);
    expect(found[0].severity).toBe('warning');
    expect(found[0].message).toContain('store-a.record');
    expect(found[0].message).toContain('fails closed');
    expect(byCode(res, 'UNDECLARED_WRITE_CALL')).toEqual([]);
  });

  it('control: the READ through the same cast → nothing', () => {
    const res = run({ tracker: tracker('(this.checkins as any).find(id);') });
    expect(byCode(res, 'CALL_ORIGIN_UNRESOLVED'), codes(res)).toEqual([]);
  });

  it('control: the cast write in the method that narrates it is no unclaimed write (only its claim goes unchecked)', () => {
    const res = run({ tracker: TRACKER_FILE.replace('return this.checkins.record(id);', 'return (this.checkins as any).record(id);') });
    expect(byCode(res, 'CALL_ORIGIN_UNRESOLVED').filter(i => i.message.includes('fails closed')), codes(res)).toEqual([]);
  });
});

describe('5. a Portal calling a workflow verb its narrative never names (solo-app D22)', () => {
  const calling = portal('this.tracker.archive(id);', 'private readonly unused?: number', '');

  it('a verb with no effect declared → UNDECLARED_WRITE_CALL on the Portal', () => {
    const res = run({ portal: calling });
    const found = byCode(res, 'UNDECLARED_WRITE_CALL');
    expect(found, codes(res)).toHaveLength(1);
    expect(found[0].specId).toBe('impl-web-a');
    expect(found[0].message).toContain('tracker-a.archive');
  });

  it('a verb declaring write → UNDECLARED_WRITE_CALL', () => {
    expect(byCode(run({ portal: calling, archiveEffect: 'write' }), 'UNDECLARED_WRITE_CALL')).toHaveLength(1);
  });

  it('control: a verb declaring read → nothing', () => {
    const res = run({ portal: calling, archiveEffect: 'read' });
    expect(byCode(res, 'UNDECLARED_WRITE_CALL'), codes(res)).toEqual([]);
  });

  it('control: the Portal narrates the verb → nothing', () => {
    const res = run({ portal: calling, portalNarratesArchive: true });
    expect(byCode(res, 'UNDECLARED_WRITE_CALL'), codes(res)).toEqual([]);
  });
});

describe('6. honest dependency-injection layouts are clean (solo-app H5/H6/H7/H9)', () => {
  const quiet = (res: Result): void => {
    for (const code of ['CALL_ORIGIN_UNRESOLVED', 'UNREALIZED_DEPENDENCY', 'CALL_STEP_UNREALIZED', 'UNDECLARED_DEPENDENCY', 'PORTAL_WRITE_SHORTCUT_IN_CODE']) {
      expect(byCode(res, code), `${code}\n${codes(res)}`).toEqual([]);
    }
  };
  const honestPortal = (trackerImport: string): string =>
    portal('', 'private readonly unused?: number', '', '', trackerImport);

  it('H5 a type-only ports barrel the Portal imports its collaborator from', () => {
    quiet(run({
      portal: honestPortal("import type { HabitTracker } from './ports.js';"),
      files: { 'src/ports.ts': "export type { HabitTracker } from './tracker.js';\n" },
    }));
  });

  it('H9 an `export *` barrel', () => {
    quiet(run({
      portal: honestPortal("import type { HabitTracker } from './ports.js';"),
      files: { 'src/ports.ts': "export * from './tracker.js';\n" },
    }));
  });

  it('H6 a Store port declared in a shared module, realized by the Store class', () => {
    quiet(run({
      tracker: TRACKER_FILE.replace("import type { CheckinStore } from './store.js';", "import type { CheckinPort as CheckinStore } from './ports.js';"),
      files: {
        'src/ports.ts': 'export interface CheckinPort {\n  record(id: string): string;\n  find(id: string): string;\n}\n',
        'src/store.ts': "import type { CheckinPort } from './ports.js';\nexport class CheckinStore implements CheckinPort {\n  record(id: string): string { return id; }\n  find(id: string): string { return id; }\n}\n",
      },
    }));
  });

  it('H7 a deps bag typed inline on the Orchestrator', () => {
    quiet(run({
      tracker: [
        "import type { CheckinStore } from './store.js';",
        'export class HabitTracker {',
        '  constructor(private readonly deps: { checkins: CheckinStore; now?: () => Date }) {}',
        '  checkIn(id: string): string { return this.deps.checkins.record(id); }',
        '  peek(id: string): string { return this.deps.checkins.find(id); }',
        '  archive(id: string): string { return id; }',
        '}', '',
      ].join('\n'),
    }));
  });

  it('control: a declared edge nothing realizes — no import, no call — is still UNREALIZED_DEPENDENCY', () => {
    const res = run({
      tracker: [
        'export class HabitTracker {',
        '  checkIn(id: string): string { return id; }',
        '  peek(id: string): string { return id; }',
        '  archive(id: string): string { return id; }',
        '}', '',
      ].join('\n'),
    });
    expect(byCode(res, 'UNREALIZED_DEPENDENCY').some(i => i.message.includes('"tracker-a" declares dependsOn "store-a"')), codes(res)).toBe(true);
  });

  it('control: a claimed call through a collaborator typed as another class is not realized (a typed declaration never accuses, so it stays unchecked)', () => {
    const res = run({
      tracker: TRACKER_FILE.replace('peek(id: string): string { return this.checkins.find(id); }', 'peek(id: string): string { return this.other.find(id); }')
        .replace('constructor(private readonly checkins: CheckinStore) {}', 'constructor(private readonly checkins: CheckinStore, private readonly other: Ledger) {}')
        .replace("import type { CheckinStore } from './store.js';", "import type { CheckinStore } from './store.js';\nimport type { Ledger } from './ledger.js';"),
      files: { 'src/ledger.ts': 'export class Ledger {\n  find(id: string): string { return id; }\n}\n' },
    });
    expect(byCode(res, 'CALL_ORIGIN_UNRESOLVED').some(i => i.message.includes('store-a.find')), codes(res)).toBe(true);
    expect(byCode(res, 'CALL_STEP_UNREALIZED')).toEqual([]);
  });
});

describe('7. a private field behind a getter is backing storage, not data', () => {
  const money = 'subsystem: sub-a\nsourcePath: src/money.ts\nsymbol: Money\nfields:\n  - { name: amountMinor, type: int }\n  - { name: currency, type: string }';
  it('private parameter properties read by the getters → no UNDECLARED_TYPE_FIELD', () => {
    proj = createTempProject();
    proj.type('money', money);
    proj.source('src/money.ts', [
      'export class Money {',
      '  constructor(private readonly a: number, private readonly c: string) {}',
      '  get amountMinor(): number { return this.a; }',
      '  get currency(): string { return this.c; }',
      '}', '',
    ].join('\n'));
    proj.activate();
    const res = validateProject();
    expect(byCode(res, 'UNDECLARED_TYPE_FIELD'), codes(res)).toEqual([]);
    expect(byCode(res, 'UNREALIZED_TYPE_FIELD')).toEqual([]);
  });

  it('control: a private field no getter reads is still data the type does not declare', () => {
    proj = createTempProject();
    proj.type('money', money);
    proj.source('src/money.ts', [
      'export class Money {',
      '  constructor(private readonly a: number, private readonly c: string, private readonly rounding: number) {}',
      '  get amountMinor(): number { return this.a; }',
      '  get currency(): string { return this.c; }',
      '}', '',
    ].join('\n'));
    proj.activate();
    const found = byCode(validateProject(), 'UNDECLARED_TYPE_FIELD');
    expect(found).toHaveLength(1);
    expect(found[0].message).toContain('"rounding"');
    expect(found[0].message).not.toContain('"a"');
  });
});

describe('8. UNDECLARED_PARAM names the parameter that was inserted', () => {
  function fulfil(signature: string) {
    proj = createTempProject();
    proj.component('order-flow', 'Orchestrator', '');
    proj.contract('order-flow', [['fulfillOrder']], '[{ name: orderId, type: string }]');
    proj.impl('order-flow', `sourcePath: src/flow.ts\nmethods:\n${intent('fulfillOrder')}`);
    proj.source('src/flow.ts', `export function fulfillOrder(${signature}): string { return 'ok'; }\n`);
    proj.activate();
    return validateProject();
  }

  it('a leading parameter inserted before the declared one → names it, not the declared one', () => {
    const found = byCode(fulfil('requester: string, orderId: string'), 'UNDECLARED_PARAM');
    expect(found).toHaveLength(1);
    expect(found[0].message).toContain('"requester"');
    expect(found[0].message).not.toContain('"orderId"');
  });

  it('control: a trailing extra parameter is still the one named', () => {
    const found = byCode(fulfil('orderId: string, reason: string'), 'UNDECLARED_PARAM');
    expect(found).toHaveLength(1);
    expect(found[0].message).toContain('"reason"');
  });
});
