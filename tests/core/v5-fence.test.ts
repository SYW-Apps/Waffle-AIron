import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  aiDirAt, getProjectRoot, legacyFolderAt, readsV5Forms, runInV5Reading, runWithProjectBinding, runWithProjectRoot, setProjectRoot,
} from '../../src/utils/fs.js';
import {
  getLoaderIssues, invalidateSpecCache, loadComponentSpecs, loadInterfaceSpecs, loadSubsystemSpecs, loadSystemSpec, saveComponentSpec,
} from '../../src/core/specs.js';
import { readLockRecord } from '../../src/core/lockfile.js';
import { LockRecordUnreadableError } from '../../src/utils/errors.js';
import { declaredMembers } from '../../src/models/project.js';
import { landReference, type ReadableProject } from '../../src/models/project-family.js';
import { v5FormsIn } from '../../src/models/specs.js';
import { writeYamlFile } from '../../src/utils/yaml.js';
import type { ComponentSpec } from '../../src/models/index.js';

// ---------------------------------------------------------------------------
// The v5 reading, and the fence around it.
//
// The core reads only the running major's forms. The forms wairon 5 wrote are
// read under ONE binding — runInV5Reading, which `wairon upgrade` binds around
// its rehearsal — and anywhere else a spec, a configuration or a lock holding
// one is refused as a load error that names the form and what replaces it.
// Each family of form is proved both ways on a real temp tree: refused outside
// the fence, read inside it.
// ---------------------------------------------------------------------------

const now = '2026-10-18T00:00:00.000Z';
const roots: string[] = [];

afterEach(() => {
  setProjectRoot(null);
  invalidateSpecCache();
  for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true });
});

/** A fresh temp project root with a current-major configuration, bound as the project root. */
function project(extra: Record<string, unknown> = {}): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-fence-')));
  roots.push(root);
  writeYamlFile(path.join(root, '.wai', 'project.yaml'), {
    schemaVersion: '1.0.0', id: 'fence', name: 'fence', waironMajor: 6, targets: [], rules: {},
    extensions: { packs: [], useGlobalPacks: false }, createdAt: now, updatedAt: now, ...extra,
  });
  setProjectRoot(root);
  invalidateSpecCache();
  return root;
}

const spec = (root: string, rel: string, doc: Record<string, unknown>): void =>
  writeYamlFile(path.join(root, '.wai', 'specs', ...rel.split('/')), doc);

const system = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  schemaVersion: '1.0.0', name: 'Fence', vision: 'v', boundaries: [], globalRequirements: [], createdAt: now, updatedAt: now, ...over,
});
const subsystem = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'shop', name: 'shop', description: 'd', parentSystem: 'Fence', publicInterfaces: [], trustedLinks: [], createdAt: now, updatedAt: now, ...over,
});
const component = (id: string, over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id, name: id, description: 'd', subsystem: 'shop', componentType: 'Orchestrator', owns: [], dependsOn: [], createdAt: now, updatedAt: now, ...over,
});
const contract = (id: string, comp: string, methods: Record<string, unknown>[]): Record<string, unknown> => ({
  id, name: id, description: 'd', component: comp, methods, createdAt: now, updatedAt: now,
});
const verb = (name: string, over: Record<string, unknown> = {}): Record<string, unknown> => ({
  name, description: `the ${name} verb`, signature: `${name}(): void`, returns: 'void', ...over,
});

/** The messages of every loader error, after a fresh read of the tree. */
function loadErrors(read: () => unknown): string[] {
  invalidateSpecCache();
  read();
  return getLoaderIssues().filter((i) => i.severity === 'error').map((i) => i.message);
}

describe('the v5 reading binding', () => {
  it('is bound nowhere by default, and only inside runInV5Reading', () => {
    expect(readsV5Forms()).toBe(false);
    expect(runInV5Reading(() => readsV5Forms())).toBe(true);
    expect(readsV5Forms()).toBe(false);
  });

  it('is kept by a nested root binding and a nested request binding, and ends with the call', async () => {
    const root = project();
    const inner = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-fence-inner-')));
    roots.push(inner);
    runInV5Reading(() => {
      expect(runWithProjectRoot(inner, () => readsV5Forms())).toBe(true);
      expect(runWithProjectBinding(inner, { topRoot: root, parentReach: true }, () => readsV5Forms())).toBe(true);
    });
    // The other way round: a root binding around the fence still reads the bound root.
    expect(runWithProjectRoot(inner, () => runInV5Reading(() => getProjectRoot()))).toBe(path.resolve(inner));
    // An async body is held across its awaits.
    const seen = await runInV5Reading(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      return readsV5Forms();
    });
    expect(seen).toBe(true);
    expect(readsV5Forms()).toBe(false);
    // Binding it without a root leaves the override in charge of the root.
    expect(runInV5Reading(() => getProjectRoot())).toBe(root);
  });

  it('makes the spec scan re-read the tree: what one reading refuses the other reads', () => {
    const root = project();
    spec(root, '.index.yaml', system());
    spec(root, 'shop/.index.yaml', subsystem());
    spec(root, 'shop/old/.index.yaml', component('old', { componentType: 'Specialist' }));
    expect(loadErrors(() => loadComponentSpecs())).toHaveLength(1);
    expect(loadComponentSpecs()).toEqual([]);
    runInV5Reading(() => {
      expect(loadErrors(() => loadComponentSpecs())).toEqual([]);
      expect(loadComponentSpecs().map((c) => c.id)).toEqual(['old']);
    });
    expect(loadComponentSpecs()).toEqual([]);
  });
});

describe('retired reach forms are refused outside the fence', () => {
  const portalWithPortalType = (): string => {
    const root = project();
    spec(root, '.index.yaml', system());
    spec(root, 'shop/.index.yaml', subsystem());
    spec(root, 'shop/web/.index.yaml', component('web', { componentType: 'Portal', portalType: 'HTTP_API' }));
    return root;
  };

  it('a Portal\'s `portalType`', () => {
    portalWithPortalType();
    const errors = loadErrors(() => loadComponentSpecs());
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('`portalType` is a wairon 5 form; wairon 6 reads `transport`');
    expect(errors[0]).toContain('web');
    expect(loadComponentSpecs()).toEqual([]);
    runInV5Reading(() => {
      expect(loadErrors(() => loadComponentSpecs())).toEqual([]);
      expect(loadComponentSpecs()[0]).toMatchObject({ id: 'web', transport: 'HTTP' });
    });
  });

  it('a listener\'s `mounts`', () => {
    const root = project();
    spec(root, '.index.yaml', system());
    spec(root, 'shop/.index.yaml', subsystem());
    spec(root, 'shop/host/.index.yaml', component('host', { componentType: 'Portal', transport: 'HTTP', mounts: [{ portal: 'web', prefixes: ['/web'] }] }));
    const errors = loadErrors(() => loadComponentSpecs());
    expect(errors.join('\n')).toContain('`mounts` (a listener\'s mounts) is a wairon 5 form');
    runInV5Reading(() => expect(loadErrors(() => loadComponentSpecs())).toEqual([]));
  });

  it('an `invokedBy` kind of `external` or `sibling-subsystem`', () => {
    const root = project();
    spec(root, '.index.yaml', system());
    spec(root, 'shop/.index.yaml', subsystem());
    spec(root, 'shop/web/.index.yaml', component('web', { componentType: 'Portal', transport: 'HTTP' }));
    spec(root, 'shop/web/.interface.yaml', contract('iweb', 'web', [
      verb('browse', { invokedBy: { kind: 'external', caller: 'Browsers' } }),
      verb('settle', { invokedBy: { kind: 'sibling-subsystem', caller: 'The ledger' } }),
    ]));
    const errors = loadErrors(() => loadInterfaceSpecs()).join('\n');
    expect(errors).toContain('`invokedBy: { kind: external }` is a wairon 5 form');
    expect(errors).toContain('`invokedBy: { kind: sibling-subsystem }` is a wairon 5 form');
    runInV5Reading(() => expect(loadErrors(() => loadInterfaceSpecs())).toEqual([]));
  });

  it('an export entry\'s authored `type`, in an L1 subsystem and in the L0', () => {
    const root = project();
    spec(root, '.index.yaml', system({ publicInterfaces: [{ as: 'shop-api', from: 'shop', component: 'web', type: 'REST', details: 'the shop' }] }));
    spec(root, 'shop/.index.yaml', subsystem({ publicInterfaces: [{ component: 'web', type: 'REST', details: 'the shop' }] }));
    const l1 = loadErrors(() => loadSubsystemSpecs()).join('\n');
    expect(l1).toContain('an export entry\'s `type` is a wairon 5 form; wairon 6 derives the export kind from the backing Portal\'s transport');
    loadErrors(() => loadSystemSpec());
    expect(loadSystemSpec()).toBeNull();
    expect(getLoaderIssues().map((i) => i.message).join('\n')).toContain('an export entry\'s `type` is a wairon 5 form');
    runInV5Reading(() => {
      invalidateSpecCache();
      expect(loadSystemSpec()).not.toBeNull();
      expect(loadErrors(() => loadSubsystemSpecs())).toEqual([]);
    });
  });

  it('names every form of a document, by the pure reader', () => {
    expect(v5FormsIn('component', { portalType: 'HTTP_API', mounts: [], componentType: 'Gateway' })).toHaveLength(3);
    expect(v5FormsIn('component', { transport: 'HTTP', componentType: 'Portal' })).toEqual([]);
    expect(v5FormsIn('subsystem', { projectPath: 'services/x' })).toHaveLength(1);
    expect(v5FormsIn('subsystem', { projectPath: '  ' })).toEqual([]);
  });
});

describe('retired stereotypes are refused outside the fence', () => {
  for (const [type, replacement] of [['Specialist', 'an Orchestrator with a `dependencyClass`'], ['Gateway', 'a Portal with `variant: gateway`']] as const) {
    it(`a ${type}`, () => {
      const root = project();
      spec(root, '.index.yaml', system());
      spec(root, 'shop/.index.yaml', subsystem());
      spec(root, 'shop/old/.index.yaml', component('old', { componentType: type }));
      const errors = loadErrors(() => loadComponentSpecs());
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain(`\`componentType: ${type}\` is a wairon 5 form; wairon 6 reads ${replacement}`);
      runInV5Reading(() => expect(loadComponentSpecs()[0]).toMatchObject({ id: 'old', componentType: type }));
    });
  }

  it('is not written by a component save outside the fence', () => {
    const root = project();
    spec(root, '.index.yaml', system());
    spec(root, 'shop/.index.yaml', subsystem());
    const old = { ...component('old'), componentType: 'Specialist' } as unknown as ComponentSpec;
    expect(() => saveComponentSpec(old)).toThrow(/wairon 5 form/);
    runInV5Reading(() => saveComponentSpec(old));
    runInV5Reading(() => expect(loadComponentSpecs().map((c) => c.id)).toEqual(['old']));
  });
});

describe('legacy mounts and long-form member paths are refused outside the fence', () => {
  it('an L1 subsystem carrying `projectPath`', () => {
    const root = project();
    spec(root, '.index.yaml', system());
    spec(root, 'kid/.index.yaml', subsystem({ id: 'kid', name: 'kid', projectPath: 'packages/kid' }));
    const errors = loadErrors(() => loadSubsystemSpecs());
    expect(errors.join('\n')).toContain('`projectPath` (a legacy L1 mount) is a wairon 5 form; wairon 6 declares the member under `members` in .wai/project.yaml');
    expect(loadSubsystemSpecs()).toEqual([]);
    // In the v5 reading the mount is a member declaration, never a subsystem.
    runInV5Reading(() => {
      expect(loadErrors(() => loadSubsystemSpecs())).toEqual([]);
      expect(loadSubsystemSpecs()).toEqual([]);
    });
  });

  it('a `members` entry\'s long-form `path`', () => {
    const members = { billing: { path: 'services/billing', description: 'Invoices' } };
    const outside = declaredMembers({ members });
    expect(outside[0].problem).toBe('the member "billing" uses `path`, a wairon 5 form; wairon 6 reads `source` — `wairon upgrade` rewrites a tree wairon 5 wrote');
    const inside = runInV5Reading(() => declaredMembers({ members }));
    expect(inside[0]).toMatchObject({ alias: 'billing', path: 'services/billing', deprecatedPath: true });
    expect(inside[0].problem).toBeUndefined();
    // The current form reads the same in both.
    expect(declaredMembers({ members: { billing: { source: 'services/billing' } } })[0]).toMatchObject({ path: 'services/billing', deprecatedPath: false });
  });
});

describe('the deprecated reference forms do not bind outside the fence', () => {
  const project = (namespace: string, over: Partial<ReadableProject> = {}): ReadableProject => ({
    namespace, aliases: new Map(), declaredAliases: new Set(), subsystems: new Set(), ...over,
  });
  const family = [
    project('', { aliases: new Map([['billing', 'billing']]), declaredAliases: new Set(['billing']) }),
    project('billing', { parent: '', aliases: new Map() }),
  ];

  it('a leading `::`, a `super::` and a member path', () => {
    for (const reference of ['::billing::invoice', 'super::invoice', 'billing::deep::invoice', 'fence::billing::invoice']) {
      const from = reference.startsWith('super') ? 'billing' : '';
      expect(landReference(family, reference, from).kind, reference).not.toBe('project');
    }
    expect(landReference(family, '::billing::invoice', '')).toEqual({ kind: 'unresolved', form: 'leading' });
    expect(landReference(family, 'super::invoice', 'billing')).toEqual({ kind: 'unresolved', form: 'super' });
    expect(landReference(family, 'billing::deep::invoice', '')).toEqual({ kind: 'unresolved', form: 'path' });
  });

  it('bind in the v5 reading, and `alias::name` binds in both', () => {
    runInV5Reading(() => {
      expect(landReference(family, '::billing::invoice', '')).toMatchObject({ kind: 'project', form: 'leading', project: 'billing', name: 'invoice' });
      expect(landReference(family, 'super::invoice', 'billing')).toMatchObject({ kind: 'project', form: 'super', project: '', name: 'invoice' });
    });
    expect(landReference(family, 'billing::invoice', '')).toMatchObject({ kind: 'project', form: 'alias', project: 'billing', name: 'invoice' });
    runInV5Reading(() => expect(landReference(family, 'billing::invoice', '')).toMatchObject({ kind: 'project', form: 'alias' }));
  });
});

describe('a lock record wairon 5 wrote is refused outside the fence', () => {
  const writeLock = (root: string, extra: Record<string, unknown>): void => {
    fs.writeFileSync(path.join(root, '.wai', 'lock.json'), JSON.stringify({
      stateId: { algorithm: 'sha256', digest: '0'.repeat(64) }, lockedAt: now, lockedBy: { id: 'a', source: 'git' },
      validatorVersion: '5.1.0', validationResult: { valid: true, errors: 0, warnings: 0 }, status: 'ready', ...extra,
    }));
  };

  for (const [label, extra, format] of [['1 (no format)', {}, 1], ['2', { format: 2, members: {} }, 2]] as const) {
    it(`format ${label}: named, with the way forward, and read in the v5 reading`, () => {
      const root = project();
      writeLock(root, extra);
      let thrown: unknown;
      try { readLockRecord(); } catch (e) { thrown = e; }
      expect(thrown).toBeInstanceOf(LockRecordUnreadableError);
      const message = (thrown as Error).message;
      expect(message).toContain(`it is lock record format ${format}, written by wairon 5 (wairon 6 reads format 3)`);
      expect(message).toContain('Run `wairon upgrade`');
      expect(message).not.toContain('delete it and run');
      expect(runInV5Reading(() => readLockRecord())).toMatchObject({ validatorVersion: '5.1.0' });
    });
  }

  it('format 3 reads outside the fence', () => {
    const root = project();
    writeLock(root, { format: 3, specsReading: 'design', specs: {} });
    expect(readLockRecord()).toMatchObject({ format: 3 });
  });
});

describe('the `.wairon` folder is not a project\'s folder outside the fence', () => {
  it('resolves the legacy folder only in the v5 reading', () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-fence-legacy-')));
    roots.push(root);
    fs.mkdirSync(path.join(root, '.wairon'), { recursive: true });
    expect(legacyFolderAt(root)).toBeNull();
    expect(aiDirAt(root, 'project.yaml')).toBe(path.join(root, '.wai', 'project.yaml'));
    runInV5Reading(() => {
      expect(legacyFolderAt(root)).toBe(path.join(root, '.wairon'));
      expect(aiDirAt(root, 'project.yaml')).toBe(path.join(root, '.wairon', 'project.yaml'));
    });
    // A `.wai` folder always wins, in both.
    fs.mkdirSync(path.join(root, '.wai'));
    runInV5Reading(() => expect(legacyFolderAt(root)).toBeNull());
  });
});
