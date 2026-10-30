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
import { foreignCallTree } from '../rules-matrix/families/conformance-foreign-call.fixtures.js';

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

// ---- 6.6.0: attrs, Field(default=...), TypedDict totals, colliding names ----------

describe('Python data types: attrs forms, the Ellipsis default, unsettled totals and colliding names', () => {
  it('reads only the attr.ib() fields of a legacy @attr.s class, annotations too once auto_attribs is True', () => {
    const legacy = [
      'import attr',
      '',
      '',
      '@attr.s',
      'class Order:',
      '    order_id: str = attr.ib()',
      '    note: str = ""',
      '    legacy = attr.ib(default=1)',
      '',
    ].join('\n');
    // `note` is an annotated plain attribute: no field of a legacy class.
    expect(codes(typed(legacy, [{ name: 'orderId' }, { name: 'legacy', optional: true }]), TYPE_CODES)).toEqual([]);
    const found = codes(typed(legacy, [{ name: 'orderId' }, { name: 'note', optional: true }, { name: 'legacy', optional: true }]), TYPE_CODES);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatch(/^UNREALIZED_TYPE_FIELD: .*"note"/);
    const auto = legacy.replace('@attr.s', '@attr.s(auto_attribs=True)');
    expect(codes(typed(auto, [{ name: 'orderId' }, { name: 'note', optional: true }, { name: 'legacy', optional: true }]), TYPE_CODES)).toEqual([]);
  });

  it('keeps the annotations of attrs.define unless auto_attribs is False', () => {
    const define = ['import attrs', '', '', '@attrs.define', 'class Order:', '    order_id: str', '    note: str = ""', ''].join('\n');
    expect(codes(typed(define, [{ name: 'orderId' }, { name: 'note', optional: true }]), TYPE_CODES)).toEqual([]);
    const off = define.replace('@attrs.define', '@attrs.define(auto_attribs=False)');
    const found = codes(typed(off, [{ name: 'orderId' }, { name: 'note', optional: true }]), TYPE_CODES);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatch(/^UNREALIZED_TYPE_FIELD: .*"orderId".*"note"/);
  });

  it('reads Field(default=...) as required, as Field(...) is, and Field(default=None) as absent-able', () => {
    const code = [
      'from typing import Optional',
      'from pydantic import BaseModel, Field',
      '',
      '',
      'class Order(BaseModel):',
      '    order_id: str = Field(default=...)',
      '    note: Optional[str] = Field(default=None)',
      '    tag: str = Field(default_factory=str)',
      '',
    ].join('\n');
    expect(codes(typed(code, [{ name: 'orderId' }, { name: 'note', optional: true }, { name: 'tag', optional: true }]), TYPE_CODES)).toEqual([]);
    const found = codes(typed(code, [{ name: 'orderId', optional: true }, { name: 'note', optional: true }, { name: 'tag', optional: true }]), TYPE_CODES);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatch(/^TYPE_FIELD_OPTIONALITY: .*"orderId"/);
  });

  it('records no absence for a TypedDict field whose total= does not settle, and compares nothing about it', () => {
    const unsettled = [
      'from typing import TypedDict',
      'from typing_extensions import NotRequired',
      '',
      'PARTIAL = bool(0)',
      '',
      '',
      'class Order(TypedDict, total=PARTIAL):',
      '    order_id: str',
      '    qty: NotRequired[int]',
      '',
    ].join('\n');
    // order_id is required in the spec, qty absent-able: only the explicitly marked field is compared.
    expect(codes(typed(unsettled, [{ name: 'orderId' }, { name: 'qty', optional: true }]), TYPE_CODES)).toEqual([]);
    expect(codes(typed(unsettled, [{ name: 'orderId', optional: true }, { name: 'qty', optional: true }]), TYPE_CODES)).toEqual([]);
    const found = codes(typed(unsettled, [{ name: 'orderId' }, { name: 'qty' }]), TYPE_CODES);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatch(/^TYPE_FIELD_OPTIONALITY: .*"qty"/);
    // Control: a literal total=False settles the same field.
    const literal = unsettled.replace('total=PARTIAL', 'total=False');
    const settled = codes(typed(literal, [{ name: 'orderId' }, { name: 'qty', optional: true }]), TYPE_CODES);
    expect(settled).toHaveLength(1);
    expect(settled[0]).toMatch(/^TYPE_FIELD_OPTIONALITY: .*"orderId"/);
  });

  it('compares the field spelled exactly as the spec spells it when two fields share a name key, neither when none is', () => {
    const code = ['from dataclasses import dataclass', '', '', '@dataclass', 'class Order:', '    order_id: str', '    orderId: str = ""', ''].join('\n');
    // `orderId` is the exact spelling: absent-able in the code.
    expect(codes(typed(code, [{ name: 'orderId', optional: true }]), ['TYPE_FIELD_OPTIONALITY'])).toEqual([]);
    const found = codes(typed(code, [{ name: 'orderId' }]), ['TYPE_FIELD_OPTIONALITY']);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatch(/"orderId"/);
    // No exact spelling among the two: ambiguous, so nothing is compared.
    expect(codes(typed(code, [{ name: 'ORDERID', optional: true }]), ['TYPE_FIELD_OPTIONALITY'])).toEqual([]);
    expect(codes(typed(code, [{ name: 'ORDERID' }]), ['TYPE_FIELD_OPTIONALITY'])).toEqual([]);
  });
});

// ---- 6.6.0: routers through packages, converters, imported routers -----------------

const ROUTER_MODULE = [
  'from fastapi import APIRouter',
  '',
  'router = APIRouter()',
  '',
  '',
  '@router.get("/{order_id}")',
  'def get_order(order_id: str) -> str:',
  '    return order_id',
  '',
  '',
  '@router.post("/")',
  'def place_order() -> str:',
  '    return "new"',
  '',
].join('\n');

const MAIN_INCLUDING = (import_: string, include: string): string => [
  'from fastapi import FastAPI',
  import_,
  '',
  'app = FastAPI()',
  `app.include_router(${include}, prefix="/orders")`,
  '',
].join('\n');

describe('Python includes are followed through a package __init__ that re-exports the router', () => {
  // The package files no spec names are read because the project walks its source root.
  const tree = (files: Record<string, string>, methodPath: string): FixtureTree =>
    ({ ...ordersPortal(files, { router: 'app', sourcePath: 'src/orders/main.py', methodPath }), rules: { conformance: { sourceRoots: ['src'] } } });

  it('follows a name the package re-exports from the module building it', () => {
    expect(codes(tree({
      'src/orders/main.py': MAIN_INCLUDING('from .routers import orders_router', 'orders_router'),
      'src/orders/routers/__init__.py': 'from .orders import router as orders_router\n',
      'src/orders/routers/orders.py': ROUTER_MODULE,
    }, 'src/orders/routers/orders.py'), ROUTE_CODES)).toEqual([]);
  });

  it('follows two hops of re-exports', () => {
    expect(codes(tree({
      'src/orders/main.py': MAIN_INCLUDING('from .routers import orders_router', 'orders_router'),
      'src/orders/routers/__init__.py': 'from .v1 import orders_router\n',
      'src/orders/routers/v1/__init__.py': 'from .orders import router as orders_router\n',
      'src/orders/routers/v1/orders.py': ROUTER_MODULE,
    }, 'src/orders/routers/v1/orders.py'), ROUTE_CODES)).toEqual([]);
  });

  it('follows the namespace form through the package', () => {
    expect(codes(tree({
      'src/orders/main.py': MAIN_INCLUDING('from . import routers', 'routers.orders_router'),
      'src/orders/routers/__init__.py': 'from .orders import router as orders_router\n',
      'src/orders/routers/orders.py': ROUTER_MODULE,
    }, 'src/orders/routers/orders.py'), ROUTE_CODES)).toEqual([]);
  });

  it('leaves an include unread when the re-exports form a cycle, and does not hang', () => {
    const found = codes(tree({
      'src/orders/main.py': MAIN_INCLUDING('from .alpha import orders_router', 'orders_router'),
      'src/orders/alpha.py': 'from .beta import orders_router\n',
      'src/orders/beta.py': 'from .alpha import orders_router\n',
    }, 'src/orders/main.py'), ROUTE_CODES);
    expect(found.map(f => f.split(':')[0])).toEqual(['UNREADABLE_ROUTER']);
  });
});

describe('Python routers: an imported router object that cannot be settled is unread at home', () => {
  const home = (extra: string[]): FixtureTree => ({ ...ordersPortal({
    'src/orders/routes.py': ['from fastapi import APIRouter', '', 'router = APIRouter(prefix="/orders")', '', '', '@router.get("/{order_id}")', 'def get_order(order_id: str) -> str:', '    return order_id', '', '', '@router.post("")', 'def place_order() -> str:', '    return "new"', ''].join('\n'),
    'src/orders/extra.py': ['from .routes import router', '', ...extra, ''].join('\n'),
  }, { router: 'src/orders/routes.py#router', sourcePath: 'src/orders/routes.py' }), rules: { conformance: { sourceRoots: ['src'] } } });

  it('reports the object unread in its own module when another module adds a route that does not settle', () => {
    const found = codes(home(['router.add_api_route("/x", lambda: "x")']), ROUTE_CODES);
    expect(found.map(f => f.split(':')[0])).toEqual(['UNREADABLE_ROUTER']);
  });

  it('reads it as before when what the other module adds settles', () => {
    expect(codes(home(['@router.get("/{order_id}/lines")', 'def lines(order_id: str) -> str:', '    return order_id']), ['UNREADABLE_ROUTER'])).toEqual([]);
  });
});

describe('Python routers: a path converter followed by more segments', () => {
  const fastapi = (path: string): string => FASTAPI(['', `@router.get("${path}")`, 'def files(rest: str) -> str:', '    return rest', '']);

  it('leaves a FastAPI router unread when segments follow the converter', () => {
    const found = codes(ordersPortal({ 'src/orders/api.py': fastapi('/files/{rest:path}/edit') }, { router: 'router' }), ROUTE_CODES);
    expect(found.map(f => f.split(':')[0])).toEqual(['UNREADABLE_ROUTER']);
  });

  it('still reads a converter that closes the path', () => {
    expect(codes(ordersPortal({ 'src/orders/api.py': fastapi('/files/{rest:path}') }, { router: 'router' }), ['UNREADABLE_ROUTER'])).toEqual([]);
  });

  it('leaves a Flask blueprint unread the same way', () => {
    const flask = (path: string): string => ['from flask import Blueprint', '', 'bp = Blueprint("orders", __name__, url_prefix="/orders")', '', '', `@bp.route("${path}")`, 'def files(rest: str) -> str:', '    return rest', ''].join('\n');
    expect(codes(ordersPortal({ 'src/orders/api.py': flask('/<path:rest>/edit') }, { router: 'bp' }), ['UNREADABLE_ROUTER'])).toHaveLength(1);
    expect(codes(ordersPortal({ 'src/orders/api.py': flask('/<path:rest>') }, { router: 'bp' }), ['UNREADABLE_ROUTER'])).toEqual([]);
  });
});

// ---- 6.6.0: guard-style routers --------------------------------------------------

describe('Python guard functions are read as routers', () => {
  const guard = (body: string[], router = 'handle', paths?: { get?: string; post?: string }): FixtureTree => {
    const tree = ordersPortal({ 'src/orders/api.py': body.join('\n') }, { router });
    const methods = tree.interfaces![0].methods as Array<{ endpoint: { path: string } }>;
    if (paths?.get) methods[0].endpoint.path = paths.get;
    if (paths?.post) methods[1].endpoint.path = paths.post;
    return tree;
  };

  it('reads if chains: a method comparison joined with a prefix test and a constant path', () => {
    const body = [
      'ORDERS = "/orders"',
      '',
      '',
      'def handle(request) -> str:',
      '    method = request.method',
      '    path = request.path',
      '    if method == "GET" and path.startswith("/orders/"):',
      '        return "one"',
      '    if method == "POST" and path == ORDERS:',
      '        return "new"',
      '    return "missing"',
      '',
    ];
    expect(codes(guard(body), ROUTE_CODES)).toEqual([]);
    const extra = [...body.slice(0, -2), '    if method == "DELETE" and path == "/orders":', '        return "gone"', '    return "missing"', ''];
    const found = codes(guard(extra), ROUTE_CODES);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatch(/^UNDECLARED_ROUTE: .*DELETE/);
  });

  it('reads split segments with len() and index comparisons', () => {
    const body = [
      'def handle(request) -> str:',
      '    method = request.method',
      '    parts = request.path.strip("/").split("/")',
      '    if method == "GET" and len(parts) == 2 and parts[0] == "orders":',
      '        return parts[1]',
      '    if method == "POST" and len(parts) == 1 and parts[0] == "orders":',
      '        return "new"',
      '    return ""',
      '',
    ];
    expect(codes(guard(body), ROUTE_CODES)).toEqual([]);
    const found = codes(guard(body.map(l => l.replace('len(parts) == 1', 'len(parts) == 3'))), ROUTE_CODES);
    expect(found.map(f => f.split(':')[0]).sort()).toEqual(['UNDECLARED_ROUTE', 'UNROUTED_ENDPOINT']);
  });

  it('gives a branch the conditions of the branches enclosing it, an else none of them', () => {
    const body = [
      'def handle(request) -> str:',
      '    method = request.method',
      '    path = request.path',
      '    if method == "GET":',
      '        if path == "/health":',
      '            return "ok"',
      '    else:',
      '        if path == "/status":',
      '            return "ok"',
      '    return ""',
      '',
    ];
    const found = codes(guard(body), ['UNDECLARED_ROUTE']);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatch(/GET \/health/);
  });

  it('answers a route for each verb of a method list', () => {
    const body = ['def handle(request) -> str:', '    method = request.method', '    path = request.path', '    if method in ("GET", "HEAD") and path == "/health":', '        return "ok"', '    return ""', ''];
    const found = codes(guard(body), ['UNDECLARED_ROUTE']).join('\n');
    expect(found).toMatch(/GET \/health/);
    expect(found).toMatch(/HEAD \/health/);
  });

  it('reads a match over (method, path) with string cases', () => {
    const body = [
      'def handle(request) -> str:',
      '    match (request.method, request.path):',
      '        case ("GET", "/orders/latest"):',
      '            return "latest"',
      '        case ("POST", "/orders"):',
      '            return "new"',
      '    return ""',
      '',
    ];
    expect(codes(guard(body, 'handle', { get: '/orders/latest' }), ROUTE_CODES)).toEqual([]);
    const found = codes(guard(body.map(l => l.replace('"/orders"', '"/orders/other"')), 'handle', { get: '/orders/latest' }), ROUTE_CODES);
    expect(found.map(f => f.split(':')[0]).sort()).toEqual(['UNDECLARED_ROUTE', 'UNROUTED_ENDPOINT']);
  });

  it('reads a match over the path under a method guard', () => {
    const body = [
      'def handle(request) -> str:',
      '    if request.method == "POST":',
      '        match request.path:',
      '            case "/orders":',
      '                return "new"',
      '    elif request.method == "GET":',
      '        match request.path:',
      '            case "/orders/latest" | "/orders/oldest":',
      '                return "one"',
      '    return ""',
      '',
    ];
    const found = codes(guard(body, 'handle', { get: '/orders/latest' }), ROUTE_CODES).join('\n');
    expect(found).toMatch(/UNDECLARED_ROUTE: .*GET \/orders\/oldest/);
    expect(found).not.toMatch(/UNROUTED_ENDPOINT/);
  });

  it('reads a dict keyed by (method, path) whose values are handlers', () => {
    const body = [
      'def latest() -> str:',
      '    return "latest"',
      '',
      '',
      'def place() -> str:',
      '    return "new"',
      '',
      '',
      'ROUTES = {',
      '    ("GET", "/orders/latest"): latest,',
      '    ("POST", "/orders"): place,',
      '}',
      '',
      '',
      'def handle(request) -> str:',
      '    return ROUTES[(request.method, request.path)]()',
      '',
    ];
    expect(codes(guard(body, 'handle', { get: '/orders/latest' }), ROUTE_CODES)).toEqual([]);
    const found = codes(guard([...body.slice(0, 11), '    ("DELETE", "/orders"): latest,', ...body.slice(11)], 'handle', { get: '/orders/latest' }), ROUTE_CODES);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatch(/^UNDECLARED_ROUTE: .*DELETE/);
  });

  it('reads an anchored raw regular expression through re.match and re.fullmatch', () => {
    const body = [
      'import re',
      '',
      '',
      'def handle(request) -> str:',
      '    method = request.method',
      '    path = request.path',
      '    if method == "GET" and re.match(r"^/orders/(\\d+)$", path):',
      '        return "one"',
      '    if method == "POST" and re.fullmatch(r"/orders", path):',
      '        return "new"',
      '    return ""',
      '',
    ];
    expect(codes(guard(body), ROUTE_CODES)).toEqual([]);
    const found = codes(guard(body.map(l => l.replace('re.fullmatch(r"/orders", path)', 're.fullmatch(r"/orders/new", path)'))), ROUTE_CODES);
    expect(found.map(f => f.split(':')[0]).sort()).toEqual(['UNDECLARED_ROUTE', 'UNROUTED_ENDPOINT']);
  });

  it('takes the verb of a do_GET method of a BaseHTTPRequestHandler subclass from its name, named Class.do_GET', () => {
    const body = [
      'from http.server import BaseHTTPRequestHandler',
      '',
      '',
      'class Handler(BaseHTTPRequestHandler):',
      '    def do_GET(self) -> None:',
      '        if self.path.startswith("/orders/"):',
      '            self.wfile.write(b"one")',
      '',
      '    def do_POST(self) -> None:',
      '        if self.path == "/orders":',
      '            self.wfile.write(b"new")',
      '',
    ];
    // do_GET alone answers the GET endpoint; the POST endpoint is not its to answer.
    const found = codes(guard(body, 'Handler.do_GET'), ROUTE_CODES);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatch(/^UNROUTED_ENDPOINT: .*POST/);
    expect(codes(guard(body, 'Handler.do_POST'), ROUTE_CODES).join('\n')).toMatch(/UNROUTED_ENDPOINT: .*GET/);
  });

  it('lists a function whose path comparison does not settle as unread, never as a part of its routes', () => {
    const body = (path: string): string[] => [
      'def compute() -> str:',
      '    return "/orders"',
      '',
      '',
      'def handle(request) -> str:',
      '    method = request.method',
      '    path = request.path',
      `    if method == "POST" and path == ${path}:`,
      '        return "new"',
      '    return ""',
      '',
    ];
    const found = codes(guard(body('compute()')), ROUTE_CODES);
    expect(found.map(f => f.split(':')[0])).toEqual(['UNREADABLE_ROUTER']);
    expect(codes(guard(body('"/orders"')), ['UNREADABLE_ROUTER'])).toEqual([]);
  });

  it('reads a startswith prefix only when it ends on a segment boundary', () => {
    const body = (prefix: string): string[] => [
      'def handle(request) -> str:',
      '    method = request.method',
      '    path = request.path',
      `    if method == "GET" and path.startswith("${prefix}"):`,
      '        return "one"',
      '    if method == "POST" and path == "/orders":',
      '        return "new"',
      '    return ""',
      '',
    ];
    // "/orders/" is a whole-segment prefix: open-ended under /orders.
    expect(codes(guard(body('/orders/')), ROUTE_CODES)).toEqual([]);
    // "/order" also matches "/orders": it is no literal segment, so the function is unread, never a route.
    expect(codes(guard(body('/order')), ROUTE_CODES).map(f => f.split(':')[0])).toEqual(['UNREADABLE_ROUTER']);
  });

  it('names a guard function among the routers a Portal naming none could name', () => {
    const body = ['def handle(request) -> str:', '    if request.method == "GET" and request.path == "/health":', '        return "ok"', '    return ""', ''];
    const found = codes(guard(body, ''), ROUTE_CODES);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatch(/^ROUTES_UNCHECKED: .*handle \(src\/orders\/api\.py\)/);
  });
});

// ---- 6.6.0: calls --------------------------------------------------------------------

const COLOCATED = ['UNDECLARED_COLOCATED_CALL'];

/** Three components in one Python file: a desk that takes orders, a ledger it may record in, an audit it may call. */
function colocated(body: string[], narrative: object[] = []): FixtureTree {
  return {
    system: { targetLanguage: 'python' },
    subsystems: [{ id: 'ordering', description: 'Takes orders and keeps their ledger.' }],
    components: [
      { id: 'order-desk', componentType: 'Orchestrator', description: 'Takes orders.', dependsOn: ['order-ledger', 'order-audit'], invokedBy: { kind: 'entry', caller: 'the shop' } },
      { id: 'order-ledger', componentType: 'Orchestrator', description: 'Keeps the order ledger.' },
      { id: 'order-audit', componentType: 'Orchestrator', description: 'Audits orders.' },
    ],
    interfaces: [
      { id: 'iorder_desk', component: 'order-desk', methods: [{ name: 'take', description: 'Take an order.', signature: 'take(order_id: string): void', returns: 'void', params: [{ name: 'order_id', type: 'string' }] }] },
      { id: 'iorder_ledger', component: 'order-ledger', methods: [{ name: 'record', description: 'Record an order.', signature: 'record(order_id: string): void', returns: 'void', params: [{ name: 'order_id', type: 'string' }], effect: 'write' }] },
      { id: 'iorder_audit', component: 'order-audit', methods: [{ name: 'audit', description: 'Audit an order.', signature: 'audit(order_id: string): void', returns: 'void', params: [{ name: 'order_id', type: 'string' }], effect: 'write' }] },
    ],
    implementations: [
      { id: 'order_desk_impl', contract: 'iorder_desk', sourcePath: 'src/orders/desk.py', methods: [{ name: 'take', narrative: [...narrative, { stepNumber: narrative.length + 1, type: 'return', outcome: 'success', description: 'Done.' }] }] },
      { id: 'order_ledger_impl', contract: 'iorder_ledger', sourcePath: 'src/orders/desk.py', methods: [{ name: 'record', detail: 'intent', narrative: [], intent: 'Records the order; it never fails.' }] },
      { id: 'order_audit_impl', contract: 'iorder_audit', sourcePath: 'src/orders/desk.py', methods: [{ name: 'audit', detail: 'intent', narrative: [], intent: 'Audits the order; it never fails.' }] },
    ],
    files: { 'src/orders/__init__.py': '', 'src/orders/desk.py': body.join('\n') },
  };
}

const LEDGER_AND_AUDIT = [
  'class OrderLedger:',
  '    def record(self, order_id: str) -> None:',
  '        pass',
  '',
  '',
  'def audit(order_id: str) -> None:',
  '    pass',
  '',
  '',
];

describe('A Python call landing in the method\'s own file on another component\'s method is a colocated crossing', () => {
  const desk = (take: string[], params = 'self, order_id: str', init = true): string[] => [
    ...LEDGER_AND_AUDIT,
    'class OrderDesk:',
    ...(init ? ['    def __init__(self, ledger: OrderLedger) -> None:', '        self._ledger = ledger', ''] : []),
    `    def take(${params}) -> None:`,
    ...take.map(line => `        ${line}`),
    '',
  ];
  const LOCAL = [{ stepNumber: 1, type: 'local', description: 'Work out the order.' }];

  it('reports a call through a field whose declared class the other component is realized by', () => {
    const found = codes(colocated(desk(['self._ledger.record(order_id)']), LOCAL), COLOCATED);
    expect(found).toHaveLength(1);
    expect(found[0]).toContain('"record" (order-ledger.record)');
  });

  it('reports a bare call to the module function the other component is realized by', () => {
    const found = codes(colocated(desk(['audit(order_id)']), LOCAL), COLOCATED);
    expect(found).toHaveLength(1);
    expect(found[0]).toContain('"audit" (order-audit.audit)');
  });

  it('is quiet once the method claims the call in a step', () => {
    const claimed = [{ stepNumber: 1, type: 'call', targetComponent: 'order-ledger', targetMethod: 'record', description: 'Record the order.' }];
    expect(codes(colocated(desk(['self._ledger.record(order_id)']), claimed), COLOCATED)).toEqual([]);
  });

  it('never reports a landing only a shared name suggests: an undeclared field, a parameter shadowing the function', () => {
    expect(codes(colocated(desk(['self._other.record(order_id)']), LOCAL), COLOCATED)).toEqual([]);
    expect(codes(colocated(desk(['audit(order_id)'], 'self, order_id: str, audit'), LOCAL), COLOCATED)).toEqual([]);
  });

  it('never reports self.m() within its own class, even where another component models the same name', () => {
    const own = desk(['self.record(order_id)']);
    own.splice(own.indexOf('class OrderDesk:') + 1, 0, '    def record(self, order_id: str) -> None:', '        pass', '');
    expect(codes(colocated(own, LOCAL), COLOCATED)).toEqual([]);
  });
});

describe('A claim aimed at another project\'s component is not judged here', () => {
  const UNJUDGED = ['CALL_TARGET_UNJUDGED', 'CALL_TARGET_PLANNED', 'CALL_STEP_UNREALIZED', 'CALL_ORIGIN_UNRESOLVED'];

  for (const language of ['typescript', 'python'] as const) {
    it(`says the ${language} caller's claim as a notice naming the project, never as planned or unrealized`, () => {
      const found = codes(foreignCallTree({ calls: true, language }), UNJUDGED);
      expect(found).toHaveLength(1);
      expect(found[0]).toMatch(/^CALL_TARGET_UNJUDGED: .*geokit::tile-library\.tileAt.*project "geokit"/);
    });

    it(`is quiet for a ${language} step that calls nothing of another project`, () => {
      expect(codes(foreignCallTree({ calls: false, language }), UNJUDGED)).toEqual([]);
    });
  }

  it('is quiet when the call is made', () => {
    const body = 'import { tileAt } from \'geokit\';\nexport function centreTile(lat: number, lon: number): string {\n  return tileAt(lat, lon);\n}\n';
    expect(codes(foreignCallTree({ calls: true, body }), UNJUDGED)).toEqual([]);
  });
});
