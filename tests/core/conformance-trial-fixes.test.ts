import { describe, it, expect, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { validateProject } from '../../src/core/validation.js';
import { invalidateSpecCache } from '../../src/core/specs.js';

// ---------------------------------------------------------------------------
// The code<->spec conformance gaps a realistic user trial (a TypeScript
// habit-tracker with constructor-injected collaborators) found:
//
//   1. A Portal method forwarding to a SAME-NAMED Orchestrator method was
//      accepted by name alone ("N:1 identity"), so replacing that forwarding
//      call with a direct Repository write changed nothing in the output.
//      Identity is now judged on the body, and the bag-of-collaborators shape
//      (`this.c.tracker.checkIn()`, typed through `Pick<…>`) is followed.
//   2. Idiomatic DI read as drift: a type-only import did not realize a
//      declared edge, an owner importing its owned member's class read as a
//      leaked surface, and a component with no code yet was asked for a sim.
//   3. The unresolved-call explanation was repeated in full on every finding.
// ---------------------------------------------------------------------------

function createTempProject() {
  invalidateSpecCache();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-trial-fixes-'));
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
  const stamp = "createdAt: '2026-10-05T10:00:00Z'\nupdatedAt: '2026-10-05T10:00:00Z'";
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
    contract: (compId: string, methods: string[]) =>
      writeSpec('interface', `i${compId}`, [
        'schemaVersion: 1.0.0', `id: i${compId}`, `name: I${compId}`, 'description: contract', `component: ${compId}`, 'methods:',
        ...methods.map(m => [
          `  - name: ${m}`,
          `    description: ${m} does its one thing, carefully and observably`,
          `    signature: "${m}(): void"`,
          '    returns: "void"',
        ].join('\n')),
      ].join('\n')),
    impl: (compId: string, body: string) =>
      writeSpec('implementation', `impl-${compId}`, `schemaVersion: 1.0.0\nid: impl-${compId}\nname: Impl${compId}\ndescription: impl\ncontract: i${compId}\n${body}`),
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

type Project = ReturnType<typeof createTempProject>;
type Result = { issues: { code: string; specId?: string; message: string }[] };
const byCode = (res: Result, code: string) => res.issues.filter(i => i.code === code);
const intent = (m: string) => `  - name: ${m}\n    detail: intent\n    intent: Performs its one thing against held state; failures surface as thrown errors.`;

// ---- the trial's shape: Portal -> Orchestrator (same method name) -> Repository ----

const TRACKER = [
  "import type { HabitRepository } from './repo.js';",
  "export type RepoContract = Pick<HabitRepository, 'record'>;",
  'export class HabitTracker {',
  '  constructor(private readonly habits: RepoContract) {}',
  '  checkIn(id: string): string { return this.habits.record(id); }',
  '}',
  '',
].join('\n');
const REPO = 'export class HabitRepository {\n  record(id: string): string { return id; }\n}\n';

/** The portal file, its checkIn body supplied: the collaborators arrive as ONE bag typed through Pick<>. */
const portalSource = (checkInBody: string) => [
  "import type { HabitRepository } from './repo.js';",
  "import type { HabitTracker } from './tracker.js';",
  'export interface Collaborators {',
  "  tracker: Pick<HabitTracker, 'checkIn'>;",
  "  habits: Pick<HabitRepository, 'record'>;",
  '}',
  'export class HabitsApi {',
  '  constructor(private readonly c: Collaborators) {}',
  `  checkIn(id: string): string { ${checkInBody} }`,
  '}',
  '/** The route binding calls the portal method by the SAME name. */',
  'export function mount(api: HabitsApi): string { return api.checkIn("x"); }',
  '',
].join('\n');

function trialShape(proj: Project, checkInBody: string): void {
  proj.component('repo-a', 'Repository');
  proj.contract('repo-a', ['record']);
  proj.impl('repo-a', `sourcePath: src/repo.ts\nmethods:\n${intent('record')}`);
  proj.source('src/repo.ts', REPO);

  proj.component('tracker-a', 'Orchestrator', 'dependsOn: [repo-a]');
  proj.contract('tracker-a', ['checkIn']);
  proj.impl('tracker-a', [
    'sourcePath: src/tracker.ts',
    'methods:',
    '  - name: checkIn',
    '    narrative:',
    '      - { stepNumber: 1, description: Record the check-in, type: call, targetComponent: repo-a, targetMethod: record }',
    '      - { stepNumber: 2, description: Done, type: return, outcome: done }',
  ].join('\n'));
  proj.source('src/tracker.ts', TRACKER);

  proj.component('api-a', 'Orchestrator', 'dependsOn: [tracker-a, repo-a]');
  proj.contract('api-a', ['checkIn']);
  proj.impl('api-a', [
    'sourcePath: src/api.ts',
    'methods:',
    '  - name: checkIn',
    '    narrative:',
    '      - { stepNumber: 1, description: Dispatch to the tracker, type: call, targetComponent: tracker-a, targetMethod: checkIn }',
    '      - { stepNumber: 2, description: Done, type: return, outcome: done }',
  ].join('\n'));
  proj.source('src/api.ts', portalSource(checkInBody));
}

describe('same-named forwarding is judged on the call, never accepted by name', () => {
  it('control: the forwarding call through a Pick<>-typed collaborator bag is resolved and realized', () => {
    const proj = createTempProject();
    trialShape(proj, 'return this.c.tracker.checkIn(id);');
    proj.activate();
    try {
      const res = validateProject();
      expect(byCode(res, 'CALL_STEP_UNREALIZED')).toEqual([]);
      // Before: the tracker's `this.habits.record()` (a field typed through a
      // local `Pick<>` alias) was reported as unchecked.
      expect(byCode(res, 'CALL_ORIGIN_UNRESOLVED')).toEqual([]);
    } finally { proj.cleanup(); }
  });

  it('fire: the handler writing straight to the repository is reported — the bypass the trial hid', () => {
    const proj = createTempProject();
    trialShape(proj, 'return this.c.habits.record(id);');
    proj.activate();
    try {
      const res = validateProject();
      // Before: nothing at all — the portal's own name `checkIn` was taken as
      // the realization of the call to tracker-a.checkIn.
      const found = byCode(res, 'CALL_STEP_UNREALIZED');
      expect(found).toHaveLength(1);
      expect(found[0].specId).toBe('impl-api-a');
      expect(found[0].message).toContain('tracker-a.checkIn');
    } finally { proj.cleanup(); }
  });

  it('honest gap: a same-named call through a receiver the analysis cannot follow is reported as unchecked, never silently passed', () => {
    const proj = createTempProject();
    trialShape(proj, 'return (this.c as any).tracker.checkIn(id);');
    proj.activate();
    try {
      const res = validateProject();
      expect(byCode(res, 'CALL_STEP_UNREALIZED')).toEqual([]);
      const unresolved = byCode(res, 'CALL_ORIGIN_UNRESOLVED');
      expect(unresolved).toHaveLength(1);
      expect(unresolved[0].specId).toBe('impl-api-a');
    } finally { proj.cleanup(); }
  });

  it('N:1 identity still holds for ONE body: two components realized by the same function in the same file', () => {
    const proj = createTempProject();
    proj.component('store-a', 'Store');
    proj.contract('store-a', ['save']);
    proj.impl('store-a', `sourcePath: src/shared.ts\nmethods:\n${intent('save')}`);
    proj.component('facade-a', 'Orchestrator', 'dependsOn: [store-a]');
    proj.contract('facade-a', ['save']);
    proj.impl('facade-a', [
      'sourcePath: src/shared.ts',
      'methods:',
      '  - name: save',
      '    narrative:',
      '      - { stepNumber: 1, description: Save, type: call, targetComponent: store-a, targetMethod: save }',
    ].join('\n'));
    proj.source('src/shared.ts', 'export function save(): void {}\n');
    proj.activate();
    try {
      const res = validateProject();
      expect(byCode(res, 'CALL_STEP_UNREALIZED')).toEqual([]);
    } finally { proj.cleanup(); }
  });

  it('identity reached from both ends: a barrel and the orchestrator both forwarding the store\'s function', () => {
    const proj = createTempProject();
    proj.component('store-a', 'Store');
    proj.contract('store-a', ['save']);
    proj.impl('store-a', `sourcePath: src/store.ts\nmethods:\n${intent('save')}`);
    proj.source('src/store.ts', 'export function save(): void {}\n');
    proj.component('orch-a', 'Orchestrator', 'dependsOn: [store-a]');
    proj.contract('orch-a', ['save']);
    proj.impl('orch-a', [
      'sourcePath: src/orch.ts',
      'methods:',
      '  - name: save',
      '    narrative:',
      '      - { stepNumber: 1, description: Save, type: call, targetComponent: store-a, targetMethod: save }',
    ].join('\n'));
    proj.source('src/orch.ts', "import { save } from './store.js';\nexport { save };\n");
    proj.component('portal-a', 'Orchestrator', 'dependsOn: [orch-a]');
    proj.contract('portal-a', ['save']);
    proj.impl('portal-a', [
      'sourcePath: src/index.ts',
      'methods:',
      '  - name: save',
      '    narrative:',
      '      - { stepNumber: 1, description: Save, type: call, targetComponent: orch-a, targetMethod: save }',
    ].join('\n'));
    proj.source('src/index.ts', "export { save } from './store.js';\n");
    proj.activate();
    try {
      const res = validateProject();
      expect(byCode(res, 'CALL_STEP_UNREALIZED')).toEqual([]);
    } finally { proj.cleanup(); }
  });
});

describe('CALL_ORIGIN_UNRESOLVED names its sites and says what it means once', () => {
  it('keeps the per-finding message to the sites, leaving the receiver catalogue to the code summary', () => {
    const proj = createTempProject();
    trialShape(proj, 'return (this.c as any).tracker.checkIn(id);');
    proj.activate();
    try {
      const [finding] = byCode(validateProject(), 'CALL_ORIGIN_UNRESOLVED');
      expect(finding.message).toContain('tracker-a.checkIn');
      expect(finding.message).not.toContain('What does not');
      expect(finding.message.length).toBeLessThan(500);
    } finally { proj.cleanup(); }
  });
});

describe('UNREALIZED_DEPENDENCY — a type-only import is what dependency injection writes down', () => {
  const wire = (proj: Project, orchSource: string) => {
    proj.component('store-a', 'Store');
    proj.contract('store-a', ['load']);
    proj.impl('store-a', `sourcePath: src/store.ts\nmethods:\n${intent('load')}`);
    proj.source('src/store.ts', 'export class Store {\n  load(): string { return ""; }\n}\n');
    proj.component('orch-a', 'Orchestrator', 'dependsOn: [store-a]');
    proj.contract('orch-a', ['run']);
    proj.impl('orch-a', `sourcePath: src/orch.ts\nmethods:\n${intent('run')}`);
    proj.source('src/orch.ts', orchSource);
  };

  it('control: a constructor-injected collaborator reached via `import type` realizes the edge', () => {
    const proj = createTempProject();
    wire(proj, "import type { Store } from './store.js';\nexport class Orch {\n  constructor(private readonly store: Store) {}\n  run(): string { return this.store.load(); }\n}\n");
    proj.activate();
    try {
      expect(byCode(validateProject(), 'UNREALIZED_DEPENDENCY')).toEqual([]);
    } finally { proj.cleanup(); }
  });

  it('fire: no import of any kind still leaves the declared edge unrealized', () => {
    const proj = createTempProject();
    wire(proj, 'export class Orch {\n  run(): string { return ""; }\n}\n');
    proj.activate();
    try {
      expect(byCode(validateProject(), 'UNREALIZED_DEPENDENCY')).toHaveLength(1);
    } finally { proj.cleanup(); }
  });

  it('a type-only import still never ACCUSES: it justifies nothing it is not asked to', () => {
    const proj = createTempProject();
    wire(proj, "import type { Store } from './store.js';\nexport class Orch {\n  constructor(private readonly store: Store) {}\n  run(): string { return this.store.load(); }\n}\n");
    proj.source('src/store.ts', "import type { Orch } from './orch.js';\nexport class Store {\n  load(o?: Orch): string { return String(o); }\n}\n");
    proj.activate();
    try {
      expect(byCode(validateProject(), 'UNDECLARED_DEPENDENCY')).toEqual([]);
    } finally { proj.cleanup(); }
  });
});

describe('UNDECLARED_EXPORT — the owns relation is inside the fence', () => {
  const pattern = (proj: Project) => {
    proj.component('store-a', 'Store');
    proj.contract('store-a', ['insert']);
    proj.impl('store-a', `sourcePath: src/store.ts\nmethods:\n${intent('insert')}`);
    proj.source('src/store.ts', 'export class HabitStore {\n  insert(): void {}\n}\n');
    proj.component('repo-a', 'Repository', 'owns: [store-a]');
    proj.contract('repo-a', ['create']);
    proj.impl('repo-a', `sourcePath: src/repo.ts\nmethods:\n${intent('create')}`);
    proj.source('src/repo.ts', "import { HabitStore } from './store.js';\nexport class HabitRepository {\n  private readonly store = new HabitStore();\n  create(): void { this.store.insert(); }\n}\n");
  };

  it('control: the Repository constructing the Store it owns is no crossing', () => {
    const proj = createTempProject();
    pattern(proj);
    proj.activate();
    try {
      expect(byCode(validateProject(), 'UNDECLARED_EXPORT')).toEqual([]);
    } finally { proj.cleanup(); }
  });

  it('fire: a component outside the pattern reaching for the member\'s class still crosses', () => {
    const proj = createTempProject();
    pattern(proj);
    proj.component('orch-a', 'Orchestrator', 'dependsOn: [repo-a]');
    proj.contract('orch-a', ['run']);
    proj.impl('orch-a', `sourcePath: src/orch.ts\nmethods:\n${intent('run')}`);
    proj.source('src/orch.ts', "import { HabitStore } from './store.js';\nexport function run(): void { new HabitStore().insert(); }\n");
    proj.activate();
    try {
      const found = byCode(validateProject(), 'UNDECLARED_EXPORT');
      expect(found).toHaveLength(1);
      expect(found[0].message).toContain('HabitStore');
    } finally { proj.cleanup(); }
  });
});

describe('UNDECLARED_EXPORT — a plain import used only as a type is a type import', () => {
  const inject = (orchSource: string) => {
    const proj = createTempProject();
    proj.component('store-a', 'Store');
    proj.contract('store-a', ['load']);
    proj.impl('store-a', `sourcePath: src/user_store.ts\nmethods:\n${intent('load')}`);
    proj.source('src/user_store.ts', 'export class UserStore {\n  load(): string { return ""; }\n}\nexport class StoreTuning {\n  depth = 1;\n}\n');
    proj.component('orch-a', 'Orchestrator', 'dependsOn: [store-a]');
    proj.contract('orch-a', ['run']);
    proj.impl('orch-a', `sourcePath: src/orch.ts\nmethods:\n${intent('run')}`);
    proj.source('src/orch.ts', orchSource);
    return proj;
  };

  it('control: constructor injection with a plain `import { X }` used only as a parameter type draws none', () => {
    const proj = inject("import { UserStore } from './user_store';\nexport class Orch {\n  constructor(private readonly store: UserStore) {}\n  run(): string { return this.store.load(); }\n}\n");
    proj.activate();
    try {
      expect(byCode(validateProject(), 'UNDECLARED_EXPORT')).toEqual([]);
    } finally { proj.cleanup(); }
  });

  it('fire: a decorated class\'s constructor parameter type is an injection token under decorator metadata, a value use', () => {
    const proj = inject("import { UserStore, StoreTuning } from './user_store';\nfunction Injectable(): ClassDecorator { return () => undefined; }\n@Injectable()\nexport class Orch {\n  constructor(private readonly store: UserStore, private readonly tuning: StoreTuning) {}\n  run(): string { return this.store.load(); }\n}\n");
    proj.activate();
    try {
      const found = byCode(validateProject(), 'UNDECLARED_EXPORT');
      expect(found).toHaveLength(1);
      // The stray export crosses; the class realizing the declared dependency is the edge made real.
      expect(found[0].message).toContain('"StoreTuning"');
      expect(found[0].message).not.toContain('"UserStore"');
    } finally { proj.cleanup(); }
  });

  it('control: without the decorator the same stray type annotation is erased, and nothing crosses', () => {
    const proj = inject("import { UserStore, StoreTuning } from './user_store';\nexport class Orch {\n  constructor(private readonly store: UserStore, private readonly tuning: StoreTuning) {}\n  run(): string { return this.store.load(); }\n}\n");
    proj.activate();
    try {
      expect(byCode(validateProject(), 'UNDECLARED_EXPORT')).toEqual([]);
    } finally { proj.cleanup(); }
  });

  // The annotation counts as a value use only where the decorator sits on the
  // declaration it types (decorator metadata is emitted per decorated declaration).
  const DEC = 'function Dec(): any { return () => undefined; }\n';
  const TUNING = "import { StoreTuning } from './user_store';\n" + DEC;
  const crossesWith = (orchSource: string): boolean => {
    const proj = inject(orchSource);
    proj.activate();
    try {
      return byCode(validateProject(), 'UNDECLARED_EXPORT').some(i => i.message.includes('"StoreTuning"'));
    } finally { proj.cleanup(); }
  };

  it('control: an undecorated class with a decorated METHOD does not make an undecorated property\'s type a value use', () => {
    expect(crossesWith(`${TUNING}export class Orch {\n  private readonly tuning!: StoreTuning;\n  @Dec()\n  run(): string { return ''; }\n}\n`)).toBe(false);
  });

  it('fire: a property carrying its own decorator is emitted as metadata, a value use', () => {
    expect(crossesWith(`${TUNING}export class Orch {\n  @Dec()\n  private readonly tuning!: StoreTuning;\n  run(): string { return ''; }\n}\n`)).toBe(true);
  });

  it('fire: an undecorated class whose constructor parameter carries a decorator is emitted as metadata, a value use', () => {
    expect(crossesWith(`${TUNING}export class Orch {\n  constructor(@Dec() private readonly tuning: StoreTuning) {}\n  run(): string { return ''; }\n}\n`)).toBe(true);
  });

  it('control: a constructor parameter of an undecorated class with only a decorated method is erased', () => {
    expect(crossesWith(`${TUNING}export class Orch {\n  constructor(private readonly tuning: StoreTuning) {}\n  @Dec()\n  run(): string { return ''; }\n}\n`)).toBe(false);
  });

  it('a method parameter is a value use only when its method is decorated', () => {
    expect(crossesWith(`${TUNING}export class Orch {\n  @Dec()\n  run(tuning: StoreTuning): string { return ''; }\n}\n`)).toBe(true);
    expect(crossesWith(`${TUNING}export class Orch {\n  @Dec()\n  other(): void {}\n  run(tuning: StoreTuning): string { return ''; }\n}\n`)).toBe(false);
  });

  it('control: the declared dependent injecting (decorated) or constructing the class realizing its dependency draws none', () => {
    for (const orch of [
      "import { UserStore } from './user_store';\nfunction Injectable(): ClassDecorator { return () => undefined; }\n@Injectable()\nexport class Orch {\n  constructor(private readonly store: UserStore) {}\n  run(): string { return this.store.load(); }\n}\n",
      "import { UserStore } from './user_store';\nexport class Orch {\n  constructor(private readonly store: UserStore = new UserStore()) {}\n  run(): string { return this.store.load(); }\n}\n",
    ]) {
      const proj = inject(orch);
      proj.activate();
      try {
        expect(byCode(validateProject(), 'UNDECLARED_EXPORT')).toEqual([]);
      } finally { proj.cleanup(); }
    }
  });

  it('fire: a component that declares no dependency on it constructing the realizing class still crosses', () => {
    const proj = inject("export class Orch {\n  run(): string { return ''; }\n}\n");
    proj.component('orch-b', 'Orchestrator');
    proj.contract('orch-b', ['go']);
    proj.impl('orch-b', `sourcePath: src/other.ts\nmethods:\n${intent('go')}`);
    proj.source('src/other.ts', "import { UserStore } from './user_store';\nexport function go(): string { return new UserStore().load(); }\n");
    proj.activate();
    try {
      const found = byCode(validateProject(), 'UNDECLARED_EXPORT');
      expect(found).toHaveLength(1);
      expect(found[0].message).toContain('"UserStore"');
    } finally { proj.cleanup(); }
  });
});

describe('MISSING_INTEGRATION_SIM — a component with no code yet has nothing to wire', () => {
  const adopted = (proj: Project, laterImpl: string) => {
    proj.component('store-a', 'Store');
    proj.contract('store-a', ['load']);
    proj.impl('store-a', `sourcePath: src/store.ts\nmethods:\n${intent('load')}`);
    proj.source('src/store.ts', 'export function load(): string { return ""; }\n');
    // The subsystem adopts sims through its first declared harness.
    proj.component('orch-a', 'Orchestrator', 'dependsOn: [store-a]');
    proj.contract('orch-a', ['run']);
    proj.impl('orch-a', `status: complete\nsourcePath: src/orch.ts\nsimPath: tests/a.sim.ts\nmethods:\n${intent('run')}`);
    proj.source('src/orch.ts', "import { load } from './store.js';\nexport function run(): string { return load(); }\n");
    proj.source('tests/a.sim.ts', "import { run } from '../src/orch.js';\nimport { load } from '../src/store.js';\nexport const sim = [run, load];\n");
    proj.component('orch-b', 'Orchestrator', 'dependsOn: [store-a]');
    proj.contract('orch-b', ['go']);
    proj.impl('orch-b', `status: complete\n${laterImpl}methods:\n${intent('go')}`);
  };

  it('control: an implementation that names no source file is not asked for a harness', () => {
    const proj = createTempProject();
    adopted(proj, '');
    proj.activate();
    try {
      expect(byCode(validateProject(), 'MISSING_INTEGRATION_SIM')).toEqual([]);
    } finally { proj.cleanup(); }
  });

  it('control: nor is one whose named file does not exist yet', () => {
    const proj = createTempProject();
    adopted(proj, 'sourcePath: src/b.ts\n');
    proj.activate();
    try {
      expect(byCode(validateProject(), 'MISSING_INTEGRATION_SIM')).toEqual([]);
    } finally { proj.cleanup(); }
  });

  it('fire: once the code exists, the harness is expected', () => {
    const proj = createTempProject();
    adopted(proj, 'sourcePath: src/b.ts\n');
    proj.source('src/b.ts', "import { load } from './store.js';\nexport function go(): string { return load(); }\n");
    proj.activate();
    try {
      const found = byCode(validateProject(), 'MISSING_INTEGRATION_SIM');
      expect(found).toHaveLength(1);
      expect(found[0].specId).toBe('impl-orch-b');
    } finally { proj.cleanup(); }
  });
});

describe('UNDECLARED_EXPORT — one file realizing two components: a class is credited to the component it is named for', () => {
  // Two classes in ONE file both hold a `run`. The first component's
  // implementation names its class (exportedVia: Alpha); the second names none.
  const twoClasses = (callerDependsOn: string, callerSource: string) => {
    const proj = createTempProject();
    proj.component('comp-x', 'Orchestrator');
    proj.contract('comp-x', ['run']);
    proj.impl('comp-x', `sourcePath: src/two.ts\nmethods:\n${intent('run')}\n    exportedVia: Alpha`);
    proj.component('comp-y', 'Orchestrator');
    proj.contract('comp-y', ['run']);
    proj.impl('comp-y', `sourcePath: src/two.ts\nmethods:\n${intent('run')}`);
    proj.source('src/two.ts', 'export class Alpha {\n  run(): void {}\n}\nexport class Beta {\n  run(): void {}\n}\n');
    proj.component('comp-c', 'Orchestrator', `dependsOn: [${callerDependsOn}]`);
    proj.contract('comp-c', ['go']);
    proj.impl('comp-c', `sourcePath: src/c.ts\nmethods:\n${intent('go')}`);
    proj.source('src/c.ts', callerSource);
    return proj;
  };
  const useBeta = "import { Beta } from './two';\nexport function go(): void { new Beta().run(); }\n";

  it('fire: a caller depending only on the first component importing the second\'s class still crosses', () => {
    const proj = twoClasses('comp-x', useBeta);
    proj.activate();
    try {
      const found = byCode(validateProject(), 'UNDECLARED_EXPORT');
      expect(found).toHaveLength(1);
      expect(found[0].message).toContain('"Beta"');
    } finally { proj.cleanup(); }
  });

  it('control: a caller depending on the component whose class it is draws none', () => {
    const proj = twoClasses('comp-y', useBeta);
    proj.activate();
    try {
      expect(byCode(validateProject(), 'UNDECLARED_EXPORT')).toEqual([]);
    } finally { proj.cleanup(); }
  });
});
