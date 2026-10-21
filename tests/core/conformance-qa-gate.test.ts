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
  deskTree, dispatchTree, py, ts, tsOrchestrator, PY_DISPATCH_BODY, PY_STORE, TS_DISPATCH_BODY, TS_STORE,
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

  it('a caller whose own port no longer matches the drifted class is held under the root cause, not reported again', () => {
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
    const root = issues.filter(i => i.code === 'RETURN_TYPE_MISMATCH' && i.specId === 'dispatch_orchestrator_impl');
    expect(root).toHaveLength(1);
    expect(root[0].message).toContain('held under this finding');
    // The caller's port no longer matches, so its call and its edge only LOOK broken: one finding, at the cause.
    expect(issues.filter(i => i.specId === 'dispatch_desk_impl' && (i.code === 'UNREALIZED_DEPENDENCY' || i.code === 'CALL_ORIGIN_UNRESOLVED'))).toEqual([]);
    // With the drift fixed, the same port resolves to the class and nothing is said on the caller either.
    tree.files!['src/dispatch/dispatch_orchestrator.ts'] = tsOrchestrator(TS_DISPATCH_BODY);
    expect(run(tree).issues.filter(i => i.specId === 'dispatch_desk_impl' && (i.code === 'UNREALIZED_DEPENDENCY' || i.code === 'CALL_ORIGIN_UNRESOLVED'))).toEqual([]);
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

describe('Python: a narrated call the code no longer makes is reported by absence', () => {
  const unrealized = (tree: FixtureTree): string[] =>
    run(tree).issues.filter(i => i.code === 'CALL_STEP_UNREALIZED').map(i => i.message);

  it('a dropped call is CALL_STEP_UNREALIZED, naming the target and that a call is matched by name', () => {
    const found = unrealized(dispatchTree(py([
      'async def dispatch_parcel(self, parcel_id: str) -> str:',
      '    return "route-" + parcel_id',
    ]), true));
    expect(found).toHaveLength(1);
    expect(found[0]).toContain('tracking-store.record');
    expect(found[0]).toContain("makes no call by the target method's name");
    expect(found[0]).toContain('matched by name');
  });

  it('a call renamed in the code alone is reported', () => {
    const found = unrealized(dispatchTree(py([
      'async def dispatch_parcel(self, parcel_id: str) -> str:',
      '    self._store.record_v2(parcel_id, parcel_id)',
      '    return parcel_id',
    ]), true));
    expect(found).toHaveLength(1);
    expect(found[0]).toContain('tracking-store.record');
  });

  it('an honest call through self._field is silent', () => {
    expect(unrealized(dispatchTree(py(PY_DISPATCH_BODY), true))).toEqual([]);
  });

  it('a call through an unannotated receiver with the right name is silent', () => {
    expect(unrealized(dispatchTree(py([
      'async def dispatch_parcel(self, parcel_id: str) -> str:',
      '    sink = self._pick()',
      '    sink.record(parcel_id, parcel_id)',
      '    return parcel_id',
    ]), true))).toEqual([]);
  });

  it('a call made in a helper the function reaches is silent', () => {
    expect(unrealized(dispatchTree(py([
      'async def dispatch_parcel(self, parcel_id: str) -> str:',
      '    self._book(parcel_id)',
      '    return parcel_id',
      '',
      'def _book(self, parcel_id: str) -> None:',
      '    self._store.record(parcel_id, parcel_id)',
    ]), true))).toEqual([]);
  });

  it('conformance off judges nothing forward', () => {
    const tree = dispatchTree(py([
      'async def dispatch_parcel(self, parcel_id: str) -> str:',
      '    return "route-" + parcel_id',
    ]), true);
    tree.implementations!.find(i => i.id === 'dispatch_orchestrator_impl')!.methods![0].conformance = 'off';
    expect(unrealized(tree)).toEqual([]);
  });
});

describe('an import against a Portal\'s call edge is reported once, on the importer', () => {
  const importsDesk = (python: boolean, imports: string[]): string[] => {
    const tree = python
      ? deskTree(py(PY_DISPATCH_BODY, [], imports), true)
      : deskTree(ts(TS_DISPATCH_BODY, [...imports, 'void DispatchDesk;', '']), false);
    return run(tree).issues.filter(i => i.code === 'UNDECLARED_DEPENDENCY' || (i.code === 'UNDECLARED_EXPORT' && i.specId === 'dispatch_desk_impl')).map(i => `${i.code} ${i.specId}: ${i.message}`);
  };

  it('TypeScript: UNDECLARED_DEPENDENCY on the orchestrator naming the desk and the edge it inverts; the desk\'s UNDECLARED_EXPORT names the importer', () => {
    const found = importsDesk(false, ["import { DispatchDesk } from './dispatch_desk.js';"]);
    expect(found).toHaveLength(2);
    const dependency = found.find(f => f.startsWith('UNDECLARED_DEPENDENCY'))!;
    expect(dependency).toMatch(/^UNDECLARED_DEPENDENCY dispatch_orchestrator_impl: "src\/dispatch\/dispatch_orchestrator\.ts" \(realizing dispatch-orchestrator\) imports "src\/dispatch\/dispatch_desk\.ts" \(realizing dispatch-desk\)/);
    expect(dependency).toContain('"dispatch-desk" depends on "dispatch-orchestrator" and calls it');
    const exported = found.find(f => f.startsWith('UNDECLARED_EXPORT'))!;
    expect(exported).toContain('"DispatchDesk" (imported by "src/dispatch/dispatch_orchestrator.ts")');
  });

  it.each([
    ['a relative import', ['from .dispatch_desk import DispatchDesk']],
    ['`from . import` of the module', ['from . import dispatch_desk']],
    ['an absolute import from the source root', ['from src.dispatch.dispatch_desk import DispatchDesk']],
    ['an absolute module import', ['import src.dispatch.dispatch_desk']],
  ])('Python: %s of the desk is UNDECLARED_DEPENDENCY on the orchestrator', (_name, imports) => {
    const found = importsDesk(true, imports);
    expect(found).toHaveLength(1);
    expect(found[0]).toContain('UNDECLARED_DEPENDENCY dispatch_orchestrator_impl: "src/dispatch/dispatch_orchestrator.py" (realizing dispatch-orchestrator) imports "src/dispatch/dispatch_desk.py" (realizing dispatch-desk)');
  });

  it('Python: a package\'s __init__.py is the module a package import lands in', () => {
    const tree = deskTree(py(PY_DISPATCH_BODY, [], ['from .desk import DispatchDesk']), true);
    const desk = tree.implementations!.find(i => i.id === 'dispatch_desk_impl')!;
    desk.sourcePath = 'src/dispatch/desk/__init__.py';
    tree.files!['src/dispatch/desk/__init__.py'] = tree.files!['src/dispatch/dispatch_desk.py'].replace('from .dispatch_orchestrator', 'from ..dispatch_orchestrator');
    delete tree.files!['src/dispatch/dispatch_desk.py'];
    const found = run(tree).issues.filter(i => i.code === 'UNDECLARED_DEPENDENCY');
    expect(found.map(i => i.message)).toEqual([expect.stringContaining('imports "src/dispatch/desk/__init__.py" (realizing dispatch-desk)')]);
  });

  it('Python: standard-library and third-party imports are no component', () => {
    expect(importsDesk(true, ['import typing', 'import requests', 'from collections import OrderedDict'])).toEqual([]);
  });
});

describe('the code reading says what was checked', () => {
  it('a Python realization is read at pattern grade, its checks and its gaps named', () => {
    const reading = run(dispatchTree(py(PY_DISPATCH_BODY), true)).result.codeReading ?? '';
    expect(reading).toMatch(/^Code read at grade pattern/);
    expect(reading).toContain('python: 2 file(s) at grade pattern with its signature reader, checked methods, params, returns (where annotated), public members, imports, calls: through declared receivers; a narrated call by name — not checked: routes, data types');
  });

  it('a Portal binding HTTP endpoints with no router named is counted among what was not checked', () => {
    const tree: FixtureTree = {
      subsystems: [{ id: 'parcel-tracking', description: 'Lets recipients follow where their parcel is.' }],
      components: [{ id: 'tracking-portal', componentType: 'Portal', transport: 'HTTP', description: 'Answers recipients\' parcel-tracking requests over HTTP.' }],
      interfaces: [{
        id: 'itracking_portal',
        component: 'tracking-portal',
        methods: [{ name: 'trackParcel', description: 'Answer where one parcel is.', signature: 'trackParcel(parcelId: string): string', returns: 'string', params: [{ name: 'parcelId', type: 'string' }], endpoint: { transport: 'HTTP', method: 'GET', path: '/parcels/{parcelId}' } }],
      }],
      implementations: [{
        id: 'tracking_portal_impl',
        contract: 'itracking_portal',
        sourcePath: 'src/tracking/tracking-portal.ts',
        methods: [{ name: 'trackParcel', narrative: [{ stepNumber: 1, type: 'return', outcome: 'success', description: 'Answer the parcel\'s last known position.' }] }],
      }],
      files: {
        'src/tracking/tracking-portal.ts': [
          'export class TrackingPortal {',
          '  trackParcel(parcelId: string): string {',
          '    return \'parcel \' + parcelId;',
          '  }',
          '}',
          '',
        ].join('\n'),
      },
    };
    const result = run(tree).result;
    expect(result.codeReading).toContain('routes where a router is named');
    expect(result.codeReading).toContain('not checked: routes of 1 HTTP Portal(s) naming no router (each judged by the public methods of its realizing class alone)');
    expect(result.codeCompact).toBe('typescript exact (not checked: routes of 1 HTTP Portal(s) naming no router)');
  });

  it('a TypeScript realization read whole is one clause', () => {
    const result = run(dispatchTree(ts(TS_DISPATCH_BODY), false)).result;
    expect(result.codeReading).toMatch(/^Code read at grade exact with TypeScript/);
    expect(result.codeCompact).toBe('typescript exact');
  });
});
