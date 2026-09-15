import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { setProjectRoot, listFilesRecursive } from '../../src/utils/fs.js';
import {
  saveSystemSpec,
  saveSubsystemSpec,
  saveComponentSpec,
  saveInterfaceSpec,
  saveImplementationSpec,
  saveTypeSpec,
  loadComponentSpec,
  loadInterfaceSpec,
  loadImplementationSpec,
  scanAllSpecs,
  invalidateSpecCache,
  workspaceFor,
} from '../../src/core/specs.js';
import { createChainedSubsystem, renameComponent } from '../../src/core/provision.js';
import { validateSddTree } from '../../src/core/validation.js';
import { readYamlFile, writeYamlFile } from '../../src/utils/yaml.js';
import type { ComponentSpec, ImplementationSpec, InterfaceSpec, SubsystemSpec } from '../../src/models/index.js';

// ---------------------------------------------------------------------------
// core_orchestrator.renameComponent — a component, and the interface and
// implementation named after it, move to the new ids and files, and every
// reference to them in the bound tree follows. Four labelled refusals come
// first, each leaving every file as it was.
// ---------------------------------------------------------------------------

const now = new Date().toISOString();

type Step = {
  type: 'local' | 'call' | 'dispatch' | 'register';
  targetComponent?: string;
  targetMethod?: string;
  capability?: string;
  auth?: { from: string };
};

const sub = (id: string, over: Partial<SubsystemSpec> = {}): SubsystemSpec => ({
  id, name: id, description: `subsystem ${id}`, parentSystem: 'books-sys',
  publicInterfaces: [], trustedLinks: [], status: 'draft', createdAt: now, updatedAt: now, ...over,
});
const comp = (id: string, subsystem: string, componentType: string, over: Record<string, unknown> = {}): ComponentSpec => ({
  id, name: id, description: 'd', subsystem, componentType, owns: [], dependsOn: [], createdAt: now, updatedAt: now, ...over,
} as ComponentSpec);
const intf = (id: string, component: string, methods: string[]): InterfaceSpec => ({
  id, name: id, description: 'd', component, createdAt: now, updatedAt: now,
  methods: methods.map((name) => ({ name, description: 'd', signature: `${name}(): void`, returns: 'void' })),
} as InterfaceSpec);
const impl = (id: string, contract: string, methods: Record<string, Step[]>): ImplementationSpec => ({
  id, name: id, description: 'd', contract, createdAt: now, updatedAt: now,
  methods: Object.entries(methods).map(([name, steps]) => ({
    name,
    narrative: steps.map((step, i) => ({ stepNumber: i + 1, description: `${step.type} step`, ...step })),
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

/** The specs a project's own spec files store with this kind and id, as written. */
function stored(projectDir: string, kind: string, id: string): any[] {
  return listFilesRecursive(path.join(projectDir, '.wai', 'specs'), '.yaml')
    .map((file) => readYamlFile(file) as any)
    .filter((raw) => kindOf(raw) === kind && (kind === 'system' || raw.id === id));
}

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

/** Every finding as `severity CODE @specId`, sorted, with the spec ids a rename would move mapped to their new id. */
function findings(root: string, renamedIds: Record<string, string> = {}): string[] {
  invalidateSpecCache();
  setProjectRoot(root);
  return validateSddTree().issues
    .map((i) => `${i.severity} ${i.code} @${renamedIds[i.specId ?? ''] ?? i.specId}`)
    .sort();
}

/**
 * A `books` subsystem whose `ledger` Store is named from every reference
 * position: the L0 and L1 published interfaces, a lifecycle entrypoint, a
 * Repository's owns, a Portal's dependsOn and dispatch table, the dependsOn of
 * an Orchestrator and an Adapter, narrative call, dispatch and register
 * targets, the credential source an Adapter presents to an authenticated
 * Portal, and an entity's componentClass. The ledger's own implementation calls
 * back into it. A chained `ext` project holds a component of its own, and
 * `books_adapter` holds the interface and implementation ids a rename onto
 * `archive` or `vault` would take.
 */
function books(): string {
  const root = projectRoot('rename-');
  setProjectRoot(root);
  saveSystemSpec({
    schemaVersion: '1.0.0', name: 'books-sys', vision: 'v', boundaries: [], globalRequirements: [], databases: [],
    publicInterfaces: [{ id: 'ledger-api', name: 'Ledger API', subsystem: 'books', component: 'ledger', interface: 'iledger', type: 'Custom', details: 'the ledger', audience: 'project' }],
    createdAt: now, updatedAt: now,
  });
  saveSubsystemSpec(sub('books', {
    publicInterfaces: [{ type: 'Custom', details: 'the ledger', component: 'ledger', interface: 'iledger' }],
    lifecycle: [{ phase: 'init', component: 'ledger', method: 'open' }],
  }));
  saveComponentSpec(comp('books_repo', 'books', 'Repository', { owns: ['ledger'] }));
  saveComponentSpec(comp('ledger', 'books', 'Store', { durability: 'durable' }));
  saveInterfaceSpec(intf('iledger', 'ledger', ['open', 'post']));
  saveImplementationSpec(impl('ledger_impl', 'iledger', {
    open: [{ type: 'local' }],
    post: [{ type: 'call', targetComponent: 'ledger', targetMethod: 'open' }],
  }));
  saveComponentSpec(comp('books_portal', 'books', 'Portal', {
    portalType: 'Custom', dependsOn: ['ledger', 'books_orch'],
    dispatch: [{ capability: 'ledger.open', component: 'ledger', method: 'open' }],
  }));
  saveComponentSpec(comp('books_orch', 'books', 'Orchestrator', { dependsOn: ['ledger'] }));
  saveInterfaceSpec(intf('ibooks_orch', 'books_orch', ['run']));
  saveImplementationSpec(impl('books_orch_impl', 'ibooks_orch', {
    run: [
      { type: 'call', targetComponent: 'ledger', targetMethod: 'post' },
      { type: 'dispatch', targetComponent: 'ledger', capability: 'ledger.open' },
      { type: 'register', targetComponent: 'ledger', targetMethod: 'open' },
    ],
  }));
  saveComponentSpec(comp('vault_portal', 'books', 'Portal', { portalType: 'Custom', auth: { scheme: 'bearer' } }));
  saveInterfaceSpec(intf('ivault_portal', 'vault_portal', ['unlock']));
  saveComponentSpec(comp('books_adapter', 'books', 'Adapter', { dependsOn: ['ledger', 'vault_portal'] }));
  saveInterfaceSpec(intf('iarchive', 'books_adapter', ['keep']));
  saveImplementationSpec(impl('vault_impl', 'iarchive', {
    keep: [{ type: 'call', targetComponent: 'vault_portal', targetMethod: 'unlock', auth: { from: 'component:ledger' } }],
  }));
  saveTypeSpec({
    kind: 'entity', id: 'entry', name: 'Entry', description: 'd', subsystem: 'books', componentClass: 'ledger',
    fields: [{ name: 'id', type: 'string', optional: false }], methods: [], createdAt: now, updatedAt: now,
  });

  createChainedSubsystem(sub('ext', { projectPath: 'packages/ext' }), 'ext');
  const ext = workspaceFor(path.join(root, 'packages', 'ext'));
  ext.saveSubsystemSpec(sub('ext', { parentSystem: 'ext' }));
  ext.saveComponentSpec(comp('widget', 'ext', 'Adapter'));
  invalidateSpecCache();
  return root;
}

describe('renameComponent', () => {
  let root: string | undefined;

  afterEach(() => {
    setProjectRoot(null);
    invalidateSpecCache();
    try { if (root) fs.rmSync(root, { recursive: true, force: true }); } catch { /* win locks */ }
    root = undefined;
  });

  it('moves the component and the interface and implementation named after it, and reports them', () => {
    root = books();

    const report = renameComponent('ledger', 'journal');

    expect(report.renamed).toEqual([
      { kind: 'component', from: 'ledger', to: 'journal' },
      { kind: 'interface', from: 'iledger', to: 'ijournal' },
      { kind: 'implementation', from: 'ledger_impl', to: 'journal_impl' },
    ]);
    expect([...report.rewritten].sort()).toEqual([
      'books', 'books_adapter', 'books_orch', 'books_orch_impl', 'books_portal', 'books_repo', 'entry', 'system', 'vault_impl',
    ]);
  });

  it('rewrites the reference in every position', () => {
    root = books();

    renameComponent('ledger', 'journal');

    const [system] = stored(root, 'system', 'system');
    expect(system.publicInterfaces).toEqual([expect.objectContaining({ component: 'journal', interface: 'ijournal' })]);
    const [subsystem] = stored(root, 'subsystem', 'books');
    expect(subsystem.publicInterfaces).toEqual([expect.objectContaining({ component: 'journal', interface: 'ijournal' })]);
    expect(subsystem.lifecycle).toEqual([expect.objectContaining({ component: 'journal', method: 'open' })]);
    expect(stored(root, 'component', 'books_repo')[0].owns).toEqual(['journal']);
    const [portal] = stored(root, 'component', 'books_portal');
    expect(portal.dependsOn).toEqual(['journal', 'books_orch']);
    expect(portal.dispatch.map((b: any) => b.component)).toEqual(['journal']);
    expect(stored(root, 'component', 'books_orch')[0].dependsOn).toEqual(['journal']);
    expect(stored(root, 'component', 'books_adapter')[0].dependsOn).toEqual(['journal', 'vault_portal']);
    const [orchImpl] = stored(root, 'implementation', 'books_orch_impl');
    expect(orchImpl.methods[0].narrative.map((s: any) => [s.type, s.targetComponent]))
      .toEqual([['call', 'journal'], ['dispatch', 'journal'], ['register', 'journal']]);
    const [vaultImpl] = stored(root, 'implementation', 'vault_impl');
    expect(vaultImpl.methods[0].narrative[0]).toMatchObject({ targetComponent: 'vault_portal', auth: { from: 'component:journal' } });
    expect(stored(root, 'type', 'entry')[0].componentClass).toBe('journal');

    // The moved specs carry their new ids, and the reference back into the component follows.
    const [journal] = stored(root, 'component', 'journal');
    expect(journal).toMatchObject({ componentType: 'Store', durability: 'durable', subsystem: 'books' });
    expect(stored(root, 'interface', 'ijournal')[0].component).toBe('journal');
    const [journalImpl] = stored(root, 'implementation', 'journal_impl');
    expect(journalImpl.contract).toBe('ijournal');
    expect(journalImpl.methods[1].narrative[0].targetComponent).toBe('journal');
  });

  it('writes the moved specs to their new files and removes the old ones', () => {
    root = books();
    const before = scanAllSpecs().paths;
    const oldFiles = [before.component.ledger, before.interface.iledger, before.implementation.ledger_impl];
    for (const file of oldFiles) expect(fs.existsSync(file)).toBe(true);

    renameComponent('ledger', 'journal');

    for (const file of oldFiles) expect(fs.existsSync(file)).toBe(false);
    invalidateSpecCache();
    const after = scanAllSpecs().paths;
    for (const file of [after.component.journal, after.interface.ijournal, after.implementation.journal_impl]) {
      expect(file).toBeDefined();
      expect(fs.existsSync(file)).toBe(true);
    }
    expect(loadComponentSpec('ledger')).toBeNull();
    expect(loadInterfaceSpec('iledger')).toBeNull();
    expect(loadImplementationSpec('ledger_impl')).toBeNull();
    for (const [kind, id] of [['component', 'ledger'], ['interface', 'iledger'], ['implementation', 'ledger_impl']]) {
      expect(stored(root, kind, id)).toEqual([]);
    }
  });

  it('adds no finding, and leaves no credential source unknown or unwired: the tree validates after the rename as it did before', () => {
    root = books();
    const authSourceFindings = (all: string[]): string[] => all.filter((f) => /UNKNOWN_AUTH_SOURCE|AUTH_SOURCE_UNWIRED/.test(f));
    const before = findings(root, { ledger: 'journal', iledger: 'ijournal', ledger_impl: 'journal_impl' });
    expect(authSourceFindings(before)).toEqual([]);

    setProjectRoot(root);
    renameComponent('ledger', 'journal');

    const after = findings(root);
    expect(authSourceFindings(after)).toEqual([]);
    expect(after).toEqual(before);
  });

  it('keeps an interface named otherwise, rewriting its component, while the implementation named after the component moves', () => {
    root = projectRoot('rename-kept-intf-');
    setProjectRoot(root);
    saveSystemSpec({ schemaVersion: '1.0.0', name: 'books-sys', vision: 'v', boundaries: [], globalRequirements: [], createdAt: now, updatedAt: now });
    saveSubsystemSpec(sub('books'));
    saveComponentSpec(comp('ledger', 'books', 'Orchestrator'));
    saveInterfaceSpec(intf('ibook_keeping', 'ledger', ['post']));
    saveImplementationSpec(impl('ledger_impl', 'ibook_keeping', { post: [{ type: 'local' }] }));
    invalidateSpecCache();

    const report = renameComponent('ledger', 'journal');

    expect(report.renamed).toEqual([
      { kind: 'component', from: 'ledger', to: 'journal' },
      { kind: 'implementation', from: 'ledger_impl', to: 'journal_impl' },
    ]);
    expect(report.rewritten).toEqual(['ibook_keeping']);
    expect(stored(root, 'interface', 'ibook_keeping')[0].component).toBe('journal');
    expect(stored(root, 'implementation', 'journal_impl')[0].contract).toBe('ibook_keeping');
    expect(stored(root, 'implementation', 'ledger_impl')).toEqual([]);
    expect(stored(root, 'component', 'ledger')).toEqual([]);
  });

  it('keeps an implementation named otherwise, rewriting its contract, while the interface named after the component moves', () => {
    root = projectRoot('rename-kept-impl-');
    setProjectRoot(root);
    saveSystemSpec({ schemaVersion: '1.0.0', name: 'books-sys', vision: 'v', boundaries: [], globalRequirements: [], createdAt: now, updatedAt: now });
    saveSubsystemSpec(sub('books'));
    saveComponentSpec(comp('ledger', 'books', 'Orchestrator'));
    saveInterfaceSpec(intf('iledger', 'ledger', ['post']));
    saveImplementationSpec(impl('double_entry_impl', 'iledger', { post: [{ type: 'local' }] }));
    invalidateSpecCache();

    const report = renameComponent('ledger', 'journal');

    expect(report.renamed).toEqual([
      { kind: 'component', from: 'ledger', to: 'journal' },
      { kind: 'interface', from: 'iledger', to: 'ijournal' },
    ]);
    expect(report.rewritten).toEqual(['double_entry_impl']);
    expect(stored(root, 'implementation', 'double_entry_impl')[0].contract).toBe('ijournal');
    expect(stored(root, 'interface', 'ijournal')[0].component).toBe('journal');
    expect(stored(root, 'interface', 'iledger')).toEqual([]);
  });

  it('moves the files of the flat layout, keeping a second interface and its implementation where they are', () => {
    root = projectRoot('rename-flat-');
    const specs = path.join(root, '.wai', 'specs');
    const write = (rel: string, content: object): void => writeYamlFile(path.join(specs, ...rel.split('/')), content);
    write('.index.yaml', { schemaVersion: '1.0.0', name: 'books-sys', vision: 'v', boundaries: [], globalRequirements: [], databases: [], createdAt: now, updatedAt: now });
    write('subsystems/books.yaml', sub('books'));
    write('components/ledger.yaml', comp('ledger', 'books', 'Orchestrator'));
    write('components/books_orch.yaml', comp('books_orch', 'books', 'Orchestrator', { dependsOn: ['ledger'] }));
    write('interfaces/iledger.yaml', intf('iledger', 'ledger', ['post']));
    write('interfaces/iledger_admin.yaml', intf('iledger_admin', 'ledger', ['audit']));
    write('implementations/ledger_impl.yaml', impl('ledger_impl', 'iledger', { post: [{ type: 'local' }] }));
    write('implementations/ledger_admin_impl.yaml', impl('ledger_admin_impl', 'iledger_admin', { audit: [{ type: 'local' }] }));
    setProjectRoot(root);
    invalidateSpecCache();

    const report = renameComponent('ledger', 'journal');

    expect(report.renamed.map((r) => r.to)).toEqual(['journal', 'ijournal', 'journal_impl']);
    expect([...report.rewritten].sort()).toEqual(['books_orch', 'iledger_admin']);
    for (const rel of ['components/journal.yaml', 'interfaces/ijournal.yaml', 'implementations/journal_impl.yaml']) {
      expect(fs.existsSync(path.join(specs, ...rel.split('/'))), rel).toBe(true);
    }
    for (const rel of ['components/ledger.yaml', 'interfaces/iledger.yaml', 'implementations/ledger_impl.yaml']) {
      expect(fs.existsSync(path.join(specs, ...rel.split('/'))), rel).toBe(false);
    }
    expect((readYamlFile(path.join(specs, 'interfaces', 'iledger_admin.yaml')) as any).component).toBe('journal');
    expect((readYamlFile(path.join(specs, 'implementations', 'ledger_admin_impl.yaml')) as any).contract).toBe('iledger_admin');
    expect((readYamlFile(path.join(specs, 'components', 'books_orch.yaml')) as any).dependsOn).toEqual(['journal']);
  });

  describe('refuses, changing no file', () => {
    const refusals: [string, string, string, RegExp][] = [
      ['a component that does not exist', 'nope', 'journal', /component-missing/],
      ['a component inside a chained subproject', 'ext::widget', 'gadget', /chained-component/],
      ['a new id with an uppercase letter', 'ledger', 'Journal', /invalid-id/],
      ['a new id carrying a namespace separator', 'ledger', 'ext::journal', /invalid-id/],
      ['a new id with a space', 'ledger', 'the journal', /invalid-id/],
      ['a new id another component holds', 'ledger', 'books_orch', /id-taken/],
      ['a new id whose interface id is taken', 'ledger', 'archive', /id-taken/],
      ['a new id whose implementation id is taken', 'ledger', 'vault', /id-taken/],
      // The refusals are checked in order: existence, then chaining, then the grammar, then the ids taken.
      ['a missing component before the new id', 'nope', 'Not An Id', /component-missing/],
      ['a chained component before the new id', 'ext::widget', 'books_orch', /chained-component/],
      ['a new id outside the grammar before the ids taken', 'ledger', 'Books_orch', /invalid-id/],
    ];

    for (const [what, componentId, newId, label] of refusals) {
      it(what, () => {
        root = books();
        const before = snapshot(root);

        expect(() => renameComponent(componentId, newId)).toThrow(label);

        expect(snapshot(root)).toEqual(before);
      });
    }
  });
});
