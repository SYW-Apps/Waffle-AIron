/**
 * Round-8 platform BLOCKER: from a family root, `sdd_delete_spec` deleted a
 * MEMBER project's spec (no force), while `sdd_update_spec` on the same id was
 * refused. Every write tool now asks the same project boundary
 * (crossProjectWriteRefusal) before it writes anything — this walks every
 * authoring write tool the server advertises with a member's id and asserts
 * the refusal, and that the member's files never changed.
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { runWithProjectRoot, setProjectRoot } from '../../src/utils/fs.js';
import { invalidateSpecCache, saveSpec, scanAllSpecs } from '../../src/core/specs.js';
import { createMember, provisionProject } from '../../src/core/provision.js';
import { createMcpServer } from '../../src/mcp/server.js';

type ToolResult = { isError?: boolean; content?: { type: string; text?: string }[] };
const now = '2026-10-09T00:00:00.000Z';
const roots: string[] = [];
const clients: Client[] = [];

afterEach(async () => {
  for (const c of clients.splice(0)) await c.close();
  setProjectRoot(null);
  invalidateSpecCache();
  for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true });
});

/** Every file under a project's specs folder, relative and sorted. */
function files(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out.push(`${path.relative(dir, p).split(path.sep).join('/')}:${fs.statSync(p).mtimeMs}`);
    }
  };
  walk(path.join(dir, '.wai', 'specs'));
  return out.sort();
}

/** The tools that write a project's own specs, other than the family migrations and the member and external declarations. */
const NOT_SPEC_AUTHORING = new Set([
  'sdd_add_member', 'sdd_move_member', 'sdd_rename_project', 'sdd_rename_member_alias', 'sdd_add_external',
  'sdd_update_external', 'sdd_set_network',
]);

describe('every authoring write tool refuses a member project\'s spec from the root', () => {
  it('walks each write tool with a member id: refused, naming the member, and nothing in the member changes', async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-r8-boundary-')));
    roots.push(root);
    fs.mkdirSync(path.join(root, '.wai', 'specs'), { recursive: true });
    setProjectRoot(root);
    provisionProject('Shop');
    saveSpec('subsystem', { id: 'orders', name: 'orders', description: 'orders', parentSystem: 'Shop', publicInterfaces: [], trustedLinks: [], status: 'complete', createdAt: now, updatedAt: now } as never);
    saveSpec('component', { id: 'order_flow', name: 'Flow', description: 'f', subsystem: 'orders', componentType: 'Orchestrator', owns: [], dependsOn: [], status: 'complete', createdAt: now, updatedAt: now } as never);
    createMember('payments', 'services/payments', 'Payments', 'project');
    const member = path.join(root, 'services', 'payments');
    runWithProjectRoot(member, () => {
      invalidateSpecCache();
      saveSpec('subsystem', { id: 'payments', name: 'payments', description: 'p', parentSystem: 'payments', publicInterfaces: [], trustedLinks: [], status: 'complete', createdAt: now, updatedAt: now } as never);
      saveSpec('component', { id: 'payment_store', name: 'S', description: 's', subsystem: 'payments', componentType: 'Store', durability: 'ram-projection', owns: [], dependsOn: [], status: 'complete', createdAt: now, updatedAt: now } as never);
      saveSpec('interface', { id: 'ipayment_store', name: 'S', description: 's', component: 'payment_store', methods: [{ name: 'put', description: 'p', params: [{ name: 'id', type: 'string' }], returns: 'void' }], status: 'complete', createdAt: now, updatedAt: now } as never);
      saveSpec('implementation', { id: 'payment_store_mem', name: 'M', description: 'm', contract: 'ipayment_store', methods: [{ name: 'put', narrative: [] }], status: 'complete', createdAt: now, updatedAt: now } as never);
      saveSpec('type', { kind: 'value-object', id: 'sku_id', name: 'SkuId', fields: [{ name: 'v', type: 'string' }], methods: [], createdAt: now, updatedAt: now } as never);
      invalidateSpecCache();
    });
    setProjectRoot(root);
    invalidateSpecCache();
    const key = scanAllSpecs().components.find((c) => c.id.endsWith('::payment_store'))!.id.split('::')[0];
    const before = files(member);

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'project-boundary-r8', version: '0.0.1' });
    clients.push(client);
    await Promise.all([createMcpServer().connect(serverTransport), client.connect(clientTransport)]);

    const calls: Record<string, Record<string, unknown>[]> = {
      sdd_update_spec: [{ kind: 'component', id: `${key}::payment_store`, delta: { description: 'x' } }],
      sdd_delete_spec: [
        { kind: 'component', id: `${key}::payment_store` },
        { kind: 'component', id: `${key}::payment_store`, dryRun: true },
        { kind: 'type', id: `${key}::sku_id` },
        { kind: 'interface', id: `${key}::ipayment_store`, dryRun: true },
      ],
      sdd_rename_component: [{ id: `${key}::payment_store`, newId: 'ledger_store' }],
      sdd_rename_method: [{ id: `${key}::payment_store`, method: 'put', newName: 'store' }],
      sdd_rename_type: [{ id: `${key}::sku_id`, newId: 'sku' }],
      sdd_rename_field: [{ id: `${key}::sku_id`, field: 'v', newName: 'w' }],
      sdd_rename_param: [{ id: `${key}::payment_store`, method: 'put', param: 'id', newName: 'ref' }],
      sdd_rename_spec: [{ kind: 'interface', id: `${key}::ipayment_store`, newId: 'ipay' }, { kind: 'implementation', id: `${key}::payment_store_mem`, newId: 'mem' }],
      sdd_move_spec: [{ kind: 'component', id: `${key}::payment_store`, subsystem: 'orders' }, { kind: 'type', id: `${key}::sku_id`, subsystem: 'orders', dryRun: true }],
      sdd_move_methods: [{ from: `${key}::payment_store`, to: 'order_flow', methods: ['put'] }],
      sdd_set_endpoints: [{ interface: `${key}::ipayment_store`, endpoints: [{ method: 'put', transport: 'CLI', command: 'put' }] }],
      sdd_add_type: [{ kind: 'value-object', id: 'intruder', name: 'I', subsystem: `${key}::payments`, fields: [] }],
      sdd_add_group: [{ id: 'intruder_g', name: 'I', subsystem: `${key}::payments` }],
      sdd_write_narrative: [{ id: 'intruder_impl', name: 'I', description: 'i', contract: `${key}::ipayment_store`, methods: [] }],
      sdd_define_interface: [{ id: 'iintruder', name: 'I', description: 'i', component: `${key}::payment_store`, methods: [] }],
      sdd_add_component: [{ id: 'intruder', name: 'I', description: 'i', subsystem: `${key}::payments`, componentType: 'Orchestrator' }],
      sdd_add_subsystem: [{ id: `${key}::intruders`, name: 'I', description: 'i' }],
      sdd_set_public_interfaces: [{ subsystem: `${key}::payments`, publicInterfaces: [] }],
    };

    // The walk covers every advertised tool that authors a spec.
    const advertised = (await client.listTools()).tools.map((t) => t.name)
      .filter((n) => /^sdd_(update|delete|rename|move|set|add|define|write)_/.test(n) && !NOT_SPEC_AUTHORING.has(n));
    expect(advertised.filter((n) => !(n in calls)), 'a write tool the walk does not cover').toEqual([]);

    for (const [tool, argsList] of Object.entries(calls)) {
      for (const args of argsList) {
        const result = (await client.callTool({ name: tool, arguments: args })) as ToolResult;
        const text = result.content?.map((c) => c.text ?? '').join('\n') ?? '';
        expect(result.isError, `${tool} ${JSON.stringify(args)} answered: ${text}`).toBe(true);
        expect(text, `${tool} ${JSON.stringify(args)}`).toMatch(/lives in another project/);
        expect(text, `${tool} names the member's folder`).toMatch(/services\/payments/);
      }
    }
    invalidateSpecCache();
    expect(files(member)).toEqual(before);
  }, 120_000);
});

/**
 * Round-10 BLOCKER: the round-8 boundary judged only an id spelled with a
 * member's prefix. A BARE id the bound project does not hold still landed in a
 * member's tree: the path builders matched it against the composed index by
 * suffix (a subsystem) or by an owner's local id (a component a member's
 * Repository owns), so `sdd_add_subsystem tiles` from the parent re-authored
 * the sibling member's `tiles` and cleared its publicInterfaces. Ids are per
 * project: a bare id is the bound project's own. A bare id it does not hold is
 * a NEW local spec (a create lands locally), and a write that needs an existing
 * spec is refused as missing — never resolved into a member.
 */
describe('a bare id a member holds is the bound project\'s own: writes never land in a member', () => {
  type Ids = { sub: string; repo: string; store: string; iface: string; impl: string; type: string };

  /** One member's design: a subsystem with a Repository owning a Store, its contract and implementation, and a type. */
  function seedMember(dir: string, system: string, ids: Ids): void {
    runWithProjectRoot(dir, () => {
      invalidateSpecCache();
      saveSpec('subsystem', { id: ids.sub, name: ids.sub, description: 's', parentSystem: system, publicInterfaces: [{ details: 'the store', component: ids.store, interface: ids.iface }], trustedLinks: [], status: 'complete', createdAt: now, updatedAt: now } as never);
      saveSpec('component', { id: ids.repo, name: 'R', description: 'r', subsystem: ids.sub, componentType: 'Repository', owns: [ids.store], dependsOn: [], status: 'complete', createdAt: now, updatedAt: now } as never);
      saveSpec('component', { id: ids.store, name: 'S', description: 's', subsystem: ids.sub, componentType: 'Store', durability: 'ram-projection', owns: [], dependsOn: [], status: 'complete', createdAt: now, updatedAt: now } as never);
      saveSpec('interface', { id: ids.iface, name: 'S', description: 's', component: ids.store, methods: [{ name: 'put', description: 'p', params: [{ name: 'id', type: 'string' }], returns: 'void' }], status: 'complete', createdAt: now, updatedAt: now } as never);
      saveSpec('implementation', { id: ids.impl, name: 'M', description: 'm', contract: ids.iface, methods: [{ name: 'put', narrative: [] }], status: 'complete', createdAt: now, updatedAt: now } as never);
      saveSpec('type', { kind: 'value-object', id: ids.type, name: 'T', subsystem: ids.sub, fields: [{ name: 'v', type: 'string' }], methods: [], createdAt: now, updatedAt: now } as never);
      invalidateSpecCache();
    });
  }

  /** Every file under a project's specs folder with its exact bytes. */
  function contents(dir: string): Record<string, string> {
    const out: Record<string, string> = {};
    const base = path.join(dir, '.wai', 'specs');
    const walk = (d: string): void => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else out[path.relative(base, p).split(path.sep).join('/')] = fs.readFileSync(p).toString('base64');
      }
    };
    walk(base);
    return out;
  }

  /** The bound project's own spec file holding `id: <id>` at its top level, relative to its specs folder. */
  function localFileOf(root: string, id: string): string | undefined {
    const files = contents(root);
    return Object.keys(files).find((f) => new RegExp(`^id: ${id}\\r?$`, 'm').test(Buffer.from(files[f], 'base64').toString('utf8')));
  }

  it('walks each write tool with bare ids a sibling and a contained member hold: refused as missing, or created locally; no member byte changes', async () => {
    const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-r10-bare-')));
    roots.push(base);
    const root = path.join(base, 'app');
    fs.mkdirSync(path.join(root, '.wai', 'specs'), { recursive: true });
    setProjectRoot(root);
    provisionProject('Shop');
    saveSpec('subsystem', { id: 'orders', name: 'orders', description: 'orders', parentSystem: 'Shop', publicInterfaces: [], trustedLinks: [], status: 'complete', createdAt: now, updatedAt: now } as never);
    saveSpec('component', { id: 'order_flow', name: 'Flow', description: 'f', subsystem: 'orders', componentType: 'Orchestrator', owns: [], dependsOn: [], status: 'complete', createdAt: now, updatedAt: now } as never);
    createMember('geo', '../geo', 'Geo', 'project');
    createMember('payments', 'services/payments', 'Payments', 'project');
    const sibling = path.join(base, 'geo');
    const contained = path.join(root, 'services', 'payments');
    const members: { dir: string; ids: Ids }[] = [
      { dir: sibling, ids: { sub: 'tiles', repo: 'tile_repository', store: 'tile_store', iface: 'itile_store', impl: 'tile_store_mem', type: 'tile' } },
      { dir: contained, ids: { sub: 'payments', repo: 'payment_repository', store: 'payment_store', iface: 'ipayment_store', impl: 'payment_store_mem', type: 'sku_id' } },
    ];
    seedMember(sibling, 'geo', members[0].ids);
    seedMember(contained, 'payments', members[1].ids);
    setProjectRoot(root);
    invalidateSpecCache();
    // Both members are composed into the bound tree's reads under their keys.
    const keys = scanAllSpecs().subsystems.map((s) => s.id);
    expect(keys.some((k) => k.endsWith('::tiles')), `the sibling is composed: ${keys.join(', ')}`).toBe(true);
    expect(keys.some((k) => k.endsWith('::payments')), `the contained member is composed: ${keys.join(', ')}`).toBe(true);
    const before = members.map((m) => contents(m.dir));

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'project-boundary-r10', version: '0.0.1' });
    clients.push(client);
    await Promise.all([createMcpServer().connect(serverTransport), client.connect(clientTransport)]);

    // Phase A — nothing local holds these ids: every write that needs an
    // existing spec (or an existing parent) is refused, as the member's.
    const refused = (ids: Ids): Record<string, Record<string, unknown>[]> => ({
      sdd_update_spec: [
        { kind: 'subsystem', id: ids.sub, delta: { description: 'x' } },
        { kind: 'component', id: ids.store, delta: { description: 'x' } },
        { kind: 'component', id: ids.repo, delta: { description: 'x' } },
        { kind: 'interface', id: ids.iface, delta: { description: 'x' } },
        { kind: 'implementation', id: ids.impl, delta: { description: 'x' } },
        { kind: 'type', id: ids.type, delta: { name: 'X' } },
      ],
      sdd_delete_spec: [
        { kind: 'subsystem', id: ids.sub }, { kind: 'component', id: ids.store }, { kind: 'component', id: ids.repo },
        { kind: 'interface', id: ids.iface }, { kind: 'implementation', id: ids.impl }, { kind: 'type', id: ids.type },
      ],
      sdd_rename_component: [{ id: ids.store, newId: 'renamed_store' }],
      sdd_rename_method: [{ id: ids.store, method: 'put', newName: 'store' }],
      sdd_rename_type: [{ id: ids.type, newId: 'renamed_type' }],
      sdd_rename_field: [{ id: ids.type, field: 'v', newName: 'w' }],
      sdd_rename_param: [{ id: ids.store, method: 'put', param: 'id', newName: 'ref' }],
      sdd_rename_spec: [{ kind: 'interface', id: ids.iface, newId: 'irenamed' }, { kind: 'implementation', id: ids.impl, newId: 'renamed_impl' }],
      sdd_move_spec: [{ kind: 'component', id: ids.store, subsystem: 'orders' }, { kind: 'type', id: ids.type, subsystem: 'orders' }],
      sdd_move_methods: [{ from: ids.store, to: 'order_flow', methods: ['put'] }, { from: 'order_flow', to: ids.store, methods: ['put'] }],
      sdd_set_endpoints: [{ interface: ids.iface, endpoints: [{ method: 'put', transport: 'CLI', command: 'put' }] }],
      sdd_set_public_interfaces: [{ subsystem: ids.sub, publicInterfaces: [] }],
      sdd_add_component: [{ id: 'intruder', name: 'I', description: 'i', subsystem: ids.sub, componentType: 'Orchestrator' }],
      sdd_add_type: [{ kind: 'value-object', id: 'intruder_t', name: 'I', subsystem: ids.sub, fields: [] }],
      sdd_add_group: [{ id: 'intruder_g', name: 'I', subsystem: ids.sub }],
      sdd_define_interface: [{ id: 'iintruder', name: 'I', description: 'i', component: ids.store, methods: [] }],
      sdd_write_narrative: [{ id: 'intruder_impl', name: 'I', description: 'i', contract: ids.iface, methods: [] }],
    });
    // Phase B — the creates: a bare id the bound project does not hold is a
    // NEW local spec, beside the member's same-named one (ids are per project).
    const created = (ids: Ids): Record<string, Record<string, unknown>[]> => ({
      sdd_add_subsystem: [{ id: ids.sub, name: 'Local', description: 'the bound project\'s own' }],
      sdd_add_component: [{ id: ids.store, name: 'Local', description: 'l', subsystem: 'orders', componentType: 'Orchestrator' }],
      sdd_define_interface: [{ id: ids.iface, name: 'Local', description: 'l', component: ids.store, methods: [{ name: 'run', description: 'r', params: [], returns: 'void' }] }],
      sdd_write_narrative: [{ id: ids.impl, name: 'Local', description: 'l', contract: ids.iface, methods: [{ name: 'run', narrative: [] }] }],
      sdd_add_type: [{ kind: 'value-object', id: ids.type, name: 'Local', subsystem: ids.sub, fields: [{ name: 'v', type: 'string' }] }],
    });

    const advertised = (await client.listTools()).tools.map((t) => t.name)
      .filter((n) => /^sdd_(update|delete|rename|move|set|add|define|write)_/.test(n) && !NOT_SPEC_AUTHORING.has(n));
    const walked = new Set([...Object.keys(refused(members[0].ids)), ...Object.keys(created(members[0].ids))]);
    expect(advertised.filter((n) => !walked.has(n)), 'a write tool the walk does not cover').toEqual([]);

    const call = async (tool: string, args: Record<string, unknown>): Promise<{ isError: boolean; text: string }> => {
      const result = (await client.callTool({ name: tool, arguments: args })) as ToolResult;
      return { isError: result.isError === true, text: result.content?.map((c) => c.text ?? '').join('\n') ?? '' };
    };
    for (const [at, m] of members.entries()) {
      for (const [tool, argsList] of Object.entries(refused(m.ids))) {
        for (const args of argsList) {
          const { isError, text } = await call(tool, args);
          expect(isError, `${tool} ${JSON.stringify(args)} answered: ${text}`).toBe(true);
          // A bare id only a member holds is refused as that member's, naming it — never as missing.
          expect(text, `${tool} ${JSON.stringify(args)}`).toMatch(/^Error: chained-spec: "[^"]+" lives in another project.*It belongs to the member project "[^"]+" at [^:]+: .* there\.( This project has no \w+ "[^"]+" of its own: a bare id always names this project's own spec\.)? Nothing was written\.$/s);
          invalidateSpecCache();
          expect(contents(m.dir), `${tool} ${JSON.stringify(args)} changed the member`).toEqual(before[at]);
        }
      }
      for (const [tool, argsList] of Object.entries(created(m.ids))) {
        for (const args of argsList) {
          const { isError, text } = await call(tool, args);
          expect(isError, `${tool} ${JSON.stringify(args)} answered: ${text}`).toBe(false);
          expect(text, `${tool} ${JSON.stringify(args)} re-authored a spec`).not.toMatch(/already existed/);
          invalidateSpecCache();
          expect(contents(m.dir), `${tool} ${JSON.stringify(args)} changed the member`).toEqual(before[at]);
          expect(localFileOf(root, String(args.id)), `${tool} wrote ${String(args.id)} in the bound project`).toBeDefined();
        }
      }
      // The local same-named specs are the bound project's: a delta lands on them.
      const { isError, text } = await call('sdd_update_spec', { kind: 'subsystem', id: m.ids.sub, delta: { description: 'edited locally' } });
      expect(isError, text).toBe(false);
      invalidateSpecCache();
      expect(contents(m.dir)).toEqual(before[at]);
    }
    // Reads still compose the members, under their keys.
    invalidateSpecCache();
    const after = scanAllSpecs();
    expect(after.subsystems.filter((s) => s.id === 'tiles' || s.id.endsWith('::tiles'))).toHaveLength(2);
    expect(after.subsystems.find((s) => s.id.endsWith('::tiles'))!.publicInterfaces).toHaveLength(1);
  }, 180_000);
});
