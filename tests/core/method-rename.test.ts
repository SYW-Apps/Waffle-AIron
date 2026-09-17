import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { setProjectRoot, listFilesRecursive } from '../../src/utils/fs.js';
import { invalidateSpecCache, workspaceFor } from '../../src/core/specs.js';
import { createChainedSubsystem, renameMethod } from '../../src/core/provision.js';
import { readYamlFile, writeYamlFile } from '../../src/utils/yaml.js';
import type { ComponentSpec, ImplementationSpec, InterfaceSpec, SubsystemSpec } from '../../src/models/index.js';

// ---------------------------------------------------------------------------
// core_orchestrator.renameMethod — the method moves on every contract of the
// component that declares it and on the implementations of those contracts,
// every reference to it is retargeted, and what merely NAMES it — prose, and a
// published gRPC wire method — is reported and left exactly as it was. Five
// labelled refusals come first, each leaving every file untouched.
// ---------------------------------------------------------------------------

const now = new Date().toISOString();

type Step = {
  type: 'local' | 'call' | 'dispatch' | 'register';
  targetComponent?: string;
  targetMethod?: string;
  capability?: string;
};
type MethodDef = { name: string; endpoint?: Record<string, unknown> };
type MethodImpl = { name: string; steps?: Step[]; symbol?: string; sourcePath?: string; detail?: string; intent?: string };

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
function projectRoot(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.mkdirSync(path.join(dir, '.wai', 'specs'), { recursive: true });
  writeYamlFile(path.join(dir, '.wai', 'project.yaml'), {
    schemaVersion: '1.0.0', name: path.basename(dir),
    targets: [{ type: 'claude', outputDir: '.claude/agents', enabled: true }],
    rules: {}, extensions: { packs: [], useGlobalPacks: false }, createdAt: now, updatedAt: now,
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
 * A `books` subsystem whose `ledger` Store declares `post` on TWO contracts —
 * one of them binding it to a gRPC wire method — and is named from every
 * reference position: a lifecycle entrypoint, a Portal's dispatch table, and
 * narrative call, register and dispatch steps, its own implementation calling
 * back into it. `mailer` declares a `post` of its own, `close` and `audit` are
 * the ledger's other methods, and an entity's prose names the method. A chained
 * `ext` project holds a component of its own.
 */
function books(): string {
  const root = projectRoot('method-rename-');
  const specs = path.join(root, '.wai', 'specs');
  // The flat layout, written straight to file: a component serves ONE contract
  // in the nested layout, and this ledger serves two.
  const write = (rel: string, content: object): void => writeYamlFile(path.join(specs, ...rel.split('/')), content);
  write('.index.yaml', { schemaVersion: '1.0.0', name: 'books-sys', vision: 'v', boundaries: [], globalRequirements: [], createdAt: now, updatedAt: now });
  write('subsystems/books.yaml', sub('books', {
    lifecycle: [
      { phase: 'init', component: 'ledger', method: 'post' },
      { phase: 'shutdown', component: 'ledger', method: 'close' },
    ],
  }));
  write('components/ledger.yaml', comp('ledger', 'books', 'Store', { durability: 'durable' }));
  write('interfaces/iledger.yaml', intf('iledger', 'ledger', ['close', { name: 'post', endpoint: { transport: 'gRPC', service: 'books.Ledger', method: 'post' } }]));
  write('interfaces/iledger_admin.yaml', intf('iledger_admin', 'ledger', ['post', 'audit']));
  write('implementations/ledger_impl.yaml', impl('ledger_impl', 'iledger', [
    { name: 'close', steps: [{ type: 'call', targetComponent: 'ledger', targetMethod: 'post' }] },
    { name: 'post', steps: [{ type: 'local' }] },
  ]));
  write('implementations/ledger_admin_impl.yaml', impl('ledger_admin_impl', 'iledger_admin', [
    {
      name: 'post', symbol: 'appendEntry', sourcePath: 'src/books/admin.ts', detail: 'intent',
      intent: 'Appends the entry to the durable log and fsyncs it before it answers.',
    },
    { name: 'audit', steps: [{ type: 'local' }] },
  ]));
  write('components/books_portal.yaml', comp('books_portal', 'books', 'Portal', {
    portalType: 'Custom', dependsOn: ['ledger', 'books_orch'],
    dispatch: [
      { capability: 'ledger.post', component: 'ledger', method: 'post' },
      { capability: 'ledger.close', component: 'ledger', method: 'close' },
    ],
  }));
  write('components/books_orch.yaml', comp('books_orch', 'books', 'Orchestrator', {
    dependsOn: ['ledger', 'mailer'], description: 'posts entries, and its own prose names no method',
  }));
  write('interfaces/ibooks_orch.yaml', intf('ibooks_orch', 'books_orch', ['run']));
  write('implementations/books_orch_impl.yaml', impl('books_orch_impl', 'ibooks_orch', [{
    name: 'run',
    steps: [
      { type: 'call', targetComponent: 'ledger', targetMethod: 'post' },
      { type: 'register', targetComponent: 'ledger', targetMethod: 'post' },
      { type: 'dispatch', targetComponent: 'books_portal', capability: 'ledger.post' },
      { type: 'call', targetComponent: 'ledger', targetMethod: 'close' },
      { type: 'call', targetComponent: 'mailer', targetMethod: 'post' },
    ],
  }]));
  write('components/mailer.yaml', comp('mailer', 'books', 'Adapter'));
  write('interfaces/imailer.yaml', intf('imailer', 'mailer', ['post']));
  write('implementations/mailer_impl.yaml', impl('mailer_impl', 'imailer', [{ name: 'post', steps: [{ type: 'local' }] }]));
  write('types/entry.yaml', {
    kind: 'entity', id: 'entry', name: 'Entry', description: 'the entry a post appends', subsystem: 'books', componentClass: 'ledger',
    fields: [{ name: 'id', type: 'string', optional: false }], methods: [], createdAt: now, updatedAt: now,
  });
  setProjectRoot(root);
  invalidateSpecCache();

  createChainedSubsystem(sub('ext', { projectPath: 'packages/ext' }), 'ext');
  const ext = workspaceFor(path.join(root, 'packages', 'ext'));
  ext.saveSubsystemSpec(sub('ext', { parentSystem: 'ext' }));
  ext.saveComponentSpec(comp('widget', 'ext', 'Adapter'));
  invalidateSpecCache();
  return root;
}

describe('renameMethod', () => {
  let root: string | undefined;

  afterEach(() => {
    setProjectRoot(null);
    invalidateSpecCache();
    try { if (root) fs.rmSync(root, { recursive: true, force: true }); } catch { /* win locks */ }
    root = undefined;
  });

  it('moves the method on every contract that declares it, its signature following its name', () => {
    root = books();

    const report = renameMethod('ledger', 'post', 'append');

    expect([...report.renamed].sort()).toEqual(['iledger', 'iledger_admin', 'ledger_admin_impl', 'ledger_impl']);
    expect(report.component).toBe('ledger');
    expect(report.from).toBe('post');
    expect(report.to).toBe('append');

    const contract = stored(root, 'interface', 'iledger');
    expect(contract.methods.map((m: any) => m.name)).toEqual(['close', 'append']);
    expect(contract.methods[1].signature).toBe('append(entry: Entry): void');
    expect(contract.methods[0].signature).toBe('close(entry: Entry): void');
    expect(stored(root, 'interface', 'iledger_admin').methods.map((m: any) => m.name)).toEqual(['append', 'audit']);
    // Another component's method of the same name stays as it is.
    expect(stored(root, 'interface', 'imailer').methods.map((m: any) => m.name)).toEqual(['post']);
  });

  it('moves it on the implementations of those contracts, carrying what the method declares', () => {
    root = books();

    renameMethod('ledger', 'post', 'append');

    expect(stored(root, 'implementation', 'ledger_impl').methods.map((m: any) => m.name)).toEqual(['close', 'append']);
    // Narrative, sourcePath, symbol, detail and intent travel with the method.
    expect(method(root, 'ledger_admin_impl', 'append')).toMatchObject({
      symbol: 'appendEntry',
      sourcePath: 'src/books/admin.ts',
      detail: 'intent',
      intent: 'Appends the entry to the durable log and fsyncs it before it answers.',
    });
    expect(method(root, 'ledger_admin_impl', 'post')).toBeUndefined();
    // An implementation of another component's contract is untouched.
    expect(stored(root, 'implementation', 'mailer_impl').methods.map((m: any) => m.name)).toEqual(['post']);
  });

  it('pins the symbol of an implementation that named none, so the function it binds to keeps binding', () => {
    root = books();

    const report = renameMethod('ledger', 'post', 'append');

    expect(report.pinnedSymbol).toBe('post');
    expect(method(root, 'ledger_impl', 'append').symbol).toBe('post');
    // One that named a symbol keeps the one it named.
    expect(method(root, 'ledger_admin_impl', 'append').symbol).toBe('appendEntry');
  });

  it('leaves the symbol unpinned when pinSymbol is false', () => {
    root = books();

    const report = renameMethod('ledger', 'post', 'append', false);

    expect(report.pinnedSymbol).toBeUndefined();
    expect(method(root, 'ledger_impl', 'append').symbol).toBeUndefined();
    expect(method(root, 'ledger_admin_impl', 'append').symbol).toBe('appendEntry');
  });

  it('retargets every reference to the method, and only those', () => {
    root = books();

    const report = renameMethod('ledger', 'post', 'append');

    expect([...report.rewritten].sort()).toEqual(['books', 'books_orch_impl', 'books_portal', 'ledger_impl']);
    // A lifecycle entrypoint naming it for a phase; its sibling phase is left alone.
    expect(stored(root, 'subsystem', 'books').lifecycle).toEqual([
      expect.objectContaining({ phase: 'init', component: 'ledger', method: 'append' }),
      expect.objectContaining({ phase: 'shutdown', component: 'ledger', method: 'close' }),
    ]);
    // A dispatch-table binding routing a capability to it — the capability NAME
    // is the table's key, not a reference to the method, and stays as it is.
    expect(stored(root, 'component', 'books_portal').dispatch).toEqual([
      { capability: 'ledger.post', component: 'ledger', method: 'append' },
      { capability: 'ledger.close', component: 'ledger', method: 'close' },
    ]);
    // Narrative call and register steps naming this component and this method —
    // never another component's method of the same name, nor another method of
    // this one.
    expect(stored(root, 'implementation', 'books_orch_impl').methods[0].narrative.map((s: any) => [s.type, s.targetComponent, s.targetMethod ?? s.capability]))
      .toEqual([
        ['call', 'ledger', 'append'],
        ['register', 'ledger', 'append'],
        ['dispatch', 'books_portal', 'ledger.post'],
        ['call', 'ledger', 'close'],
        ['call', 'mailer', 'post'],
      ]);
  });

  it("retargets the moved implementation's own call into the component, in the same pass", () => {
    root = books();

    renameMethod('ledger', 'post', 'append');

    expect(method(root, 'ledger_impl', 'close').narrative[0]).toMatchObject({ targetComponent: 'ledger', targetMethod: 'append' });
  });

  it('reports what still names the method — prose, and a published wire method — and rewrites none of it', () => {
    root = books();
    const entryBefore = stored(root, 'type', 'entry').description;

    const report = renameMethod('ledger', 'post', 'append');

    expect([...report.mentions].sort()).toEqual(['entry', 'iledger']);
    // Prose is never rewritten.
    expect(stored(root, 'type', 'entry').description).toBe(entryBefore);
    // A published wire name is never changed by a contract rename.
    expect(stored(root, 'interface', 'iledger').methods[1]).toMatchObject({
      name: 'append',
      endpoint: { transport: 'gRPC', service: 'books.Ledger', method: 'post' },
    });
    // Prose that merely CONTAINS the name is not a mention of it.
    expect(report.mentions).not.toContain('books_orch');
  });

  describe('refuses, changing no file', () => {
    const refusals: [string, string, string, string, RegExp][] = [
      ['a component that does not exist', 'nope', 'post', 'append', /component-missing/],
      ['a component inside a chained subproject', 'ext::widget', 'post', 'append', /chained-component/],
      ['a new name with an uppercase first letter', 'ledger', 'post', 'Append', /invalid-name/],
      ['a new name carrying a namespace separator', 'ledger', 'post', 'ext::append', /invalid-name/],
      ['a new name with a space', 'ledger', 'post', 'append entry', /invalid-name/],
      ['a new name outside camel case', 'ledger', 'post', 'append_entry', /invalid-name/],
      ['a method the component does not declare', 'ledger', 'missing', 'append', /method-missing/],
      ['a method only another component declares', 'mailer', 'audit', 'append', /method-missing/],
      ['a new name a moving contract already declares', 'ledger', 'post', 'audit', /name-taken/],
      // The refusals are checked in order: existence, then chaining, then the
      // grammar, then the method, then the name taken.
      ['a missing component before the new name', 'nope', 'post', 'Append', /component-missing/],
      ['a chained component before the new name', 'ext::widget', 'post', 'Append', /chained-component/],
      ['a new name outside the grammar before the missing method', 'ledger', 'missing', 'Append', /invalid-name/],
      ['a missing method before the name taken', 'ledger', 'missing', 'audit', /method-missing/],
    ];

    for (const [what, componentId, methodName, newName, label] of refusals) {
      it(what, () => {
        root = books();
        const before = snapshot(root);

        expect(() => renameMethod(componentId, methodName, newName)).toThrow(label);

        expect(snapshot(root)).toEqual(before);
      });
    }
  });
});
