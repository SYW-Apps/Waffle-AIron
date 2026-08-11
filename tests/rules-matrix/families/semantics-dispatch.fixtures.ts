/**
 * Dispatch-table family (src/core/rules/semantic-edges.ts, dispatchRule):
 * machine-readable capability -> component.method maps on generic-dispatch
 * Portals, plus the dispatch narrative step routed through them.
 *
 * Documented intents pinned here:
 *  - DISPATCH_ON_NON_PORTAL (error): capability dispatch is a Portal
 *    responsibility (the subsystem's front door routing inward).
 *  - DUPLICATE_CAPABILITY (error): a capability bound twice makes runtime
 *    routing ambiguous.
 *  - UNSERVED_CAPABILITY (error): a table binding with no existing server, or
 *    a dispatch step routing a capability the target Portal does not serve.
 *  - DISPATCH_CROSS_SUBSYSTEM (error): a portal dispatches inward — bindings
 *    may not leave its subsystem.
 *  - UNDECLARED_DISPATCH_TARGET (error): the table edge is a real runtime
 *    dependency and must appear under dependsOn/owns.
 *  - MALFORMED_DISPATCH_STEP (error): a dispatch step must carry its
 *    capability.
 *  - NARRATIVE_SEMANTIC_UNBACKED (warning): a dispatch step may not assert a
 *    guarantee the bound capability method does not declare.
 */
import { defineRuleFixture } from '../harness.js';

export default [
  // -------------------------------------------------------------------------
  // DISPATCH_ON_NON_PORTAL
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'DISPATCH_ON_NON_PORTAL',
    severity: 'error',
    anchoredTo: 'telemetry-orchestrator',
    expectFire: true,
    scenario:
      'The telemetry orchestrator declares a capability dispatch table, but generic dispatch is the front-door Portal\'s responsibility, not a workflow component\'s.',
    tree: {
      subsystems: [{ id: 'telemetry', description: 'Metric collection and flushing for the fleet.' }],
      components: [
        {
          id: 'telemetry-orchestrator',
          componentType: 'Orchestrator',
          description: 'Coordinates metric collection cycles.',
          dependsOn: ['metrics-flusher'],
          dispatch: [
            {
              capability: 'metrics.flush',
              component: 'metrics-flusher',
              method: 'flush',
              description: 'Flush the buffered metrics to cold storage.',
            },
          ],
        },
        {
          id: 'metrics-flusher',
          componentType: 'Specialist',
          description: 'Compacts and flushes buffered metrics.',
        },
      ],
      interfaces: [
        {
          id: 'itelemetry_orchestrator',
          component: 'telemetry-orchestrator',
          methods: [{ name: 'collect', description: 'Run one metric collection cycle over the fleet.' }],
        },
        {
          id: 'imetrics_flusher',
          component: 'metrics-flusher',
          methods: [{ name: 'flush', description: 'Compact and flush the buffered metrics to cold storage.' }],
        },
      ],
    },
  }),
  defineRuleFixture({
    code: 'DISPATCH_ON_NON_PORTAL',
    expectFire: false,
    reason: 'The dispatch table sits on the telemetry Portal — the sanctioned home for capability routing.',
    scenario:
      'The telemetry portal carries the metrics.flush capability binding, dispatching inward to the flusher specialist.',
    tree: {
      subsystems: [{ id: 'telemetry', description: 'Metric collection and flushing for the fleet.' }],
      components: [
        {
          id: 'telemetry-portal',
          componentType: 'Portal',
          portalType: 'HTTP_API',
          description: 'Generic telemetry portal dispatching capabilities inward.',
          dependsOn: ['metrics-flusher'],
          dispatch: [
            {
              capability: 'metrics.flush',
              component: 'metrics-flusher',
              method: 'flush',
              description: 'Flush the buffered metrics to cold storage.',
            },
          ],
        },
        {
          id: 'metrics-flusher',
          componentType: 'Specialist',
          description: 'Compacts and flushes buffered metrics.',
        },
      ],
      interfaces: [
        {
          id: 'itelemetry_portal',
          component: 'telemetry-portal',
          methods: [{ name: 'ingest', description: 'Accept a metrics envelope from a fleet device.' }],
        },
        {
          id: 'imetrics_flusher',
          component: 'metrics-flusher',
          methods: [{ name: 'flush', description: 'Compact and flush the buffered metrics to cold storage.' }],
        },
      ],
    },
  }),

  // -------------------------------------------------------------------------
  // DUPLICATE_CAPABILITY
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'DUPLICATE_CAPABILITY',
    severity: 'error',
    anchoredTo: 'device-portal',
    expectFire: true,
    scenario:
      'The device portal binds the device.read capability twice — once to the shadow reader and once to the state projector — leaving runtime routing ambiguous.',
    tree: {
      subsystems: [{ id: 'device-management', description: 'Device shadow reads and state projection.' }],
      components: [
        {
          id: 'device-portal',
          componentType: 'Portal',
          portalType: 'HTTP_API',
          description: 'Generic device portal dispatching capabilities inward.',
          dependsOn: ['shadow-reader', 'state-projector'],
          dispatch: [
            { capability: 'device.read', component: 'shadow-reader', method: 'readShadow', description: 'Read the device shadow.' },
            { capability: 'device.read', component: 'state-projector', method: 'projectState', description: 'Project the device state.' },
          ],
        },
        { id: 'shadow-reader', componentType: 'Specialist', description: 'Reads the persisted device shadow.' },
        { id: 'state-projector', componentType: 'Specialist', description: 'Projects live device state.' },
      ],
      interfaces: [
        {
          id: 'ishadow_reader',
          component: 'shadow-reader',
          methods: [{ name: 'readShadow', description: 'Read the persisted shadow document for a device.' }],
        },
        {
          id: 'istate_projector',
          component: 'state-projector',
          methods: [{ name: 'projectState', description: 'Project the current live state for a device.' }],
        },
      ],
    },
  }),
  defineRuleFixture({
    code: 'DUPLICATE_CAPABILITY',
    expectFire: false,
    reason: 'Each capability name is bound exactly once, so runtime routing is unambiguous.',
    scenario:
      'The device portal binds device.read to the shadow reader and device.project to the state projector, one binding per capability.',
    tree: {
      subsystems: [{ id: 'device-management', description: 'Device shadow reads and state projection.' }],
      components: [
        {
          id: 'device-portal',
          componentType: 'Portal',
          portalType: 'HTTP_API',
          description: 'Generic device portal dispatching capabilities inward.',
          dependsOn: ['shadow-reader', 'state-projector'],
          dispatch: [
            { capability: 'device.read', component: 'shadow-reader', method: 'readShadow', description: 'Read the device shadow.' },
            { capability: 'device.project', component: 'state-projector', method: 'projectState', description: 'Project the device state.' },
          ],
        },
        { id: 'shadow-reader', componentType: 'Specialist', description: 'Reads the persisted device shadow.' },
        { id: 'state-projector', componentType: 'Specialist', description: 'Projects live device state.' },
      ],
      interfaces: [
        {
          id: 'ishadow_reader',
          component: 'shadow-reader',
          methods: [{ name: 'readShadow', description: 'Read the persisted shadow document for a device.' }],
        },
        {
          id: 'istate_projector',
          component: 'state-projector',
          methods: [{ name: 'projectState', description: 'Project the current live state for a device.' }],
        },
      ],
    },
  }),

  // -------------------------------------------------------------------------
  // UNSERVED_CAPABILITY — table side and step side
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'UNSERVED_CAPABILITY',
    severity: 'error',
    anchoredTo: 'firmware-portal',
    expectFire: true,
    scenario:
      'The firmware portal binds firmware.update to firmware-updater.applyPatch, but the updater\'s contract only declares scheduleUpdate — the capability has no real server.',
    tree: {
      subsystems: [{ id: 'firmware', description: 'Fleet firmware rollout management.' }],
      components: [
        {
          id: 'firmware-portal',
          componentType: 'Portal',
          portalType: 'HTTP_API',
          description: 'Generic firmware portal dispatching rollout capabilities inward.',
          dependsOn: ['firmware-updater'],
          dispatch: [
            { capability: 'firmware.update', component: 'firmware-updater', method: 'applyPatch', description: 'Apply a firmware patch.' },
          ],
        },
        { id: 'firmware-updater', componentType: 'Actor', description: 'Schedules and applies firmware updates.' },
      ],
      interfaces: [
        {
          id: 'ifirmware_updater',
          component: 'firmware-updater',
          methods: [{ name: 'scheduleUpdate', description: 'Schedule a staged firmware update for a device cohort.' }],
        },
      ],
    },
  }),
  defineRuleFixture({
    code: 'UNSERVED_CAPABILITY',
    severity: 'error',
    anchoredTo: 'rollout_orchestrator_impl',
    expectFire: true,
    scenario:
      'The rollout orchestrator dispatches the firmware.rollback capability through the firmware portal, but that portal\'s table only serves firmware.update.',
    tree: {
      subsystems: [{ id: 'firmware', description: 'Fleet firmware rollout management.' }],
      components: [
        {
          id: 'firmware-portal',
          componentType: 'Portal',
          portalType: 'HTTP_API',
          description: 'Generic firmware portal dispatching rollout capabilities inward.',
          dependsOn: ['firmware-updater'],
          dispatch: [
            { capability: 'firmware.update', component: 'firmware-updater', method: 'scheduleUpdate', description: 'Schedule a staged update.' },
          ],
        },
        { id: 'firmware-updater', componentType: 'Actor', description: 'Schedules and applies firmware updates.' },
        {
          id: 'rollout-orchestrator',
          componentType: 'Orchestrator',
          description: 'Coordinates staged firmware rollouts and their rollback.',
          dependsOn: ['firmware-portal'],
        },
      ],
      interfaces: [
        {
          id: 'ifirmware_updater',
          component: 'firmware-updater',
          methods: [{ name: 'scheduleUpdate', description: 'Schedule a staged firmware update for a device cohort.' }],
        },
        {
          id: 'irollout_orchestrator',
          component: 'rollout-orchestrator',
          methods: [{ name: 'abortRollout', description: 'Abort a failing rollout and roll the cohort back.' }],
        },
      ],
      implementations: [
        {
          id: 'rollout_orchestrator_impl',
          contract: 'irollout_orchestrator',
          methods: [
            {
              name: 'abortRollout',
              narrative: [
                {
                  stepNumber: 1,
                  type: 'dispatch',
                  description: 'Route the rollback through the firmware portal.',
                  targetComponent: 'firmware-portal',
                  capability: 'firmware.rollback',
                },
              ],
            },
          ],
        },
      ],
    },
  }),
  defineRuleFixture({
    code: 'UNSERVED_CAPABILITY',
    expectFire: false,
    reason:
      'The table binds firmware.update to a method the updater really declares, and the dispatch step routes exactly that served capability.',
    scenario:
      'The rollout orchestrator dispatches firmware.update through the firmware portal, whose table binds it to the updater\'s declared scheduleUpdate method.',
    tree: {
      subsystems: [{ id: 'firmware', description: 'Fleet firmware rollout management.' }],
      components: [
        {
          id: 'firmware-portal',
          componentType: 'Portal',
          portalType: 'HTTP_API',
          description: 'Generic firmware portal dispatching rollout capabilities inward.',
          dependsOn: ['firmware-updater'],
          dispatch: [
            { capability: 'firmware.update', component: 'firmware-updater', method: 'scheduleUpdate', description: 'Schedule a staged update.' },
          ],
        },
        { id: 'firmware-updater', componentType: 'Actor', description: 'Schedules and applies firmware updates.' },
        {
          id: 'rollout-orchestrator',
          componentType: 'Orchestrator',
          description: 'Coordinates staged firmware rollouts.',
          dependsOn: ['firmware-portal'],
        },
      ],
      interfaces: [
        {
          id: 'ifirmware_updater',
          component: 'firmware-updater',
          methods: [{ name: 'scheduleUpdate', description: 'Schedule a staged firmware update for a device cohort.' }],
        },
        {
          id: 'irollout_orchestrator',
          component: 'rollout-orchestrator',
          methods: [{ name: 'startRollout', description: 'Start a staged rollout for a device cohort.' }],
        },
      ],
      implementations: [
        {
          id: 'rollout_orchestrator_impl',
          contract: 'irollout_orchestrator',
          methods: [
            {
              name: 'startRollout',
              narrative: [
                {
                  stepNumber: 1,
                  type: 'dispatch',
                  description: 'Route the staged update through the firmware portal.',
                  targetComponent: 'firmware-portal',
                  capability: 'firmware.update',
                },
              ],
            },
          ],
        },
      ],
    },
  }),

  // -------------------------------------------------------------------------
  // DISPATCH_CROSS_SUBSYSTEM
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'DISPATCH_CROSS_SUBSYSTEM',
    severity: 'error',
    anchoredTo: 'device-gateway-portal',
    expectFire: true,
    scenario:
      'The device gateway portal binds the fleet.report capability to the report builder living in the fleet-analytics subsystem — a portal dispatches inward, never across the boundary.',
    tree: {
      subsystems: [
        { id: 'device-gateway', description: 'Ingress for device commands.' },
        { id: 'fleet-analytics', description: 'Fleet-wide reporting and analytics.' },
      ],
      components: [
        {
          id: 'device-gateway-portal',
          componentType: 'Portal',
          portalType: 'HTTP_API',
          subsystem: 'device-gateway',
          description: 'Generic gateway portal dispatching device capabilities.',
          dependsOn: ['fleet-report-builder'],
          dispatch: [
            { capability: 'fleet.report', component: 'fleet-report-builder', method: 'buildReport', description: 'Build the fleet report.' },
          ],
        },
        {
          id: 'fleet-report-builder',
          componentType: 'Specialist',
          subsystem: 'fleet-analytics',
          description: 'Builds fleet-wide utilization reports.',
        },
      ],
      interfaces: [
        {
          id: 'ifleet_report_builder',
          component: 'fleet-report-builder',
          methods: [{ name: 'buildReport', description: 'Build the fleet-wide utilization report.' }],
        },
      ],
    },
  }),
  defineRuleFixture({
    code: 'DISPATCH_CROSS_SUBSYSTEM',
    expectFire: false,
    reason: 'The bound report builder lives in the portal\'s own subsystem, so the portal dispatches inward as required.',
    scenario:
      'The device gateway portal binds fleet.report to a report builder inside its own device-gateway subsystem.',
    tree: {
      subsystems: [
        { id: 'device-gateway', description: 'Ingress for device commands.' },
        { id: 'fleet-analytics', description: 'Fleet-wide reporting and analytics.' },
      ],
      components: [
        {
          id: 'device-gateway-portal',
          componentType: 'Portal',
          portalType: 'HTTP_API',
          subsystem: 'device-gateway',
          description: 'Generic gateway portal dispatching device capabilities.',
          dependsOn: ['fleet-report-builder'],
          dispatch: [
            { capability: 'fleet.report', component: 'fleet-report-builder', method: 'buildReport', description: 'Build the fleet report.' },
          ],
        },
        {
          id: 'fleet-report-builder',
          componentType: 'Specialist',
          subsystem: 'device-gateway',
          description: 'Builds fleet-wide utilization reports.',
        },
      ],
      interfaces: [
        {
          id: 'ifleet_report_builder',
          component: 'fleet-report-builder',
          methods: [{ name: 'buildReport', description: 'Build the fleet-wide utilization report.' }],
        },
      ],
    },
  }),

  // -------------------------------------------------------------------------
  // UNDECLARED_DISPATCH_TARGET
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'UNDECLARED_DISPATCH_TARGET',
    severity: 'error',
    anchoredTo: 'support-portal',
    expectFire: true,
    scenario:
      'The support portal binds ticket.reassign to the triage specialist but never lists it under dependsOn, hiding a real runtime dependency from the coupling rules.',
    tree: {
      subsystems: [{ id: 'customer-support', description: 'Support ticket intake and triage.' }],
      components: [
        {
          id: 'support-portal',
          componentType: 'Portal',
          portalType: 'HTTP_API',
          description: 'Generic support portal dispatching ticket capabilities inward.',
          dependsOn: [],
          dispatch: [
            { capability: 'ticket.reassign', component: 'triage-specialist', method: 'reassign', description: 'Reassign a ticket to another queue.' },
          ],
        },
        { id: 'triage-specialist', componentType: 'Specialist', description: 'Classifies and routes support tickets.' },
      ],
      interfaces: [
        {
          id: 'itriage_specialist',
          component: 'triage-specialist',
          methods: [{ name: 'reassign', description: 'Reassign a ticket to another support queue.' }],
        },
      ],
    },
  }),
  defineRuleFixture({
    code: 'UNDECLARED_DISPATCH_TARGET',
    expectFire: false,
    reason: 'The portal declares the bound specialist under dependsOn, so the dispatch edge is a visible dependency.',
    scenario:
      'The support portal lists the triage specialist as a dependency alongside its ticket.reassign table binding.',
    tree: {
      subsystems: [{ id: 'customer-support', description: 'Support ticket intake and triage.' }],
      components: [
        {
          id: 'support-portal',
          componentType: 'Portal',
          portalType: 'HTTP_API',
          description: 'Generic support portal dispatching ticket capabilities inward.',
          dependsOn: ['triage-specialist'],
          dispatch: [
            { capability: 'ticket.reassign', component: 'triage-specialist', method: 'reassign', description: 'Reassign a ticket to another queue.' },
          ],
        },
        { id: 'triage-specialist', componentType: 'Specialist', description: 'Classifies and routes support tickets.' },
      ],
      interfaces: [
        {
          id: 'itriage_specialist',
          component: 'triage-specialist',
          methods: [{ name: 'reassign', description: 'Reassign a ticket to another support queue.' }],
        },
      ],
    },
  }),

  // -------------------------------------------------------------------------
  // MALFORMED_DISPATCH_STEP
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'MALFORMED_DISPATCH_STEP',
    severity: 'error',
    anchoredTo: 'routing_orchestrator_impl',
    expectFire: true,
    scenario:
      'The routing orchestrator\'s dispatch step names the command portal but omits the capability, so nobody can tell which binding the step routes through.',
    tree: {
      subsystems: [{ id: 'command-center', description: 'Operator command parsing and routing.' }],
      components: [
        {
          id: 'command-portal',
          componentType: 'Portal',
          portalType: 'HTTP_API',
          description: 'Generic command portal dispatching operator capabilities inward.',
          dependsOn: ['command-executor'],
          dispatch: [
            { capability: 'command.execute', component: 'command-executor', method: 'execute', description: 'Execute a parsed operator command.' },
          ],
        },
        { id: 'command-executor', componentType: 'Specialist', description: 'Executes parsed operator commands.' },
        {
          id: 'routing-orchestrator',
          componentType: 'Orchestrator',
          description: 'Parses operator input and routes commands.',
          dependsOn: ['command-portal'],
        },
      ],
      interfaces: [
        {
          id: 'icommand_executor',
          component: 'command-executor',
          methods: [{ name: 'execute', description: 'Execute a parsed operator command against the fleet.' }],
        },
        {
          id: 'irouting_orchestrator',
          component: 'routing-orchestrator',
          methods: [{ name: 'routeCommand', description: 'Parse an operator command and route it for execution.' }],
        },
      ],
      implementations: [
        {
          id: 'routing_orchestrator_impl',
          contract: 'irouting_orchestrator',
          methods: [
            {
              name: 'routeCommand',
              narrative: [
                {
                  stepNumber: 1,
                  type: 'dispatch',
                  description: 'Route the parsed command through the command portal.',
                  targetComponent: 'command-portal',
                },
              ],
            },
          ],
        },
      ],
    },
  }),
  defineRuleFixture({
    code: 'MALFORMED_DISPATCH_STEP',
    expectFire: false,
    reason: 'The dispatch step names its routed capability, so the binding it takes is explicit.',
    scenario:
      'The routing orchestrator\'s dispatch step carries the command.execute capability alongside its target portal.',
    tree: {
      subsystems: [{ id: 'command-center', description: 'Operator command parsing and routing.' }],
      components: [
        {
          id: 'command-portal',
          componentType: 'Portal',
          portalType: 'HTTP_API',
          description: 'Generic command portal dispatching operator capabilities inward.',
          dependsOn: ['command-executor'],
          dispatch: [
            { capability: 'command.execute', component: 'command-executor', method: 'execute', description: 'Execute a parsed operator command.' },
          ],
        },
        { id: 'command-executor', componentType: 'Specialist', description: 'Executes parsed operator commands.' },
        {
          id: 'routing-orchestrator',
          componentType: 'Orchestrator',
          description: 'Parses operator input and routes commands.',
          dependsOn: ['command-portal'],
        },
      ],
      interfaces: [
        {
          id: 'icommand_executor',
          component: 'command-executor',
          methods: [{ name: 'execute', description: 'Execute a parsed operator command against the fleet.' }],
        },
        {
          id: 'irouting_orchestrator',
          component: 'routing-orchestrator',
          methods: [{ name: 'routeCommand', description: 'Parse an operator command and route it for execution.' }],
        },
      ],
      implementations: [
        {
          id: 'routing_orchestrator_impl',
          contract: 'irouting_orchestrator',
          methods: [
            {
              name: 'routeCommand',
              narrative: [
                {
                  stepNumber: 1,
                  type: 'dispatch',
                  description: 'Route the parsed command through the command portal.',
                  targetComponent: 'command-portal',
                  capability: 'command.execute',
                },
              ],
            },
          ],
        },
      ],
    },
  }),

  // -------------------------------------------------------------------------
  // NARRATIVE_SEMANTIC_UNBACKED (dispatch-step guarantee consistency)
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'NARRATIVE_SEMANTIC_UNBACKED',
    severity: 'warning',
    anchoredTo: 'payment_orchestrator_impl',
    expectFire: true,
    scenario:
      'The payment orchestrator\'s dispatch step asserts idempotency, but the captureCharge method the capability resolves to declares no such contract guarantee.',
    tree: {
      subsystems: [{ id: 'payment-processing', description: 'Payment capture routed through the payments portal.' }],
      components: [
        {
          id: 'payments-portal',
          componentType: 'Portal',
          portalType: 'HTTP_API',
          description: 'Generic payments portal dispatching capture capabilities inward.',
          dependsOn: ['charge-executor'],
          dispatch: [
            { capability: 'payment.capture', component: 'charge-executor', method: 'captureCharge', description: 'Capture an authorized charge.' },
          ],
        },
        { id: 'charge-executor', componentType: 'Specialist', description: 'Executes charge captures against the gateway.' },
        {
          id: 'payment-orchestrator',
          componentType: 'Orchestrator',
          description: 'Drives the capture flow for authorized payments.',
          dependsOn: ['payments-portal'],
        },
      ],
      interfaces: [
        {
          id: 'icharge_executor',
          component: 'charge-executor',
          methods: [{ name: 'captureCharge', description: 'Capture the authorized amount for one payment.' }],
        },
        {
          id: 'ipayment_orchestrator',
          component: 'payment-orchestrator',
          methods: [{ name: 'capturePayment', description: 'Capture the authorized amount for a completed order.' }],
        },
      ],
      implementations: [
        {
          id: 'payment_orchestrator_impl',
          contract: 'ipayment_orchestrator',
          methods: [
            {
              name: 'capturePayment',
              narrative: [
                {
                  stepNumber: 1,
                  type: 'dispatch',
                  description: 'Capture the authorized amount exactly once via the payments portal.',
                  targetComponent: 'payments-portal',
                  capability: 'payment.capture',
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
    reason: 'The bound captureCharge method declares the idempotent guarantee, so the narrative assertion is backed by the contract.',
    scenario:
      'The charge executor\'s captureCharge contract declares idempotency, backing the orchestrator\'s asserted guarantee on the dispatch step.',
    tree: {
      subsystems: [{ id: 'payment-processing', description: 'Payment capture routed through the payments portal.' }],
      components: [
        {
          id: 'payments-portal',
          componentType: 'Portal',
          portalType: 'HTTP_API',
          description: 'Generic payments portal dispatching capture capabilities inward.',
          dependsOn: ['charge-executor'],
          dispatch: [
            { capability: 'payment.capture', component: 'charge-executor', method: 'captureCharge', description: 'Capture an authorized charge.' },
          ],
        },
        { id: 'charge-executor', componentType: 'Specialist', description: 'Executes charge captures against the gateway.' },
        {
          id: 'payment-orchestrator',
          componentType: 'Orchestrator',
          description: 'Drives the capture flow for authorized payments.',
          dependsOn: ['payments-portal'],
        },
      ],
      interfaces: [
        {
          id: 'icharge_executor',
          component: 'charge-executor',
          methods: [
            {
              name: 'captureCharge',
              description: 'Capture the authorized amount for one payment.',
              guarantees: ['idempotent'],
            },
          ],
        },
        {
          id: 'ipayment_orchestrator',
          component: 'payment-orchestrator',
          methods: [{ name: 'capturePayment', description: 'Capture the authorized amount for a completed order.' }],
        },
      ],
      implementations: [
        {
          id: 'payment_orchestrator_impl',
          contract: 'ipayment_orchestrator',
          methods: [
            {
              name: 'capturePayment',
              narrative: [
                {
                  stepNumber: 1,
                  type: 'dispatch',
                  description: 'Capture the authorized amount exactly once via the payments portal.',
                  targetComponent: 'payments-portal',
                  capability: 'payment.capture',
                  assertsGuarantees: ['idempotent'],
                },
              ],
            },
          ],
        },
      ],
    },
  }),
];
