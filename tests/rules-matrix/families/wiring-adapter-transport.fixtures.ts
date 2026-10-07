/**
 * Adapter transport fixtures (adapterTransportRule in
 * src/core/rules/wiring/adapter-transport.ts, and the Adapter allowance in
 * portalFieldsRule).
 *
 * Documented intents pinned here:
 *  - ADAPTER_TRANSPORT_MISMATCH (error): an Adapter calls a verb on its target
 *    Portal's interface, so its transport is the target's. It MAY state its
 *    own; one that disagrees with a Portal it calls is an error, so a Portal's
 *    transport change shows its impact on every Adapter that calls it.
 *  - UNEXPECTED_PORTAL_FIELD stays silent on an Adapter's transport: it is the
 *    one it calls over, the one non-Portal block that may state one.
 */
import { defineRuleFixture } from '../harness.js';

const SYSTEM = {
  name: 'ParcelPost',
  vision: 'Parcel tracking for a courier: a tracking service and the depot workers that report scans to it.',
};

const SUBSYSTEMS = [
  { id: 'tracking', description: 'The parcel tracking service and its API.' },
  { id: 'depot', description: 'The depot workers that report parcel scans.' },
];

/** The tracking API, an HTTP Portal, and the depot's client Adapter calling it. */
function tree(adapterTransport: string | undefined) {
  return {
    system: SYSTEM,
    subsystems: SUBSYSTEMS,
    components: [
      {
        id: 'tracking-api', componentType: 'Portal', transport: 'HTTP', subsystem: 'tracking',
        description: 'The tracking service API the depots report scans to.',
      },
      {
        id: 'tracking-client', componentType: 'Adapter', subsystem: 'depot', dependsOn: ['tracking-api'],
        ...(adapterTransport ? { transport: adapterTransport } : {}),
        description: 'Reports a depot scan to the tracking service.',
      },
    ],
    interfaces: [
      {
        id: 'itracking-api', component: 'tracking-api',
        methods: [{ name: 'recordScan', description: 'Record one parcel scan.', signature: 'recordScan(): void', returns: 'void', endpoint: { transport: 'HTTP', method: 'POST', path: '/scans' } }],
      },
      {
        id: 'itracking-client', component: 'tracking-client',
        methods: [{ name: 'report', description: 'Report one scan.', signature: 'report(): void', returns: 'void', invokedBy: { kind: 'runtime', caller: 'The depot scanner loop, once per scanned parcel.' } }],
      },
    ],
    implementations: [{
      id: 'tracking-client-impl', contract: 'itracking-client',
      methods: [{ name: 'report', narrative: [{ stepNumber: 1, type: 'call', description: 'Record the scan.', targetComponent: 'tracking-api', targetMethod: 'recordScan' }] }],
    }],
  };
}

export default [
  defineRuleFixture({
    code: 'ADAPTER_TRANSPORT_MISMATCH',
    severity: 'error',
    anchoredTo: 'tracking-client',
    expectFire: true,
    scenario:
      'The depot\'s tracking client states it calls over gRPC, but the tracking API it calls is an HTTP Portal — the API moved to HTTP and the client was never updated.',
    tree: tree('gRPC'),
  }),
  defineRuleFixture({
    code: 'ADAPTER_TRANSPORT_MISMATCH',
    expectFire: false,
    reason: 'The client states HTTP, the transport of the tracking API it calls: the Adapter and its target agree.',
    scenario: 'The depot\'s tracking client states HTTP, matching the HTTP tracking API it reports scans to.',
    tree: tree('HTTP'),
  }),
  defineRuleFixture({
    code: 'ADAPTER_TRANSPORT_MISMATCH',
    expectFire: false,
    reason: 'An Adapter that states no transport takes its target\'s: nothing to disagree with.',
    scenario: 'The depot\'s tracking client states no transport; it is inferred from the HTTP tracking API it calls.',
    tree: tree(undefined),
  }),
  defineRuleFixture({
    code: 'UNEXPECTED_PORTAL_FIELD',
    expectFire: false,
    reason: 'An Adapter may state the transport it calls its target Portal over; only abi and basePath stay Portal-only.',
    scenario: 'The depot\'s tracking client states HTTP, the transport it reports scans over.',
    tree: tree('HTTP'),
  }),
];
