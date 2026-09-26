import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { setProjectRoot, listFilesRecursive } from '../../src/utils/fs.js';
import { invalidateSpecCache, moveMethods, type SpecWriteHooks } from '../../src/core/specs.js';
import { methodMoveGate, moveMethods as gatedMoveMethods } from '../../src/core/authoring.js';
import { readYamlFile, writeYamlFile } from '../../src/utils/yaml.js';
import type { ComponentSpec, ImplementationSpec, InterfaceSpec, SubsystemSpec } from '../../src/models/index.js';

// ---------------------------------------------------------------------------
// core_orchestrator.moveMethods — the methods leave one component's contract
// and arrive on another's, their implementations travel with them, and every
// reference that named the old home follows: narrative call, register and
// dispatch steps, dispatch-table bindings, lifecycle entrypoints, and `calls`
// entries. Prose and a published wire address are reported and left exactly as
// they were.
//
// The refusal is the feature: when a rule refuses the move NOTHING is written
// and the report ranks the candidate homes cheapest-legal-first, the requested
// target among them so its shortfall reads beside the others.
// ---------------------------------------------------------------------------

const now = new Date().toISOString();

type Step = {
  type: 'local' | 'call' | 'dispatch' | 'register';
  targetComponent?: string;
  targetMethod?: string;
  capability?: string;
};
type MethodDef = { name: string; endpoint?: Record<string, unknown> };
type MethodImpl = {
  name: string;
  steps?: Step[];
  calls?: string[];
  symbol?: string;
  sourcePath?: string;
  detail?: string;
  intent?: string;
};

const sub = (id: string, over: Partial<SubsystemSpec> = {}): SubsystemSpec => ({
  id, name: id, description: `subsystem ${id}`, parentSystem: 'books-sys',
  publicInterfaces: [], trustedLinks: [], status: 'draft', createdAt: now, updatedAt: now, ...over,
});
const comp = (id: string, subsystem: string, componentType: string, over: Record<string, unknown> = {}): ComponentSpec => ({
  id, name: id, description: 'd', subsystem, componentType, owns: [], dependsOn: [], createdAt: now, updatedAt: now, ...over,
} as ComponentSpec);
const intf = (id: string, component: string, methods: (string | MethodDef)[]): InterfaceSpec => ({
  id, name: id, description: 'd', component, createdAt: now, updatedAt: now,
  methods: methods.map((m) => {
    const def: MethodDef = typeof m === 'string' ? { name: m } : m;
    return { description: 'd', signature: `${def.name}(entry: Entry): void`, returns: 'void', ...def };
  }),
} as InterfaceSpec);
const impl = (id: string, contract: string, methods: MethodImpl[]): ImplementationSpec => ({
  id, name: id, description: 'd', contract, createdAt: now, updatedAt: now,
  methods: methods.map(({ name, steps = [], ...rest }) => ({
    name,
    narrative: steps.map((step, i) => ({ stepNumber: i + 1, description: `${step.type} step`, ...step })),
    ...rest,
  })),
} as ImplementationSpec);

/** A fresh project root with packs pinned off, so no machine-level pack changes a verdict. */
function projectRoot(prefix: string, rules: Record<string, unknown> = {}): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.mkdirSync(path.join(dir, '.wai', 'specs'), { recursive: true });
  writeYamlFile(path.join(dir, '.wai', 'project.yaml'), {
    schemaVersion: '1.0.0', name: path.basename(dir),
    targets: [{ type: 'claude', outputDir: '.claude/agents', enabled: true }],
    rules, extensions: { packs: [], useGlobalPacks: false }, createdAt: now, updatedAt: now,
  });
  return dir;
}

/** What a spec file is, read from its content as the loader reads it. */
function kindOf(raw: any): string {
  if ('componentType' in raw) return 'component';
  if ('parentSystem' in raw) return 'subsystem';
  if ('vision' in raw) return 'system';
  if ('contract' in raw) return 'implementation';
  if ('component' in raw) return 'interface';
  if ('kind' in raw) return 'type';
  return 'unknown';
}

/** The spec a project's own spec files store with this kind and id, as written. */
function stored(projectDir: string, kind: string, id: string): any {
  const [spec] = listFilesRecursive(path.join(projectDir, '.wai', 'specs'), '.yaml')
    .map((file) => readYamlFile(file) as any)
    .filter((raw) => kindOf(raw) === kind && (kind === 'system' || raw.id === id));
  return spec;
}

/** A stored implementation's method, by name. */
const method = (projectDir: string, id: string, name: string): any =>
  stored(projectDir, 'implementation', id)?.methods.find((m: any) => m.name === name);

/** The method names a stored contract declares, in order. */
const declared = (projectDir: string, id: string): string[] =>
  stored(projectDir, 'interface', id).methods.map((m: any) => m.name);

/** Every file under a directory, by relative path, with its content. */
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (at: string): void => {
    for (const entry of fs.readdirSync(at, { withFileTypes: true })) {
      const full = path.join(at, entry.name);
      if (entry.isDirectory()) walk(full);
      else out[path.relative(dir, full)] = fs.readFileSync(full, 'utf8');
    }
  };
  walk(dir);
  return out;
}

/**
 * A `books` subsystem whose `intake` Orchestrator declares `post`, `audit` and
 * `close`, and is named from every reference position: a lifecycle entrypoint,
 * a Portal's dispatch table, narrative call and register steps, a `calls` entry
 * on a narrative-less method, and its own implementation calling back into
 * itself. `post` is bound to a gRPC wire method and an entity's prose names the
 * component. `archive` is the intended new home; `ledger` and `desk` are the
 * other candidate homes in the subsystem.
 */
function books(rules: Record<string, unknown> = {}): string {
  const root = projectRoot('method-move-', rules);
  const specs = path.join(root, '.wai', 'specs');
  const write = (rel: string, content: object): void => writeYamlFile(path.join(specs, ...rel.split('/')), content);

  write('.index.yaml', {
    schemaVersion: '1.0.0', name: 'books-sys', vision: 'v', boundaries: [], globalRequirements: [],
    createdAt: now, updatedAt: now,
  });
  write('subsystems/books.yaml', sub('books', {
    lifecycle: [
      { phase: 'init', component: 'intake', method: 'post' },
      { phase: 'shutdown', component: 'intake', method: 'close' },
    ],
  }));

  // The source: three methods, two of which move.
  write('components/intake.yaml', comp('intake', 'books', 'Orchestrator', { dependsOn: ['vault', 'mailer', 'clock'] }));
  write('interfaces/iintake.yaml', intf('iintake', 'intake', [
    { name: 'post', endpoint: { transport: 'gRPC', service: 'books.Intake', method: 'post' } },
    'audit',
    'close',
  ]));
  write('implementations/intake_impl.yaml', impl('intake_impl', 'iintake', [
    {
      name: 'post',
      symbol: 'appendEntry', sourcePath: 'src/books/intake.ts', detail: 'full',
      steps: [
        { type: 'call', targetComponent: 'vault', targetMethod: 'put' },
        { type: 'call', targetComponent: 'mailer', targetMethod: 'send' },
      ],
    },
    {
      name: 'audit', detail: 'intent',
      intent: 'Walks the vault and reports every entry whose signature does not verify.',
      calls: ['vault.put'],
    },
    // Stays behind, and calls a method that leaves — so its call must follow.
    { name: 'close', steps: [{ type: 'call', targetComponent: 'intake', targetMethod: 'post' }] },
  ]));

  // The intended new home, and the two other candidates.
  write('components/archive.yaml', comp('archive', 'books', 'Orchestrator', { dependsOn: ['clock'] }));
  write('interfaces/iarchive.yaml', intf('iarchive', 'archive', ['sweep']));
  write('implementations/archive_impl.yaml', impl('archive_impl', 'iarchive', [
    { name: 'sweep', steps: [{ type: 'call', targetComponent: 'clock', targetMethod: 'now' }] },
  ]));
  write('components/ledger.yaml', comp('ledger', 'books', 'Orchestrator', { dependsOn: ['vault', 'mailer'] }));
  write('interfaces/iledger.yaml', intf('iledger', 'ledger', ['reconcile']));
  write('implementations/ledger_impl.yaml', impl('ledger_impl', 'iledger', [{ name: 'reconcile', steps: [{ type: 'local' }] }]));
  write('components/desk.yaml', comp('desk', 'books', 'Orchestrator', { dependsOn: [] }));
  write('interfaces/idesk.yaml', intf('idesk', 'desk', ['greet']));
  write('implementations/desk_impl.yaml', impl('desk_impl', 'idesk', [{ name: 'greet', steps: [{ type: 'local' }] }]));

  // The collaborators the moved methods reach.
  write('components/vault.yaml', comp('vault', 'books', 'Store', { durability: 'durable' }));
  write('interfaces/ivault.yaml', intf('ivault', 'vault', ['put']));
  write('implementations/vault_impl.yaml', impl('vault_impl', 'ivault', [{ name: 'put', steps: [{ type: 'local' }] }]));
  write('components/mailer.yaml', comp('mailer', 'books', 'Adapter'));
  write('interfaces/imailer.yaml', intf('imailer', 'mailer', ['send', 'post']));
  write('implementations/mailer_impl.yaml', impl('mailer_impl', 'imailer', [
    { name: 'send', steps: [{ type: 'local' }] },
    // Another component's method of the same name — never touched by the move.
    { name: 'post', steps: [{ type: 'local' }] },
  ]));
  write('components/clock.yaml', comp('clock', 'books', 'Adapter'));
  write('interfaces/iclock.yaml', intf('iclock', 'clock', ['now']));
  write('implementations/clock_impl.yaml', impl('clock_impl', 'iclock', [{ name: 'now', steps: [{ type: 'local' }] }]));

  // The callers: a Portal's dispatch table and an Orchestrator's narrative.
  write('components/books_portal.yaml', comp('books_portal', 'books', 'Portal', {
    portalType: 'Custom', dependsOn: ['intake', 'books_orch'],
    dispatch: [
      { capability: 'intake.post', component: 'intake', method: 'post' },
      { capability: 'intake.close', component: 'intake', method: 'close' },
    ],
  }));
  write('interfaces/ibooks_portal.yaml', intf('ibooks_portal', 'books_portal', ['handle']));
  write('implementations/books_portal_impl.yaml', impl('books_portal_impl', 'ibooks_portal', [
    { name: 'handle', steps: [{ type: 'local' }] },
  ]));
  write('components/books_orch.yaml', comp('books_orch', 'books', 'Orchestrator', { dependsOn: ['intake', 'mailer'] }));
  write('interfaces/ibooks_orch.yaml', intf('ibooks_orch', 'books_orch', ['run', 'tally']));
  write('implementations/books_orch_impl.yaml', impl('books_orch_impl', 'ibooks_orch', [
    {
      name: 'run',
      steps: [
        { type: 'call', targetComponent: 'intake', targetMethod: 'post' },
        { type: 'register', targetComponent: 'intake', targetMethod: 'post' },
        // Another method of the same component that does NOT move.
        { type: 'call', targetComponent: 'intake', targetMethod: 'close' },
        // Another component's method of the same name.
        { type: 'call', targetComponent: 'mailer', targetMethod: 'post' },
      ],
    },
    // The narrative-less spelling of a call: `calls` names the same pair.
    { name: 'tally', detail: 'intent', intent: 'Counts what intake has posted.', calls: ['intake.audit', 'mailer.send'] },
  ]));

  write('types/entry.yaml', {
    kind: 'entity', id: 'entry', name: 'Entry', description: 'the entry intake appends to the vault',
    subsystem: 'books', componentClass: 'vault',
    fields: [{ name: 'id', type: 'string', optional: false }], methods: [], createdAt: now, updatedAt: now,
  });

  setProjectRoot(root);
  invalidateSpecCache();
  return root;
}

/** A hook that accepts everything — the move's mechanics with no judgement injected. */
const permissive: SpecWriteHooks = { gate: () => undefined, assess: () => [] };

describe('moveMethods', () => {
  let root: string | undefined;

  afterEach(() => {
    setProjectRoot(null);
    invalidateSpecCache();
    try { if (root) fs.rmSync(root, { recursive: true, force: true }); } catch { /* win locks */ }
    root = undefined;
  });

  // -- the clean move ------------------------------------------------------

  it('moves the contract entries, carrying signature, params and endpoint unchanged', () => {
    root = books();

    const report = moveMethods('intake', 'archive', ['post', 'audit'], permissive);

    expect(report.moved).toBe(true);
    expect(declared(root, 'iintake')).toEqual(['close']);
    expect(declared(root, 'iarchive')).toEqual(['sweep', 'post', 'audit']);
    const moved = stored(root, 'interface', 'iarchive').methods.find((m: any) => m.name === 'post');
    expect(moved.signature).toBe('post(entry: Entry): void');
    expect(moved.endpoint).toEqual({ transport: 'gRPC', service: 'books.Intake', method: 'post' });
  });

  it('moves the implementation entries, carrying narrative, symbol, sourcePath, detail, intent and calls', () => {
    root = books();

    moveMethods('intake', 'archive', ['post', 'audit'], permissive);

    expect(stored(root, 'implementation', 'intake_impl').methods.map((m: any) => m.name)).toEqual(['close']);
    expect(method(root, 'archive_impl', 'post')).toMatchObject({
      symbol: 'appendEntry', sourcePath: 'src/books/intake.ts', detail: 'full',
    });
    expect(method(root, 'archive_impl', 'post').narrative.map((s: any) => s.targetComponent)).toEqual(['vault', 'mailer']);
    expect(method(root, 'archive_impl', 'audit')).toMatchObject({
      detail: 'intent',
      intent: 'Walks the vault and reports every entry whose signature does not verify.',
      calls: ['vault.put'],
    });
  });

  it('gives the target the dependencies the moved narratives call, and only those', () => {
    root = books();

    const report = moveMethods('intake', 'archive', ['post', 'audit'], permissive);

    // clock it already had; vault and mailer the moved methods need.
    expect(stored(root, 'component', 'archive').dependsOn).toEqual(['clock', 'mailer', 'vault']);
    expect(report.edits.map((e) => `${e.kind}:${e.id}`)).toContain('component:archive');
    // The source keeps what its remaining methods might still use — a move
    // never prunes a dependency it cannot prove is dead.
    expect(stored(root, 'component', 'intake').dependsOn).toEqual(['vault', 'mailer', 'clock']);
  });

  it('re-points every reference kind that named the old home, and only those', () => {
    root = books();

    const report = moveMethods('intake', 'archive', ['post', 'audit'], permissive);

    // A lifecycle entrypoint; its sibling phase names a method that stayed.
    expect(stored(root, 'subsystem', 'books').lifecycle).toEqual([
      expect.objectContaining({ phase: 'init', component: 'archive', method: 'post' }),
      expect.objectContaining({ phase: 'shutdown', component: 'intake', method: 'close' }),
    ]);
    // A dispatch-table binding. The capability NAME is the table's key, not a
    // reference to the component, and stays as it is.
    expect(stored(root, 'component', 'books_portal').dispatch).toEqual([
      { capability: 'intake.post', component: 'archive', method: 'post' },
      { capability: 'intake.close', component: 'intake', method: 'close' },
    ]);
    // Narrative call and register steps — never another method of the same
    // component, nor another component's method of the same name.
    expect(method(root, 'books_orch_impl', 'run').narrative.map((s: any) => [s.type, s.targetComponent, s.targetMethod]))
      .toEqual([
        ['call', 'archive', 'post'],
        ['register', 'archive', 'post'],
        ['call', 'intake', 'close'],
        ['call', 'mailer', 'post'],
      ]);
    // A `calls` entry — the narrative-less spelling of the same reference.
    expect(method(root, 'books_orch_impl', 'tally').calls).toEqual(['archive.audit', 'mailer.send']);
    // The method left behind, calling one that moved.
    expect(method(root, 'intake_impl', 'close').narrative[0]).toMatchObject({ targetComponent: 'archive', targetMethod: 'post' });
    // 5 references: lifecycle, dispatch, call, register, `calls`, and close's call.
    expect(report.repointed).toBe(6);
  });

  it('reports what still names the old home — prose and a published wire address — and rewrites neither', () => {
    root = books();
    const proseBefore = stored(root, 'type', 'entry').description;

    const report = moveMethods('intake', 'archive', ['post', 'audit'], permissive);

    // The intent prose of a caller, an entity's description, and the contract
    // the wire-bound method arrived on. A dispatch capability NAME is not prose.
    expect([...report.mentions].sort()).toEqual(['books_orch_impl', 'entry', 'iarchive']);
    expect(stored(root, 'type', 'entry').description).toBe(proseBefore);
    // Moving a method between components must not silently re-address an RPC.
    expect(stored(root, 'interface', 'iarchive').methods.find((m: any) => m.name === 'post').endpoint)
      .toEqual({ transport: 'gRPC', service: 'books.Intake', method: 'post' });
  });

  it('notices the caller that now reaches the new home without declaring it', () => {
    root = books();

    const report = moveMethods('intake', 'archive', ['post', 'audit'], permissive);

    expect(report.notices.some((n) => n.includes('"books_orch" now reaches "archive"'))).toBe(true);
    // The move re-points the reference; it never edits another component's
    // dependency list, because a dependency nobody judged is what the gate is for.
    expect(stored(root, 'component', 'books_orch').dependsOn).toEqual(['intake', 'mailer']);
  });

  // -- the dry run ---------------------------------------------------------

  it('runs the whole move for a dry run and writes nothing', () => {
    root = books();
    const before = snapshot(path.join(root, '.wai'));

    const report = moveMethods('intake', 'archive', ['post', 'audit'], permissive, true);

    expect(report.dryRun).toBe(true);
    expect(report.moved).toBe(false);
    expect(report.edits.length).toBeGreaterThan(0);
    expect(report.edits.every((e) => e.dryRun && !e.written)).toBe(true);
    expect(report.repointed).toBe(6);
    expect(snapshot(path.join(root, '.wai'))).toEqual(before);
  });

  // -- the pre-write refusals ----------------------------------------------

  it.each([
    ['a source component that does not exist', 'ghost', 'archive', ['post'], 'no component has the id "ghost"'],
    ['a target component that does not exist', 'intake', 'ghost', ['post'], 'no component has the id "ghost"'],
    ['a method the source does not declare', 'intake', 'archive', ['vanish'], 'no contract of "intake" declares the method "vanish"'],
    ['a source and target that are the same', 'intake', 'intake', ['post'], 'both the source and the target'],
    ['a component inside a chained subproject', 'ext::widget', 'archive', ['post'], 'chained subproject'],
  ])('refuses %s before the first write', (_label, from, to, methods, message) => {
    root = books();
    const before = snapshot(path.join(root, '.wai'));

    expect(() => moveMethods(from as string, to as string, methods as string[], permissive))
      .toThrow(new RegExp(`unmovable request: .*${message.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    expect(snapshot(path.join(root, '.wai'))).toEqual(before);
  });

  it('refuses a name the target already declares before the first write', () => {
    root = books();
    // archive declares a `close` of its own, so intake's cannot land there.
    const iarchive = path.join(root, '.wai', 'specs', 'interfaces', 'iarchive.yaml');
    const spec = readYamlFile(iarchive) as any;
    spec.methods.push({ name: 'close', description: 'd', signature: 'close(entry: Entry): void', returns: 'void' });
    writeYamlFile(iarchive, spec);
    invalidateSpecCache();
    const before = snapshot(path.join(root, '.wai'));

    expect(() => moveMethods('intake', 'archive', ['close'], permissive))
      .toThrow(/unmovable request: "archive" already declares "close"/);
    expect(snapshot(path.join(root, '.wai'))).toEqual(before);
  });

  it('names a mistyped id as a mistyped id, never as a rule refusing the design', () => {
    root = books();

    expect(() => moveMethods('intake', 'archive', ['pots'], permissive))
      .toThrow(/^unmovable request: no contract of "intake" declares the method "pots"/);
  });

  // -- the refusal, with ranked alternatives --------------------------------

  it('refuses the move, writes nothing, and ranks the homes cheapest legal first', () => {
    // archive holds 1 dependency and the moved methods need 2 more: 3 against a
    // ceiling of 2. ledger already reaches both, so it costs nothing.
    root = books({ complexity: { maxComponentDependencies: 2 } });
    const before = snapshot(path.join(root, '.wai'));

    const report = gatedMoveMethods('intake', 'archive', ['post', 'audit']);

    expect(report.moved).toBe(false);
    expect(report.refusals).toEqual(['EXCESSIVE_DEPENDENCIES']);
    expect(report.edits).toEqual([]);
    expect(report.repointed).toBe(0);
    expect(snapshot(path.join(root, '.wai'))).toEqual(before);

    // The cheapest legal home is first, and the requested target is among them
    // so its shortfall reads beside the others.
    const homes = report.alternatives.map((c) => c.component);
    expect(homes[0]).toBe('ledger');
    expect(homes).toContain('archive');
    const ledger = report.alternatives.find((c) => c.component === 'ledger');
    expect(ledger).toMatchObject({ legal: true, newDependencies: [], dependencyCount: 2, dependencyLimit: 2, refusals: [] });
    const archive = report.alternatives.find((c) => c.component === 'archive');
    expect(archive).toMatchObject({
      legal: false, newDependencies: ['mailer', 'vault'], dependencyCount: 3, dependencyLimit: 2,
      refusals: ['EXCESSIVE_DEPENDENCIES'],
    });
    expect(report.summary).toContain('cheapest legal home is "ledger"');
  });

  it('never refuses the SOURCE for a ceiling it already exceeded — emptying it is the point', () => {
    // intake holds 3 dependencies against a ceiling of 2 and must still be able
    // to give methods away.
    root = books({ complexity: { maxComponentDependencies: 2 } });

    const report = gatedMoveMethods('intake', 'ledger', ['post', 'audit']);

    expect(report.moved).toBe(true);
    expect(declared(root, 'iledger')).toEqual(['reconcile', 'post', 'audit']);
  });

  it('asks the hook to assess each candidate rather than driving the search on caught exceptions', () => {
    root = books({ complexity: { maxComponentDependencies: 2 } });
    const assessed: string[] = [];
    const counting: SpecWriteHooks = {
      gate: (kind, merged) => { if ((merged as ComponentSpec).id === 'archive') throw new Error('refused'); },
      assess: (kind, merged) => {
        assessed.push((merged as ComponentSpec).id);
        return (merged as ComponentSpec).id === 'archive' ? ['EXCESSIVE_DEPENDENCIES'] : [];
      },
    };

    const report = moveMethods('intake', 'archive', ['post', 'audit'], counting);

    expect(report.moved).toBe(false);
    // Every other component of the source's subsystem was weighed, without a throw.
    expect(assessed).toContain('ledger');
    expect(assessed).toContain('desk');
    expect(assessed).not.toContain('intake');
    expect(report.alternatives.every((c) => c.dependencyLimit === 2)).toBe(true);
  });

  it('is the gate, not the store, that holds the judgement — no hook means no refusal', () => {
    root = books({ complexity: { maxComponentDependencies: 2 } });

    const report = moveMethods('intake', 'archive', ['post', 'audit']);

    expect(report.moved).toBe(true);
    expect(report.refusals).toEqual([]);
  });

  // -- atomicity -----------------------------------------------------------

  it('restores what it already wrote when a write fails, so nothing moves by halves', () => {
    root = books();
    const before = snapshot(path.join(root, '.wai'));
    // The last spec the sweep re-points, made unwritable so its save throws
    // after several edits have already landed.
    const blocked = path.join(root, '.wai', 'specs', 'implementations', 'books_orch_impl.yaml');
    fs.chmodSync(blocked, 0o444);

    try {
      expect(() => moveMethods('intake', 'archive', ['post', 'audit'], permissive)).toThrow(/move-write-failed/);
    } finally {
      fs.chmodSync(blocked, 0o666);
    }

    invalidateSpecCache();
    // Every edit that landed before the failure is back. The comparison is of
    // CONTENT, not bytes: a restore goes through the store's own writer, which
    // normalizes field order and makes a defaulted status explicit — what must
    // not survive is a single moved method or a single re-pointed reference.
    expect(declared(root, 'iintake')).toEqual(['post', 'audit', 'close']);
    expect(declared(root, 'iarchive')).toEqual(['sweep']);
    expect(stored(root, 'implementation', 'intake_impl').methods.map((m: any) => m.name)).toEqual(['post', 'audit', 'close']);
    expect(stored(root, 'implementation', 'archive_impl').methods.map((m: any) => m.name)).toEqual(['sweep']);
    expect(stored(root, 'component', 'archive').dependsOn).toEqual(['clock']);
    expect(stored(root, 'subsystem', 'books').lifecycle[0]).toMatchObject({ component: 'intake', method: 'post' });
    expect(stored(root, 'component', 'books_portal').dispatch[0]).toMatchObject({ component: 'intake', method: 'post' });
    expect(method(root, 'intake_impl', 'close').narrative[0]).toMatchObject({ targetComponent: 'intake' });
    expect(method(root, 'books_orch_impl', 'tally').calls).toEqual(['intake.audit', 'mailer.send']);
    expect(before).toBeDefined();
  });

  // -- the gate the authoring seam injects ---------------------------------

  it('exempts only the source from the ceiling, and answers with codes rather than throwing', () => {
    root = books({ complexity: { maxComponentDependencies: 2 } });
    const hooks = methodMoveGate('intake');
    const over = comp('over', 'books', 'Orchestrator', { dependsOn: ['a', 'b', 'c'] });

    expect(hooks.assess?.('component', over)).toEqual(['EXCESSIVE_DEPENDENCIES']);
    expect(() => hooks.gate?.('component', over)).toThrow(/EXCESSIVE_DEPENDENCIES/);
    // The source itself, at the same count, is not refused.
    expect(hooks.assess?.('component', { ...over, id: 'intake' })).toEqual([]);
    expect(() => hooks.gate?.('component', { ...over, id: 'intake' })).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// F77 — a target without a contract receives one.
//
// Splitting a portal meant moving methods into brand-new components, and every
// dry run refused: '"approval_portal" declares no contract, so the methods
// would have nowhere to arrive.' Each target first needed an empty interface
// and an empty implementation authored by hand, with a sourcePath the move
// could have inherited. The move now creates i<target> and <target>_impl and
// names what it created; what it refuses, it still refuses for a reason.
// ---------------------------------------------------------------------------

describe('moveMethods into a component with no contract yet', () => {
  let root: string | undefined;

  afterEach(() => {
    setProjectRoot(null);
    invalidateSpecCache();
    try { if (root) fs.rmSync(root, { recursive: true, force: true }); } catch { /* win locks */ }
    root = undefined;
  });

  /** books() plus `shelf`, a bare Orchestrator, and a spec-level sourcePath on intake_impl to inherit. */
  function booksWithShelf(extra: (write: (rel: string, content: object) => void) => void = () => undefined): string {
    const dir = books();
    const specs = path.join(dir, '.wai', 'specs');
    const write = (rel: string, content: object): void => writeYamlFile(path.join(specs, ...rel.split('/')), content);
    write('components/shelf.yaml', comp('shelf', 'books', 'Orchestrator', { dependsOn: ['vault', 'mailer'] }));
    const intakeImpl = path.join(specs, 'implementations', 'intake_impl.yaml');
    writeYamlFile(intakeImpl, { ...(readYamlFile(intakeImpl) as object), sourcePath: 'src/books/intake-impl.ts', status: 'complete' });
    const iintake = path.join(specs, 'interfaces', 'iintake.yaml');
    writeYamlFile(iintake, { ...(readYamlFile(iintake) as object), status: 'complete' });
    extra(write);
    invalidateSpecCache();
    return dir;
  }

  it('creates i<target> and <target>_impl, inheriting the sourcePath, and names both', () => {
    root = booksWithShelf();

    const report = moveMethods('intake', 'shelf', ['post', 'audit'], permissive);

    expect(report.moved).toBe(true);
    expect(report.created).toEqual([
      'interface "ishelf"',
      'implementation "shelf_impl" (sourcePath src/books/intake-impl.ts, inherited from "intake_impl")',
    ]);
    expect(report.summary).toContain('created interface "ishelf" and implementation "shelf_impl"');
    expect(declared(root, 'ishelf')).toEqual(['post', 'audit']);
    expect(stored(root, 'interface', 'ishelf')).toMatchObject({ component: 'shelf', status: 'complete' });
    const created = stored(root, 'implementation', 'shelf_impl');
    expect(created).toMatchObject({ contract: 'ishelf', sourcePath: 'src/books/intake-impl.ts', status: 'complete' });
    // The entries arrived whole: narrative, symbol and their own sourcePath.
    expect(method(root, 'shelf_impl', 'post')).toMatchObject({ symbol: 'appendEntry', sourcePath: 'src/books/intake.ts' });
    expect(method(root, 'shelf_impl', 'audit').calls).toEqual(['vault.put']);
    // References followed the methods to the new home.
    expect(method(root, 'intake_impl', 'close').narrative[0]).toMatchObject({ targetComponent: 'shelf' });
    expect(declared(root, 'iintake')).toEqual(['close']);
    // Each created spec has its own change report, marked as created.
    expect(report.edits.find((e) => e.id === 'ishelf')?.summary).toBe('Created interface "ishelf" to receive the moved methods.');
  });

  it('creates only the implementation when the contract exists but nothing realizes it', () => {
    root = booksWithShelf((write) => write('interfaces/ishelf.yaml', intf('ishelf', 'shelf', ['stack'])));

    const report = moveMethods('intake', 'shelf', ['post'], permissive);

    expect(report.moved).toBe(true);
    expect(report.created).toEqual(['implementation "shelf_impl" (sourcePath src/books/intake-impl.ts, inherited from "intake_impl")']);
    expect(declared(root, 'ishelf')).toEqual(['stack', 'post']);
    expect(stored(root, 'implementation', 'shelf_impl').methods.map((m: any) => m.name)).toEqual(['post']);
  });

  it('a dry run names what it would create and writes nothing', () => {
    root = booksWithShelf();
    const before = snapshot(path.join(root, '.wai'));

    const report = moveMethods('intake', 'shelf', ['post'], permissive, true);

    expect(report.moved).toBe(false);
    expect(report.created).toEqual([
      'interface "ishelf"',
      'implementation "shelf_impl" (sourcePath src/books/intake-impl.ts, inherited from "intake_impl")',
    ]);
    expect(report.summary).toContain('would create interface "ishelf"');
    expect(snapshot(path.join(root, '.wai'))).toEqual(before);
  });

  it('refuses to create a contract under an id another component\'s contract holds', () => {
    root = booksWithShelf((write) => write('interfaces/ishelf.yaml', intf('ishelf', 'desk', ['greet2'])));
    const before = snapshot(path.join(root, '.wai'));

    expect(() => moveMethods('intake', 'shelf', ['post'], permissive))
      .toThrow(/^unmovable request: "shelf" declares no contract, and the one the move would create for it, "ishelf", is already the id of "desk"'s contract/);
    expect(snapshot(path.join(root, '.wai'))).toEqual(before);
  });

  it('refuses to create an implementation under an id another implementation holds', () => {
    root = booksWithShelf((write) => write('implementations/shelf_impl.yaml', impl('shelf_impl', 'idesk', [])));

    expect(() => moveMethods('intake', 'shelf', ['post'], permissive))
      .toThrow(/^unmovable request: no implementation realizes "ishelf", and the one the move would create for it, "shelf_impl", is already the id of the implementation of "idesk"/);
  });

  it('a failed write deletes the specs it created as it restores the ones it edited', () => {
    root = booksWithShelf();
    const blocked = path.join(root, '.wai', 'specs', 'implementations', 'books_orch_impl.yaml');
    fs.chmodSync(blocked, 0o444);
    try {
      expect(() => moveMethods('intake', 'shelf', ['post', 'audit'], permissive)).toThrow(/move-write-failed/);
    } finally {
      fs.chmodSync(blocked, 0o666);
    }
    invalidateSpecCache();
    expect(stored(root, 'interface', 'ishelf')).toBeUndefined();
    expect(stored(root, 'implementation', 'shelf_impl')).toBeUndefined();
    expect(declared(root, 'iintake')).toEqual(['post', 'audit', 'close']);
  });
});

// ---------------------------------------------------------------------------
// A moved entry keeps the file it is realized in.
//
// An implementation entry with no sourcePath of its own is realized in its
// implementation's default file. Moved into an implementation that names a
// DIFFERENT file, it used to take that file on silently — the spec now
// claimed the method lived where no code of it was. It keeps its old file as
// its own sourcePath instead, and the report says so.
// ---------------------------------------------------------------------------

describe('moveMethods keeps where a moved entry is realized', () => {
  let root: string | undefined;

  afterEach(() => {
    setProjectRoot(null);
    invalidateSpecCache();
    try { if (root) fs.rmSync(root, { recursive: true, force: true }); } catch { /* win locks */ }
    root = undefined;
  });

  /** books() with default files on both implementations. */
  function booksWithFiles(intakeFile: string, archiveFile: string): string {
    const dir = books();
    const specs = path.join(dir, '.wai', 'specs', 'implementations');
    for (const [file, sourcePath] of [['intake_impl.yaml', intakeFile], ['archive_impl.yaml', archiveFile]]) {
      const at = path.join(specs, file);
      writeYamlFile(at, { ...(readYamlFile(at) as object), sourcePath });
    }
    invalidateSpecCache();
    return dir;
  }

  it('an entry realized by default in a different file keeps that file as its own, and the report says so', () => {
    root = booksWithFiles('src/books/intake.ts', 'src/books/archive.ts');

    const report = moveMethods('intake', 'archive', ['post', 'audit'], permissive);

    expect(report.moved).toBe(true);
    // audit named no file: it was realized in intake_impl's, and still is.
    expect(method(root, 'archive_impl', 'audit').sourcePath).toBe('src/books/intake.ts');
    // post named its own file already: nothing to keep.
    expect(method(root, 'archive_impl', 'post').sourcePath).toBe('src/books/intake.ts');
    expect(report.notices).toContain(
      '"audit" keeps src/books/intake.ts as its own sourcePath: it was realized there by default, and '
      + '"archive_impl" names src/books/archive.ts — moving a method is not moving its code.',
    );
    expect(report.notices.filter((n) => n.includes('keeps'))).toHaveLength(1);
  });

  it('an entry whose default file is the target\'s own changes nothing', () => {
    root = booksWithFiles('src/books/shared.ts', 'src/books/shared.ts');

    const report = moveMethods('intake', 'archive', ['audit'], permissive);

    expect(report.moved).toBe(true);
    expect(method(root, 'archive_impl', 'audit').sourcePath).toBeUndefined();
    expect(report.notices.some((n) => n.includes('keeps'))).toBe(false);
  });
});
