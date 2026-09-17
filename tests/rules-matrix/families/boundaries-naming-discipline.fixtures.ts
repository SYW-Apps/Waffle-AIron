/**
 * Naming-discipline family (src/core/rules/heuristic/naming-discipline.ts): a
 * name says what a thing is, once. All four are warnings — judgements about
 * names, never about behaviour — and none of them reads a description.
 *
 * Documented intents pinned here:
 *  - MISLEADING_BLOCK_WORD: the id's head noun names a building block the
 *    component is not.
 *  - GENERIC_COMPONENT_NAME: the id or name leans on a role word that says
 *    nothing (manager, helper, utils, handler, service…).
 *  - METHOD_REPEATS_COMPONENT: the concept follows the method's verb, so the
 *    call site says it twice. A QUALIFIED compound narrows instead of
 *    repeating, and Adapter/Portal forwarders are exempt.
 *  - COMPONENT_IS_ITS_ONLY_METHOD: a lone method the component is named after.
 *    Adapters are exempt — a client shim wraps exactly one remote call.
 */
import { defineRuleFixture } from '../harness.js';

const SYSTEM = {
  name: 'Freightline',
  vision: 'Freight brokerage platform covering shipment booking, carrier dispatch, and manifest reconciliation.',
};

const DISPATCH_SUB = { id: 'dispatch', description: 'Shipment booking, carrier assignment, and dispatch scheduling.' };

export default [
  // -------------------------------------------------------------------------
  // MISLEADING_BLOCK_WORD
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'MISLEADING_BLOCK_WORD',
    severity: 'warning',
    anchoredTo: 'shipment-schedule-store',
    expectFire: true,
    scenario:
      'The dispatch scheduler is named shipment-schedule-store, so every reader expects held state, while the spec declares it an Orchestrator.',
    tree: {
      system: SYSTEM,
      subsystems: [DISPATCH_SUB],
      components: [
        { id: 'shipment-schedule-store', componentType: 'Orchestrator', description: 'Builds the dispatch schedule for the day\'s booked shipments.' },
      ],
    },
  }),
  defineRuleFixture({
    code: 'MISLEADING_BLOCK_WORD',
    expectFire: false,
    reason: 'The head noun no longer claims a building block, so the id and the componentType agree.',
    scenario:
      'The dispatch scheduler is named shipment-scheduler, matching the Orchestrator it is declared to be.',
    tree: {
      system: SYSTEM,
      subsystems: [DISPATCH_SUB],
      components: [
        { id: 'shipment-scheduler', componentType: 'Orchestrator', description: 'Builds the dispatch schedule for the day\'s booked shipments.' },
      ],
    },
  }),

  // -------------------------------------------------------------------------
  // GENERIC_COMPONENT_NAME
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'GENERIC_COMPONENT_NAME',
    severity: 'warning',
    anchoredTo: 'shipment-manager',
    expectFire: true,
    scenario:
      'The component that picks carriers for booked shipments is called shipment-manager, a name every component in the subsystem would fit.',
    tree: {
      system: SYSTEM,
      subsystems: [DISPATCH_SUB],
      components: [
        { id: 'shipment-manager', componentType: 'Orchestrator', description: 'Picks a carrier for each booked shipment and schedules the pickup.' },
      ],
    },
  }),
  defineRuleFixture({
    code: 'GENERIC_COMPONENT_NAME',
    expectFire: false,
    reason: 'The name states the responsibility — assigning carriers — rather than a role word that fits anything.',
    scenario:
      'The component that picks carriers for booked shipments is called carrier-assigner.',
    tree: {
      system: SYSTEM,
      subsystems: [DISPATCH_SUB],
      components: [
        { id: 'carrier-assigner', componentType: 'Orchestrator', name: 'Carrier Assigner', description: 'Picks a carrier for each booked shipment and schedules the pickup.' },
      ],
    },
  }),

  // -------------------------------------------------------------------------
  // METHOD_REPEATS_COMPONENT
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'METHOD_REPEATS_COMPONENT',
    severity: 'warning',
    anchoredTo: 'imanifest_orchestrator',
    expectFire: true,
    scenario:
      'The manifest orchestrator exposes reconcileManifest, so every call site reads manifestOrchestrator.reconcileManifest and says "manifest" twice.',
    tree: {
      system: SYSTEM,
      subsystems: [{ id: 'reconciliation', description: 'Manifest reconciliation against carrier scans and delivery receipts.' }],
      components: [
        { id: 'manifest_orchestrator', componentType: 'Orchestrator', description: 'Reconciles a shipment manifest against the carrier\'s delivery scans.' },
      ],
      interfaces: [
        {
          id: 'imanifest_orchestrator',
          component: 'manifest_orchestrator',
          methods: [{ name: 'reconcileManifest', description: 'Reconcile the manifest against the carrier\'s delivery scans.' }],
        },
      ],
    },
  }),
  defineRuleFixture({
    code: 'METHOD_REPEATS_COMPONENT',
    expectFire: false,
    reason: 'The method name drops the concept the component already carries, so the call site states it once.',
    scenario:
      'The manifest orchestrator exposes reconcile, read at the call site as manifestOrchestrator.reconcile.',
    tree: {
      system: SYSTEM,
      subsystems: [{ id: 'reconciliation', description: 'Manifest reconciliation against carrier scans and delivery receipts.' }],
      components: [
        { id: 'manifest_orchestrator', componentType: 'Orchestrator', description: 'Reconciles a shipment manifest against the carrier\'s delivery scans.' },
      ],
      interfaces: [
        {
          id: 'imanifest_orchestrator',
          component: 'manifest_orchestrator',
          methods: [{ name: 'reconcile', description: 'Reconcile the manifest against the carrier\'s delivery scans.' }],
        },
      ],
    },
  }),

  // -------------------------------------------------------------------------
  // COMPONENT_IS_ITS_ONLY_METHOD
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'COMPONENT_IS_ITS_ONLY_METHOD',
    severity: 'warning',
    anchoredTo: 'route_plan',
    expectFire: true,
    scenario:
      'route_plan holds exactly one method, buildPlan — a function given a component\'s costume rather than a responsibility of its own.',
    tree: {
      system: SYSTEM,
      subsystems: [DISPATCH_SUB],
      components: [
        { id: 'route_plan', componentType: 'Orchestrator', description: 'Builds the multi-stop route a dispatched shipment follows.' },
      ],
      interfaces: [
        {
          id: 'iroute_plan',
          component: 'route_plan',
          methods: [{ name: 'buildPlan', description: 'Build the multi-stop route plan for a dispatched shipment.' }],
        },
      ],
    },
  }),
  defineRuleFixture({
    code: 'COMPONENT_IS_ITS_ONLY_METHOD',
    expectFire: false,
    reason: 'The component is named for the responsibility it holds, not for the one method it happens to expose.',
    scenario:
      'route_planner holds the same single method, buildPlan, but is named for the planning it owns rather than for its output.',
    tree: {
      system: SYSTEM,
      subsystems: [DISPATCH_SUB],
      components: [
        { id: 'route_planner', componentType: 'Orchestrator', description: 'Builds the multi-stop route a dispatched shipment follows.' },
      ],
      interfaces: [
        {
          id: 'iroute_planner',
          component: 'route_planner',
          methods: [{ name: 'buildPlan', description: 'Build the multi-stop route plan for a dispatched shipment.' }],
        },
      ],
    },
  }),
];
