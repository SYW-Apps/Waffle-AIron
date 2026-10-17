/**
 * A family with a declared network, for the derived networking (sdd_network):
 *
 *   platform (root, declares the network)  edge: api_gateway (HTTP gateway,
 *                                           outside entry), orders_client
 *   ├── orders  (service)                  orders_api (HTTP, network entry),
 *   │                                      billing_client, order_pricing
 *   ├── billing (service, its own nested   billing_api (HTTP gateway of the
 *   │            network)                  billing network, outside entry)
 *   └── geo     (library)                  geo_lib (InProcess, no flows)
 *
 * The modelled calls: the root's orders_client creates orders, the orders
 * service charges through billing's gateway, and prices with the geo library.
 */
import * as yaml from 'js-yaml';
import { BASE_FIXTURE_RULES, type FixtureTree } from '../rules-matrix/harness.js';

const TS = '2026-01-01T00:00:00.000Z';

const dump = (spec: Record<string, unknown>): string =>
  yaml.dump({ schemaVersion: '1.0.0', createdAt: TS, updatedAt: TS, ...spec }, { noRefs: true, lineWidth: 200 });

function projectYaml(name: string, extra: Record<string, unknown> = {}): string {
  return dump({ name, targets: [], rules: BASE_FIXTURE_RULES, extensions: { packs: [], useGlobalPacks: false }, ...extra });
}

/** One member project's files under its directory: L0, one subsystem, components, contracts, implementations. */
function member(dir: string, o: {
  id: string;
  config?: Record<string, unknown>;
  exports: Record<string, unknown>[];
  subsystem: string;
  published: string;
  components: Record<string, unknown>[];
  interfaces: Record<string, unknown>[];
  implementations?: Record<string, unknown>[];
}): Record<string, string> {
  const base = `${dir}/.wai`;
  const files: Record<string, string> = {
    [`${base}/project.yaml`]: projectYaml(o.id, { id: o.id, ...(o.config ?? {}) }),
    [`${base}/specs/.index.yaml`]: dump({ name: o.id, vision: `The ${o.id} part of the order platform.`, publicInterfaces: o.exports }),
    [`${base}/specs/subsystems/${o.subsystem}.yaml`]: dump({
      id: o.subsystem, name: o.subsystem, description: `The ${o.id} subsystem.`, parentSystem: o.id,
      publicInterfaces: [{ component: o.published, details: `The ${o.id} surface.` }],
    }),
  };
  for (const c of o.components) {
    files[`${base}/specs/components/${c.id}.yaml`] = dump({ owns: [], dependsOn: [], subsystem: o.subsystem, name: c.id, ...c });
  }
  for (const i of o.interfaces) files[`${base}/specs/interfaces/${i.id}.yaml`] = dump({ name: i.id, description: `${i.id}.`, ...i });
  for (const impl of o.implementations ?? []) files[`${base}/specs/implementations/${impl.id}.yaml`] = dump({ name: impl.id, description: `${impl.id}.`, ...impl });
  return files;
}

const runtime = (caller: string) => ({ kind: 'runtime', caller });

/** The platform family. */
export function platformFamily(): FixtureTree {
  return {
    system: { name: 'Platform', vision: 'An order platform: an edge gateway in front of the order and billing services.' },
    subsystems: [{ id: 'edge', description: 'The edge of the platform.' }],
    components: [
      {
        id: 'api_gateway', componentType: 'Portal', transport: 'HTTP', variant: 'gateway',
        description: 'The platform\'s public API gateway.',
        invokedBy: { kind: 'entry', caller: 'Browsers and mobile apps of the shop' },
      },
      { id: 'orders_client', componentType: 'Adapter', description: 'Calls the orders service over HTTP.', dependsOn: ['orders::orders'] },
    ],
    interfaces: [
      {
        id: 'iapi_gateway', component: 'api_gateway',
        methods: [
          { name: 'listOrders', description: 'List orders.', endpoint: { transport: 'HTTP', method: 'GET', path: '/api/orders' } },
          { name: 'placeOrder', description: 'Place an order.', endpoint: { transport: 'HTTP', method: 'POST', path: '/api/orders' } },
        ],
      },
      { id: 'iorders_client', component: 'orders_client', methods: [{ name: 'submitOrder', description: 'Submit an order.', invokedBy: runtime('The edge worker, once per placed order.') }] },
    ],
    implementations: [{
      id: 'orders_client_impl', contract: 'iorders_client',
      methods: [{ name: 'submitOrder', narrative: [{ stepNumber: 1, type: 'call', description: 'Create the order.', targetComponent: 'orders::orders', targetMethod: 'create' }] }],
    }],
    files: {
      '.wai/project.yaml': projectYaml('platform', {
        id: 'platform',
        network: { description: 'The order platform' },
        members: { orders: 'services/orders', billing: 'services/billing', geo: 'libs/geo' },
      }),
      ...member('services/orders', {
        id: 'orders',
        config: { externals: { billing: {}, geo: {} } },
        exports: [{ from: 'ordering', component: 'orders_api', as: 'orders', audience: 'project' }],
        subsystem: 'ordering',
        published: 'orders_api',
        components: [
          {
            id: 'orders_api', componentType: 'Portal', transport: 'HTTP', description: 'The orders service API.',
            invokedBy: { kind: 'entry', scope: 'network', caller: 'The platform\'s own services' },
          },
          { id: 'billing_client', componentType: 'Adapter', description: 'Charges orders through billing.', dependsOn: ['billing::billing'] },
          { id: 'order_pricing', componentType: 'Orchestrator', description: 'Prices an order.', dependsOn: ['geo::geo'] },
        ],
        interfaces: [
          {
            id: 'iorders_api', component: 'orders_api',
            methods: [
              { name: 'create', description: 'Create an order.', signature: 'create(): void', returns: 'void', endpoint: { transport: 'HTTP', method: 'POST', path: '/orders' } },
              { name: 'get', description: 'Read an order.', signature: 'get(): void', returns: 'void', endpoint: { transport: 'HTTP', method: 'GET', path: '/orders/{id}' } },
            ],
          },
          { id: 'ibilling_client', component: 'billing_client', methods: [{ name: 'chargeOrder', description: 'Charge one order.', signature: 'chargeOrder(): void', returns: 'void', invokedBy: runtime('The order worker, once per created order.') }] },
          { id: 'iorder_pricing', component: 'order_pricing', methods: [{ name: 'price', description: 'Price one order.', signature: 'price(): void', returns: 'void', invokedBy: runtime('The order worker, once per created order.') }] },
        ],
        implementations: [
          { id: 'billing_client_impl', contract: 'ibilling_client', methods: [{ name: 'chargeOrder', narrative: [{ stepNumber: 1, type: 'call', description: 'Charge it.', targetComponent: 'billing::billing', targetMethod: 'charge' }] }] },
          { id: 'order_pricing_impl', contract: 'iorder_pricing', methods: [{ name: 'price', narrative: [{ stepNumber: 1, type: 'call', description: 'Measure the distance.', targetComponent: 'geo::geo', targetMethod: 'distance' }] }] },
        ],
      }),
      ...member('services/billing', {
        id: 'billing',
        config: { network: true },
        exports: [{ from: 'charging', component: 'billing_api', as: 'billing', audience: 'project' }],
        subsystem: 'charging',
        published: 'billing_api',
        components: [{
          id: 'billing_api', componentType: 'Portal', transport: 'HTTP', variant: 'gateway', description: 'The billing network\'s gateway.',
          invokedBy: { kind: 'entry', caller: 'The platform\'s services, from outside the billing network' },
        }],
        interfaces: [{
          id: 'ibilling_api', component: 'billing_api',
          methods: [
            { name: 'charge', description: 'Charge an order.', signature: 'charge(): void', returns: 'void', endpoint: { transport: 'HTTP', method: 'POST', path: '/charges' } },
            { name: 'refund', description: 'Refund a charge.', signature: 'refund(): void', returns: 'void', endpoint: { transport: 'HTTP', method: 'POST', path: '/charges/{id}/refund' } },
          ],
        }],
      }),
      ...member('libs/geo', {
        id: 'geo',
        exports: [{ from: 'geometry', component: 'geo_lib', as: 'geo', audience: 'project' }],
        subsystem: 'geometry',
        published: 'geo_lib',
        components: [{
          id: 'geo_lib', componentType: 'Portal', transport: 'InProcess', description: 'The geometry library.',
          invokedBy: { kind: 'entry', caller: 'Services that link the library' },
        }],
        interfaces: [{
          id: 'igeo_lib', component: 'geo_lib',
          methods: [{ name: 'distance', description: 'The distance between two points.', signature: 'distance(): float', returns: 'float', effect: 'none' }],
        }],
      }),
    },
  };
}

/** The team's bindings for the platform: every workload with a flow bound, the root network (`network`) by a label every member pod carries, and the outside blocks. */
export const PLATFORM_BINDINGS = `# The platform's deployment, kept outside .wai/.
workloads:
  orders_client:
    selector: { app.kubernetes.io/name: edge }
    namespace: platform
    port: 8443
  api_gateway:
    selector: { app.kubernetes.io/name: edge }
    namespace: platform
    port: 8443
  orders:
    selector: { app.kubernetes.io/name: orders }
    namespace: platform
    port: 8080
  billing:
    selector: { app.kubernetes.io/name: billing }
    namespace: payments
    port: 9090
  network:
    selector: { platform.example/member: "true" }
outside:
  - 0.0.0.0/0
`;
