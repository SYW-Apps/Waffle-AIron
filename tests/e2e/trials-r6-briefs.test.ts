import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FixtureTree } from '../rules-matrix/harness';
import { createTrialSandbox, countCode, transcript, writeFile, type TrialSandbox } from './trials-helpers';
import { geoKit, projectYaml } from '../helpers/conformance-r6-trees';

// ---------------------------------------------------------------------------
// Round-6 user trials, delegation and bindings:
//
//  - Briefs (raised every round since round 2; solo-app r6 printed "Code
//    write fence: src/habit-portal.ts · src/**"): a brief fences exact files —
//    planned files and the component's own types included — and lists the
//    shared files (module setup, files other components also name, unnamed
//    helpers) apart, with the rule that governs them (platform r6: the
//    brief left out the component's own type, so the subagent copied it, and
//    the service's package.json, so its tests could not run in place).
//  - Binding modules (lib-and-app R3-43 → R5-33 → R6-21): the consumer's
//    hand-written binding still declared a name the producer renamed, after a
//    re-pin, and nothing reported it. An implementation now names its binding
//    (`bindings`) and validate compares it with the pin.
// ---------------------------------------------------------------------------

let sb: TrialSandbox;

/** The paths `wairon agent brief` prints under one heading (`Code write fence:`, `Shared (…):`, `Read paths:`). */
function listed(stdout: string, heading: string): string[] {
  const lines = stdout.split(/\r?\n/).map((l) => l.replace(/^ℹ\s?/, ''));
  const start = lines.findIndex((l) => l.trimStart().startsWith(heading));
  if (start < 0) return [];
  const out: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (!/^\s{2,}\S/.test(line)) break;
    out.push(line.trim());
  }
  return out;
}

beforeAll(() => { sb = createTrialSandbox('r6briefs'); });
afterAll(async () => { await sb?.cleanup(); });

/** Payments: a store whose contract alone uses Payment, and a refund workflow sharing PaymentId with it. */
function payments(): FixtureTree {
  return {
    system: { name: 'Payments', vision: 'Takes payments and refunds them.', targetLanguage: 'TypeScript' },
    subsystems: [{ id: 'payments', description: 'Payments and refunds.' }],
    components: [
      { id: 'payment_store', componentType: 'Store', durability: 'read-through', description: 'Holds the payments taken.' },
      {
        id: 'refund_workflow', componentType: 'Orchestrator', dependsOn: ['payment_store'], description: 'Refunds a payment.',
        invokedBy: { kind: 'runtime', caller: 'The refund job the operator runs.' },
      },
    ],
    interfaces: [
      {
        id: 'ipayment_store', component: 'payment_store',
        methods: [
          { name: 'put', description: 'Store one payment.', params: [{ name: 'payment', type: 'payment' }], returns: 'void', effect: 'write' },
          { name: 'get', description: 'The payment with an id.', params: [{ name: 'id', type: 'payment_id' }], returns: 'payment?', effect: 'read' },
        ],
      },
      {
        id: 'irefund_workflow', component: 'refund_workflow',
        methods: [{ name: 'refund', description: 'Refund one payment.', params: [{ name: 'id', type: 'payment_id' }], returns: 'void' }],
      },
    ],
    implementations: [
      { id: 'payment_store_impl', contract: 'ipayment_store', sourcePath: 'services/payments/src/persistence/payment-store.ts', methods: [{ name: 'put', detail: 'intent', intent: 'Writes the payment row.' }, { name: 'get', detail: 'intent', intent: 'Reads the payment row, none when absent.' }] },
      { id: 'refund_workflow_impl', contract: 'irefund_workflow', sourcePath: 'services/payments/src/refunds/refund-workflow.ts', methods: [{ name: 'refund', detail: 'intent', intent: 'Reads the payment and refunds it.', calls: ['payment_store.get'] }] },
    ],
    types: [
      { id: 'payment', kind: 'entity', subsystem: 'payments', name: 'Payment', description: 'One payment taken.', sourcePath: 'services/payments/src/domain/payment.ts', fields: [{ name: 'id', type: 'payment_id' }, { name: 'cents', type: 'int' }] },
      { id: 'payment_id', kind: 'value-object', subsystem: 'payments', name: 'PaymentId', description: 'A payment\'s id.', holds: 'string', sourcePath: 'services/payments/src/domain/ids.ts' },
    ],
    files: {
      'package.json': '{ "name": "payments", "type": "commonjs" }\n',
      'services/payments/package.json': '{ "name": "payments-service", "type": "module" }\n',
      'services/payments/src/persistence/payment-store.ts': 'export class PaymentStore {}\n',
      'services/payments/src/persistence/sql-client.ts': 'export const sql = {};\n',
    },
  };
}

describe('r6 briefs: the fence is exact files, the shared files are named apart', () => {
  it('a component brief fences its own file and its own type\'s planned file — never a folder — and lists the module setup, the shared type and the helper as shared', async () => {
    const dir = sb.materialize('payments', payments());
    const r = await sb.run(['agent', 'brief', 'payment_store'], dir);
    expect(r.code, transcript(r)).toBe(0);
    expect(listed(r.stdout, 'Code write fence:'), transcript(r)).toEqual([
      'services/payments/src/persistence/payment-store.ts', 'services/payments/src/domain/payment.ts',
    ]);
    expect(listed(r.stdout, 'Shared (')).toEqual([
      'services/payments/src/domain/ids.ts', 'package.json', 'services/payments/package.json', 'services/payments/src/persistence/sql-client.ts',
    ]);
    expect(r.stdout).toContain('`services/payments/src/domain/payment.ts` (planned — create it)');
    expect(r.stdout).toContain('that is a design change: stop and report it');
    // Its read paths carry the contract's types.
    expect(r.stdout).toContain('.wai/specs/types/payment.yaml');
    expect(r.stdout).toContain('.wai/specs/types/payment_id.yaml');
  });

  it('control — the sibling\'s fence holds only its own file, so the two never overlap, and it reads the store\'s contract and code', async () => {
    const dir = sb.materialize('payments-sibling', payments());
    const r = await sb.run(['agent', 'brief', 'refund_workflow'], dir);
    expect(r.code, transcript(r)).toBe(0);
    expect(listed(r.stdout, 'Code write fence:'), transcript(r)).toEqual(['services/payments/src/refunds/refund-workflow.ts']);
    expect(listed(r.stdout, 'Read paths:')).toEqual(expect.arrayContaining([
      '.wai/specs/interfaces/ipayment_store.yaml', 'services/payments/src/persistence/payment-store.ts',
    ]));
  });
});

/** RoutePlanner's leg planner reaching GeoKit's distance library through a hand-written binding module. */
function legPlanner(n: number, binding: string): string {
  const tree: FixtureTree = {
    system: { name: 'RoutePlanner', vision: 'Plans delivery routes over GeoKit.', targetLanguage: 'TypeScript' },
    subsystems: [{ id: 'routing', description: 'Route planning.' }],
    components: [{
      id: 'leg_planner', componentType: 'Orchestrator', dependsOn: ['geo::distance_library'], description: 'Measures the legs of a route.',
      invokedBy: { kind: 'runtime', caller: 'The route planner CLI a dispatcher runs.' },
    }],
    interfaces: [{
      id: 'ileg_planner', component: 'leg_planner',
      methods: [{ name: 'legLength', description: 'The length of one leg in km.', params: [{ name: 'fromStop', type: 'string' }, { name: 'toStop', type: 'string' }], returns: 'float' }],
    }],
    implementations: [{
      id: 'leg_planner_impl', contract: 'ileg_planner', sourcePath: 'src/leg-planner.ts', bindings: ['src/geo-binding.ts'],
      methods: [{ name: 'legLength', detail: 'intent', intent: 'Looks both stops up and measures the great-circle distance between them.' }],
    }],
    files: {
      'src/geo-binding.ts': binding,
      'src/leg-planner.ts': 'export function legLength(fromStop: string, toStop: string): number { return 0; }\n',
    },
  };
  const rp = sb.materialize(`rp${n}`, tree);
  writeFile(rp, '.wai/project.yaml', projectYaml('route-planner', { externals: { geo: { source: { path: `../geo${n}` } } } }));
  return rp;
}

const binding = (verb: string, latField: string): string => [
  '// Hand-typed binding for the GeoKit library; names are GeoKit\'s own.',
  'export interface Coordinate {',
  `  ${latField}: number;`,
  '  lon: number;',
  '}',
  '',
  'export interface DistanceLibrary {',
  `  ${verb}(from: Coordinate, to: Coordinate): number;`,
  '}',
  '',
].join('\n');

describe('r6 (lib-and-app R6-21): a binding module is compared with the pin', () => {
  it('rename in the producer → re-pin → the consumer\'s binding is BINDING_DRIFT naming the rename to follow; following it is clean', async () => {
    const geo = sb.materialize('geo1', geoKit());
    const rp = legPlanner(1, binding('haversine', 'lat'));
    const pinned = await sb.run(['externals', 'pin'], rp);
    expect(pinned.code, transcript(pinned)).toBe(0);
    const before = await sb.run(['validate'], rp);
    expect(countCode(before.all, 'BINDING_DRIFT'), transcript(before)).toBe(0);
    expect(countCode(before.all, 'BINDING_UNREAD'), transcript(before)).toBe(0);

    // The producer's release: a verb and a field renamed with their traces.
    const verb = await sb.run(['method', 'rename', 'distance_library', 'haversine', 'greatCircle', '--no-pin-symbol'], geo);
    expect(verb.code, transcript(verb)).toBe(0);
    const field = await sb.run(['type', 'rename-field', 'coordinate', 'lat', 'latitude'], geo);
    expect(field.code, transcript(field)).toBe(0);
    const repin = await sb.run(['externals', 'pin', 'geo'], rp);
    expect(repin.code, transcript(repin)).toBe(0);

    const after = await sb.run(['validate'], rp);
    expect(countCode(after.all, 'BINDING_DRIFT'), transcript(after)).toBe(2);
    expect(after.all).toMatch(/\[BINDING_DRIFT\][^\n]*src\/geo-binding\.ts[^\n]*"haversine" was renamed to "greatCircle" in geo::distance_library — follow the rename/);
    expect(after.all).toMatch(/\[BINDING_DRIFT\][^\n]*field "lat" was renamed to "latitude" — follow the rename/);
    const ci = await sb.run(['validate', '--ci'], rp);
    expect(ci.code, transcript(ci)).toBe(1);

    // Following the renames in the binding clears it.
    writeFile(rp, 'src/geo-binding.ts', binding('greatCircle', 'latitude'));
    const followed = await sb.run(['validate'], rp);
    expect(countCode(followed.all, 'BINDING_DRIFT'), transcript(followed)).toBe(0);
  });

  it('control — a binding matching the pin draws nothing; a binding not written yet is a notice, never a failure', async () => {
    sb.materialize('geo2', geoKit());
    const rp = legPlanner(2, binding('haversine', 'lat'));
    expect((await sb.run(['externals', 'pin'], rp)).code).toBe(0);
    const clean = await sb.run(['validate'], rp);
    expect(countCode(clean.all, 'BINDING_DRIFT'), transcript(clean)).toBe(0);

    sb.materialize('geo3', geoKit());
    const planned = legPlanner(3, binding('haversine', 'lat'));
    expect((await sb.run(['externals', 'pin'], planned)).code).toBe(0);
    const fs = await import('fs');
    fs.rmSync(`${planned}/src/geo-binding.ts`);
    const r = await sb.run(['validate'], planned);
    expect(r.all, transcript(r)).toMatch(/\[BINDING_UNREAD\][^\n]*src\/geo-binding\.ts[^\n]*not on disk yet/);
    expect(countCode(r.all, 'BINDING_DRIFT')).toBe(0);
  });
});
