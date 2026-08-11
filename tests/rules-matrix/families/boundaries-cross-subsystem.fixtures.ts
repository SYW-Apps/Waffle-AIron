/**
 * Cross-subsystem / cross-tree boundary fixtures for the remaining
 * stereotype-deps.ts codes (the intra-subsystem matrix lives in
 * boundaries-stereotype-matrix.fixtures.ts).
 *
 * Documented intents pinned here (rule description + doc comments):
 *  - CROSS_SUBSYSTEM_NON_ADAPTER (error): only a local client Adapter may
 *    cross a subsystem boundary — UNLESS the SOURCE subsystem licenses the
 *    direct in-process edge with a trustedLink to the peer.
 *  - CROSS_SUBSYSTEM_PRIVATE_ACCESS (error): a cross-subsystem dependency may
 *    only target the peer's published public surface.
 *  - CROSS_SUBSYSTEM_TARGET_NON_PORTAL (error): the published target must be
 *    the peer's inbound Portal (its front door), never a published internal.
 *  - CROSS_TREE_REF_UNRESOLVED (warning): a `::`/`super::` cross-tree
 *    dependsOn with no surface snapshot covering it; a stored snapshot in
 *    .wai/surfaces/ resolves it (and then the Adapter-crosser shape applies).
 *  - INVALID_DEPENDENCY_REFERENCE (error): dependsOn names a non-existent
 *    local component.
 *  - PORTAL_WRITE_SHORTCUT (error): a Portal narrative `call` into a
 *    write-effect method on a Repository/Index — the read shortcut is for
 *    READS only; writes route through an Orchestrator. Untagged methods are
 *    not judged (documented).
 *  - allowedEdges (profile edge-delta): a governing pack profile may LICENSE
 *    an intra-subsystem edge the builtin matrix refuses — pinned as a quiet
 *    control for ARCHITECTURE_VIOLATION_SPECIALIST_DEP.
 */
import { defineRuleFixture } from '../harness.js';

// ---------------------------------------------------------------------------
// Shared tree slices: MediBook's scheduling + billing subsystems. billing
// publishes its invoice Portal; scheduling reaches it various (il)legal ways.
// ---------------------------------------------------------------------------

const SYSTEM = {
  name: 'MediBook',
  vision: 'Clinic appointment booking platform covering scheduling, patient records, and partner integrations.',
};

const BILLING_SUB = (publishedComponent: string) => ({
  id: 'billing',
  description: 'Invoicing and payment collection for booked visits.',
  publicInterfaces: [
    { type: 'Custom', details: 'Invoice submission surface for sibling subsystems.', component: publishedComponent },
  ],
});

const INVOICE_PORTAL = {
  id: 'invoice-portal',
  componentType: 'Portal',
  portalType: 'Custom',
  subsystem: 'billing',
  description: 'Inbound invoicing surface of the billing subsystem.',
};

const INVOICE_LEDGER_ORCH = {
  id: 'invoice-ledger-orchestrator',
  componentType: 'Orchestrator',
  subsystem: 'billing',
  description: 'Drives invoice drafting and ledger posting inside billing.',
};

export default [
  // -------------------------------------------------------------------------
  // CROSS_SUBSYSTEM_NON_ADAPTER
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'CROSS_SUBSYSTEM_NON_ADAPTER',
    severity: 'error',
    anchoredTo: 'appointment-orchestrator',
    expectFire: true,
    scenario:
      'The scheduling appointment orchestrator depends directly on the billing subsystem\'s invoice portal instead of routing the hop through a local client adapter.',
    tree: {
      system: SYSTEM,
      subsystems: [
        { id: 'scheduling', description: 'Appointment booking and slot management.' },
        BILLING_SUB('invoice-portal'),
      ],
      components: [
        {
          id: 'appointment-orchestrator',
          componentType: 'Orchestrator',
          subsystem: 'scheduling',
          description: 'Coordinates the appointment booking workflow end to end.',
          dependsOn: ['invoice-portal'],
        },
        INVOICE_PORTAL,
      ],
    },
  }),
  defineRuleFixture({
    code: 'CROSS_SUBSYSTEM_NON_ADAPTER',
    expectFire: false,
    reason: 'A local client Adapter is the one component sanctioned to cross a subsystem boundary into the peer\'s published Portal.',
    scenario:
      'The scheduling subsystem reaches the billing invoice portal through its local billing client adapter, the sanctioned boundary crosser.',
    tree: {
      system: SYSTEM,
      subsystems: [
        { id: 'scheduling', description: 'Appointment booking and slot management.' },
        BILLING_SUB('invoice-portal'),
      ],
      components: [
        {
          id: 'billing-client-adapter',
          componentType: 'Adapter',
          subsystem: 'scheduling',
          description: 'Client adapter abstracting the hop to the billing subsystem\'s invoice surface.',
          dependsOn: ['invoice-portal'],
        },
        INVOICE_PORTAL,
      ],
    },
  }),
  defineRuleFixture({
    code: 'CROSS_SUBSYSTEM_NON_ADAPTER',
    expectFire: false,
    reason:
      'A trustedLink declared on the SOURCE subsystem licenses a direct in-process edge into the peer without the client-Adapter shim (the published-Portal target requirement still holds, and this edge targets the published Portal).',
    scenario:
      'The scheduling orchestrator calls the billing invoice portal directly under a trustedLink that scheduling declares toward billing for the monolith deployment\'s invoicing fast lane.',
    tree: {
      system: SYSTEM,
      subsystems: [
        {
          id: 'scheduling',
          description: 'Appointment booking and slot management.',
          trustedLinks: [{ subsystem: 'billing', reason: 'In-process invoicing fast lane sanctioned for the monolith deployment.' }],
        },
        BILLING_SUB('invoice-portal'),
      ],
      components: [
        {
          id: 'appointment-orchestrator',
          componentType: 'Orchestrator',
          subsystem: 'scheduling',
          description: 'Coordinates the appointment booking workflow end to end.',
          dependsOn: ['invoice-portal'],
        },
        INVOICE_PORTAL,
      ],
    },
  }),

  // -------------------------------------------------------------------------
  // CROSS_SUBSYSTEM_PRIVATE_ACCESS
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'CROSS_SUBSYSTEM_PRIVATE_ACCESS',
    severity: 'error',
    anchoredTo: 'billing-client-adapter',
    expectFire: true,
    scenario:
      'The scheduling billing client adapter depends on billing\'s internal invoice ledger orchestrator, which is not part of billing\'s published public surface.',
    tree: {
      system: SYSTEM,
      subsystems: [
        { id: 'scheduling', description: 'Appointment booking and slot management.' },
        BILLING_SUB('invoice-portal'),
      ],
      components: [
        {
          id: 'billing-client-adapter',
          componentType: 'Adapter',
          subsystem: 'scheduling',
          description: 'Client adapter abstracting the hop to the billing subsystem.',
          dependsOn: ['invoice-ledger-orchestrator'],
        },
        INVOICE_PORTAL,
        INVOICE_LEDGER_ORCH,
      ],
    },
  }),
  defineRuleFixture({
    code: 'CROSS_SUBSYSTEM_PRIVATE_ACCESS',
    expectFire: false,
    reason: 'The dependency targets the invoice portal, which billing declares in its publicInterfaces — the published public surface.',
    scenario:
      'The scheduling billing client adapter depends on the invoice portal that billing publishes as its public surface.',
    tree: {
      system: SYSTEM,
      subsystems: [
        { id: 'scheduling', description: 'Appointment booking and slot management.' },
        BILLING_SUB('invoice-portal'),
      ],
      components: [
        {
          id: 'billing-client-adapter',
          componentType: 'Adapter',
          subsystem: 'scheduling',
          description: 'Client adapter abstracting the hop to the billing subsystem.',
          dependsOn: ['invoice-portal'],
        },
        INVOICE_PORTAL,
        INVOICE_LEDGER_ORCH,
      ],
    },
  }),

  // -------------------------------------------------------------------------
  // CROSS_SUBSYSTEM_TARGET_NON_PORTAL
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'CROSS_SUBSYSTEM_TARGET_NON_PORTAL',
    severity: 'error',
    anchoredTo: 'billing-client-adapter',
    expectFire: true,
    scenario:
      'Billing publishes its internal invoice ledger orchestrator and the scheduling client adapter enters through it, leaking the boundary past billing\'s inbound portal.',
    tree: {
      system: SYSTEM,
      subsystems: [
        { id: 'scheduling', description: 'Appointment booking and slot management.' },
        BILLING_SUB('invoice-ledger-orchestrator'),
      ],
      components: [
        {
          id: 'billing-client-adapter',
          componentType: 'Adapter',
          subsystem: 'scheduling',
          description: 'Client adapter abstracting the hop to the billing subsystem.',
          dependsOn: ['invoice-ledger-orchestrator'],
        },
        INVOICE_PORTAL,
        INVOICE_LEDGER_ORCH,
      ],
    },
  }),
  defineRuleFixture({
    code: 'CROSS_SUBSYSTEM_TARGET_NON_PORTAL',
    expectFire: false,
    reason: 'The published, targeted component is billing\'s inbound Portal — the front door that dispatches inward, keeping the distribution seam intact.',
    scenario:
      'Billing publishes its inbound invoice portal and the scheduling client adapter enters the subsystem through that front door.',
    tree: {
      system: SYSTEM,
      subsystems: [
        { id: 'scheduling', description: 'Appointment booking and slot management.' },
        BILLING_SUB('invoice-portal'),
      ],
      components: [
        {
          id: 'billing-client-adapter',
          componentType: 'Adapter',
          subsystem: 'scheduling',
          description: 'Client adapter abstracting the hop to the billing subsystem.',
          dependsOn: ['invoice-portal'],
        },
        INVOICE_PORTAL,
        INVOICE_LEDGER_ORCH,
      ],
    },
  }),

  // -------------------------------------------------------------------------
  // INVALID_DEPENDENCY_REFERENCE
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'INVALID_DEPENDENCY_REFERENCE',
    severity: 'error',
    anchoredTo: 'claims-orchestrator',
    expectFire: true,
    scenario:
      'The claims orchestrator still depends on the retired adjudication engine component that was deleted from the claims subsystem.',
    tree: {
      system: SYSTEM,
      subsystems: [{ id: 'claims', description: 'Insurance claim intake and adjudication.' }],
      components: [
        {
          id: 'claims-orchestrator',
          componentType: 'Orchestrator',
          subsystem: 'claims',
          description: 'Coordinates claim intake through adjudication.',
          dependsOn: ['retired-adjudication-engine'],
        },
        {
          id: 'adjudication-specialist',
          componentType: 'Specialist',
          subsystem: 'claims',
          description: 'Pure capability scoring a claim against the payer\'s adjudication rules.',
        },
      ],
    },
  }),
  defineRuleFixture({
    code: 'INVALID_DEPENDENCY_REFERENCE',
    expectFire: false,
    reason: 'Every dependsOn entry resolves to an existing component of the tree.',
    scenario:
      'The claims orchestrator depends on the adjudication specialist that actually exists in the claims subsystem.',
    tree: {
      system: SYSTEM,
      subsystems: [{ id: 'claims', description: 'Insurance claim intake and adjudication.' }],
      components: [
        {
          id: 'claims-orchestrator',
          componentType: 'Orchestrator',
          subsystem: 'claims',
          description: 'Coordinates claim intake through adjudication.',
          dependsOn: ['adjudication-specialist'],
        },
        {
          id: 'adjudication-specialist',
          componentType: 'Specialist',
          subsystem: 'claims',
          description: 'Pure capability scoring a claim against the payer\'s adjudication rules.',
        },
      ],
    },
  }),

  // -------------------------------------------------------------------------
  // CROSS_TREE_REF_UNRESOLVED
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'CROSS_TREE_REF_UNRESOLVED',
    severity: 'warning',
    anchoredTo: 'telemetry-export-adapter',
    expectFire: true,
    scenario:
      'The telemetry export adapter depends on the observability hub\'s ingest portal in another project tree, and no surface snapshot in .wai/surfaces covers that reference.',
    tree: {
      system: SYSTEM,
      subsystems: [{ id: 'clinic-operations', description: 'Operational telemetry and monitoring hooks of the clinic platform.' }],
      components: [
        {
          id: 'telemetry-export-adapter',
          componentType: 'Adapter',
          subsystem: 'clinic-operations',
          description: 'Ships clinic telemetry to the external observability hub.',
          dependsOn: ['::observability-hub::ingest-portal'],
        },
      ],
    },
  }),
  defineRuleFixture({
    code: 'CROSS_TREE_REF_UNRESOLVED',
    expectFire: false,
    reason:
      'A stored surface snapshot for the observability-hub project declares the ingest portal, so the cross-tree edge validates against the DECLARED contract instead of falling back to the unresolved warning.',
    scenario:
      'The telemetry export adapter depends on the observability hub\'s ingest portal, and the vendored observability-hub surface snapshot declares that portal.',
    tree: {
      system: SYSTEM,
      subsystems: [{ id: 'clinic-operations', description: 'Operational telemetry and monitoring hooks of the clinic platform.' }],
      components: [
        {
          id: 'telemetry-export-adapter',
          componentType: 'Adapter',
          subsystem: 'clinic-operations',
          description: 'Ships clinic telemetry to the external observability hub.',
          dependsOn: ['::observability-hub::ingest-portal'],
        },
      ],
      files: {
        '.wai/surfaces/observability-hub.yaml': [
          'projectName: observability-hub',
          'origin: exchanged',
          "generatedAt: '2026-01-01T00:00:00.000Z'",
          'interfaces:',
          '  - id: ingest-portal',
          '    name: Ingest Portal',
          '    component: ingest-portal',
          '    type: Custom',
          '    details: Telemetry ingest surface of the observability hub.',
          'types: []',
          '',
        ].join('\n'),
      },
    },
  }),

  // -------------------------------------------------------------------------
  // PORTAL_WRITE_SHORTCUT — the Portal→Repository/Index READ license vs writes
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'PORTAL_WRITE_SHORTCUT',
    severity: 'error',
    anchoredTo: 'booking_api_impl',
    expectFire: true,
    scenario:
      'The booking API portal narrative persists an appointment by calling the repository facade\'s write-effect saveAppointment method directly, skipping the workflow layer.',
    tree: {
      system: SYSTEM,
      subsystems: [{ id: 'patient-scheduling', description: 'Appointment booking and slot management for the clinic.' }],
      components: [
        {
          id: 'booking-api-portal',
          componentType: 'Portal',
          portalType: 'Custom',
          subsystem: 'patient-scheduling',
          description: 'Patient-facing API surface receiving appointment booking requests.',
          dependsOn: ['appointment-repository'],
        },
        {
          id: 'appointment-repository',
          componentType: 'Repository',
          subsystem: 'patient-scheduling',
          description: 'Facade over the appointment store and its write registry.',
          owns: ['appointment-store', 'appointment-registry'],
        },
        { id: 'appointment-store', componentType: 'Store', subsystem: 'patient-scheduling', description: 'Holds the booked appointment records.' },
        { id: 'appointment-registry', componentType: 'Registry', subsystem: 'patient-scheduling', description: 'Validated write path for appointment records.' },
      ],
      interfaces: [
        {
          id: 'ibooking_api',
          component: 'booking-api-portal',
          methods: [{ name: 'bookVisit', description: 'Book a visit for a patient.' }],
        },
        {
          id: 'iappointment_repository',
          component: 'appointment-repository',
          methods: [
            { name: 'saveAppointment', description: 'Persist a booked appointment.', effect: 'write' },
            { name: 'findAppointment', description: 'Load one appointment by id.', effect: 'read' },
            { name: 'listAppointments', description: 'List appointments for a patient.' },
          ],
        },
      ],
      implementations: [
        {
          id: 'booking_api_impl',
          contract: 'ibooking_api',
          methods: [
            {
              name: 'bookVisit',
              narrative: [
                {
                  stepNumber: 1,
                  type: 'call',
                  description: 'Persist the booked appointment straight through the repository facade.',
                  targetComponent: 'appointment-repository',
                  targetMethod: 'saveAppointment',
                },
              ],
            },
          ],
        },
      ],
    },
  }),
  defineRuleFixture({
    code: 'PORTAL_WRITE_SHORTCUT',
    severity: 'error',
    anchoredTo: 'availability_api_impl',
    expectFire: true,
    scenario:
      'The availability API portal narrative calls the open-slot index\'s write-effect rebuild method directly, using the read-only Index shortcut for a write.',
    tree: {
      system: SYSTEM,
      subsystems: [{ id: 'patient-scheduling', description: 'Appointment booking and slot management for the clinic.' }],
      components: [
        {
          id: 'availability-api-portal',
          componentType: 'Portal',
          portalType: 'Custom',
          subsystem: 'patient-scheduling',
          description: 'Patient-facing API surface answering slot availability queries.',
          dependsOn: ['open-slot-index'],
        },
        { id: 'open-slot-index', componentType: 'Index', subsystem: 'patient-scheduling', description: 'Read projection answering open-slot availability queries.' },
      ],
      interfaces: [
        {
          id: 'iavailability_api',
          component: 'availability-api-portal',
          methods: [{ name: 'refreshAvailability', description: 'Refresh the availability projection.' }],
        },
        {
          id: 'iopen_slot_index',
          component: 'open-slot-index',
          methods: [
            { name: 'rebuildSlotProjection', description: 'Rebuild the open-slot projection.', effect: 'write' },
            { name: 'queryOpenSlots', description: 'Query open slots for a date range.', effect: 'read' },
          ],
        },
      ],
      implementations: [
        {
          id: 'availability_api_impl',
          contract: 'iavailability_api',
          methods: [
            {
              name: 'refreshAvailability',
              narrative: [
                {
                  stepNumber: 1,
                  type: 'call',
                  description: 'Rebuild the open-slot projection straight from the portal.',
                  targetComponent: 'open-slot-index',
                  targetMethod: 'rebuildSlotProjection',
                },
              ],
            },
          ],
        },
      ],
    },
  }),
  defineRuleFixture({
    code: 'PORTAL_WRITE_SHORTCUT',
    expectFire: false,
    reason: 'The Portal→Repository shortcut is licensed for READS: the called method is effect-tagged read, so no write shortcut exists.',
    scenario:
      'The booking API portal narrative reads an appointment through the repository facade\'s read-effect findAppointment method, the licensed passthrough read.',
    tree: {
      system: SYSTEM,
      subsystems: [{ id: 'patient-scheduling', description: 'Appointment booking and slot management for the clinic.' }],
      components: [
        {
          id: 'booking-api-portal',
          componentType: 'Portal',
          portalType: 'Custom',
          subsystem: 'patient-scheduling',
          description: 'Patient-facing API surface receiving appointment booking requests.',
          dependsOn: ['appointment-repository'],
        },
        {
          id: 'appointment-repository',
          componentType: 'Repository',
          subsystem: 'patient-scheduling',
          description: 'Facade over the appointment store and its write registry.',
          owns: ['appointment-store', 'appointment-registry'],
        },
        { id: 'appointment-store', componentType: 'Store', subsystem: 'patient-scheduling', description: 'Holds the booked appointment records.' },
        { id: 'appointment-registry', componentType: 'Registry', subsystem: 'patient-scheduling', description: 'Validated write path for appointment records.' },
      ],
      interfaces: [
        {
          id: 'ibooking_api',
          component: 'booking-api-portal',
          methods: [{ name: 'bookVisit', description: 'Book a visit for a patient.' }],
        },
        {
          id: 'iappointment_repository',
          component: 'appointment-repository',
          methods: [
            { name: 'saveAppointment', description: 'Persist a booked appointment.', effect: 'write' },
            { name: 'findAppointment', description: 'Load one appointment by id.', effect: 'read' },
            { name: 'listAppointments', description: 'List appointments for a patient.' },
          ],
        },
      ],
      implementations: [
        {
          id: 'booking_api_impl',
          contract: 'ibooking_api',
          methods: [
            {
              name: 'bookVisit',
              narrative: [
                {
                  stepNumber: 1,
                  type: 'call',
                  description: 'Load the existing appointment through the repository read face.',
                  targetComponent: 'appointment-repository',
                  targetMethod: 'findAppointment',
                },
              ],
            },
          ],
        },
      ],
    },
  }),
  defineRuleFixture({
    code: 'PORTAL_WRITE_SHORTCUT',
    expectFire: false,
    reason: 'Untagged methods are not judged (documented): effect tags are the mechanism, and MISSING_EFFECT_TAG drives their adoption separately.',
    scenario:
      'The booking API portal narrative calls the repository facade\'s untagged listAppointments method, which carries no effect tag and is therefore not judged.',
    tree: {
      system: SYSTEM,
      subsystems: [{ id: 'patient-scheduling', description: 'Appointment booking and slot management for the clinic.' }],
      components: [
        {
          id: 'booking-api-portal',
          componentType: 'Portal',
          portalType: 'Custom',
          subsystem: 'patient-scheduling',
          description: 'Patient-facing API surface receiving appointment booking requests.',
          dependsOn: ['appointment-repository'],
        },
        {
          id: 'appointment-repository',
          componentType: 'Repository',
          subsystem: 'patient-scheduling',
          description: 'Facade over the appointment store and its write registry.',
          owns: ['appointment-store', 'appointment-registry'],
        },
        { id: 'appointment-store', componentType: 'Store', subsystem: 'patient-scheduling', description: 'Holds the booked appointment records.' },
        { id: 'appointment-registry', componentType: 'Registry', subsystem: 'patient-scheduling', description: 'Validated write path for appointment records.' },
      ],
      interfaces: [
        {
          id: 'ibooking_api',
          component: 'booking-api-portal',
          methods: [{ name: 'bookVisit', description: 'Book a visit for a patient.' }],
        },
        {
          id: 'iappointment_repository',
          component: 'appointment-repository',
          methods: [
            { name: 'saveAppointment', description: 'Persist a booked appointment.', effect: 'write' },
            { name: 'listAppointments', description: 'List appointments for a patient.' },
          ],
        },
      ],
      implementations: [
        {
          id: 'booking_api_impl',
          contract: 'ibooking_api',
          methods: [
            {
              name: 'bookVisit',
              narrative: [
                {
                  stepNumber: 1,
                  type: 'call',
                  description: 'List the patient\'s appointments through the repository facade.',
                  targetComponent: 'appointment-repository',
                  targetMethod: 'listAppointments',
                },
              ],
            },
          ],
        },
      ],
    },
  }),

  // -------------------------------------------------------------------------
  // Profile edge-deltas: allowedEdges licenses a matrix-refused edge
  // (documented in the stereotype-deps rule description). Quiet control for
  // ARCHITECTURE_VIOLATION_SPECIALIST_DEP; the unlicensed fire lives in the
  // stereotype-matrix sweep (Specialist → Store).
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'ARCHITECTURE_VIOLATION_SPECIALIST_DEP',
    expectFire: false,
    reason:
      'The governing pack profile (clinic-embedded) licenses Specialist→Store via allowedEdges with a stated reason — the documented profile edge-delta mechanism for a platform\'s own idiom.',
    scenario:
      'On the embedded vitals monitor profile, the vitals sampling specialist reads its ring-buffer store directly under the profile\'s declared allowedEdges license.',
    tree: {
      system: SYSTEM,
      subsystems: [
        { id: 'vitals-monitoring', description: 'Embedded vitals sampling on the bedside monitor.', profile: 'clinic-embedded' },
      ],
      components: [
        {
          id: 'vitals-sampling-specialist',
          componentType: 'Specialist',
          subsystem: 'vitals-monitoring',
          description: 'Samples the vitals ring buffer and derives alarm thresholds.',
          dependsOn: ['vitals-ring-buffer-store'],
        },
        {
          id: 'vitals-ring-buffer-store',
          componentType: 'Store',
          subsystem: 'vitals-monitoring',
          description: 'Fixed-size ring buffer holding the latest vitals samples.',
        },
      ],
      packs: ['./packs/clinic-doctrine'],
      files: {
        'packs/clinic-doctrine/pack.yaml': [
          'name: clinic-doctrine',
          'version: 1.0.0',
          'profiles:',
          '  clinic-embedded:',
          '    family: backend-like',
          '    allowedEdges:',
          '      - from: [Specialist]',
          '        to: [Store]',
          '        reason: >-',
          '          On the embedded vitals monitor a sampling specialist reads its',
          '          ring-buffer store directly; the repository ceremony cannot fit',
          '          the device budget.',
          '',
        ].join('\n'),
      },
    },
  }),
];
