/**
 * Removable-forwarder family (src/core/rules/heuristic/removable-forwarder.ts).
 *
 * Documented intent pinned here:
 *  - REMOVABLE_FORWARDER (warning): an Orchestrator whose every narrated method
 *    is a single hand-off is a forwarder. When EVERY modelled caller could
 *    legally call the forwarded target itself, the hop adds nothing doctrine
 *    asks for, and it is reported. Legal is the doctrine rules' own verdict on
 *    the edge the caller would need, so a forwarder doctrine REQUIRES is never
 *    reported: a Portal never depends on an Adapter, a Portal never calls a
 *    write-effect facade method, and one caller that cannot make the call is
 *    enough. A deliberate seam is kept with a reasoned lint.allow.
 */
import { defineRuleFixture, type FixtureSpecInput } from '../harness.js';

const SYSTEM = {
  name: 'Harborline',
  vision: 'Container shipping platform covering shipment tracking, carrier rates and delay alerts.',
};

const TRACKING_SUB = { id: 'tracking', description: 'Shipment tracking for customers and the operations desk.' };

/** The tracking portal: one verb, handed to the shipment lookup orchestrator. */
const TRACKING_PORTAL = {
  id: 'tracking-portal',
  componentType: 'Portal',
  transport: 'Custom',
  description: 'Customer-facing API answering where a shipment is.',
  dependsOn: ['shipment-lookup-orchestrator'],
};

/** The shipment data: a Repository facade over its Store, with a read and a write. */
const SHIPMENT_DATA: FixtureSpecInput[] = [
  {
    id: 'shipment-repository',
    componentType: 'Repository',
    description: 'Facade over the shipment records.',
    owns: ['shipment-store'],
  },
  { id: 'shipment-store', componentType: 'Store', description: 'Holds the shipment records.' },
];

const SHIPMENT_REPOSITORY_CONTRACT = {
  id: 'ishipment_repository',
  component: 'shipment-repository',
  methods: [
    { name: 'findShipment', description: 'Load one shipment by its tracking number.', effect: 'read' },
    { name: 'recordScan', description: 'Record a port scan against a shipment.', effect: 'write' },
  ],
};

/** A method that hands its call to one collaborator and returns what it answered. */
function handsOff(name: string, targetComponent: string, targetMethod: string) {
  return {
    name,
    narrative: [
      {
        stepNumber: 1,
        type: 'call',
        description: `Pass the request to ${targetComponent} unchanged.`,
        targetComponent,
        targetMethod,
      },
      { stepNumber: 2, type: 'return', description: `Return what ${targetComponent} answered.`, outcome: `${name} result` },
    ],
  };
}

/** The tracking portal's implementation: its verb calls the lookup orchestrator. */
const TRACKING_PORTAL_IMPL = {
  id: 'tracking_portal_impl',
  contract: 'itracking_portal',
  methods: [handsOff('trackShipment', 'shipment-lookup-orchestrator', 'trackShipment')],
};

const TRACKING_PORTAL_CONTRACT = {
  id: 'itracking_portal',
  component: 'tracking-portal',
  methods: [{ name: 'trackShipment', description: 'Answer where a shipment is.' }],
};

/** The lookup orchestrator, forwarding its one verb to the given target. */
function lookupOrchestrator(dependsOn: string[], extra: Record<string, unknown> = {}) {
  return {
    id: 'shipment-lookup-orchestrator',
    componentType: 'Orchestrator',
    description: 'Looks a shipment up for the tracking surfaces.',
    dependsOn,
    ...extra,
  };
}

const LOOKUP_CONTRACT = {
  id: 'ishipment_lookup',
  component: 'shipment-lookup-orchestrator',
  methods: [{ name: 'trackShipment', description: 'Look a shipment up by its tracking number.' }],
};

function lookupImpl(targetComponent: string, targetMethod: string) {
  return {
    id: 'shipment_lookup_impl',
    contract: 'ishipment_lookup',
    methods: [handsOff('trackShipment', targetComponent, targetMethod)],
  };
}

/** Portal → lookup orchestrator → shipment repository, the orchestrator forwarding to the given repository method. */
function repositoryTree(targetMethod: string, lookupExtra: Record<string, unknown> = {}) {
  return {
    system: SYSTEM,
    subsystems: [TRACKING_SUB],
    components: [TRACKING_PORTAL, lookupOrchestrator(['shipment-repository'], lookupExtra), ...SHIPMENT_DATA],
    interfaces: [TRACKING_PORTAL_CONTRACT, LOOKUP_CONTRACT, SHIPMENT_REPOSITORY_CONTRACT],
    implementations: [TRACKING_PORTAL_IMPL, lookupImpl('shipment-repository', targetMethod)],
  };
}

export default [
  defineRuleFixture({
    code: 'REMOVABLE_FORWARDER',
    severity: 'warning',
    anchoredTo: 'shipment-lookup-orchestrator',
    expectFire: true,
    scenario:
      'The tracking portal asks a shipment lookup orchestrator for a shipment, and the orchestrator only passes the read on to the shipment repository, which the portal may read directly.',
    tree: repositoryTree('findShipment'),
  }),
  defineRuleFixture({
    code: 'REMOVABLE_FORWARDER',
    expectFire: false,
    reason: 'A Portal never depends on an Adapter, so the orchestrator between them is required: it is where the portal\'s shape is translated into the carrier\'s.',
    scenario:
      'The tracking portal asks a shipment lookup orchestrator for a shipment, and the orchestrator only passes the call on to the carrier tracking adapter.',
    tree: {
      system: SYSTEM,
      subsystems: [TRACKING_SUB],
      components: [
        TRACKING_PORTAL,
        lookupOrchestrator(['carrier-tracking-adapter']),
        { id: 'carrier-tracking-adapter', componentType: 'Adapter', description: 'Calls the ocean carrier\'s tracking API.' },
      ],
      interfaces: [
        TRACKING_PORTAL_CONTRACT,
        LOOKUP_CONTRACT,
        {
          id: 'icarrier_tracking',
          component: 'carrier-tracking-adapter',
          methods: [{ name: 'fetchPosition', description: 'Fetch a container\'s last reported position from the carrier.', effect: 'io' }],
        },
      ],
      implementations: [TRACKING_PORTAL_IMPL, lookupImpl('carrier-tracking-adapter', 'fetchPosition')],
    },
  }),
  defineRuleFixture({
    code: 'REMOVABLE_FORWARDER',
    expectFire: false,
    reason: 'The forwarded method writes, and a Portal may only READ through a Repository facade — the write routes through an Orchestrator, so this one is required.',
    scenario:
      'The tracking portal hands a port scan to a shipment lookup orchestrator, which only passes it on to the shipment repository\'s write-effect recordScan method.',
    tree: repositoryTree('recordScan'),
  }),
  defineRuleFixture({
    code: 'REMOVABLE_FORWARDER',
    expectFire: false,
    reason: 'The team keeps the hop on purpose as the place where shipment answers will be reshaped for customers, and says so with a reasoned lint.allow.',
    scenario:
      'The shipment lookup orchestrator only passes the tracking portal\'s read on to the shipment repository, and is kept deliberately with a lint.allow stating why.',
    tree: repositoryTree('findShipment', {
      lint: {
        allow: [{
          code: 'REMOVABLE_FORWARDER',
          reason: 'Kept on purpose: customer-facing shipment answers will be reshaped here once the redacted view ships.',
        }],
      },
    }),
  }),
  defineRuleFixture({
    code: 'REMOVABLE_FORWARDER',
    expectFire: false,
    reason: 'The delay alert observer may not reach a Repository directly, so for that caller the orchestrator is required — one such caller is enough to keep it.',
    scenario:
      'Both the tracking portal and a delay alert observer ask the shipment lookup orchestrator for a shipment; the portal could read the shipment repository itself, the observer could not.',
    tree: {
      system: SYSTEM,
      subsystems: [TRACKING_SUB],
      components: [
        TRACKING_PORTAL,
        {
          id: 'delay-alert-observer',
          componentType: 'Observer',
          description: 'Listens for vessel delay events and looks up the shipments they affect.',
          dependsOn: ['shipment-lookup-orchestrator'],
        },
        lookupOrchestrator(['shipment-repository']),
        ...SHIPMENT_DATA,
      ],
      interfaces: [
        TRACKING_PORTAL_CONTRACT,
        {
          id: 'idelay_alert_observer',
          component: 'delay-alert-observer',
          methods: [{ name: 'onVesselDelayed', description: 'React to a vessel delay by looking up the affected shipment.' }],
        },
        LOOKUP_CONTRACT,
        SHIPMENT_REPOSITORY_CONTRACT,
      ],
      implementations: [
        TRACKING_PORTAL_IMPL,
        {
          id: 'delay_alert_observer_impl',
          contract: 'idelay_alert_observer',
          methods: [handsOff('onVesselDelayed', 'shipment-lookup-orchestrator', 'trackShipment')],
        },
        lookupImpl('shipment-repository', 'findShipment'),
      ],
    },
  }),
];
