import { describe, it, expect, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { setProjectRoot } from '../../src/utils/fs.js';
import { invalidateSpecCache, loadComponentSpec, loadInterfaceSpec, retiredReachFacts } from '../../src/core/specs.js';
import { migrate, type ReachabilityMigrationPlan } from '../../src/core/reachability-migration.js';
import * as corePortal from '../../src/core/index.js';
import { migrateReachability as cliMigrateReachability } from '../../src/commands/adapters/core.js';
import { readYamlFile, writeYamlFile } from '../../src/utils/yaml.js';
import { runDoctor } from '../../src/commands/doctor.js';
import { DoctorOptionsError } from '../../src/utils/errors.js';

// ---------------------------------------------------------------------------
// reachability_migration.migrate — the one-project migration onto the
// reachability model, over a fixture tree written in EVERY retired form:
// portalType (HTTP_API and Custom), a listener's mounts (with a via, without
// one, onto a non-Portal, and an endpoint outside every prefix), an empty
// mounts list, the retired invokedBy kinds (external on a Portal and off one,
// sibling-subsystem), in-process Custom addresses (all in-process, and mixed
// with a wire address), authored L1 and L0 export types (agreeing and not),
// and lint allows of retired codes. The plan writes nothing, apply writes
// exactly the plan, an applied plan re-plans empty, and it never invents an
// entry the old model did not imply.
// ---------------------------------------------------------------------------

const now = new Date().toISOString();

let proj: string | undefined;
afterEach(() => {
  setProjectRoot(null);
  invalidateSpecCache();
  try { if (proj) fs.rmSync(proj, { recursive: true, force: true }); } catch { /* win locks */ }
  proj = undefined;
});

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

const portal = (id: string, over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id, name: id, description: `the ${id} portal`, subsystem: 'shop', componentType: 'Portal', owns: [], dependsOn: [], createdAt: now, updatedAt: now, ...over,
});
const method = (name: string, over: Record<string, unknown> = {}): Record<string, unknown> => ({
  name, description: `the ${name} verb`, signature: `${name}(): void`, returns: 'void', ...over,
});
const contract = (id: string, component: string, methods: Record<string, unknown>[]): Record<string, unknown> => ({
  id, name: id, description: 'd', component, methods, createdAt: now, updatedAt: now,
});

/** The fixture project, written straight to disk in the retired forms. Answers its specs directory. */
function oldShop(): string {
  proj = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-reach-migrate-'));
  const specs = path.join(proj, '.wai', 'specs');
  const write = (rel: string, doc: Record<string, unknown>): void => writeYamlFile(path.join(specs, ...rel.split('/')), doc);
  writeYamlFile(path.join(proj, '.wai', 'project.yaml'), {
    schemaVersion: '1.0.0', name: 'shop', targets: [], rules: {}, extensions: { packs: [], useGlobalPacks: false }, createdAt: now, updatedAt: now,
  });
  write('.index.yaml', {
    schemaVersion: '1.0.0', name: 'Shop', vision: 'sells things', boundaries: [], globalRequirements: [],
    publicInterfaces: [{ as: 'shop-api', from: 'shop', component: 'web', type: 'REST', details: 'the shop', audience: 'external' }],
    createdAt: now, updatedAt: now,
  });
  write('shop/.index.yaml', {
    id: 'shop', name: 'Shop', description: 'd', parentSystem: 'Shop', trustedLinks: [],
    publicInterfaces: [
      { component: 'web', type: 'REST', details: 'the shop API' },
      { component: 'lib', type: 'RPC', details: 'the library' },
    ],
    createdAt: now, updatedAt: now,
  });
  // The listener: HTTP_API, mounting web (with its router), admin (none) and a Store.
  write('shop/host/.index.yaml', portal('host', {
    portalType: 'HTTP_API',
    mounts: [
      { portal: 'web', prefixes: ['/web'], via: 'handleWebRequest' },
      { portal: 'admin', prefixes: ['/admin'] },
      { portal: 'ledger', prefixes: ['/ledger'] },
    ],
    lint: { allow: [
      { code: 'UNMOUNTED_PORTAL', reason: 'the host starts it' },
      { code: 'MISSING_PORTAL_TYPE', reason: 'kept for the record' },
    ] },
  }));
  write('shop/host/.interface.yaml', contract('ihost', 'host', [method('health', { endpoint: { transport: 'HTTP', method: 'GET', path: '/health' } })]));
  // A mounted Portal: one endpoint under the prefix, one outside every prefix; external read as an entry.
  write('shop/web/.index.yaml', portal('web', { portalType: 'HTTP_API' }));
  write('shop/web/.interface.yaml', contract('iweb', 'web', [
    method('browse', { endpoint: { transport: 'HTTP', method: 'GET', path: '/web/items' }, invokedBy: { kind: 'external', caller: 'Browsers of the shop' } }),
    method('legacy', { endpoint: { transport: 'HTTP', method: 'POST', path: '/api/legacy' } }),
  ]));
  write('shop/web/.implementation.yaml', {
    id: 'web_impl', name: 'Web', description: 'd', contract: 'iweb', createdAt: now, updatedAt: now,
    methods: [{ name: 'browse', narrative: [] }, { name: 'legacy', narrative: [] }],
  });
  // A mounted Portal already in the new form, already declaring its entry.
  write('shop/admin/.index.yaml', portal('admin', { transport: 'HTTP', invokedBy: { kind: 'entry', caller: 'The shop operators in their browsers' } }));
  write('shop/admin/.interface.yaml', contract('iadmin', 'admin', [method('stats', { endpoint: { transport: 'HTTP', method: 'GET', path: '/admin/stats' } })]));
  write('shop/ledger/.index.yaml', { ...portal('ledger'), componentType: 'Store', durability: 'durable' });
  // A Custom Portal that binds no endpoint: in-process.
  write('shop/lib/.index.yaml', portal('lib', { portalType: 'Custom' }));
  write('shop/lib/.interface.yaml', contract('ilib', 'lib', [method('price')]));
  // A Custom Portal whose every address names an in-process call.
  write('shop/sdk/.index.yaml', portal('sdk', { transport: 'Custom' }));
  write('shop/sdk/.interface.yaml', contract('isdk', 'sdk', [
    method('run', { endpoint: { transport: 'Custom', address: 'in-process migration.run' } }),
    method('check', { endpoint: { transport: 'Custom', address: '@shop/sdk#check' } }),
  ]));
  // A Custom Portal mixing an in-process address with a wire one: reported.
  write('shop/mixed/.index.yaml', portal('mixed', { portalType: 'Custom' }));
  write('shop/mixed/.interface.yaml', contract('imixed', 'mixed', [
    method('local', { endpoint: { transport: 'Custom', address: 'in-process mixed.local' } }),
    method('remote', { endpoint: { transport: 'Custom', address: 'tcp://mixed:9000' } }),
  ]));
  // An empty mounts list (the old authoring default): no listener, no entry.
  write('shop/solo/.index.yaml', portal('solo', { transport: 'HTTP', mounts: [] }));
  write('shop/solo/.interface.yaml', contract('isolo', 'solo', [method('ping', { endpoint: { transport: 'HTTP', method: 'GET', path: '/ping' } })]));
  // Neither a listener nor mounted: no entry is ever invented for it.
  write('shop/loose/.index.yaml', portal('loose', { transport: 'HTTP' }));
  write('shop/loose/.interface.yaml', contract('iloose', 'loose', [method('poke', { endpoint: { transport: 'HTTP', method: 'GET', path: '/poke' } })]));
  // A non-Portal with an external (a runtime hook) and a sibling-subsystem declaration.
  write('shop/worker/.index.yaml', { ...portal('worker'), componentType: 'Orchestrator' });
  write('shop/worker/.interface.yaml', contract('iworker', 'worker', [
    method('tick', { invokedBy: { kind: 'external', caller: 'The process scheduler, every minute' } }),
    method('settle', { invokedBy: { kind: 'sibling-subsystem', caller: 'The ledger subsystem after a close' } }),
  ]));
  // A lint allow of a retired code on a type, beside one that stays.
  write('shop/types/item.yaml', {
    kind: 'value-object', id: 'item', name: 'Item', description: 'd', subsystem: 'shop', fields: [], methods: [],
    lint: { allow: [
      { code: 'PUBLIC_INTERFACE_EVENT_MISTYPED', reason: 'old' },
      { code: 'UNUSED_TYPE', reason: 'exported later' },
    ] },
    createdAt: now, updatedAt: now,
  });
  setProjectRoot(proj);
  invalidateSpecCache();
  return specs;
}

const lines = (entries: { specId: string; form: string; to: string }[]): string[] =>
  entries.map((e) => `${e.form}|${e.specId}|${e.to}`).sort();

describe('reachability migration — the plan', () => {
  it('plans every retired form and writes nothing', () => {
    const specs = oldShop();
    const before = snapshot(specs);
    const plan = migrate(false);
    expect(plan.applied).toBe(false);
    expect(snapshot(specs)).toEqual(before);

    expect(lines(plan.rewrites)).toEqual([
      'export-type|shop|type of "web" dropped',
      'export-type|system|type of "shop-api" dropped',
      'in-process-endpoint|isdk|endpoint of "check" dropped',
      'in-process-endpoint|isdk|endpoint of "run" dropped',
      'in-process-endpoint|lib|transport InProcess',
      'in-process-endpoint|sdk|transport InProcess',
      'invoked-by-kind|iweb|invokedBy entry on "browse"',
      'invoked-by-kind|iworker|invokedBy runtime on "tick"',
      'listener-mounts|host|invokedBy entry (outside) on the Portal',
      'listener-mounts|host|mounts removed',
      'listener-mounts|solo|mounts removed',
      'listener-mounts|web_impl|router handleWebRequest',
      'listener-mounts|web|invokedBy entry (outside) on the Portal',
      'portal-type|host|transport HTTP',
      'portal-type|mixed|transport Custom',
      'portal-type|web|transport HTTP',
      'retired-allow|host|allow of MISSING_PORTAL_TYPE rekeyed to MISSING_PORTAL_TRANSPORT',
      'retired-allow|host|allow of UNMOUNTED_PORTAL removed',
      'retired-allow|item|allow of PUBLIC_INTERFACE_EVENT_MISTYPED removed',
    ]);
    // What it will not fix: never invented, never guessed.
    expect(lines(plan.reported)).toEqual([
      'export-type|shop|type RPC of "lib" kept',
      'in-process-endpoint|mixed|transport Custom kept',
      'invoked-by-kind|iworker|invokedBy sibling-subsystem on "settle" kept',
      'listener-mounts|host|mount of "ledger" dropped',
      'listener-mounts|iweb|endpoint POST /api/legacy of "legacy" kept',
      'listener-mounts|solo|no entry written',
    ]);
  });

  it('the in-process address is reported as a symbol hint', () => {
    oldShop();
    const run = migrate(false).rewrites.find((r) => r.to === 'endpoint of "run" dropped');
    expect(run?.reason).toContain('in-process migration.run');
  });

  it('the spec maintenance portal and the CLI core adapter forward to the same migration', () => {
    expect(corePortal.migrateReachability).toBe(migrate);
    expect(cliMigrateReachability).toBe(migrate);
  });
});

describe('reachability migration — apply', () => {
  function applied(): { specs: string; plan: ReachabilityMigrationPlan } {
    const specs = oldShop();
    const plan = migrate(true);
    invalidateSpecCache();
    return { specs, plan };
  }
  const read = (specs: string, rel: string): Record<string, any> => readYamlFile(path.join(specs, ...rel.split('/'))) as Record<string, any>;

  it('writes the transports, and drops in-process addresses', () => {
    const { specs, plan } = applied();
    expect(plan.applied).toBe(true);
    const host = read(specs, 'shop/host/.index.yaml');
    expect(host.transport).toBe('HTTP');
    expect('portalType' in host).toBe(false);
    expect(read(specs, 'shop/lib/.index.yaml').transport).toBe('InProcess');
    expect(read(specs, 'shop/sdk/.index.yaml').transport).toBe('InProcess');
    expect(read(specs, 'shop/sdk/.interface.yaml').methods.map((m: any) => m.endpoint)).toEqual([undefined, undefined]);
    // The mixed Portal keeps its transport and both addresses.
    expect(read(specs, 'shop/mixed/.index.yaml').transport).toBe('Custom');
    expect(read(specs, 'shop/mixed/.interface.yaml').methods.map((m: any) => m.endpoint.address)).toEqual(['in-process mixed.local', 'tcp://mixed:9000']);
  });

  it('turns the listener and the Portals it mounted into entries, and the via into the router', () => {
    const { specs } = applied();
    const host = read(specs, 'shop/host/.index.yaml');
    expect('mounts' in host).toBe(false);
    expect(host.invokedBy.kind).toBe('entry');
    expect(host.invokedBy.caller).toContain('host');
    const web = read(specs, 'shop/web/.index.yaml');
    expect(web.invokedBy).toEqual({ kind: 'entry', caller: 'Clients served through the listener host under "/web"' });
    // admin already declared its entry: kept exactly.
    expect(read(specs, 'shop/admin/.index.yaml').invokedBy).toEqual({ kind: 'entry', caller: 'The shop operators in their browsers' });
    expect(read(specs, 'shop/web/.implementation.yaml').router).toBe('handleWebRequest');
    // The endpoint outside every prefix is kept as it was.
    expect(read(specs, 'shop/web/.interface.yaml').methods[1].endpoint).toEqual({ transport: 'HTTP', method: 'POST', path: '/api/legacy' });
  });

  it('never invents an entry: neither the empty-mounts Portal nor the loose one gets one', () => {
    const { specs } = applied();
    const solo = read(specs, 'shop/solo/.index.yaml');
    expect('mounts' in solo).toBe(false);
    expect(solo.invokedBy).toBeUndefined();
    expect(read(specs, 'shop/loose/.index.yaml').invokedBy).toBeUndefined();
    expect(loadComponentSpec('loose')?.invokedBy).toBeUndefined();
  });

  it('rewrites external by where it sits, keeping the caller, and leaves sibling-subsystem stored for its author', () => {
    const { specs } = applied();
    expect(read(specs, 'shop/web/.interface.yaml').methods[0].invokedBy).toEqual({ kind: 'entry', caller: 'Browsers of the shop' });
    const worker = read(specs, 'shop/worker/.interface.yaml').methods;
    expect(worker[0].invokedBy).toEqual({ kind: 'runtime', caller: 'The process scheduler, every minute' });
    expect(worker[1].invokedBy).toEqual({ kind: 'sibling-subsystem', caller: 'The ledger subsystem after a close' });
    expect(loadInterfaceSpec('iworker')!.methods[1].invokedBy?.kind).toBe('runtime');
  });

  it('drops the export types that agree with the derived kind and keeps the one that does not', () => {
    const { specs } = applied();
    expect(read(specs, 'shop/.index.yaml').publicInterfaces).toEqual([
      { component: 'web', details: 'the shop API' },
      { component: 'lib', type: 'RPC', details: 'the library' },
    ]);
    expect('type' in read(specs, '.index.yaml').publicInterfaces[0]).toBe(false);
  });

  it('removes the allows of retired codes and rekeys MISSING_PORTAL_TYPE', () => {
    const { specs } = applied();
    expect(read(specs, 'shop/host/.index.yaml').lint.allow).toEqual([{ code: 'MISSING_PORTAL_TRANSPORT', reason: 'kept for the record' }]);
    expect(read(specs, 'shop/types/item.yaml').lint.allow).toEqual([{ code: 'UNUSED_TYPE', reason: 'exported later' }]);
  });

  it('is idempotent: an applied plan re-plans empty, and a second apply writes nothing', () => {
    const { specs, plan } = applied();
    // Only the forms it reports and never writes are still met by the scan.
    expect(retiredReachFacts().map((f) => `${f.form}|${f.specId}|${f.at ?? ''}`).sort()).toEqual([
      'export-type|shop|lib',
      'in-process-endpoint|imixed|local',
      'invoked-by-kind|iworker|settle',
    ]);
    const again = migrate(false);
    expect(again.rewrites).toEqual([]);
    // The forms it reports are reported again, and nothing else.
    expect(lines(again.reported)).toEqual(lines(plan.reported).filter((l) =>
      // a dropped mount and an outside endpoint lived on the mounts, which are gone
      !l.startsWith('listener-mounts|')));
    const before = snapshot(specs);
    expect(migrate(true).applied).toBe(false);
    expect(snapshot(specs)).toEqual(before);
  });
});

describe('wairon doctor --report reachability', () => {
  it('prints every rewrite by form, what it will not fix, and the totals, writing nothing', async () => {
    const specs = oldShop();
    const before = snapshot(specs);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      await runDoctor({ report: 'reachability' });
      const printed = log.mock.calls.map((c) => String(c[0])).join('\n');
      expect(printed).toContain('portalType (3)');
      expect(printed).toContain('listener mounts (5)');
      expect(printed).toContain('Will not fix (6)');
      expect(printed).toContain('Totals: 19 rewrite(s)');
      expect(printed).toContain('Nothing was written.');
      await expect(runDoctor({ report: 'reachability', fix: true })).rejects.toThrow(DoctorOptionsError);
    } finally {
      log.mockRestore();
    }
    expect(snapshot(specs)).toEqual(before);
  });
});
