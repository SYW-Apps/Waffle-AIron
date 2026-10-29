/**
 * Python code read for routes, data types and dependency realization: the
 * route decorators of FastAPI- and Flask-style router objects (with their
 * prefixes and includes) against a Portal's HTTP endpoints, the fields of
 * declarative data classes against a type spec's, and a declared edge between
 * two Python components realized by an import or by a call of the target's
 * contract.
 */
import { describe, expect, it } from 'vitest';
import { defineRuleFixture, runRuleFixture, type FixtureTree } from '../rules-matrix/harness.js';
import { dispatchTree, py, PY_DISPATCH_BODY, PY_STORE } from '../rules-matrix/families/conformance-surface-gaps.fixtures.js';

function run(tree: FixtureTree) {
  return runRuleFixture(defineRuleFixture({ code: 'UNREALIZED_DEPENDENCY', expectFire: false, reason: 'probe', scenario: 'A Python service the gate reads.', tree }));
}

function codes(tree: FixtureTree, wanted: readonly string[]): string[] {
  return run(tree).issues.filter(i => wanted.includes(i.code)).map(i => `${i.code}: ${i.message}`);
}

// ---- dependency realization ------------------------------------------------

const UNREALIZED = ['UNREALIZED_DEPENDENCY'];

/** The dispatch tree with the orchestrator's file replaced. */
function dispatchWith(orchestrator: string, extra: Record<string, string> = {}, storeFile?: string): FixtureTree {
  const tree = dispatchTree(py(PY_DISPATCH_BODY), true);
  tree.files!['src/dispatch/dispatch_orchestrator.py'] = orchestrator;
  if (storeFile) {
    delete tree.files!['src/dispatch/tracking_store.py'];
    tree.files![storeFile] = PY_STORE;
    const store = tree.implementations!.find(i => i.id === 'tracking_store_impl')!;
    store.sourcePath = storeFile;
  }
  Object.assign(tree.files!, extra);
  return tree;
}

describe('a declared Python edge is judged for realization', () => {
  it('reports an edge no import and no contract call realizes', () => {
    const found = codes(dispatchWith([
      'class DispatchOrchestrator:',
      '    async def dispatch_parcel(self, parcel_id: str) -> str:',
      '        return "route-" + parcel_id',
      '',
    ].join('\n')), UNREALIZED);
    expect(found).toHaveLength(1);
    expect(found[0]).toContain('"dispatch-orchestrator" declares dependsOn "tracking-store"');
    expect(found[0]).toContain('none of them calls a method of its contract');
  });

  it('accepts the import of the target\'s module', () => {
    expect(codes(dispatchTree(py(PY_DISPATCH_BODY), true), UNREALIZED)).toEqual([]);
  });

  it('accepts a call of the target\'s contract through a collaborator typed by a Protocol', () => {
    expect(codes(dispatchWith([
      'from typing import Protocol',
      '',
      '',
      'class BookingSink(Protocol):',
      '    def record(self, parcel_id: str, route_id: str) -> None: ...',
      '',
      '',
      'class DispatchOrchestrator:',
      '    def __init__(self, sink: BookingSink) -> None:',
      '        self._sink = sink',
      '',
      '    async def dispatch_parcel(self, parcel_id: str) -> str:',
      '        route_id = "route-" + parcel_id',
      '        self._sink.record(parcel_id, route_id)',
      '        return route_id',
      '',
    ].join('\n')), UNREALIZED)).toEqual([]);
  });

  it('accepts an import of the package holding the target, whose __init__.py no component realizes', () => {
    expect(codes(dispatchWith([
      'from .storage import TrackingStore',
      '',
      '',
      'class DispatchOrchestrator:',
      '    def __init__(self, store: "TrackingStore") -> None:',
      '        self._store = store',
      '',
      '    async def dispatch_parcel(self, parcel_id: str) -> str:',
      '        return "route-" + parcel_id',
      '',
    ].join('\n'), { 'src/dispatch/storage/__init__.py': 'from .tracking_store import TrackingStore\n' }, 'src/dispatch/storage/tracking_store.py'), UNREALIZED)).toEqual([]);
  });

  it('does not read a bare `from . import` as reaching every sibling', () => {
    const found = codes(dispatchWith([
      'from . import helpers',
      '',
      '',
      'class DispatchOrchestrator:',
      '    async def dispatch_parcel(self, parcel_id: str) -> str:',
      '        return helpers.route_for(parcel_id)',
      '',
    ].join('\n'), { 'src/dispatch/helpers.py': 'def route_for(parcel_id: str) -> str:\n    return "route-" + parcel_id\n' }), UNREALIZED);
    expect(found).toHaveLength(1);
  });
});

// ---- routes ----------------------------------------------------------------

const ROUTE_CODES = ['UNDECLARED_ROUTE', 'UNROUTED_ENDPOINT', 'UNREADABLE_ROUTER', 'ROUTES_UNCHECKED', 'ROUTER_UNDECLARED'];

/** An orders Portal over HTTP whose implementation lives in the given files. */
function ordersPortal(files: Record<string, string>, opts: { router?: string; sourcePath?: string; methodPath?: string } = {}): FixtureTree {
  const sourcePath = opts.sourcePath ?? 'src/orders/api.py';
  return {
    system: { targetLanguage: 'python' },
    subsystems: [{ id: 'ordering', description: 'Takes and answers orders.' }],
    components: [{
      id: 'orders-portal', componentType: 'Portal', transport: 'HTTP',
      description: 'Answers order requests over HTTP.',
      invokedBy: { kind: 'entry', caller: 'the shop front end' },
    }],
    interfaces: [{
      id: 'iorders_portal',
      component: 'orders-portal',
      methods: [
        { name: 'get_order', description: 'Answer one order.', signature: 'get_order(order_id: string): string', returns: 'string', params: [{ name: 'order_id', type: 'string' }], endpoint: { transport: 'HTTP', method: 'GET', path: '/orders/{order_id}' } },
        { name: 'place_order', description: 'Place an order.', signature: 'place_order(): string', returns: 'string', params: [], endpoint: { transport: 'HTTP', method: 'POST', path: '/orders' } },
      ],
    }],
    implementations: [{
      id: 'orders_portal_impl',
      contract: 'iorders_portal',
      sourcePath,
      ...(opts.router ? { router: opts.router } : {}),
      methods: [
        { name: 'get_order', ...(opts.methodPath ? { sourcePath: opts.methodPath } : {}), narrative: [{ stepNumber: 1, type: 'return', outcome: 'success', description: 'Answer the order.' }] },
        { name: 'place_order', ...(opts.methodPath ? { sourcePath: opts.methodPath } : {}), narrative: [{ stepNumber: 1, type: 'return', outcome: 'success', description: 'Answer the new order id.' }] },
      ],
    }],
    files: { 'src/orders/__init__.py': '', ...files },
  };
}

const FASTAPI = (extra: string[] = []): string => [
  'from fastapi import APIRouter, FastAPI',
  '',
  'app = FastAPI()',
  'router = APIRouter(prefix="/orders")',
  '',
  '',
  '@router.get("/{order_id}")',
  'def get_order(order_id: str) -> str:',
  '    return order_id',
  '',
  '',
  '@router.post("")',
  'def place_order() -> str:',
  '    return "new"',
  '',
  ...extra,
  '',
  'app.include_router(router)',
  '',
].join('\n');

describe('Python routes are read off route decorators', () => {
  it('matches a FastAPI router included under its prefix with the contract', () => {
    expect(codes(ordersPortal({ 'src/orders/api.py': FASTAPI() }, { router: 'app' }), ROUTE_CODES)).toEqual([]);
  });

  it('reports a route no endpoint declares', () => {
    const found = codes(ordersPortal({ 'src/orders/api.py': FASTAPI(['', '@router.delete("/{order_id}")', 'def cancel_order(order_id: str) -> None:', '    pass', '']) }, { router: 'app' }), ROUTE_CODES);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatch(/^UNDECLARED_ROUTE: .*DELETE/);
  });

  it('reports an endpoint no route answers', () => {
    const code = FASTAPI().replace('@router.post("")', '@router.put("")');
    const found = codes(ordersPortal({ 'src/orders/api.py': code }, { router: 'router' }), ROUTE_CODES);
    expect(found.map(f => f.split(':')[0]).sort()).toEqual(['UNDECLARED_ROUTE', 'UNROUTED_ENDPOINT']);
  });

  it('follows an include of a router another module constructs, under the include\'s prefix', () => {
    const tree = ordersPortal({
      'src/orders/main.py': ['from fastapi import FastAPI', 'from .routes import router as orders_router', '', 'app = FastAPI()', 'app.include_router(orders_router, prefix="/orders")', ''].join('\n'),
      'src/orders/routes.py': ['from fastapi import APIRouter', '', 'router = APIRouter()', '', '', '@router.get("/{order_id}")', 'def get_order(order_id: str) -> str:', '    return order_id', '', '', '@router.post("/")', 'def place_order() -> str:', '    return "new"', ''].join('\n'),
    }, { router: 'app', sourcePath: 'src/orders/main.py', methodPath: 'src/orders/routes.py' });
    expect(codes(tree, ROUTE_CODES)).toEqual([]);
  });

  it('reads a Flask blueprint, its url_prefix and its methods list', () => {
    const tree = ordersPortal({
      'src/orders/api.py': [
        'from flask import Blueprint',
        '',
        'PREFIX = "/orders"',
        'bp = Blueprint("orders", __name__, url_prefix=PREFIX)',
        '',
        '',
        '@bp.route("/<int:order_id>")',
        'def get_order(order_id: int) -> str:',
        '    return str(order_id)',
        '',
        '',
        '@bp.route("", methods=["POST"])',
        'def place_order() -> str:',
        '    return "new"',
        '',
      ].join('\n'),
    }, { router: 'bp' });
    expect(codes(tree, ROUTE_CODES)).toEqual([]);
  });

  it('reports a router whose path does not settle as unread, never as partly read', () => {
    const code = FASTAPI(['', 'BASE = "/x" + "/y"', '', '@router.get(BASE)', 'def other() -> str:', '    return ""', '']);
    const found = codes(ordersPortal({ 'src/orders/api.py': code }, { router: 'router' }), ROUTE_CODES);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatch(/^UNREADABLE_ROUTER: .*cannot settle/);
  });

  it('reports a router that mounts an application as unread', () => {
    const code = FASTAPI(['', 'app.mount("/static", object())']);
    const found = codes(ordersPortal({ 'src/orders/api.py': code }, { router: 'app' }), ROUTE_CODES);
    expect(found.map(f => f.split(':')[0])).toEqual(['UNREADABLE_ROUTER']);
  });

  it('says ROUTES_UNCHECKED for a Python Portal naming no router while its file holds one', () => {
    const found = codes(ordersPortal({ 'src/orders/api.py': FASTAPI() }), ROUTE_CODES);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatch(/^ROUTES_UNCHECKED: .*app \(src\/orders\/api\.py\).*router \(src\/orders\/api\.py\)/);
  });
});

// ---- data types ------------------------------------------------------------

const TYPE_CODES = ['UNREALIZED_TYPE_FIELD', 'UNDECLARED_TYPE_FIELD', 'TYPE_FIELD_OPTIONALITY'];

function typed(code: string, fields: Array<{ name: string; type?: string; optional?: boolean }>, name = 'Order'): FixtureTree {
  return {
    system: { targetLanguage: 'python' },
    subsystems: [{ id: 'ordering', description: 'Takes and answers orders.' }],
    components: [{ id: 'order-desk', componentType: 'Orchestrator', description: 'Takes orders.', invokedBy: { kind: 'entry', caller: 'the shop' } }],
    interfaces: [{ id: 'iorder_desk', component: 'order-desk', methods: [{ name: 'take', description: 'Take an order.', signature: 'take(): void', returns: 'void', params: [] }] }],
    implementations: [{ id: 'order_desk_impl', contract: 'iorder_desk', sourcePath: 'src/orders/desk.py', methods: [{ name: 'take', detail: 'intent', narrative: [], intent: 'Takes an order; it never fails.' }] }],
    types: [{ id: name.toLowerCase(), name, kind: 'value-object', sourcePath: 'src/orders/models.py', fields: fields.map(f => ({ type: 'string', optional: false, ...f })) }],
    files: {
      'src/orders/__init__.py': '',
      'src/orders/desk.py': 'def take() -> None:\n    pass\n',
      'src/orders/models.py': code,
    },
  };
}

describe('Python data types are read off declarative classes', () => {
  const DATACLASS = [
    'from dataclasses import dataclass, field',
    'from typing import ClassVar',
    '',
    '',
    '@dataclass(frozen=True)',
    'class Order:',
    '    """One order."""',
    '    order_id: str',
    '    note: str = ""',
    '    tags: list[str] = field(default_factory=list)',
    '    total: int = field()',
    '    KIND: ClassVar[str] = "order"',
    '',
    '    def summary(self) -> str:',
    '        return self.order_id',
    '',
  ].join('\n');

  it('agrees with a dataclass whose fields, defaults and field calls match, its names by nameKey', () => {
    expect(codes(typed(DATACLASS, [
      { name: 'orderId' }, { name: 'note', optional: true }, { name: 'tags', type: 'list<string>', optional: true }, { name: 'total', type: 'int' },
    ]), TYPE_CODES)).toEqual([]);
  });

  it('reports a field the dataclass lacks, one it carries, and an optionality disagreement', () => {
    const found = codes(typed(DATACLASS, [
      { name: 'orderId', optional: true }, { name: 'note', optional: true }, { name: 'tags', optional: true }, { name: 'currency' },
    ]), TYPE_CODES).map(f => f.split(':')[0]).sort();
    expect(found).toEqual(['TYPE_FIELD_OPTIONALITY', 'UNDECLARED_TYPE_FIELD', 'UNREALIZED_TYPE_FIELD']);
  });

  it('reads a Pydantic model: Field(...) required, Field(None) absent-able, Optional alone required', () => {
    const code = [
      'from typing import Optional',
      'from pydantic import BaseModel, Field',
      '',
      '',
      'class Order(BaseModel):',
      '    order_id: str = Field(...)',
      '    note: Optional[str] = Field(None)',
      '    coupon: Optional[str]',
      '    _cache: dict = {}',
      '',
    ].join('\n');
    expect(codes(typed(code, [{ name: 'orderId' }, { name: 'note', optional: true }, { name: 'coupon' }]), TYPE_CODES)).toEqual([]);
    const found = codes(typed(code, [{ name: 'orderId' }, { name: 'note', optional: true }, { name: 'coupon', optional: true }]), TYPE_CODES);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatch(/^TYPE_FIELD_OPTIONALITY: .*"coupon"/);
  });

  it('reads a TypedDict: total=False, Required and NotRequired', () => {
    const code = [
      'from typing import TypedDict',
      'from typing_extensions import NotRequired, Required',
      '',
      '',
      'class Order(TypedDict, total=False):',
      '    order_id: Required[str]',
      '    note: str',
      '',
      '',
      'class Line(TypedDict):',
      '    sku: str',
      '    qty: NotRequired[int]',
      '',
    ].join('\n');
    expect(codes(typed(code, [{ name: 'orderId' }, { name: 'note', optional: true }]), TYPE_CODES)).toEqual([]);
    expect(codes(typed(code, [{ name: 'sku' }, { name: 'qty', optional: true }], 'Line'), TYPE_CODES)).toEqual([]);
  });

  it('judges a subclass of a model as extending another: what it shows, never what it omits', () => {
    const code = [
      'from pydantic import BaseModel',
      '',
      '',
      'class Base(BaseModel):',
      '    created_at: str',
      '',
      '',
      'class Order(Base):',
      '    order_id: str',
      '',
    ].join('\n');
    expect(codes(typed(code, [{ name: 'orderId' }, { name: 'createdAt' }]), TYPE_CODES)).toEqual([]);
  });

  it('stays silent on a plain class', () => {
    const code = ['class Order:', '    def __init__(self, order_id: str) -> None:', '        self.order_id = order_id', ''].join('\n');
    expect(codes(typed(code, [{ name: 'orderId' }, { name: 'currency' }]), TYPE_CODES)).toEqual([]);
  });
});

describe('the code reading says Python routes and data types are checked', () => {
  it('names them among what Python was checked for', () => {
    const { result } = run(ordersPortal({ 'src/orders/api.py': FASTAPI() }, { router: 'app' }));
    expect(result.codeReading).toMatch(/python: .*routes.*data types \(of declarative data classes\)/);
    expect(result.codeReading).not.toMatch(/not checked: [^.]*routes/);
  });
});
