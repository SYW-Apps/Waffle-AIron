/**
 * Contract ↔ implementation symmetry and narrative target resolution
 * (src/core/rules/contracts.ts).
 *
 * Documented intents pinned here:
 *  - UNEXPECTED_IMPLEMENTATION_METHOD (error): implementation declares a method
 *    the contract does not define — implementations mirror their contract
 *    method-for-method.
 *  - MISSING_IMPLEMENTATION_METHOD (error): a contract method has no
 *    implementation counterpart.
 *  - MISSING_TARGET_METHOD (error): a call/register step names no
 *    `targetMethod`. Register steps (runtime-callback handoffs) share the
 *    IDENTICAL target shape with call steps, so both step kinds get a pair.
 *  - INVALID_TARGET_COMPONENT_REFERENCE (error): a call/dispatch/register step
 *    names a component that does not exist (a BARE unresolved id — a local
 *    typo, not a cross-tree form). Covered for the call and dispatch shapes.
 *  - UNDECLARED_DEPENDENCY_CALL (error): the step's target exists but the
 *    calling component neither depends on nor owns it. Covered for the call
 *    and dispatch shapes (the rule documents they share this check).
 *  - INVALID_TARGET_METHOD_REFERENCE (error): the target component exists and
 *    is a declared dependency, but no interface of it defines the named
 *    method. Covered for the call and register shapes.
 *  - NARRATIVE_SEMANTIC_UNBACKED (warning): a step asserts a semantic
 *    guarantee the called contract does not declare. Covered for the local
 *    (in-tree L3 contract) path and the cross-tree (surface snapshot) path.
 *
 * NOTE on scope: these codes pin method-NAME symmetry and target resolution.
 * The contracts rule deliberately does not compare signatures/params/returns —
 * its documented contract is "mirror the contract method-for-method" by name.
 */
import * as yaml from 'js-yaml';
import { defineRuleFixture } from '../harness.js';

const TS = '2026-01-01T00:00:00.000Z';

/** A generated-origin parent surface snapshot, dumped as snapshot YAML. */
function surfaceYaml(snapshot: Record<string, unknown>): string {
  return yaml.dump(
    { origin: 'generated', stateId: 'sha256:feedfacefeedface', generatedAt: TS, types: [], ...snapshot },
    { noRefs: true, lineWidth: 200 },
  );
}

// ---------------------------------------------------------------------------
// A reusable miniature freight-booking domain: a booking orchestrator that
// drives a dock registry. Each fixture varies exactly the defect under test.
// ---------------------------------------------------------------------------

const bookingComponents = (orchestratorDeps: string[]) => [
  {
    id: 'booking-orchestrator',
    componentType: 'Orchestrator',
    subsystem: 'freight-booking',
    description: 'Coordinates dock reservations for inbound freight bookings.',
    dependsOn: orchestratorDeps,
  },
  {
    id: 'dock-registry',
    componentType: 'Registry',
    subsystem: 'freight-booking',
    description: 'Registers dock definitions and their reservation windows.',
  },
];

const dockRegistryInterface = (methods: Record<string, unknown>[]) => ({
  id: 'idock_registry',
  component: 'dock-registry',
  methods,
});

export default [
  // -------------------------------------------------------------------------
  // UNEXPECTED_IMPLEMENTATION_METHOD
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'UNEXPECTED_IMPLEMENTATION_METHOD',
    severity: 'error',
    anchoredTo: 'dock_registry_impl',
    expectFire: true,
    scenario:
      'The dock registry implementation grew a purgeExpired method that its contract never defined, so consumers cannot see it in the L3 interface.',
    tree: {
      subsystems: [{ id: 'freight-booking', description: 'Dock reservation booking for inbound freight.' }],
      components: [bookingComponents([])[1]],
      interfaces: [
        dockRegistryInterface([{ name: 'reserveDock', description: 'Reserve a dock for a delivery window.' }]),
      ],
      implementations: [
        {
          id: 'dock_registry_impl',
          contract: 'idock_registry',
          methods: [
            {
              name: 'reserveDock',
              narrative: [{ stepNumber: 1, type: 'local', description: 'Record the reservation window on the dock entry.' }],
            },
            {
              // The defect: a method the contract does not define.
              name: 'purgeExpired',
              narrative: [{ stepNumber: 1, type: 'local', description: 'Drop reservation windows that ended in the past.' }],
            },
          ],
        },
      ],
    },
  }),
  defineRuleFixture({
    code: 'UNEXPECTED_IMPLEMENTATION_METHOD',
    expectFire: false,
    reason: 'Every implementation method exists on the contract — the mirror is method-for-method.',
    scenario:
      'The dock registry implementation implements exactly the reserveDock and purgeExpired methods its contract defines.',
    tree: {
      subsystems: [{ id: 'freight-booking', description: 'Dock reservation booking for inbound freight.' }],
      components: [bookingComponents([])[1]],
      interfaces: [
        dockRegistryInterface([
          { name: 'reserveDock', description: 'Reserve a dock for a delivery window.' },
          { name: 'purgeExpired', description: 'Drop reservation windows that ended in the past.' },
        ]),
      ],
      implementations: [
        {
          id: 'dock_registry_impl',
          contract: 'idock_registry',
          methods: [
            {
              name: 'reserveDock',
              narrative: [{ stepNumber: 1, type: 'local', description: 'Record the reservation window on the dock entry.' }],
            },
            {
              name: 'purgeExpired',
              narrative: [{ stepNumber: 1, type: 'local', description: 'Drop reservation windows that ended in the past.' }],
            },
          ],
        },
      ],
    },
  }),

  // -------------------------------------------------------------------------
  // MISSING_IMPLEMENTATION_METHOD
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'MISSING_IMPLEMENTATION_METHOD',
    severity: 'error',
    anchoredTo: 'dock_registry_impl',
    expectFire: true,
    scenario:
      'The dock registry contract promises releaseDock, but the implementation spec never realizes it, leaving half the contract unimplemented.',
    tree: {
      subsystems: [{ id: 'freight-booking', description: 'Dock reservation booking for inbound freight.' }],
      components: [bookingComponents([])[1]],
      interfaces: [
        dockRegistryInterface([
          { name: 'reserveDock', description: 'Reserve a dock for a delivery window.' },
          { name: 'releaseDock', description: 'Release a dock reservation before its window starts.' },
        ]),
      ],
      implementations: [
        {
          id: 'dock_registry_impl',
          contract: 'idock_registry',
          methods: [
            {
              name: 'reserveDock',
              narrative: [{ stepNumber: 1, type: 'local', description: 'Record the reservation window on the dock entry.' }],
            },
            // The defect: releaseDock is absent.
          ],
        },
      ],
    },
  }),
  defineRuleFixture({
    code: 'MISSING_IMPLEMENTATION_METHOD',
    expectFire: false,
    reason: 'Both contract methods have implementation counterparts.',
    scenario:
      'The dock registry implementation realizes both reserveDock and releaseDock exactly as its contract defines them.',
    tree: {
      subsystems: [{ id: 'freight-booking', description: 'Dock reservation booking for inbound freight.' }],
      components: [bookingComponents([])[1]],
      interfaces: [
        dockRegistryInterface([
          { name: 'reserveDock', description: 'Reserve a dock for a delivery window.' },
          { name: 'releaseDock', description: 'Release a dock reservation before its window starts.' },
        ]),
      ],
      implementations: [
        {
          id: 'dock_registry_impl',
          contract: 'idock_registry',
          methods: [
            {
              name: 'reserveDock',
              narrative: [{ stepNumber: 1, type: 'local', description: 'Record the reservation window on the dock entry.' }],
            },
            {
              name: 'releaseDock',
              narrative: [{ stepNumber: 1, type: 'local', description: 'Clear the reservation window from the dock entry.' }],
            },
          ],
        },
      ],
    },
  }),

  // -------------------------------------------------------------------------
  // MISSING_TARGET_METHOD — call-step shape
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'MISSING_TARGET_METHOD',
    severity: 'error',
    anchoredTo: 'booking_orchestrator_impl',
    expectFire: true,
    scenario:
      'The booking orchestrator narrative calls into the dock registry but its call step names no targetMethod, so the contract edge is unverifiable.',
    tree: {
      subsystems: [{ id: 'freight-booking', description: 'Dock reservation booking for inbound freight.' }],
      components: bookingComponents(['dock-registry']),
      interfaces: [
        {
          id: 'ibooking_orchestrator',
          component: 'booking-orchestrator',
          methods: [{ name: 'bookDelivery', description: 'Book a dock slot for an inbound delivery.' }],
        },
        dockRegistryInterface([{ name: 'reserveDock', description: 'Reserve a dock for a delivery window.' }]),
      ],
      implementations: [
        {
          id: 'booking_orchestrator_impl',
          contract: 'ibooking_orchestrator',
          methods: [
            {
              name: 'bookDelivery',
              narrative: [
                // The defect: targetComponent present, targetMethod missing.
                { stepNumber: 1, type: 'call', description: 'Reserve a dock for the delivery window.', targetComponent: 'dock-registry' },
              ],
            },
          ],
        },
      ],
    },
  }),
  defineRuleFixture({
    code: 'MISSING_TARGET_METHOD',
    expectFire: false,
    reason: 'The call step names both targetComponent and targetMethod, so the edge is fully modeled.',
    scenario:
      'The booking orchestrator narrative calls reserveDock on the dock registry with an explicit targetMethod.',
    tree: {
      subsystems: [{ id: 'freight-booking', description: 'Dock reservation booking for inbound freight.' }],
      components: bookingComponents(['dock-registry']),
      interfaces: [
        {
          id: 'ibooking_orchestrator',
          component: 'booking-orchestrator',
          methods: [{ name: 'bookDelivery', description: 'Book a dock slot for an inbound delivery.' }],
        },
        dockRegistryInterface([{ name: 'reserveDock', description: 'Reserve a dock for a delivery window.' }]),
      ],
      implementations: [
        {
          id: 'booking_orchestrator_impl',
          contract: 'ibooking_orchestrator',
          methods: [
            {
              name: 'bookDelivery',
              narrative: [
                { stepNumber: 1, type: 'call', description: 'Reserve a dock for the delivery window.', targetComponent: 'dock-registry', targetMethod: 'reserveDock' },
              ],
            },
          ],
        },
      ],
    },
  }),

  // -------------------------------------------------------------------------
  // MISSING_TARGET_METHOD — register-step shape (runtime-callback handoff)
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'MISSING_TARGET_METHOD',
    severity: 'error',
    anchoredTo: 'booking_orchestrator_impl',
    expectFire: true,
    scenario:
      'The booking orchestrator registers an expiry callback on the dock registry, but the register step names no targetMethod for the handoff.',
    tree: {
      subsystems: [{ id: 'freight-booking', description: 'Dock reservation booking for inbound freight.' }],
      components: bookingComponents(['dock-registry']),
      interfaces: [
        {
          id: 'ibooking_orchestrator',
          component: 'booking-orchestrator',
          methods: [{ name: 'watchExpiries', description: 'Arrange to be told when a reservation window lapses.' }],
        },
        dockRegistryInterface([{ name: 'onWindowLapsed', description: 'Register a callback fired when a reservation window lapses.' }]),
      ],
      implementations: [
        {
          id: 'booking_orchestrator_impl',
          contract: 'ibooking_orchestrator',
          methods: [
            {
              name: 'watchExpiries',
              narrative: [
                // The defect: a register handoff without a targetMethod.
                { stepNumber: 1, type: 'register', description: 'Register the lapse callback with the dock registry.', targetComponent: 'dock-registry' },
              ],
            },
          ],
        },
      ],
    },
  }),
  defineRuleFixture({
    code: 'MISSING_TARGET_METHOD',
    expectFire: false,
    reason: 'The register handoff names its targetMethod — the callback edge points at a real dependency method.',
    scenario:
      'The booking orchestrator registers its lapse callback through onWindowLapsed on the dock registry, named explicitly on the register step.',
    tree: {
      subsystems: [{ id: 'freight-booking', description: 'Dock reservation booking for inbound freight.' }],
      components: bookingComponents(['dock-registry']),
      interfaces: [
        {
          id: 'ibooking_orchestrator',
          component: 'booking-orchestrator',
          methods: [{ name: 'watchExpiries', description: 'Arrange to be told when a reservation window lapses.' }],
        },
        dockRegistryInterface([{ name: 'onWindowLapsed', description: 'Register a callback fired when a reservation window lapses.' }]),
      ],
      implementations: [
        {
          id: 'booking_orchestrator_impl',
          contract: 'ibooking_orchestrator',
          methods: [
            {
              name: 'watchExpiries',
              narrative: [
                { stepNumber: 1, type: 'register', description: 'Register the lapse callback with the dock registry.', targetComponent: 'dock-registry', targetMethod: 'onWindowLapsed' },
              ],
            },
          ],
        },
      ],
    },
  }),

  // -------------------------------------------------------------------------
  // INVALID_TARGET_COMPONENT_REFERENCE — call-step shape (bare local typo)
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'INVALID_TARGET_COMPONENT_REFERENCE',
    severity: 'error',
    anchoredTo: 'booking_orchestrator_impl',
    expectFire: true,
    scenario:
      'The booking orchestrator narrative calls a dock-catalog component that does not exist anywhere in the tree — a bare local typo, not a cross-tree form.',
    tree: {
      subsystems: [{ id: 'freight-booking', description: 'Dock reservation booking for inbound freight.' }],
      components: bookingComponents(['dock-registry']),
      interfaces: [
        {
          id: 'ibooking_orchestrator',
          component: 'booking-orchestrator',
          methods: [{ name: 'bookDelivery', description: 'Book a dock slot for an inbound delivery.' }],
        },
        dockRegistryInterface([{ name: 'reserveDock', description: 'Reserve a dock for a delivery window.' }]),
      ],
      implementations: [
        {
          id: 'booking_orchestrator_impl',
          contract: 'ibooking_orchestrator',
          methods: [
            {
              name: 'bookDelivery',
              narrative: [
                // The defect: "dock-catalog" exists nowhere.
                { stepNumber: 1, type: 'call', description: 'Reserve a dock for the delivery window.', targetComponent: 'dock-catalog', targetMethod: 'reserveDock' },
              ],
            },
          ],
        },
      ],
    },
  }),
  defineRuleFixture({
    code: 'INVALID_TARGET_COMPONENT_REFERENCE',
    expectFire: false,
    reason: 'The call step targets the dock-registry component that actually exists in the tree.',
    scenario:
      'The booking orchestrator narrative calls reserveDock on the existing dock registry component.',
    tree: {
      subsystems: [{ id: 'freight-booking', description: 'Dock reservation booking for inbound freight.' }],
      components: bookingComponents(['dock-registry']),
      interfaces: [
        {
          id: 'ibooking_orchestrator',
          component: 'booking-orchestrator',
          methods: [{ name: 'bookDelivery', description: 'Book a dock slot for an inbound delivery.' }],
        },
        dockRegistryInterface([{ name: 'reserveDock', description: 'Reserve a dock for a delivery window.' }]),
      ],
      implementations: [
        {
          id: 'booking_orchestrator_impl',
          contract: 'ibooking_orchestrator',
          methods: [
            {
              name: 'bookDelivery',
              narrative: [
                { stepNumber: 1, type: 'call', description: 'Reserve a dock for the delivery window.', targetComponent: 'dock-registry', targetMethod: 'reserveDock' },
              ],
            },
          ],
        },
      ],
    },
  }),

  // -------------------------------------------------------------------------
  // INVALID_TARGET_COMPONENT_REFERENCE — dispatch-step shape
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'INVALID_TARGET_COMPONENT_REFERENCE',
    severity: 'error',
    anchoredTo: 'quote_router_impl',
    expectFire: true,
    scenario:
      'The quote router narrative dispatches a rating capability through a pricing-portal component that exists nowhere in the tree.',
    tree: {
      subsystems: [{ id: 'freight-quoting', description: 'Carrier quote rating and routing.' }],
      components: [
        {
          id: 'quote-router',
          componentType: 'Orchestrator',
          subsystem: 'freight-quoting',
          description: 'Routes rating requests to the pricing surface.',
        },
      ],
      interfaces: [
        {
          id: 'iquote_router',
          component: 'quote-router',
          methods: [{ name: 'rateShipment', description: 'Obtain a rated quote for a shipment.' }],
        },
      ],
      implementations: [
        {
          id: 'quote_router_impl',
          contract: 'iquote_router',
          methods: [
            {
              name: 'rateShipment',
              narrative: [
                // The defect: the dispatch target portal does not exist.
                { stepNumber: 1, type: 'dispatch', description: 'Dispatch the rating request through the pricing portal.', targetComponent: 'pricing-portal', capability: 'rates.quote' },
              ],
            },
          ],
        },
      ],
    },
  }),
  defineRuleFixture({
    code: 'INVALID_TARGET_COMPONENT_REFERENCE',
    expectFire: false,
    reason: 'The dispatch step routes through a pricing portal that exists and is a declared dependency.',
    scenario:
      'The quote router narrative dispatches its rating capability through the existing pricing portal component.',
    tree: {
      subsystems: [{ id: 'freight-quoting', description: 'Carrier quote rating and routing.' }],
      components: [
        {
          id: 'quote-router',
          componentType: 'Orchestrator',
          subsystem: 'freight-quoting',
          description: 'Routes rating requests to the pricing surface.',
          dependsOn: ['pricing-portal'],
        },
        {
          id: 'pricing-portal',
          componentType: 'Portal',
          subsystem: 'freight-quoting',
          portalType: 'Custom',
          description: 'Generic capability surface for rating requests.',
          dependsOn: ['rate-calculator'],
          dispatch: [{ capability: 'rates.quote', component: 'rate-calculator', method: 'computeQuote' }],
        },
        {
          id: 'rate-calculator',
          componentType: 'Specialist',
          subsystem: 'freight-quoting',
          description: 'Computes rated quotes from carrier tariffs.',
        },
      ],
      interfaces: [
        {
          id: 'iquote_router',
          component: 'quote-router',
          methods: [{ name: 'rateShipment', description: 'Obtain a rated quote for a shipment.' }],
        },
        {
          id: 'ipricing_portal',
          component: 'pricing-portal',
          methods: [{ name: 'handleCapability', description: 'Generic capability envelope dispatched by capability name.' }],
        },
        {
          id: 'irate_calculator',
          component: 'rate-calculator',
          methods: [{ name: 'computeQuote', description: 'Compute a rated quote from the tariff tables.' }],
        },
      ],
      implementations: [
        {
          id: 'quote_router_impl',
          contract: 'iquote_router',
          methods: [
            {
              name: 'rateShipment',
              narrative: [
                { stepNumber: 1, type: 'dispatch', description: 'Dispatch the rating request through the pricing portal.', targetComponent: 'pricing-portal', capability: 'rates.quote' },
              ],
            },
          ],
        },
      ],
    },
  }),

  // -------------------------------------------------------------------------
  // UNDECLARED_DEPENDENCY_CALL — call-step shape
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'UNDECLARED_DEPENDENCY_CALL',
    severity: 'error',
    anchoredTo: 'booking_orchestrator_impl',
    expectFire: true,
    scenario:
      'The booking orchestrator narrative calls the dock registry, but the orchestrator component never declares dock-registry as a dependency.',
    tree: {
      subsystems: [{ id: 'freight-booking', description: 'Dock reservation booking for inbound freight.' }],
      // The defect: dependsOn is empty while the narrative calls dock-registry.
      components: bookingComponents([]),
      interfaces: [
        {
          id: 'ibooking_orchestrator',
          component: 'booking-orchestrator',
          methods: [{ name: 'bookDelivery', description: 'Book a dock slot for an inbound delivery.' }],
        },
        dockRegistryInterface([{ name: 'reserveDock', description: 'Reserve a dock for a delivery window.' }]),
      ],
      implementations: [
        {
          id: 'booking_orchestrator_impl',
          contract: 'ibooking_orchestrator',
          methods: [
            {
              name: 'bookDelivery',
              narrative: [
                { stepNumber: 1, type: 'call', description: 'Reserve a dock for the delivery window.', targetComponent: 'dock-registry', targetMethod: 'reserveDock' },
              ],
            },
          ],
        },
      ],
    },
  }),
  defineRuleFixture({
    code: 'UNDECLARED_DEPENDENCY_CALL',
    expectFire: false,
    reason: 'The caller declares dock-registry in dependsOn, so the narrative edge is backed by a declared collaborator edge.',
    scenario:
      'The booking orchestrator declares its dock registry dependency and calls reserveDock on it.',
    tree: {
      subsystems: [{ id: 'freight-booking', description: 'Dock reservation booking for inbound freight.' }],
      components: bookingComponents(['dock-registry']),
      interfaces: [
        {
          id: 'ibooking_orchestrator',
          component: 'booking-orchestrator',
          methods: [{ name: 'bookDelivery', description: 'Book a dock slot for an inbound delivery.' }],
        },
        dockRegistryInterface([{ name: 'reserveDock', description: 'Reserve a dock for a delivery window.' }]),
      ],
      implementations: [
        {
          id: 'booking_orchestrator_impl',
          contract: 'ibooking_orchestrator',
          methods: [
            {
              name: 'bookDelivery',
              narrative: [
                { stepNumber: 1, type: 'call', description: 'Reserve a dock for the delivery window.', targetComponent: 'dock-registry', targetMethod: 'reserveDock' },
              ],
            },
          ],
        },
      ],
    },
  }),

  // -------------------------------------------------------------------------
  // UNDECLARED_DEPENDENCY_CALL — dispatch-step shape
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'UNDECLARED_DEPENDENCY_CALL',
    severity: 'error',
    anchoredTo: 'quote_router_impl',
    expectFire: true,
    scenario:
      'The quote router dispatches through the pricing portal without declaring the portal as a dependency of the router component.',
    tree: {
      subsystems: [{ id: 'freight-quoting', description: 'Carrier quote rating and routing.' }],
      components: [
        {
          id: 'quote-router',
          componentType: 'Orchestrator',
          subsystem: 'freight-quoting',
          description: 'Routes rating requests to the pricing surface.',
          // The defect: pricing-portal is not declared here.
          dependsOn: [],
        },
        {
          id: 'pricing-portal',
          componentType: 'Portal',
          subsystem: 'freight-quoting',
          portalType: 'Custom',
          description: 'Generic capability surface for rating requests.',
          dependsOn: ['rate-calculator'],
          dispatch: [{ capability: 'rates.quote', component: 'rate-calculator', method: 'computeQuote' }],
        },
        {
          id: 'rate-calculator',
          componentType: 'Specialist',
          subsystem: 'freight-quoting',
          description: 'Computes rated quotes from carrier tariffs.',
        },
      ],
      interfaces: [
        {
          id: 'iquote_router',
          component: 'quote-router',
          methods: [{ name: 'rateShipment', description: 'Obtain a rated quote for a shipment.' }],
        },
        {
          id: 'ipricing_portal',
          component: 'pricing-portal',
          methods: [{ name: 'handleCapability', description: 'Generic capability envelope dispatched by capability name.' }],
        },
        {
          id: 'irate_calculator',
          component: 'rate-calculator',
          methods: [{ name: 'computeQuote', description: 'Compute a rated quote from the tariff tables.' }],
        },
      ],
      implementations: [
        {
          id: 'quote_router_impl',
          contract: 'iquote_router',
          methods: [
            {
              name: 'rateShipment',
              narrative: [
                { stepNumber: 1, type: 'dispatch', description: 'Dispatch the rating request through the pricing portal.', targetComponent: 'pricing-portal', capability: 'rates.quote' },
              ],
            },
          ],
        },
      ],
    },
  }),
  defineRuleFixture({
    code: 'UNDECLARED_DEPENDENCY_CALL',
    expectFire: false,
    reason: 'The router declares the pricing portal in dependsOn, so the dispatch is backed by a declared edge.',
    scenario:
      'The quote router declares the pricing portal dependency and dispatches its rating capability through it.',
    tree: {
      subsystems: [{ id: 'freight-quoting', description: 'Carrier quote rating and routing.' }],
      components: [
        {
          id: 'quote-router',
          componentType: 'Orchestrator',
          subsystem: 'freight-quoting',
          description: 'Routes rating requests to the pricing surface.',
          dependsOn: ['pricing-portal'],
        },
        {
          id: 'pricing-portal',
          componentType: 'Portal',
          subsystem: 'freight-quoting',
          portalType: 'Custom',
          description: 'Generic capability surface for rating requests.',
          dependsOn: ['rate-calculator'],
          dispatch: [{ capability: 'rates.quote', component: 'rate-calculator', method: 'computeQuote' }],
        },
        {
          id: 'rate-calculator',
          componentType: 'Specialist',
          subsystem: 'freight-quoting',
          description: 'Computes rated quotes from carrier tariffs.',
        },
      ],
      interfaces: [
        {
          id: 'iquote_router',
          component: 'quote-router',
          methods: [{ name: 'rateShipment', description: 'Obtain a rated quote for a shipment.' }],
        },
        {
          id: 'ipricing_portal',
          component: 'pricing-portal',
          methods: [{ name: 'handleCapability', description: 'Generic capability envelope dispatched by capability name.' }],
        },
        {
          id: 'irate_calculator',
          component: 'rate-calculator',
          methods: [{ name: 'computeQuote', description: 'Compute a rated quote from the tariff tables.' }],
        },
      ],
      implementations: [
        {
          id: 'quote_router_impl',
          contract: 'iquote_router',
          methods: [
            {
              name: 'rateShipment',
              narrative: [
                { stepNumber: 1, type: 'dispatch', description: 'Dispatch the rating request through the pricing portal.', targetComponent: 'pricing-portal', capability: 'rates.quote' },
              ],
            },
          ],
        },
      ],
    },
  }),

  // -------------------------------------------------------------------------
  // INVALID_TARGET_METHOD_REFERENCE — call-step shape
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'INVALID_TARGET_METHOD_REFERENCE',
    severity: 'error',
    anchoredTo: 'booking_orchestrator_impl',
    expectFire: true,
    scenario:
      'The booking orchestrator calls holdDock on the dock registry, but no interface of the registry defines a holdDock method.',
    tree: {
      subsystems: [{ id: 'freight-booking', description: 'Dock reservation booking for inbound freight.' }],
      components: bookingComponents(['dock-registry']),
      interfaces: [
        {
          id: 'ibooking_orchestrator',
          component: 'booking-orchestrator',
          methods: [{ name: 'bookDelivery', description: 'Book a dock slot for an inbound delivery.' }],
        },
        dockRegistryInterface([{ name: 'reserveDock', description: 'Reserve a dock for a delivery window.' }]),
      ],
      implementations: [
        {
          id: 'booking_orchestrator_impl',
          contract: 'ibooking_orchestrator',
          methods: [
            {
              name: 'bookDelivery',
              narrative: [
                // The defect: holdDock is not on any dock-registry interface.
                { stepNumber: 1, type: 'call', description: 'Hold a dock for the delivery window.', targetComponent: 'dock-registry', targetMethod: 'holdDock' },
              ],
            },
          ],
        },
      ],
    },
  }),
  defineRuleFixture({
    code: 'INVALID_TARGET_METHOD_REFERENCE',
    expectFire: false,
    reason: 'The called method reserveDock exists on the dock registry contract.',
    scenario:
      'The booking orchestrator calls reserveDock, a method the dock registry contract actually defines.',
    tree: {
      subsystems: [{ id: 'freight-booking', description: 'Dock reservation booking for inbound freight.' }],
      components: bookingComponents(['dock-registry']),
      interfaces: [
        {
          id: 'ibooking_orchestrator',
          component: 'booking-orchestrator',
          methods: [{ name: 'bookDelivery', description: 'Book a dock slot for an inbound delivery.' }],
        },
        dockRegistryInterface([{ name: 'reserveDock', description: 'Reserve a dock for a delivery window.' }]),
      ],
      implementations: [
        {
          id: 'booking_orchestrator_impl',
          contract: 'ibooking_orchestrator',
          methods: [
            {
              name: 'bookDelivery',
              narrative: [
                { stepNumber: 1, type: 'call', description: 'Reserve a dock for the delivery window.', targetComponent: 'dock-registry', targetMethod: 'reserveDock' },
              ],
            },
          ],
        },
      ],
    },
  }),

  // -------------------------------------------------------------------------
  // INVALID_TARGET_METHOD_REFERENCE — register-step shape
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'INVALID_TARGET_METHOD_REFERENCE',
    severity: 'error',
    anchoredTo: 'booking_orchestrator_impl',
    expectFire: true,
    scenario:
      'The booking orchestrator registers its lapse callback through onDockExpired, a hook the dock registry contract never defines.',
    tree: {
      subsystems: [{ id: 'freight-booking', description: 'Dock reservation booking for inbound freight.' }],
      components: bookingComponents(['dock-registry']),
      interfaces: [
        {
          id: 'ibooking_orchestrator',
          component: 'booking-orchestrator',
          methods: [{ name: 'watchExpiries', description: 'Arrange to be told when a reservation window lapses.' }],
        },
        dockRegistryInterface([{ name: 'onWindowLapsed', description: 'Register a callback fired when a reservation window lapses.' }]),
      ],
      implementations: [
        {
          id: 'booking_orchestrator_impl',
          contract: 'ibooking_orchestrator',
          methods: [
            {
              name: 'watchExpiries',
              narrative: [
                // The defect: onDockExpired does not exist on the registry contract.
                { stepNumber: 1, type: 'register', description: 'Register the lapse callback with the dock registry.', targetComponent: 'dock-registry', targetMethod: 'onDockExpired' },
              ],
            },
          ],
        },
      ],
    },
  }),
  defineRuleFixture({
    code: 'INVALID_TARGET_METHOD_REFERENCE',
    expectFire: false,
    reason: 'The register handoff points at onWindowLapsed, which the dock registry contract defines.',
    scenario:
      'The booking orchestrator registers its lapse callback through the onWindowLapsed hook the dock registry contract defines.',
    tree: {
      subsystems: [{ id: 'freight-booking', description: 'Dock reservation booking for inbound freight.' }],
      components: bookingComponents(['dock-registry']),
      interfaces: [
        {
          id: 'ibooking_orchestrator',
          component: 'booking-orchestrator',
          methods: [{ name: 'watchExpiries', description: 'Arrange to be told when a reservation window lapses.' }],
        },
        dockRegistryInterface([{ name: 'onWindowLapsed', description: 'Register a callback fired when a reservation window lapses.' }]),
      ],
      implementations: [
        {
          id: 'booking_orchestrator_impl',
          contract: 'ibooking_orchestrator',
          methods: [
            {
              name: 'watchExpiries',
              narrative: [
                { stepNumber: 1, type: 'register', description: 'Register the lapse callback with the dock registry.', targetComponent: 'dock-registry', targetMethod: 'onWindowLapsed' },
              ],
            },
          ],
        },
      ],
    },
  }),

  // -------------------------------------------------------------------------
  // NARRATIVE_SEMANTIC_UNBACKED — local (in-tree contract) path
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'NARRATIVE_SEMANTIC_UNBACKED',
    severity: 'warning',
    anchoredTo: 'booking_orchestrator_impl',
    expectFire: true,
    scenario:
      'The booking orchestrator narrative asserts the reserveDock call is idempotent, but the dock registry contract declares no idempotent guarantee on that method.',
    tree: {
      subsystems: [{ id: 'freight-booking', description: 'Dock reservation booking for inbound freight.' }],
      components: bookingComponents(['dock-registry']),
      interfaces: [
        {
          id: 'ibooking_orchestrator',
          component: 'booking-orchestrator',
          methods: [{ name: 'bookDelivery', description: 'Book a dock slot for an inbound delivery.' }],
        },
        dockRegistryInterface([
          // The defect: no `guarantees` on the called method.
          { name: 'reserveDock', description: 'Reserve a dock for a delivery window.' },
        ]),
      ],
      implementations: [
        {
          id: 'booking_orchestrator_impl',
          contract: 'ibooking_orchestrator',
          methods: [
            {
              name: 'bookDelivery',
              narrative: [
                {
                  stepNumber: 1,
                  type: 'call',
                  description: 'Reserve a dock; retried safely on timeout because the reservation is idempotent.',
                  targetComponent: 'dock-registry',
                  targetMethod: 'reserveDock',
                  assertsGuarantees: ['idempotent'],
                },
              ],
            },
          ],
        },
      ],
    },
  }),
  defineRuleFixture({
    code: 'NARRATIVE_SEMANTIC_UNBACKED',
    expectFire: false,
    reason: 'The called contract method declares the idempotent guarantee the narrative asserts, so the claim is backed.',
    scenario:
      'The booking orchestrator asserts idempotency on a reserveDock call whose contract explicitly declares the idempotent guarantee.',
    tree: {
      subsystems: [{ id: 'freight-booking', description: 'Dock reservation booking for inbound freight.' }],
      components: bookingComponents(['dock-registry']),
      interfaces: [
        {
          id: 'ibooking_orchestrator',
          component: 'booking-orchestrator',
          methods: [{ name: 'bookDelivery', description: 'Book a dock slot for an inbound delivery.' }],
        },
        dockRegistryInterface([
          { name: 'reserveDock', description: 'Reserve a dock for a delivery window.', guarantees: ['idempotent'] },
        ]),
      ],
      implementations: [
        {
          id: 'booking_orchestrator_impl',
          contract: 'ibooking_orchestrator',
          methods: [
            {
              name: 'bookDelivery',
              narrative: [
                {
                  stepNumber: 1,
                  type: 'call',
                  description: 'Reserve a dock; retried safely on timeout because the reservation is idempotent.',
                  targetComponent: 'dock-registry',
                  targetMethod: 'reserveDock',
                  assertsGuarantees: ['idempotent'],
                },
              ],
            },
          ],
        },
      ],
    },
  }),

  // -------------------------------------------------------------------------
  // NARRATIVE_SEMANTIC_UNBACKED — cross-tree (surface snapshot) path
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'NARRATIVE_SEMANTIC_UNBACKED',
    severity: 'warning',
    anchoredTo: 'settlement_runner_impl',
    expectFire: true,
    scenario:
      'A chained settlement subproject asserts exactly-once on a cross-tree clearinghouse call, but the vendored parent surface snapshot declares no such guarantee on that method.',
    tree: {
      subsystems: [{ id: 'settlement', description: 'Payout settlement runs against the parent clearinghouse.' }],
      components: [
        {
          id: 'settlement-runner',
          componentType: 'Orchestrator',
          subsystem: 'settlement',
          description: 'Drives payout settlement batches through the family clearinghouse.',
          dependsOn: ['super::payment-clearinghouse'],
        },
      ],
      interfaces: [
        {
          id: 'isettlement_runner',
          component: 'settlement-runner',
          methods: [{ name: 'runSettlement', description: 'Settle the cleared payout batch.' }],
        },
      ],
      implementations: [
        {
          id: 'settlement_runner_impl',
          contract: 'isettlement_runner',
          methods: [
            {
              name: 'runSettlement',
              narrative: [
                {
                  stepNumber: 1,
                  type: 'call',
                  description: 'Post the batch to the clearinghouse, relying on exactly-once submission.',
                  targetComponent: 'super::payment-clearinghouse',
                  targetMethod: 'postBatch',
                  assertsGuarantees: ['exactly-once'],
                },
              ],
            },
          ],
        },
      ],
      files: {
        '.wai/surfaces/PayCore.yaml': surfaceYaml({
          projectName: 'PayCore',
          interfaces: [
            {
              id: 'ipayment_clearinghouse',
              name: 'Payment Clearinghouse',
              component: 'payment-clearinghouse',
              audience: 'project',
              type: 'REST',
              details: 'Family clearinghouse surface for settlement batches.',
              methods: [
                {
                  name: 'postBatch',
                  description: 'Post one settlement batch for clearing.',
                  signature: 'postBatch(batchId: string): void',
                  returns: 'void',
                  // The defect: no exactly-once guarantee declared on the surface.
                },
              ],
            },
          ],
        }),
      },
    },
  }),
  defineRuleFixture({
    code: 'NARRATIVE_SEMANTIC_UNBACKED',
    expectFire: false,
    reason: 'The vendored surface snapshot declares exactly-once on postBatch, so the cross-tree assertion is backed by the declared contract.',
    scenario:
      'A chained settlement subproject asserts exactly-once on a clearinghouse call whose vendored surface snapshot declares that guarantee.',
    tree: {
      subsystems: [{ id: 'settlement', description: 'Payout settlement runs against the parent clearinghouse.' }],
      components: [
        {
          id: 'settlement-runner',
          componentType: 'Orchestrator',
          subsystem: 'settlement',
          description: 'Drives payout settlement batches through the family clearinghouse.',
          dependsOn: ['super::payment-clearinghouse'],
        },
      ],
      interfaces: [
        {
          id: 'isettlement_runner',
          component: 'settlement-runner',
          methods: [{ name: 'runSettlement', description: 'Settle the cleared payout batch.' }],
        },
      ],
      implementations: [
        {
          id: 'settlement_runner_impl',
          contract: 'isettlement_runner',
          methods: [
            {
              name: 'runSettlement',
              narrative: [
                {
                  stepNumber: 1,
                  type: 'call',
                  description: 'Post the batch to the clearinghouse, relying on exactly-once submission.',
                  targetComponent: 'super::payment-clearinghouse',
                  targetMethod: 'postBatch',
                  assertsGuarantees: ['exactly-once'],
                },
              ],
            },
          ],
        },
      ],
      files: {
        '.wai/surfaces/PayCore.yaml': surfaceYaml({
          projectName: 'PayCore',
          interfaces: [
            {
              id: 'ipayment_clearinghouse',
              name: 'Payment Clearinghouse',
              component: 'payment-clearinghouse',
              audience: 'project',
              type: 'REST',
              details: 'Family clearinghouse surface for settlement batches.',
              methods: [
                {
                  name: 'postBatch',
                  description: 'Post one settlement batch for clearing.',
                  signature: 'postBatch(batchId: string): void',
                  returns: 'void',
                  guarantees: ['exactly-once'],
                },
              ],
            },
          ],
        }),
      },
    },
  }),
];
