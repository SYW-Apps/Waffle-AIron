/**
 * The code↔spec gaps the release QA seat found open (seat 3, document
 * conversion) — src/core/rules/conformance/{param,export,call,dependency}-conformance.ts
 * and route-coverage.ts.
 *
 * Documented intents pinned here (each rule's description):
 *  - RETURN_TYPE_MISMATCH (warning): the function realizing a contract method
 *    is annotated to return a type the contract's `returns` does not describe.
 *    Named on the method that changed — never only on a caller whose port it
 *    broke. TypeScript, and Python through its signature reader.
 *  - UNDECLARED_PUBLIC_MEMBER (warning): a public method of a component's
 *    realizing class, or a function its realizing file exports, that no
 *    contract declares and nothing in the project uses. TypeScript and Python.
 *  - UNNARRATED_CALL (warning): a method whose narrative claims its calls
 *    (detail full or calls-only) calls, in its own body, a contract method of a
 *    collaborator it narrates that no step names. TypeScript and Python.
 *  - ROUTES_UNCHECKED (warning): a Portal's files hold a router no `router:`
 *    names, so the routes it serves were checked against nothing.
 *  - Python is judged for parameter names (in its snake_case) and imports too:
 *    PARAM_NAME_MISMATCH and UNDECLARED_DEPENDENCY fire on a .py realization.
 *  - UNDECLARED_DEPENDENCY (warning), round 2: a component importing the
 *    Portal that depends on it and CALLS it runs against the declared edge —
 *    an import cycle, never forgiven as the mounting shape. Only a Portal that
 *    depends on a component without calling it (a server mounting its
 *    Portals) is mounted, and that reverse import stays quiet. TypeScript and
 *    Python.
 *  - UNDECLARED_PUBLIC_MEMBER (warning), round 2: an exported CLASS that no
 *    contract declares and nothing uses — not even its own file, outside its
 *    own body — is surface like an unused exported function.
 *
 * Each control is the same tree with the defect corrected.
 */
import { defineRuleFixture, type FixtureTree } from '../harness.js';

// ---------------------------------------------------------------------------
// The parcel-dispatch system: a dispatch orchestrator that books a parcel onto
// a route and records it in the tracking store.
// ---------------------------------------------------------------------------

interface DispatchCode {
  /** The orchestrator's file, by language. */
  orchestrator: string;
  /** The tracking store's file. */
  store: string;
}

export const TS_STORE = [
  'export class TrackingStore {',
  '  private readonly entries = new Map<string, string>();',
  '',
  '  record(parcelId: string, routeId: string): void {',
  '    this.entries.set(parcelId, routeId);',
  '  }',
  '',
  '  lookup(parcelId: string): string {',
  '    return this.entries.get(parcelId) ?? \'\';',
  '  }',
  '}',
  '',
].join('\n');

export const PY_STORE = [
  'class TrackingStore:',
  '    def __init__(self) -> None:',
  '        self._entries: dict[str, str] = {}',
  '',
  '    def record(self, parcel_id: str, route_id: str) -> None:',
  '        self._entries[parcel_id] = route_id',
  '',
  '    def lookup(self, parcel_id: str) -> str:',
  '        return self._entries.get(parcel_id, "")',
  '',
].join('\n');

/** A TypeScript orchestrator with the given method bodies inside its class and the given lines after it. */
export function tsOrchestrator(members: string[], after: string[] = []): string {
  return [
    'import { TrackingStore } from \'./tracking-store.js\';',
    '',
    'export class DispatchOrchestrator {',
    '  constructor(private readonly store: TrackingStore) {}',
    '',
    ...members.map(line => (line ? `  ${line}` : '')),
    '}',
    '',
    ...after,
  ].join('\n');
}

export const TS_DISPATCH_BODY = [
  'async dispatchParcel(parcelId: string): Promise<string> {',
  '  const routeId = `route-${parcelId}`;',
  '  this.store.record(parcelId, routeId);',
  '  return routeId;',
  '}',
];

/** A Python orchestrator with the given method lines inside its class and the given lines after it. */
function pyOrchestrator(members: string[], after: string[] = [], imports: string[] = []): string {
  return [
    'from .tracking_store import TrackingStore',
    ...imports,
    '',
    '',
    'class DispatchOrchestrator:',
    '    def __init__(self, store: TrackingStore) -> None:',
    '        self._store = store',
    '',
    ...members.map(line => (line ? `    ${line}` : '')),
    '',
    ...after,
  ].join('\n');
}

export const PY_DISPATCH_BODY = [
  'async def dispatch_parcel(self, parcel_id: str) -> str:',
  '    route_id = "route-" + parcel_id',
  '    self._store.record(parcel_id, route_id)',
  '    return route_id',
];

/**
 * The tree: the orchestrator depends on the tracking store; its dispatch verb
 * returns the route id and its narrative records the booking (and, where
 * `narratesLookup`, reads it back first). Python names its verbs in
 * snake_case, as the language does.
 */
export function dispatchTree(code: DispatchCode, python: boolean, opts: { narratesLookup?: boolean; dependsOnStore?: boolean } = {}): FixtureTree {
  const ext = python ? 'py' : 'ts';
  const dispatch = python ? 'dispatch_parcel' : 'dispatchParcel';
  const parcel = python ? 'parcel_id' : 'parcelId';
  const route = python ? 'route_id' : 'routeId';
  const storeFile = python ? 'src/dispatch/tracking_store.py' : 'src/dispatch/tracking-store.ts';
  return {
    ...(python ? { system: { targetLanguage: 'python' } } : {}),
    subsystems: [{ id: 'parcel-dispatch', description: 'Books parcels onto delivery routes and tracks where each one went.' }],
    components: [
      {
        id: 'dispatch-orchestrator',
        componentType: 'Orchestrator',
        description: 'Books a parcel onto a delivery route and records the booking.',
        dependsOn: opts.dependsOnStore === false ? [] : ['tracking-store'],
      },
      {
        id: 'tracking-store',
        componentType: 'Store',
        description: 'Holds which route each parcel was booked onto.',
      },
    ],
    interfaces: [
      {
        id: 'idispatch_orchestrator',
        component: 'dispatch-orchestrator',
        methods: [{
          name: dispatch,
          description: 'Book one parcel onto a delivery route and answer the route it was booked onto.',
          signature: `${dispatch}(${parcel}: string): async string`,
          returns: 'async string',
          params: [{ name: parcel, type: 'string' }],
        }],
      },
      {
        id: 'itracking_store',
        component: 'tracking-store',
        methods: [
          {
            name: 'record',
            description: 'Record the route a parcel was booked onto.',
            signature: `record(${parcel}: string, ${route}: string): void`,
            returns: 'void',
            params: [{ name: parcel, type: 'string' }, { name: route, type: 'string' }],
            effect: 'write',
          },
          {
            name: 'lookup',
            description: 'Answer the route a parcel was booked onto, empty when it was never booked.',
            signature: `lookup(${parcel}: string): string`,
            returns: 'string',
            params: [{ name: parcel, type: 'string' }],
            effect: 'read',
          },
        ],
      },
    ],
    implementations: [
      {
        id: 'dispatch_orchestrator_impl',
        contract: 'idispatch_orchestrator',
        sourcePath: `src/dispatch/dispatch_orchestrator.${ext}`,
        methods: [{
          name: dispatch,
          narrative: [
            ...(opts.narratesLookup ? [{ stepNumber: 1, type: 'call', targetComponent: 'tracking-store', targetMethod: 'lookup', description: 'Read back any route the parcel was already booked onto.' }] : []),
            { stepNumber: opts.narratesLookup ? 2 : 1, type: 'local', description: 'Pick the delivery route for the parcel.' },
            { stepNumber: opts.narratesLookup ? 3 : 2, type: 'call', targetComponent: 'tracking-store', targetMethod: 'record', description: 'Record the booking in the tracking store.' },
            { stepNumber: opts.narratesLookup ? 4 : 3, type: 'return', outcome: 'success', description: 'Answer the route id.' },
          ],
        }],
      },
      {
        id: 'tracking_store_impl',
        contract: 'itracking_store',
        sourcePath: storeFile,
        methods: [
          { name: 'record', detail: 'intent', narrative: [], intent: 'Stores the route a parcel was booked onto under the parcel id, replacing an earlier booking; it never fails.' },
          { name: 'lookup', detail: 'intent', narrative: [], intent: 'Answers the route recorded for the parcel id, or an empty string when the parcel was never booked; it never fails.' },
        ],
      },
    ],
    files: {
      [`src/dispatch/dispatch_orchestrator.${ext}`]: code.orchestrator,
      [storeFile]: code.store,
      ...(python ? { 'src/dispatch/__init__.py': '' } : {}),
    },
  };
}

export const ts = (members: string[], after: string[] = []): DispatchCode => ({ orchestrator: tsOrchestrator(members, after), store: TS_STORE });
export const py = (members: string[], after: string[] = [], imports: string[] = []): DispatchCode => ({ orchestrator: pyOrchestrator(members, after, imports), store: PY_STORE });

// ---- the dispatch desk: a Portal that calls the orchestrator ---------------

/**
 * The dispatch tree with a desk Portal that depends on the orchestrator and
 * CALLS it (its narrative books through it), and, where `server`, a Supervisor
 * the desk is mounted onto: the desk depends on it without calling it, and the
 * server's file imports the desk's to serve it.
 */
export function deskTree(code: DispatchCode, python: boolean, opts: { server?: boolean } = {}): FixtureTree {
  const tree = dispatchTree(code, python);
  const ext = python ? 'py' : 'ts';
  const book = python ? 'book_parcel' : 'bookParcel';
  const dispatch = python ? 'dispatch_parcel' : 'dispatchParcel';
  const parcel = python ? 'parcel_id' : 'parcelId';
  tree.components!.push({
    id: 'dispatch-desk', componentType: 'Portal', transport: 'InProcess',
    description: 'The dispatch desk\'s in-process entry for booking parcels.',
    dependsOn: ['dispatch-orchestrator', ...(opts.server ? ['dispatch-server'] : [])],
    invokedBy: { kind: 'entry', caller: 'the dispatch desk application' },
  });
  tree.interfaces!.push({ id: 'idispatch_desk', component: 'dispatch-desk', methods: [{ name: book, description: 'Book a parcel from the desk.', signature: `${book}(${parcel}: string): async string`, returns: 'async string', params: [{ name: parcel, type: 'string' }] }] });
  tree.implementations!.push({ id: 'dispatch_desk_impl', contract: 'idispatch_desk', sourcePath: `src/dispatch/dispatch_desk.${ext}`, methods: [{ name: book, narrative: [{ stepNumber: 1, type: 'call', targetComponent: 'dispatch-orchestrator', targetMethod: dispatch, description: 'Hand the booking to the dispatch orchestrator.' }, { stepNumber: 2, type: 'return', outcome: 'success', description: 'Answer the route id.' }] }] });
  tree.files![`src/dispatch/dispatch_desk.${ext}`] = python
    ? [
      'from .dispatch_orchestrator import DispatchOrchestrator',
      '',
      '',
      'class DispatchDesk:',
      '    def __init__(self, orchestrator: DispatchOrchestrator) -> None:',
      '        self._orchestrator = orchestrator',
      '',
      '    async def book_parcel(self, parcel_id: str) -> str:',
      '        return await self._orchestrator.dispatch_parcel(parcel_id)',
      '',
    ].join('\n')
    : [
      'import { DispatchOrchestrator } from \'./dispatch_orchestrator.js\';',
      '',
      'export class DispatchDesk {',
      '  constructor(private readonly orchestrator: DispatchOrchestrator) {}',
      '',
      '  async bookParcel(parcelId: string): Promise<string> {',
      '    return this.orchestrator.dispatchParcel(parcelId);',
      '  }',
      '}',
      '',
    ].join('\n');
  if (opts.server) {
    tree.components!.push({ id: 'dispatch-server', componentType: 'Supervisor', description: 'Hosts the dispatch desk and keeps it running.', dependsOn: [] });
    tree.interfaces!.push({ id: 'idispatch_server', component: 'dispatch-server', methods: [{ name: 'serve', description: 'Start serving the dispatch desk.', signature: 'serve(): void', returns: 'void', params: [] }] });
    tree.implementations!.push({ id: 'dispatch_server_impl', contract: 'idispatch_server', sourcePath: `src/dispatch/server.${ext}`, methods: [{ name: 'serve', detail: 'intent', narrative: [], intent: 'Builds the dispatch desk and starts serving it; it never fails.' }] });
    tree.files![`src/dispatch/server.${ext}`] = python
      ? ['from .dispatch_desk import DispatchDesk', '', '', 'def serve() -> None:', '    print(DispatchDesk)', ''].join('\n')
      : ['import { DispatchDesk } from \'./dispatch_desk.js\';', '', 'export function serve(): void {', '  console.log(DispatchDesk.name);', '}', ''].join('\n');
  }
  return tree;
}

// ---- the portal whose files hold a router ----------------------------------

function trackingPortalTree(router: string | null): FixtureTree {
  return {
    subsystems: [{ id: 'parcel-tracking', description: 'Lets recipients follow where their parcel is.' }],
    components: [{ id: 'tracking-portal', componentType: 'Portal', portalType: 'HTTP_API', description: 'Answers recipients\' parcel-tracking requests over HTTP.' }],
    interfaces: [{
      id: 'itracking_portal',
      component: 'tracking-portal',
      methods: [{ name: 'trackParcel', description: 'Answer where one parcel is.', endpoint: { transport: 'HTTP', method: 'GET', path: '/parcels/{parcelId}' } }],
    }],
    implementations: [{
      id: 'tracking_portal_impl',
      contract: 'itracking_portal',
      sourcePath: 'src/tracking/tracking-portal.ts',
      ...(router ? { router } : {}),
      methods: [{ name: 'trackParcel', narrative: [{ stepNumber: 1, type: 'local', description: 'Answer the parcel\'s last known position.' }] }],
    }],
    files: {
      'src/tracking/tracking-portal.ts': [
        'export interface TrackingRequest { method: string; url: string; }',
        '',
        'export function trackParcel(parcelId: string): string {',
        '  return \'parcel \' + parcelId;',
        '}',
        '',
        'export function handleTrackingRequest(req: TrackingRequest): string | undefined {',
        '  const parts = req.url.split(\'/\').filter(Boolean);',
        '  if (req.method === \'GET\' && parts[0] === \'parcels\' && parts.length === 2) return trackParcel(parts[1]);',
        '  return undefined;',
        '}',
        '',
      ].join('\n'),
    },
  };
}

export default [
  // -------------------------------------------------------------------------
  // RETURN_TYPE_MISMATCH
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'RETURN_TYPE_MISMATCH',
    severity: 'warning',
    anchoredTo: 'dispatch_orchestrator_impl',
    expectFire: true,
    scenario: 'The dispatch orchestrator was changed to answer every route a parcel might take, while its contract still promises the one route it was booked onto.',
    tree: dispatchTree(ts([
      'async dispatchParcel(parcelId: string): Promise<string[]> {',
      '  const routeId = `route-${parcelId}`;',
      '  this.store.record(parcelId, routeId);',
      '  return [routeId];',
      '}',
    ]), false),
  }),
  defineRuleFixture({
    code: 'RETURN_TYPE_MISMATCH',
    expectFire: false,
    reason: 'The function is annotated with the contract\'s own type: a promise of the one route id.',
    scenario: 'The dispatch orchestrator answers the route a parcel was booked onto, as its contract promises.',
    tree: dispatchTree(ts(TS_DISPATCH_BODY), false),
  }),
  defineRuleFixture({
    code: 'RETURN_TYPE_MISMATCH',
    severity: 'warning',
    anchoredTo: 'dispatch_orchestrator_impl',
    expectFire: true,
    scenario: 'The Python dispatch service was changed to answer a list of candidate routes, while its contract still promises one route id.',
    tree: dispatchTree(py([
      'async def dispatch_parcel(self, parcel_id: str) -> list[str]:',
      '    route_id = "route-" + parcel_id',
      '    self._store.record(parcel_id, route_id)',
      '    return [route_id]',
    ]), true),
  }),
  defineRuleFixture({
    code: 'RETURN_TYPE_MISMATCH',
    expectFire: false,
    reason: 'An `async def` annotated `-> str` is the contract\'s `async string`.',
    scenario: 'The Python dispatch service answers the one route id its contract promises.',
    tree: dispatchTree(py(PY_DISPATCH_BODY), true),
  }),

  // -------------------------------------------------------------------------
  // UNDECLARED_PUBLIC_MEMBER
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'UNDECLARED_PUBLIC_MEMBER',
    severity: 'warning',
    anchoredTo: 'dispatch_orchestrator_impl',
    expectFire: true,
    scenario: 'A cancel-every-booking method was added to the dispatch orchestrator\'s class in the code alone: public, called by nothing, declared by no contract.',
    tree: dispatchTree(ts([...TS_DISPATCH_BODY, '', 'cancelEveryBooking(): void {', '  void this.store;', '}']), false),
  }),
  defineRuleFixture({
    code: 'UNDECLARED_PUBLIC_MEMBER',
    expectFire: false,
    reason: 'The same helper is private: the class\'s own factoring, no surface any caller can reach.',
    scenario: 'The dispatch orchestrator keeps its booking clean-up as a private helper of the class.',
    tree: dispatchTree(ts([...TS_DISPATCH_BODY, '', 'private cancelEveryBooking(): void {', '  void this.store;', '}']), false),
  }),
  defineRuleFixture({
    code: 'UNDECLARED_PUBLIC_MEMBER',
    severity: 'warning',
    anchoredTo: 'dispatch_orchestrator_impl',
    expectFire: true,
    scenario: 'A purge-the-backlog function is exported from the dispatch orchestrator\'s module: no contract declares it and no file uses it.',
    tree: dispatchTree(ts(TS_DISPATCH_BODY, ['export function purgeBacklog(): number {', '  return 0;', '}', '']), false),
  }),
  defineRuleFixture({
    code: 'UNDECLARED_PUBLIC_MEMBER',
    expectFire: false,
    reason: 'A module helper the file does not export is the module\'s own factoring.',
    scenario: 'The dispatch orchestrator\'s module keeps its backlog purge as an unexported helper.',
    tree: dispatchTree(ts(TS_DISPATCH_BODY, ['function purgeBacklog(): number {', '  return 0;', '}', '']), false),
  }),
  defineRuleFixture({
    code: 'UNDECLARED_PUBLIC_MEMBER',
    severity: 'warning',
    anchoredTo: 'dispatch_orchestrator_impl',
    expectFire: true,
    scenario: 'The Python dispatch service grew a public purge method in the code alone, called by nothing and declared by no contract.',
    tree: dispatchTree(py([...PY_DISPATCH_BODY, '', 'def purge_backlog(self) -> None:', '    self._store = self._store']), true),
  }),
  defineRuleFixture({
    code: 'UNDECLARED_PUBLIC_MEMBER',
    expectFire: false,
    reason: 'A leading underscore is Python\'s private: the class\'s factoring, not its surface.',
    scenario: 'The Python dispatch service keeps its backlog purge as a private method.',
    tree: dispatchTree(py([...PY_DISPATCH_BODY, '', 'def _purge_backlog(self) -> None:', '    self._store = self._store']), true),
  }),

  // -------------------------------------------------------------------------
  // UNNARRATED_CALL
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'UNNARRATED_CALL',
    severity: 'warning',
    anchoredTo: 'dispatch_orchestrator_impl',
    expectFire: true,
    scenario: 'The dispatch orchestrator also reads back the parcel\'s earlier booking from the tracking store, which its narrative — the list of what it asks the store — never says.',
    tree: dispatchTree(ts([
      'async dispatchParcel(parcelId: string): Promise<string> {',
      '  const earlier = this.store.lookup(parcelId);',
      '  const routeId = earlier || `route-${parcelId}`;',
      '  this.store.record(parcelId, routeId);',
      '  return routeId;',
      '}',
    ]), false),
  }),
  defineRuleFixture({
    code: 'UNNARRATED_CALL',
    expectFire: false,
    reason: 'The narrative names the read-back as a step of its own.',
    scenario: 'The dispatch orchestrator reads back the parcel\'s earlier booking, and its narrative says so.',
    tree: dispatchTree(ts([
      'async dispatchParcel(parcelId: string): Promise<string> {',
      '  const earlier = this.store.lookup(parcelId);',
      '  const routeId = earlier || `route-${parcelId}`;',
      '  this.store.record(parcelId, routeId);',
      '  return routeId;',
      '}',
    ]), false, { narratesLookup: true }),
  }),
  defineRuleFixture({
    code: 'UNNARRATED_CALL',
    severity: 'warning',
    anchoredTo: 'dispatch_orchestrator_impl',
    expectFire: true,
    scenario: 'The Python dispatch service reads back the parcel\'s earlier booking through the store it was handed, which its narrative never says.',
    tree: dispatchTree(py([
      'async def dispatch_parcel(self, parcel_id: str) -> str:',
      '    earlier = self._store.lookup(parcel_id)',
      '    route_id = earlier or "route-" + parcel_id',
      '    self._store.record(parcel_id, route_id)',
      '    return route_id',
    ]), true),
  }),
  defineRuleFixture({
    code: 'UNNARRATED_CALL',
    expectFire: false,
    reason: 'The narrative names the read-back as a step of its own.',
    scenario: 'The Python dispatch service reads back the earlier booking, and its narrative says so.',
    tree: dispatchTree(py([
      'async def dispatch_parcel(self, parcel_id: str) -> str:',
      '    earlier = self._store.lookup(parcel_id)',
      '    route_id = earlier or "route-" + parcel_id',
      '    self._store.record(parcel_id, route_id)',
      '    return route_id',
    ]), true, { narratesLookup: true }),
  }),

  // -------------------------------------------------------------------------
  // ROUTES_UNCHECKED
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'ROUTES_UNCHECKED',
    severity: 'warning',
    anchoredTo: 'tracking_portal_impl',
    expectFire: true,
    scenario: 'The tracking portal\'s module holds the router that serves its HTTP routes, but its implementation never names it, so no route it serves is checked against the contract.',
    tree: trackingPortalTree(null),
  }),
  defineRuleFixture({
    code: 'ROUTES_UNCHECKED',
    expectFire: false,
    reason: 'The implementation names its router, so its routes are read against the contract.',
    scenario: 'The tracking portal names the router that serves its HTTP routes.',
    tree: trackingPortalTree('handleTrackingRequest'),
  }),

  // -------------------------------------------------------------------------
  // Python reaches the signature and import checks too
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'PARAM_NAME_MISMATCH',
    severity: 'warning',
    anchoredTo: 'dispatch_orchestrator_impl',
    expectFire: true,
    scenario: 'The Python dispatch service renamed its parcel argument to `parcel_ref` in the code alone; the contract and every brief still call it the parcel id.',
    tree: dispatchTree(py([
      'async def dispatch_parcel(self, parcel_ref: str) -> str:',
      '    route_id = "route-" + parcel_ref',
      '    self._store.record(parcel_ref, route_id)',
      '    return route_id',
    ]), true),
  }),
  defineRuleFixture({
    code: 'UNDECLARED_DEPENDENCY',
    severity: 'warning',
    expectFire: true,
    scenario: 'The Python dispatch service imports the tracking store\'s module although its design lists no dependency on the store.',
    tree: dispatchTree(py(PY_DISPATCH_BODY), true, { dependsOnStore: false }),
  }),

  // -------------------------------------------------------------------------
  // Round 2: an import running against a Portal's call edge is no mount
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'UNDECLARED_DEPENDENCY',
    severity: 'warning',
    anchoredTo: 'dispatch_orchestrator_impl',
    expectFire: true,
    scenario: 'The dispatch orchestrator imports the desk Portal that books parcels through it — the desk depends on and calls the orchestrator, so the import runs back against that edge.',
    tree: deskTree(ts(TS_DISPATCH_BODY, ['import { DispatchDesk } from \'./dispatch_desk.js\';', 'void DispatchDesk;', '']), false),
  }),
  defineRuleFixture({
    code: 'UNDECLARED_DEPENDENCY',
    expectFire: false,
    reason: 'The server is what the desk is mounted onto: the desk depends on it without calling it, so the server importing the desk to serve it is the mounting shape.',
    scenario: 'The dispatch server imports the desk Portal it serves; the desk declares it is mounted onto the server.',
    tree: deskTree(ts(TS_DISPATCH_BODY), false, { server: true }),
  }),
  defineRuleFixture({
    code: 'UNDECLARED_DEPENDENCY',
    severity: 'warning',
    anchoredTo: 'dispatch_orchestrator_impl',
    expectFire: true,
    scenario: 'The Python dispatch service imports the desk Portal module that calls it (`from .dispatch_desk import DispatchDesk`), a dependency its design does not list.',
    tree: deskTree(py(PY_DISPATCH_BODY, [], ['from .dispatch_desk import DispatchDesk', 'import requests']), true),
  }),
  defineRuleFixture({
    code: 'UNDECLARED_DEPENDENCY',
    expectFire: false,
    reason: 'Third-party and standard-library modules are no component; the Python server imports the desk it is mounted onto.',
    scenario: 'The Python dispatch service imports only `typing` and `requests`, and the server imports the desk Portal it serves.',
    tree: deskTree(py(PY_DISPATCH_BODY, [], ['import typing', 'import requests']), true, { server: true }),
  }),

  // -------------------------------------------------------------------------
  // Round 2: an unused exported class
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'UNDECLARED_PUBLIC_MEMBER',
    severity: 'warning',
    anchoredTo: 'dispatch_orchestrator_impl',
    expectFire: true,
    scenario: 'A test-only fake dispatcher class was appended to the dispatch orchestrator\'s module and exported: no contract declares it and nothing uses it.',
    tree: dispatchTree(ts(TS_DISPATCH_BODY, ['export class FakeDispatcher {', '  static create(): FakeDispatcher {', '    return new FakeDispatcher();', '  }', '', '  route(): string {', '    return \'route-0\';', '  }', '}', '']), false),
  }),
  defineRuleFixture({
    code: 'UNDECLARED_PUBLIC_MEMBER',
    expectFire: false,
    reason: 'The exported options class is the type of the orchestrator\'s own constructor parameter: its file uses it.',
    scenario: 'The dispatch orchestrator\'s module exports the options class its constructor takes.',
    tree: dispatchTree({
      orchestrator: [
        'import { TrackingStore } from \'./tracking-store.js\';',
        '',
        'export class DispatchOptions {',
        '  prefix = \'route-\';',
        '}',
        '',
        'export class DispatchOrchestrator {',
        '  constructor(private readonly store: TrackingStore, private readonly options: DispatchOptions = new DispatchOptions()) {}',
        '',
        '  async dispatchParcel(parcelId: string): Promise<string> {',
        '    const routeId = `${this.options.prefix}${parcelId}`;',
        '    this.store.record(parcelId, routeId);',
        '    return routeId;',
        '  }',
        '}',
        '',
      ].join('\n'),
      store: TS_STORE,
    }, false),
  }),
  defineRuleFixture({
    code: 'UNDECLARED_PUBLIC_MEMBER',
    severity: 'warning',
    anchoredTo: 'dispatch_orchestrator_impl',
    expectFire: true,
    scenario: 'A fake dispatcher class was appended to the Python dispatch service\'s module: public, declared by no contract and used by nothing.',
    tree: dispatchTree(py(PY_DISPATCH_BODY, ['class FakeDispatcher:', '    def route(self) -> str:', '        return "route-0"', '']), true),
  }),
  defineRuleFixture({
    code: 'UNDECLARED_PUBLIC_MEMBER',
    expectFire: false,
    reason: 'The error class is raised by the module\'s own dispatch method: its file uses it.',
    scenario: 'The Python dispatch service raises its own public error class when a parcel id is empty.',
    tree: dispatchTree(py([
      'async def dispatch_parcel(self, parcel_id: str) -> str:',
      '    if not parcel_id:',
      '        raise DispatchError("no parcel")',
      '    route_id = "route-" + parcel_id',
      '    self._store.record(parcel_id, route_id)',
      '    return route_id',
    ], ['class DispatchError(Exception):', '    pass', '']), true),
  }),
];
