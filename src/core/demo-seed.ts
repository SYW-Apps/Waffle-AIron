import {
  saveSystemSpec,
  saveSubsystemSpec,
  saveComponentSpec,
  saveInterfaceSpec,
  saveImplementationSpec,
  saveTypeSpec,
  invalidateSpecCache,
} from './specs.js';
import type {
  ComponentSpec,
  ComponentType,
  InterfaceSpec,
  ImplementationSpec,
  MethodSignature,
  MethodImplementation,
  NarrativeStep,
  PublicInterface,
  SpecStatus,
  SubsystemSpec,
  TypeSpec,
} from '../models/index.js';

// ---------------------------------------------------------------------------
// Demo project seeder (sdd_core)
//
// Writes a RICH, coherent, multi-layer example spec tree into the bound project
// root so the architecture canvas has substantial content to render across all
// three views (component architecture, the type ERD, and narrative flow). The
// example system — "ShopFlow", a small commerce platform — is authored via the
// same core spec-writer functions the MCP tools use, so it always matches the
// on-disk schema/layout.
//
// The caller binds the target project root (via runWithProjectRoot) before
// calling seedDemoTree(); every save() below resolves to that root.
//
// Coverage the example deliberately exercises:
//   • ≥3 subsystems, each a layered slice: Portal → Orchestrator → Repository
//     (which OWNS a Store + Registry + Index), plus a Specialist / Adapter.
//   • Two cross-subsystem edges shaped correctly: a client Adapter in one
//     subsystem dependsOn another subsystem's PUBLISHED Portal (red boundary
//     edges + frames in the canvas).
//   • L3 interfaces with structured params + returns (details panels).
//   • Types with primary/unique keys and foreign references (ERD tables + FK
//     cardinality edges), including cross-subsystem references (data coupling).
//   • L5 narratives mixing every step kind: local, call, branch, switch, loop,
//     try, jump, return, throw — plus intent-only methods (the detail dial).
// ---------------------------------------------------------------------------

export const DEMO_SYSTEM_NAME = 'ShopFlow';

type MethodInput = {
  name: string;
  description: string;
  returns: string;
  params?: { name: string; type: string; optional?: boolean }[];
  endpoint?: MethodSignature['endpoint'];
};

/** Build an L3 method signature from a compact input (derives the display signature). */
function method(m: MethodInput): MethodSignature {
  const params = (m.params ?? []).map((p) => `${p.name}${p.optional ? '?' : ''}: ${p.type}`).join(', ');
  return {
    name: m.name,
    description: m.description,
    signature: `${m.name}(${params}): ${m.returns}`,
    returns: m.returns,
    ...(m.params && m.params.length ? { params: m.params } : {}),
    ...(m.endpoint ? { endpoint: m.endpoint } : {}),
  };
}

/**
 * Author the ShopFlow example spec tree at the currently-bound project root.
 * Overwrites the L0 system spec the provisioner wrote with a richer one, then
 * lays down the three subsystems and their layered component/interface/
 * implementation/type slices. Invalidates the spec cache at the end.
 */
export function seedDemoTree(): void {
  const now = new Date().toISOString();
  const status: SpecStatus = 'complete';
  const base = { createdAt: now, updatedAt: now };
  const lifecycle = { status, ...base }; // L1–L4 specs carry a status; L0/types do not

  // ── L0: System ────────────────────────────────────────────────────────────
  saveSystemSpec({
    schemaVersion: '1.0.0',
    name: DEMO_SYSTEM_NAME,
    vision:
      'A modular commerce platform: browse a product catalog, place orders, and settle payments. ' +
      'Three cleanly-bounded subsystems collaborate only through published portals.',
    targetLanguage: 'typescript',
    boundaries: [
      { name: 'Payment gateways', description: 'Third-party card processors are integrated, never re-implemented.' },
      { name: 'Fulfilment', description: 'Warehouse and shipping are out of scope for this system.' },
    ],
    globalRequirements: [
      { description: 'An order is never charged twice — checkout is idempotent.' },
      { description: 'Catalog reads must not block on payment-gateway availability.' },
    ],
    // System-level databases — the persistence the Repositories back onto. Types
    // carry a matching `database` pointer, so the canvas Databases view groups
    // them into these schemas with PK/FK relations.
    databases: [
      { id: 'catalogdb', name: 'Catalog DB', engine: 'postgres', description: 'Products and categories.' },
      { id: 'ordersdb', name: 'Orders DB', engine: 'postgres', description: 'Orders, order lines, and payments.' },
    ],
    // L0 gateway surface — the entries exported beyond the project (each backed by
    // a subsystem-published Portal), with an audience ceiling. Catalog + Ordering
    // are externally shareable (they appear in a public share's OpenAPI); Payments
    // is instance-internal (excluded from an external projection).
    publicInterfaces: [
      { id: 'catalog-api', name: 'Catalog API', subsystem: 'catalog', component: 'catalog-portal', interface: 'icatalog-portal', type: 'REST', details: 'Public product catalog — browse products, categories, and display pricing.', audience: 'external' },
      { id: 'ordering-api', name: 'Ordering API', subsystem: 'ordering', component: 'ordering-portal', interface: 'iordering-portal', type: 'REST', details: 'Order management — place and fetch orders.', audience: 'external' },
      { id: 'payments-api', name: 'Payments API', subsystem: 'payments', component: 'payments-portal', interface: 'ipayments-portal', type: 'REST', details: 'Payment settlement (internal).', audience: 'instance' },
    ],
    ...base,
  });

  // ── L1: Subsystems ─────────────────────────────────────────────────────────
  const subsystem = (
    id: string,
    name: string,
    description: string,
    publicInterfaces: PublicInterface[],
  ): void =>
    saveSubsystemSpec({
      id,
      name,
      description,
      parentSystem: DEMO_SYSTEM_NAME,
      publicInterfaces,
      trustedLinks: [],
      ...lifecycle,
    } as SubsystemSpec);

  subsystem('catalog', 'Catalog', 'Product catalog: browse products and categories, compute display pricing.', [
    { type: 'REST', details: 'Public product catalog API', component: 'catalog-portal', interface: 'icatalog-portal' },
  ]);
  subsystem('payments', 'Payments', 'Payment settlement: authorize and record charges against orders.', [
    { type: 'REST', details: 'Payment processing API', component: 'payments-portal', interface: 'ipayments-portal' },
  ]);
  subsystem('ordering', 'Ordering', 'Order workflow: assemble a cart, price it, charge it, and persist the order.', [
    { type: 'REST', details: 'Order management API', component: 'ordering-portal', interface: 'iordering-portal' },
  ]);

  // ── L2: Components ───────────────────────────────────────────────────────────
  // Saved so that each Repository (with its `owns` set) is written before its
  // members, so the layout normalizer nests the Store/Registry/Index inside it.
  const comp = (
    id: string,
    name: string,
    subsystem: string,
    componentType: ComponentType,
    description: string,
    extra: Partial<ComponentSpec> = {},
  ): void =>
    void saveComponentSpec({
      id,
      name,
      description,
      subsystem,
      componentType,
      owns: [],
      dependsOn: [],
      ...lifecycle,
      ...extra,
    } as ComponentSpec);

  // catalog
  comp('catalog-portal', 'Catalog Portal', 'catalog', 'Portal', 'HTTP front door for catalog reads.', {
    portalType: 'HTTP_API',
    basePath: '/catalog',
    dependsOn: ['catalog-orchestrator'],
  });
  comp('catalog-orchestrator', 'Catalog Orchestrator', 'catalog', 'Orchestrator', 'Coordinates catalog reads and pricing.', {
    dependsOn: ['product-repo', 'pricing-specialist'],
  });
  comp('product-repo', 'Product Repository', 'catalog', 'Repository', 'Persistence facade for products.', {
    owns: ['product-store', 'product-registry', 'product-index'],
  });
  comp('product-store', 'Product Store', 'catalog', 'Store', 'Durable product record storage.');
  comp('product-registry', 'Product Registry', 'catalog', 'Registry', 'SKU → product identity registry.');
  comp('product-index', 'Product Index', 'catalog', 'Index', 'Category → product id lookup index.');
  comp('pricing-specialist', 'Pricing Specialist', 'catalog', 'Specialist', 'Computes tiered display pricing.');

  // payments
  comp('payments-portal', 'Payments Portal', 'payments', 'Portal', 'HTTP front door for charges.', {
    portalType: 'HTTP_API',
    basePath: '/payments',
    dependsOn: ['payments-orchestrator'],
  });
  comp('payments-orchestrator', 'Payments Orchestrator', 'payments', 'Orchestrator', 'Coordinates authorization + recording.', {
    dependsOn: ['payment-repo', 'gateway-adapter'],
  });
  comp('payment-repo', 'Payment Repository', 'payments', 'Repository', 'Persistence facade for payments.', {
    owns: ['payment-store', 'payment-registry', 'payment-index'],
  });
  comp('payment-store', 'Payment Store', 'payments', 'Store', 'Durable payment record storage.');
  comp('payment-registry', 'Payment Registry', 'payments', 'Registry', 'Order → payment identity registry.');
  comp('payment-index', 'Payment Index', 'payments', 'Index', 'Order → payment id lookup index.');
  comp('gateway-adapter', 'Gateway Adapter', 'payments', 'Adapter', 'Talks to the external payment gateway.');

  // ordering
  comp('ordering-portal', 'Ordering Portal', 'ordering', 'Portal', 'HTTP front door for orders.', {
    portalType: 'HTTP_API',
    basePath: '/orders',
    dependsOn: ['ordering-orchestrator'],
  });
  comp('ordering-orchestrator', 'Ordering Orchestrator', 'ordering', 'Orchestrator', 'Drives checkout across catalog + payments.', {
    dependsOn: ['order-repo', 'catalog-client', 'payments-client'],
  });
  comp('order-repo', 'Order Repository', 'ordering', 'Repository', 'Persistence facade for orders.', {
    owns: ['order-store', 'order-registry', 'order-index'],
  });
  comp('order-store', 'Order Store', 'ordering', 'Store', 'Durable order record storage.');
  comp('order-registry', 'Order Registry', 'ordering', 'Registry', 'Order identity registry.');
  comp('order-index', 'Order Index', 'ordering', 'Index', 'Customer → order id lookup index.');
  // Cross-subsystem client adapters — each dependsOn another subsystem's PUBLISHED portal.
  comp('catalog-client', 'Catalog Client', 'ordering', 'Adapter', 'Calls the catalog subsystem over its REST portal.', {
    dependsOn: ['catalog-portal'],
  });
  comp('payments-client', 'Payments Client', 'ordering', 'Adapter', 'Calls the payments subsystem over its REST portal.', {
    dependsOn: ['payments-portal'],
  });

  // ── L3: Interfaces ───────────────────────────────────────────────────────────
  const iface = (id: string, name: string, component: string, methods: MethodInput[]): void =>
    void saveInterfaceSpec({
      id,
      name,
      description: `${name} contract`,
      component,
      methods: methods.map(method),
      ...lifecycle,
    } as InterfaceSpec);

  // catalog interfaces
  iface('icatalog-portal', 'ICatalogPortal', 'catalog-portal', [
    { name: 'getProduct', description: 'Fetch one product by id.', returns: 'Product', params: [{ name: 'id', type: 'string' }], endpoint: { transport: 'HTTP', method: 'GET', path: '/catalog/products/{id}' } },
    { name: 'listByCategory', description: 'List products in a category.', returns: 'Product[]', params: [{ name: 'categoryId', type: 'string' }], endpoint: { transport: 'HTTP', method: 'GET', path: '/catalog/categories/{categoryId}/products' } },
  ]);
  iface('icatalog-orchestrator', 'ICatalogOrchestrator', 'catalog-orchestrator', [
    { name: 'fetchProduct', description: 'Load and validate a product.', returns: 'Product', params: [{ name: 'productId', type: 'string' }] },
    { name: 'browseCategory', description: 'List and price a category.', returns: 'Product[]', params: [{ name: 'categoryId', type: 'string' }] },
  ]);
  iface('iproduct-repo', 'IProductRepository', 'product-repo', [
    { name: 'findById', description: 'Load a product by id.', returns: 'Product', params: [{ name: 'id', type: 'string' }] },
    { name: 'findByCategory', description: 'Load products in a category.', returns: 'Product[]', params: [{ name: 'categoryId', type: 'string' }] },
    { name: 'save', description: 'Persist a product.', returns: 'void', params: [{ name: 'product', type: 'Product' }] },
  ]);
  iface('iproduct-store', 'IProductStore', 'product-store', [
    { name: 'read', description: 'Read a product record.', returns: 'Product', params: [{ name: 'id', type: 'string' }] },
    { name: 'write', description: 'Write a product record.', returns: 'void', params: [{ name: 'product', type: 'Product' }] },
  ]);
  iface('iproduct-registry', 'IProductRegistry', 'product-registry', [
    { name: 'register', description: 'Register a product identity.', returns: 'void', params: [{ name: 'product', type: 'Product' }] },
    { name: 'lookup', description: 'Resolve a product by SKU.', returns: 'Product', params: [{ name: 'sku', type: 'string' }] },
  ]);
  iface('iproduct-index', 'IProductIndex', 'product-index', [
    { name: 'byCategory', description: 'Product ids in a category.', returns: 'string[]', params: [{ name: 'categoryId', type: 'string' }] },
  ]);
  iface('ipricing-specialist', 'IPricingSpecialist', 'pricing-specialist', [
    { name: 'quote', description: 'Compute a tiered price for a quantity.', returns: 'Money', params: [{ name: 'product', type: 'Product' }, { name: 'qty', type: 'number' }] },
  ]);

  // payments interfaces
  iface('ipayments-portal', 'IPaymentsPortal', 'payments-portal', [
    { name: 'charge', description: 'Charge an order.', returns: 'Payment', params: [{ name: 'orderId', type: 'string' }, { name: 'amount', type: 'Money' }], endpoint: { transport: 'HTTP', method: 'POST', path: '/payments/charges' } },
  ]);
  iface('ipayments-orchestrator', 'IPaymentsOrchestrator', 'payments-orchestrator', [
    { name: 'settle', description: 'Authorize and record a charge for an order.', returns: 'Payment', params: [{ name: 'orderId', type: 'string' }, { name: 'amount', type: 'Money' }] },
  ]);
  iface('ipayment-repo', 'IPaymentRepository', 'payment-repo', [
    { name: 'record', description: 'Persist a payment.', returns: 'void', params: [{ name: 'payment', type: 'Payment' }] },
    { name: 'findByOrder', description: 'Load the payment for an order.', returns: 'Payment', params: [{ name: 'orderId', type: 'string' }] },
  ]);
  iface('ipayment-store', 'IPaymentStore', 'payment-store', [
    { name: 'read', description: 'Read a payment record.', returns: 'Payment', params: [{ name: 'id', type: 'string' }] },
    { name: 'write', description: 'Write a payment record.', returns: 'void', params: [{ name: 'payment', type: 'Payment' }] },
  ]);
  iface('ipayment-registry', 'IPaymentRegistry', 'payment-registry', [
    { name: 'register', description: 'Register an order → payment mapping.', returns: 'void', params: [{ name: 'payment', type: 'Payment' }] },
    { name: 'lookup', description: 'Resolve a payment by order id.', returns: 'Payment', params: [{ name: 'orderId', type: 'string' }] },
  ]);
  iface('ipayment-index', 'IPaymentIndex', 'payment-index', [
    { name: 'byOrder', description: 'Payment ids for an order.', returns: 'string[]', params: [{ name: 'orderId', type: 'string' }] },
  ]);
  iface('igateway-adapter', 'IGatewayAdapter', 'gateway-adapter', [
    { name: 'authorize', description: 'Authorize a charge with the gateway.', returns: 'string', params: [{ name: 'amount', type: 'Money' }] },
    { name: 'capture', description: 'Capture a previously authorized charge.', returns: 'boolean', params: [{ name: 'ref', type: 'string' }] },
  ]);

  // ordering interfaces
  iface('iordering-portal', 'IOrderingPortal', 'ordering-portal', [
    { name: 'placeOrder', description: 'Place a new order.', returns: 'Order', params: [{ name: 'customerId', type: 'string' }, { name: 'items', type: 'OrderLine[]' }], endpoint: { transport: 'HTTP', method: 'POST', path: '/orders' } },
    { name: 'getOrder', description: 'Fetch an order by id.', returns: 'Order', params: [{ name: 'id', type: 'string' }], endpoint: { transport: 'HTTP', method: 'GET', path: '/orders/{id}' } },
  ]);
  iface('iordering-orchestrator', 'IOrderingOrchestrator', 'ordering-orchestrator', [
    { name: 'checkout', description: 'Validate, price, charge, and persist an order.', returns: 'Order', params: [{ name: 'customerId', type: 'string' }, { name: 'items', type: 'OrderLine[]' }] },
    { name: 'lookup', description: 'Load an order by id.', returns: 'Order', params: [{ name: 'id', type: 'string' }] },
  ]);
  iface('iorder-repo', 'IOrderRepository', 'order-repo', [
    { name: 'save', description: 'Persist an order.', returns: 'void', params: [{ name: 'order', type: 'Order' }] },
    { name: 'findById', description: 'Load an order by id.', returns: 'Order', params: [{ name: 'id', type: 'string' }] },
  ]);
  iface('iorder-store', 'IOrderStore', 'order-store', [
    { name: 'read', description: 'Read an order record.', returns: 'Order', params: [{ name: 'id', type: 'string' }] },
    { name: 'write', description: 'Write an order record.', returns: 'void', params: [{ name: 'order', type: 'Order' }] },
  ]);
  iface('iorder-registry', 'IOrderRegistry', 'order-registry', [
    { name: 'register', description: 'Register an order identity.', returns: 'void', params: [{ name: 'order', type: 'Order' }] },
    { name: 'lookup', description: 'Resolve an order by id.', returns: 'Order', params: [{ name: 'id', type: 'string' }] },
  ]);
  iface('iorder-index', 'IOrderIndex', 'order-index', [
    { name: 'byCustomer', description: 'Order ids for a customer.', returns: 'string[]', params: [{ name: 'customerId', type: 'string' }] },
  ]);
  iface('icatalog-client', 'ICatalogClient', 'catalog-client', [
    { name: 'getProduct', description: 'Fetch a product from the catalog subsystem.', returns: 'Product', params: [{ name: 'id', type: 'string' }] },
  ]);
  iface('ipayments-client', 'IPaymentsClient', 'payments-client', [
    { name: 'pay', description: 'Charge an order via the payments subsystem.', returns: 'Payment', params: [{ name: 'orderId', type: 'string' }, { name: 'amount', type: 'Money' }] },
  ]);

  // ── L4/L5: Implementations + narratives ──────────────────────────────────────
  const impl = (
    id: string,
    contract: string,
    methods: MethodImplementation[],
    detail?: ImplementationSpec['detail'],
  ): void =>
    void saveImplementationSpec({
      id,
      name: id,
      description: `Implementation of ${contract}`,
      contract,
      methods,
      ...(detail ? { detail } : {}),
      ...lifecycle,
    } as ImplementationSpec);

  const step = (s: NarrativeStep): NarrativeStep => s;
  const callsOnly = (name: string, target: string, targetMethod: string, description: string): MethodImplementation => ({
    name,
    narrative: [step({ stepNumber: 1, description, type: 'call', targetComponent: target, targetMethod })],
  });
  const intentMethod = (name: string, intent: string): MethodImplementation => ({ name, narrative: [], intent });

  // catalog: Portal (calls-only) → Orchestrator (full narratives) → Specialist (switch)
  impl('catalog-portal-impl', 'icatalog-portal', [
    callsOnly('getProduct', 'catalog-orchestrator', 'fetchProduct', 'Dispatch the read to the catalog orchestrator.'),
    callsOnly('listByCategory', 'catalog-orchestrator', 'browseCategory', 'Dispatch the category browse to the orchestrator.'),
  ], 'calls-only');

  impl('catalog-orchestrator-impl', 'icatalog-orchestrator', [
    {
      name: 'fetchProduct',
      narrative: [
        step({ stepNumber: 1, description: 'Validate the requested product id.', type: 'local' }),
        step({ stepNumber: 2, description: 'Load the product from the repository.', type: 'call', targetComponent: 'product-repo', targetMethod: 'findById' }),
        step({ stepNumber: 3, description: 'If the product was not found, fail; otherwise return it.', type: 'branch', condition: 'the product was not found', onFalseStep: 5 }),
        step({ stepNumber: 4, description: 'Raise a not-found error.', type: 'throw', error: 'ProductNotFound' }),
        step({ stepNumber: 5, description: 'Return the product.', type: 'return', outcome: 'product found' }),
      ],
    },
    {
      name: 'browseCategory',
      narrative: [
        step({ stepNumber: 1, description: 'Normalize the category id.', type: 'local' }),
        step({ stepNumber: 2, description: 'Fetch every product in the category.', type: 'call', targetComponent: 'product-repo', targetMethod: 'findByCategory' }),
        step({ stepNumber: 3, description: 'Price each product for display.', type: 'loop', loopKind: 'forEach', over: 'each product in the result', endStep: 4 }),
        step({ stepNumber: 4, description: 'Compute the display price for the product.', type: 'call', targetComponent: 'pricing-specialist', targetMethod: 'quote' }),
        step({ stepNumber: 5, description: 'Return the priced product list.', type: 'return', outcome: 'priced catalog page' }),
      ],
    },
  ]);

  impl('pricing-specialist-impl', 'ipricing-specialist', [
    {
      name: 'quote',
      narrative: [
        step({ stepNumber: 1, description: 'Compute the base amount as unit price times quantity.', type: 'local' }),
        step({ stepNumber: 2, description: 'Choose a discount by the customer loyalty tier.', type: 'switch', on: 'the customer loyalty tier', cases: [{ value: 'gold', step: 3 }, { value: 'silver', step: 5 }], defaultStep: 7 }),
        step({ stepNumber: 3, description: 'Apply the 20% gold-tier discount.', type: 'local' }),
        step({ stepNumber: 4, description: 'Skip ahead to finalize the quote.', type: 'jump', toStep: 8 }),
        step({ stepNumber: 5, description: 'Apply the 10% silver-tier discount.', type: 'local' }),
        step({ stepNumber: 6, description: 'Skip ahead to finalize the quote.', type: 'jump', toStep: 8 }),
        step({ stepNumber: 7, description: 'Apply no discount for standard customers.', type: 'local' }),
        step({ stepNumber: 8, description: 'Return the computed money amount.', type: 'return', outcome: 'final quote' }),
      ],
    },
  ]);

  // catalog data blocks: intent-only (the detail dial)
  impl('product-repo-impl', 'iproduct-repo', [
    intentMethod('findById', 'Reads the product record via the store; raises ProductNotFound when absent.'),
    intentMethod('findByCategory', 'Resolves product ids through the index, then batch-reads them via the store.'),
    intentMethod('save', 'Writes the record via the store and updates the SKU registry and category index atomically.'),
  ], 'intent');
  impl('product-store-impl', 'iproduct-store', [
    intentMethod('read', 'Reads one product record by id; returns it or signals absence.'),
    intentMethod('write', 'Durably writes one product record, overwriting any prior version.'),
  ], 'intent');
  impl('product-registry-impl', 'iproduct-registry', [
    intentMethod('register', 'Records the SKU → product identity mapping.'),
    intentMethod('lookup', 'Resolves a product by SKU; signals absence when unknown.'),
  ], 'intent');
  impl('product-index-impl', 'iproduct-index', [
    intentMethod('byCategory', 'Returns the product ids currently indexed under a category.'),
  ], 'intent');

  // payments: Portal (calls-only) → Orchestrator (try/catch/finally) → Adapter (intent)
  impl('payments-portal-impl', 'ipayments-portal', [
    callsOnly('charge', 'payments-orchestrator', 'settle', 'Dispatch the charge to the payments orchestrator.'),
  ], 'calls-only');

  impl('payments-orchestrator-impl', 'ipayments-orchestrator', [
    {
      name: 'settle',
      narrative: [
        step({ stepNumber: 1, description: 'Validate the settlement amount is positive.', type: 'local' }),
        step({ stepNumber: 2, description: 'Attempt to authorize and record the payment.', type: 'try', endStep: 6, catches: [{ error: 'GatewayError', step: 7 }], finallyStep: 8 }),
        step({ stepNumber: 3, description: 'Check for an existing payment for idempotency.', type: 'call', targetComponent: 'payment-repo', targetMethod: 'findByOrder' }),
        step({ stepNumber: 4, description: 'Authorize the charge with the gateway.', type: 'call', targetComponent: 'gateway-adapter', targetMethod: 'authorize' }),
        step({ stepNumber: 5, description: 'Persist the successful payment.', type: 'call', targetComponent: 'payment-repo', targetMethod: 'record' }),
        step({ stepNumber: 6, description: 'On success, skip the failure handler.', type: 'jump', toStep: 8 }),
        step({ stepNumber: 7, description: 'The gateway declined the charge; propagate a declined error.', type: 'throw', error: 'PaymentDeclined' }),
        step({ stepNumber: 8, description: 'Emit a settlement metric regardless of outcome.', type: 'local' }),
        step({ stepNumber: 9, description: 'Return the recorded payment.', type: 'return', outcome: 'payment settled' }),
      ],
    },
  ]);

  impl('payment-repo-impl', 'ipayment-repo', [
    intentMethod('record', 'Writes the payment via the store and registers the order → payment mapping.'),
    intentMethod('findByOrder', 'Resolves the payment id through the index, then reads it via the store.'),
  ], 'intent');
  impl('gateway-adapter-impl', 'igateway-adapter', [
    intentMethod('authorize', 'Requests authorization from the external gateway; raises GatewayError on decline or transport failure.'),
    intentMethod('capture', 'Captures a previously authorized charge by reference; returns whether capture succeeded.'),
  ], 'intent');

  // ordering: Portal (calls-only) → Orchestrator (loop/branch/throw) → cross-subsystem clients
  impl('ordering-portal-impl', 'iordering-portal', [
    callsOnly('placeOrder', 'ordering-orchestrator', 'checkout', 'Dispatch the checkout to the ordering orchestrator.'),
    callsOnly('getOrder', 'ordering-orchestrator', 'lookup', 'Dispatch the order read to the orchestrator.'),
  ], 'calls-only');

  impl('ordering-orchestrator-impl', 'iordering-orchestrator', [
    {
      name: 'checkout',
      narrative: [
        step({ stepNumber: 1, description: 'Create an empty order draft for the customer.', type: 'local' }),
        step({ stepNumber: 2, description: 'Validate and price every requested line.', type: 'loop', loopKind: 'forEach', over: 'each requested order line', endStep: 6 }),
        step({ stepNumber: 3, description: 'Fetch the product from the catalog subsystem.', type: 'call', targetComponent: 'catalog-client', targetMethod: 'getProduct' }),
        step({ stepNumber: 4, description: 'If the product is unavailable, abort; otherwise price the line.', type: 'branch', condition: 'the product is unavailable', onFalseStep: 6 }),
        step({ stepNumber: 5, description: 'Abort the checkout for the unavailable product.', type: 'throw', error: 'ProductUnavailable' }),
        step({ stepNumber: 6, description: 'Add the priced line to the running order total.', type: 'local' }),
        step({ stepNumber: 7, description: 'Charge the order total through the payments subsystem.', type: 'call', targetComponent: 'payments-client', targetMethod: 'pay' }),
        step({ stepNumber: 8, description: 'Persist the completed order.', type: 'call', targetComponent: 'order-repo', targetMethod: 'save' }),
        step({ stepNumber: 9, description: 'Return the placed order.', type: 'return', outcome: 'order placed' }),
      ],
    },
    callsOnly('lookup', 'order-repo', 'findById', 'Load the order from the repository.'),
  ]);

  impl('order-repo-impl', 'iorder-repo', [
    intentMethod('save', 'Writes the order via the store and updates the customer index and identity registry.'),
    intentMethod('findById', 'Reads the order record via the store; signals absence when unknown.'),
  ], 'intent');
  impl('catalog-client-impl', 'icatalog-client', [
    callsOnly('getProduct', 'catalog-portal', 'getProduct', 'Call the catalog subsystem over its published REST portal.'),
  ], 'calls-only');
  impl('payments-client-impl', 'ipayments-client', [
    callsOnly('pay', 'payments-portal', 'charge', 'Call the payments subsystem over its published REST portal.'),
  ], 'calls-only');

  // ── Types (entities + value objects) — ERD tables + FK reference edges ────────
  const type = (t: Omit<TypeSpec, 'createdAt' | 'updatedAt' | 'methods' | 'fields'> & Partial<Pick<TypeSpec, 'methods' | 'fields'>>): void =>
    void saveTypeSpec({ methods: [], fields: [], ...base, ...t } as TypeSpec);

  // Shared, system-level value object (no owning subsystem).
  type({
    kind: 'value-object', id: 'money', name: 'Money', description: 'A monetary amount in minor units.',
    fields: [
      { name: 'amountCents', type: 'number', optional: false },
      { name: 'currency', type: 'string', optional: false },
    ],
    methods: [{ name: 'format', signature: 'format(): string', returns: 'string', description: 'Render as a localized currency string.' }],
  });

  // catalog types
  type({
    kind: 'entity', id: 'category', name: 'Category', subsystem: 'catalog', description: 'A product category.', database: 'catalogdb', table: 'categories',
    fields: [
      { name: 'id', type: 'string', optional: false, key: 'primary' },
      { name: 'slug', type: 'string', optional: false, key: 'unique' },
      { name: 'name', type: 'string', optional: false },
    ],
  });
  type({
    kind: 'entity', id: 'product', name: 'Product', subsystem: 'catalog', description: 'A sellable product.', database: 'catalogdb', table: 'products',
    fields: [
      { name: 'id', type: 'string', optional: false, key: 'primary' },
      { name: 'sku', type: 'string', optional: false, key: 'unique' },
      { name: 'name', type: 'string', optional: false },
      { name: 'priceCents', type: 'number', optional: false },
      { name: 'category', type: 'Category', optional: false }, // FK → category (card 1)
    ],
    methods: [{ name: 'label', signature: 'label(): string', returns: 'string', description: 'Human-readable product label.' }],
  });

  // payments types
  type({
    kind: 'entity', id: 'payment', name: 'Payment', subsystem: 'payments', description: 'A settled charge against an order.', database: 'ordersdb', table: 'payments',
    fields: [
      { name: 'id', type: 'string', optional: false, key: 'primary' },
      { name: 'orderId', type: 'string', optional: false, key: 'unique' },
      { name: 'amount', type: 'Money', optional: false }, // FK → money (card 1)
      { name: 'status', type: 'string', optional: false },
      { name: 'createdAt', type: 'datetime', optional: false },
    ],
  });

  // ordering types
  type({
    kind: 'value-object', id: 'order-line', name: 'OrderLine', subsystem: 'ordering', description: 'One line of an order.',
    fields: [
      { name: 'productId', type: 'Product', optional: false }, // FK → catalog::product (cross-subsystem, card 1)
      { name: 'qty', type: 'number', optional: false },
      { name: 'unitPriceCents', type: 'number', optional: false },
    ],
  });
  type({
    kind: 'entity', id: 'order', name: 'Order', subsystem: 'ordering', description: 'A customer order.', database: 'ordersdb', table: 'orders',
    fields: [
      { name: 'id', type: 'string', optional: false, key: 'primary' },
      { name: 'customerId', type: 'string', optional: false },
      { name: 'lines', type: 'OrderLine[]', optional: false }, // FK → order-line (card *)
      { name: 'totalCents', type: 'number', optional: false },
      { name: 'status', type: 'string', optional: false },
      { name: 'payment', type: 'Payment', optional: true }, // FK → payments::payment (cross-subsystem, card 0..1)
    ],
  });

  invalidateSpecCache();
}
