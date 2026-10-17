/**
 * The release QA gate's conformance corpus (seat 3, document conversion): every
 * shape the seat found passing silently is caught by the right code naming the
 * right method, and every unusual-but-legal shape — the seat's own honest
 * variants and their kin — adds none of the new findings. The fire/control
 * pairs per code live in the rule-matrix tier
 * (tests/rules-matrix/families/conformance-surface-gaps.fixtures.ts); this file
 * pins the honest corpus and what the messages say.
 */
import { describe, expect, it } from 'vitest';
import { defineRuleFixture, runRuleFixture, type FixtureTree } from '../rules-matrix/harness.js';
import {
  dispatchTree, py, ts, tsOrchestrator, PY_DISPATCH_BODY, PY_STORE, TS_DISPATCH_BODY, TS_STORE,
} from '../rules-matrix/families/conformance-surface-gaps.fixtures.js';

/** The codes the gate gained or extended to Python: an honest tree must raise none of them. */
const GAP_CODES = new Set([
  'RETURN_TYPE_MISMATCH', 'UNDECLARED_PUBLIC_MEMBER', 'UNNARRATED_CALL', 'ROUTES_UNCHECKED',
  'PARAM_NAME_MISMATCH', 'UNREALIZED_PARAM', 'UNDECLARED_PARAM', 'PARAM_TYPE_MISMATCH', 'UNDECLARED_DEPENDENCY',
]);

function run(tree: FixtureTree) {
  return runRuleFixture(defineRuleFixture({ code: 'RETURN_TYPE_MISMATCH', expectFire: false, reason: 'probe', scenario: 'A parcel dispatch system the gate reads whole.', tree }));
}

function gapFindings(tree: FixtureTree): string[] {
  return run(tree).issues.filter(i => GAP_CODES.has(i.code)).map(i => `${i.code}: ${i.message}`);
}

describe('honest code adds none of the new findings', () => {
  const honest: Array<[string, FixtureTree]> = [
    ['a private helper the method calls through (TypeScript)', dispatchTree(ts([
      'async dispatchParcel(parcelId: string): Promise<string> {',
      '  const routeId = `route-${parcelId}`;',
      '  this.book(parcelId, routeId);',
      '  return routeId;',
      '}',
      '',
      'private book(parcelId: string, routeId: string): void {',
      '  this.store.record(parcelId, routeId);',
      '}',
    ]), false)],
    ['the method written as an arrow-function property', dispatchTree(ts([
      'dispatchParcel = async (parcelId: string): Promise<string> => {',
      '  const routeId = `route-${parcelId}`;',
      '  this.store.record(parcelId, routeId);',
      '  return routeId;',
      '};',
    ]), false)],
    ['an unexported module helper and a default export of the class', dispatchTree(ts(TS_DISPATCH_BODY, ['function routeFor(parcelId: string): string {', '  return `route-${parcelId}`;', '}', '', 'export default DispatchOrchestrator;', '']), false)],
    ['a public helper the class itself calls', dispatchTree(ts([
      'async dispatchParcel(parcelId: string): Promise<string> {',
      '  const routeId = this.routeFor(parcelId);',
      '  this.store.record(parcelId, routeId);',
      '  return routeId;',
      '}',
      '',
      'routeFor(parcelId: string): string {',
      '  return `route-${parcelId}`;',
      '}',
    ]), false)],
    ['an exported helper its tests import', {
      ...dispatchTree(ts(TS_DISPATCH_BODY, ['export function routeLabel(routeId: string): string {', '  return `route ${routeId}`;', '}', '']), false),
      files: {
        'src/dispatch/dispatch_orchestrator.ts': tsOrchestrator(TS_DISPATCH_BODY, ['export function routeLabel(routeId: string): string {', '  return `route ${routeId}`;', '}', '']),
        'src/dispatch/tracking-store.ts': TS_STORE,
        'tests/dispatch.test.ts': "import { routeLabel } from '../src/dispatch/dispatch_orchestrator.js';\n\nif (routeLabel('a') !== 'route a') throw new Error('label');\n",
      },
    }],
    ['an accessor, a static factory, protected, #private and protocol members', dispatchTree(ts([
      ...TS_DISPATCH_BODY,
      '',
      'get ready(): boolean {',
      '  return true;',
      '}',
      '',
      'static over(store: TrackingStore): DispatchOrchestrator {',
      '  return new DispatchOrchestrator(store);',
      '}',
      '',
      'protected audit(): void {}',
      '',
      '#trace(): void {}',
      '',
      'toString(): string {',
      '  return \'DispatchOrchestrator\';',
      '}',
    ]), false)],
    ['a renamed local and moved comments', dispatchTree(ts([
      'async dispatchParcel(parcelId: string): Promise<string> {',
      '  const chosen = `route-${parcelId}`; // the delivery route',
      '  this.store.record(parcelId, chosen);',
      '  return chosen;',
      '}',
    ]), false)],
    ['Python: snake_case parameters, a private helper, a dunder', dispatchTree(py([
      'async def dispatch_parcel(self, parcel_id: str) -> str:',
      '    route_id = self._route_for(parcel_id)',
      '    self._store.record(parcel_id, route_id)',
      '    return route_id',
      '',
      'def _route_for(self, parcel_id: str) -> str:',
      '    return "route-" + parcel_id',
      '',
      'def __repr__(self) -> str:',
      '    return "DispatchOrchestrator()"',
    ]), true)],
    ['Python: a classmethod, a staticmethod and a property', dispatchTree(py([
      ...PY_DISPATCH_BODY,
      '',
      '@classmethod',
      'def over(cls, store: TrackingStore) -> "DispatchOrchestrator":',
      '    return cls(store)',
      '',
      '@staticmethod',
      'def engine_name() -> str:',
      '    return "dispatch"',
      '',
      '@property',
      'def ready(self) -> bool:',
      '    return True',
    ]), true)],
    ['Python: module helpers, a private one and a public one the class uses', dispatchTree(py([
      'async def dispatch_parcel(self, parcel_id: str) -> str:',
      '    route_id = route_for(_clean(parcel_id))',
      '    self._store.record(parcel_id, route_id)',
      '    return route_id',
    ], ['def _clean(text: str) -> str:', '    return text.strip()', '', '', 'def route_for(parcel_id: str) -> str:', '    return "route-" + parcel_id', '']), true)],
    ['Python: a quoted, Optional-free forward reference and typing spellings', dispatchTree({
      orchestrator: [
        'from typing import Optional',
        'from .tracking_store import TrackingStore',
        '',
        '',
        'class DispatchOrchestrator:',
        '    def __init__(self, store: TrackingStore) -> None:',
        '        self._store = store',
        '',
        '    async def dispatch_parcel(self, parcel_id: "str") -> "str":',
        '        route_id = "route-" + parcel_id',
        '        self._store.record(parcel_id, route_id)',
        '        return route_id',
        '',
      ].join('\n'),
      store: PY_STORE,
    }, true)],
  ];

  it.each(honest)('%s', (_name, tree) => {
    expect(gapFindings(tree)).toEqual([]);
  });
});

describe('the findings name the method that changed', () => {
  it('a changed return type is named on the method, with the contract\'s type and the code\'s', () => {
    const issues = run(dispatchTree(ts([
      'async dispatchParcel(parcelId: string): Promise<string[]> {',
      '  this.store.record(parcelId, parcelId);',
      '  return [parcelId];',
      '}',
    ]), false)).issues.filter(i => i.code === 'RETURN_TYPE_MISMATCH');
    expect(issues).toHaveLength(1);
    expect(issues[0].specId).toBe('dispatch_orchestrator_impl');
    expect(issues[0].message).toContain('"dispatchParcel"');
    expect(issues[0].message).toContain('`async string`');
    expect(issues[0].message).toContain('`Promise<string[]>`');
  });

  it('a caller whose own port no longer matches the drifted class is told the cause', () => {
    const tree = dispatchTree(ts([
      'async dispatchParcel(parcelId: string): Promise<string[]> {',
      '  this.store.record(parcelId, parcelId);',
      '  return [parcelId];',
      '}',
    ]), false);
    tree.components!.push({ id: 'dispatch-desk', componentType: 'Portal', transport: 'InProcess', description: 'The dispatch desk\'s in-process entry for booking parcels.', dependsOn: ['dispatch-orchestrator'], invokedBy: { kind: 'entry', caller: 'the dispatch desk application' } });
    tree.interfaces!.push({ id: 'idispatch_desk', component: 'dispatch-desk', methods: [{ name: 'bookParcel', description: 'Book a parcel from the desk.', signature: 'bookParcel(parcelId: string): async string', returns: 'async string', params: [{ name: 'parcelId', type: 'string' }] }] });
    tree.implementations!.push({ id: 'dispatch_desk_impl', contract: 'idispatch_desk', sourcePath: 'src/dispatch/desk.ts', methods: [{ name: 'bookParcel', narrative: [{ stepNumber: 1, type: 'call', targetComponent: 'dispatch-orchestrator', targetMethod: 'dispatchParcel', description: 'Hand the booking to the dispatch orchestrator.' }] }] });
    tree.files!['src/dispatch/desk.ts'] = [
      '/** The collaborator this desk calls, typed after its contract. */',
      'interface DispatchPort {',
      '  dispatchParcel(parcelId: string): Promise<string>;',
      '}',
      '',
      'export class DispatchDesk {',
      '  constructor(private readonly dispatch: DispatchPort) {}',
      '',
      '  async bookParcel(parcelId: string): Promise<string> {',
      '    return this.dispatch.dispatchParcel(parcelId);',
      '  }',
      '}',
      '',
    ].join('\n');
    const issues = run(tree).issues;
    expect(issues.some(i => i.code === 'RETURN_TYPE_MISMATCH' && i.specId === 'dispatch_orchestrator_impl')).toBe(true);
    const onCaller = issues.filter(i => i.specId === 'dispatch_desk_impl' && (i.code === 'UNREALIZED_DEPENDENCY' || i.code === 'CALL_ORIGIN_UNRESOLVED'));
    expect(onCaller.length).toBeGreaterThan(0);
    for (const issue of onCaller) expect(issue.message).toContain('RETURN_TYPE_MISMATCH');
  });

  it('an unnarrated call names the collaborator\'s verb and how it was written', () => {
    const issues = run(dispatchTree(ts([
      'async dispatchParcel(parcelId: string): Promise<string> {',
      '  const earlier = this.store.lookup(parcelId);',
      '  this.store.record(parcelId, earlier);',
      '  return earlier;',
      '}',
    ]), false)).issues.filter(i => i.code === 'UNNARRATED_CALL');
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('tracking-store.lookup');
    expect(issues[0].message).toContain('this.store.lookup');
  });

  it('a Python parameter renamed in the code alone is told under both names', () => {
    const issues = run(dispatchTree(py([
      'async def dispatch_parcel(self, parcel_ref: str) -> str:',
      '    self._store.record(parcel_ref, parcel_ref)',
      '    return parcel_ref',
    ]), true)).issues.filter(i => i.code === 'PARAM_NAME_MISMATCH');
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('"parcel_id"');
    expect(issues[0].message).toContain('"parcel_ref"');
  });
});

describe('the code reading says what was checked', () => {
  it('a Python realization is read at pattern grade, its checks and its gaps named', () => {
    const reading = run(dispatchTree(py(PY_DISPATCH_BODY), true)).result.codeReading ?? '';
    expect(reading).toMatch(/^Code read at grade pattern/);
    expect(reading).toContain('python: 2 file(s) at grade pattern with its signature reader, checked methods, params, returns (where annotated), public members, imports, calls through declared receivers — not checked: routes, data types');
  });

  it('a TypeScript realization read whole is one clause', () => {
    const result = run(dispatchTree(ts(TS_DISPATCH_BODY), false)).result;
    expect(result.codeReading).toMatch(/^Code read at grade exact with TypeScript/);
    expect(result.codeCompact).toBe('typescript exact');
  });
});
