import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { setProjectRoot } from '../../src/utils/fs.js';
import { invalidateSpecCache } from '../../src/core/specs.js';
import { createMcpServer } from '../../src/mcp/server.js';
import { ownGet, ownHas, dict } from '../../src/utils/own.js';
import { computeLayout } from '../../src/core/canvas-layout.js';

// ---------------------------------------------------------------------------
// Ids and names that are JavaScript prototype property names (tinkerer-r5
// NEW-3, platform-r5 MAJOR). A plain-object registry keyed by a user id answers
// `constructor` with `function Object()` and swallows `__proto__` as the
// prototype: sdd_add_component died on a raw Node error ("The "path" argument
// must be of type string. Received function Object"), validate reported a
// DUPLICATE_SPEC_ID against a built-in, and `member add __proto__` said it was
// "already declared as {}". Every such name is fed here as every kind of id,
// through the writers and validate: each is either accepted and works, or
// refused with a sentence about the name — never a raw error.
// ---------------------------------------------------------------------------

const NAMES = ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf'];
const now = '2026-10-07T10:00:00.000Z';
/** What a raw JavaScript error leaking through looks like. */
const RAW = /Received function|Received an instance|function Object\(\)|\[object Object\]|ERR_INVALID_ARG_TYPE|TypeError|Cannot read properties|is not a function|already declared as \{\}/;

let dir: string;
let client: Client;

async function call(name: string, args: Record<string, unknown>): Promise<{ ok: boolean; text: string }> {
  invalidateSpecCache();
  try {
    const r = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content?: { text?: string }[] };
    return { ok: !r.isError, text: (r.content ?? []).map((c) => c.text ?? '').join('\n') };
  } catch (e) {
    return { ok: false, text: String(e) };
  }
}

/** Accepted, or refused naming the name — never a raw JavaScript error. */
function clean(r: { ok: boolean; text: string }, label: string): void {
  expect(r.text, `${label}: ${r.text}`).not.toMatch(RAW);
}

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-proto-keys-'));
  fs.mkdirSync(path.join(dir, '.wai', 'specs'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.wai', 'project.yaml'), JSON.stringify({
    schemaVersion: '1.0.0', id: 'protolab', name: 'protolab', targets: [], rules: {}, createdAt: now, updatedAt: now,
  }));
  setProjectRoot(dir);
  const server = createMcpServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'proto-keys', version: '0.0.1' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  expect((await call('sdd_initialize_system', { name: 'Protolab', vision: 'Prototype names as ids.', targetLanguage: 'rust' })).ok).toBe(true);
  expect((await call('sdd_add_subsystem', { id: 'core', name: 'Core', description: 'The core.' })).ok).toBe(true);
  expect((await call('sdd_add_component', { id: 'host', name: 'Host', description: 'Holds names.', subsystem: 'core', componentType: 'Store', durability: 'ram-projection' })).ok).toBe(true);
}, 60_000);

afterAll(async () => {
  try { await client?.close(); } catch { /* closed */ }
  setProjectRoot(null);
  invalidateSpecCache();
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* windows locks */ }
});

describe('own-key helpers', () => {
  it('never answer an inherited property, and a dict has no prototype at all', () => {
    const plain: Record<string, number> = { a: 1 };
    for (const name of NAMES) {
      expect(ownGet(plain, name)).toBeUndefined();
      expect(ownHas(plain, name)).toBe(false);
    }
    const d = dict<number>([['__proto__', 1], ['constructor', 2]]);
    expect(Object.getPrototypeOf(d)).toBeNull();
    expect(ownGet(d, '__proto__')).toBe(1);
    expect(ownGet(d, 'constructor')).toBe(2);
    expect(ownGet(d, 'toString')).toBeUndefined();
  });
});

describe('the diagram layout keys its maps by id without a prototype', () => {
  it('a subsystem and a component named constructor are laid out like any other', () => {
    const model = {
      subsystems: [{ id: 'constructor' }, { id: 'core' }],
      components: [
        { id: 'constructor', subsystem: 'constructor', componentType: 'Store', owns: [], dependsOn: [] },
        { id: 'toString', subsystem: 'core', componentType: 'Orchestrator', owns: [], dependsOn: ['constructor'] },
      ],
      edges: [{ from: 'toString', to: 'constructor', cross: true }],
    };
    const layout = computeLayout(model, {}) as unknown as { boxes: Record<string, unknown> };
    expect(Object.keys(layout.boxes)).toEqual(expect.arrayContaining(['constructor', 'toString']));
  });
});

describe('prototype property names as every kind of id, through the writers and validate', () => {
  for (const name of NAMES) {
    it(`"${name}" as a subsystem, component, interface, implementation and type id`, async () => {
      const sub = await call('sdd_add_subsystem', { id: name, name: `Sub ${name}`, description: 'A subsystem.' });
      clean(sub, 'subsystem');
      const comp = await call('sdd_add_component', { id: name, name: `Comp ${name}`, description: 'A component.', subsystem: 'core', componentType: 'Store', durability: 'ram-projection' });
      clean(comp, 'component');
      const type = await call('sdd_add_type', { id: name, name: `Type ${name}`, kind: 'value-object', fields: [{ name: 'value', type: 'string' }] });
      clean(type, 'type');
      if (name === 'constructor') {
        // A legal id: it is a spec like any other.
        expect(sub.ok, sub.text).toBe(true);
        expect(comp.ok, comp.text).toBe(true);
        expect(type.ok, type.text).toBe(true);
        const intf = await call('sdd_define_interface', { id: `i${name}`, name: 'I', description: 'A contract.', component: name, methods: [{ name: 'put', description: 'Put.', params: [{ name: 'key', type: 'string' }], returns: 'void', effect: 'write' }] });
        expect(intf.ok, intf.text).toBe(true);
        const impl = await call('sdd_write_narrative', { id: `${name}_impl`, name: 'Impl', description: 'An implementation.', contract: `i${name}`, methods: [{ name: 'put', detail: 'intent', intent: 'Puts.' }] });
        expect(impl.ok, impl.text).toBe(true);
        const read = await call('sdd_get_spec', { kind: 'component', id: name });
        expect(read.ok, read.text).toBe(true);
        expect(read.text).toContain('"id": "constructor"');
      } else {
        // __proto__ is refused by the id grammar; the camelCase names are no lowercase ids.
        expect(comp.ok).toBe(false);
        expect(comp.text).toMatch(/Identifier|identifier|lowercase/);
      }
    });

    it(`"${name}" as a method, parameter and field name`, async () => {
      const intf = await call('sdd_define_interface', { id: 'ihost', name: 'Host', description: 'The host contract.', component: 'host', methods: [{ name, description: 'A method.', params: [{ name, type: 'string' }], returns: 'void', effect: 'write' }] });
      clean(intf, 'method/param');
      const type = await call('sdd_add_type', { id: 'holder', name: 'Holder', kind: 'value-object', fields: [{ name, type: 'string' }] });
      clean(type, 'field');
      if (name === '__proto__') {
        expect(intf.ok).toBe(false);
        expect(type.ok).toBe(false);
        expect(intf.text).toMatch(/__proto__/);
      }
      const update = await call('sdd_update_spec', { kind: 'type', id: 'holder', delta: { fields: [{ name: 'other', type: 'string' }] } });
      clean(update, 'update');
    });

    it(`"${name}" as a member alias, an external alias and a project id`, async () => {
      const member = await call('sdd_add_member', { alias: name, source: `services/m-${name.toLowerCase().replace(/_/g, '')}` });
      clean(member, 'member');
      const external = await call('sdd_add_external', { alias: name, source: '../nowhere', dryRun: true });
      clean(external, 'external');
      const rename = await call('sdd_rename_project', { newId: name, dryRun: true });
      clean(rename, 'rename');
      if (name === '__proto__') {
        expect(member.ok).toBe(false);
        expect(member.text).toMatch(/__proto__/);
        expect(member.text).not.toMatch(/already declared/);
      }
      if (name === 'constructor') expect(member.ok, member.text).toBe(true);
    });
  }

  it('validate reads the tree without a raw error and never reports a duplicate of a built-in', async () => {
    const v = await call('sdd_validate_tree', {});
    clean(v, 'validate');
    expect(v.text).not.toMatch(/DUPLICATE_SPEC_ID/);
    const s = await call('sdd_get_status', {});
    clean(s, 'status');
  });

  it('every spec is deleted cleanly by its id', async () => {
    for (const [kind, id] of [['implementation', 'constructor_impl'], ['interface', 'iconstructor'], ['component', 'constructor'], ['type', 'constructor'], ['subsystem', 'constructor'], ['component', '__proto__'], ['type', '__proto__']] as const) {
      const r = await call('sdd_delete_spec', { kind, id });
      clean(r, `delete ${kind} ${id}`);
    }
  });
});
