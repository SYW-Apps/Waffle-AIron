/**
 * Architectural-profile fixtures (src/core/rules/profiles.ts).
 *
 * Documented intents pinned here:
 *  - FRONTEND_STEREOTYPE_IN_BACKEND (error): View/FeatureComponent/
 *    RouterComponent only in frontend profiles.
 *  - PLC_CYCLIC_CONCURRENCY_VIOLATION (error): Actor/Supervisor forbidden in
 *    plc-cyclic — PLC logic runs single-threaded in the scan cycle. Both
 *    documented stereotypes get a fire.
 *  - BACKEND_STEREOTYPE_IN_FRONTEND (warning): Actor/Supervisor in frontend
 *    profiles are warned as a sanity check.
 *  - PROFILE_FORBIDDEN_STEREOTYPE (error) / PROFILE_DISCOURAGED_STEREOTYPE
 *    (warning): pack-registered profiles carry their own doctrine with a
 *    stated reason — exercised through a real declarative pack loaded from
 *    the fixture project.
 *  - UNKNOWN_PROFILE (warning, two documented behaviors): a subsystem profile
 *    that is neither built-in nor pack-registered, and a projectType that is
 *    neither a built-in profile/kind nor pack-registered.
 */
import { defineRuleFixture } from '../harness.js';

const SYSTEM = {
  name: 'MediBook',
  vision: 'Clinic appointment booking platform spanning backend services, kiosks, and web frontends.',
};

/** A small declarative pack registering the clinic-kiosk profile with its own doctrine. */
const KIOSK_PACK_FILES = {
  'packs/clinic-kiosk-doctrine/pack.yaml': [
    'name: clinic-kiosk-doctrine',
    'version: 1.0.0',
    'profiles:',
    '  clinic-kiosk:',
    '    family: neutral',
    '    forbiddenStereotypes:',
    '      - types: [Actor]',
    '        reason: The kiosk shell is a single-threaded UI runtime; background actors starve the touch loop.',
    '    discouragedStereotypes:',
    '      - types: [Supervisor]',
    '        reason: Kiosk deployments restart the whole shell on failure; a supervisor tree adds moving parts without benefit.',
    '',
  ].join('\n'),
};
const KIOSK_PACKS = ['./packs/clinic-kiosk-doctrine'];

export default [
  // -------------------------------------------------------------------------
  // FRONTEND_STEREOTYPE_IN_BACKEND
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'FRONTEND_STEREOTYPE_IN_BACKEND',
    severity: 'error',
    anchoredTo: 'visit-summary-view',
    expectFire: true,
    scenario:
      'A visit summary view, a frontend presenter stereotype, sits inside the backend-profiled scheduling subsystem.',
    tree: {
      system: SYSTEM,
      subsystems: [{ id: 'scheduling', description: 'Appointment booking and slot management.' }],
      components: [
        { id: 'visit-summary-view', componentType: 'View', description: 'Renders the visit summary panel.' },
      ],
    },
  }),
  defineRuleFixture({
    code: 'FRONTEND_STEREOTYPE_IN_BACKEND',
    expectFire: false,
    reason: 'Under a frontend profile (frontend-reactive) the View stereotype is exactly where it belongs.',
    scenario:
      'The visit summary view lives in the booking web frontend, whose project profile is frontend-reactive.',
    tree: {
      system: SYSTEM,
      projectType: 'frontend-reactive',
      subsystems: [{ id: 'booking-web-ui', description: 'The patient-facing booking web frontend.' }],
      components: [
        { id: 'visit-summary-view', componentType: 'View', description: 'Renders the visit summary panel.' },
      ],
    },
  }),

  // -------------------------------------------------------------------------
  // PLC_CYCLIC_CONCURRENCY_VIOLATION — both documented stereotypes
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'PLC_CYCLIC_CONCURRENCY_VIOLATION',
    severity: 'error',
    anchoredTo: 'conveyor-jam-actor',
    expectFire: true,
    scenario:
      'A conveyor jam actor is modeled inside the plc-cyclic conveyor control subsystem, whose scan cycle runs strictly single-threaded.',
    tree: {
      system: { name: 'PharmaLine', vision: 'Packaging line automation for the hospital pharmacy.' },
      subsystems: [{ id: 'conveyor-control', description: 'PLC control of the blister-pack conveyor.', profile: 'plc-cyclic' }],
      components: [
        { id: 'conveyor-jam-actor', componentType: 'Actor', description: 'Background actor clearing conveyor jam events.' },
      ],
    },
  }),
  defineRuleFixture({
    code: 'PLC_CYCLIC_CONCURRENCY_VIOLATION',
    severity: 'error',
    anchoredTo: 'line-restart-supervisor',
    expectFire: true,
    scenario:
      'A line restart supervisor is modeled inside the plc-cyclic conveyor control subsystem, which cannot host concurrent supervision trees.',
    tree: {
      system: { name: 'PharmaLine', vision: 'Packaging line automation for the hospital pharmacy.' },
      subsystems: [{ id: 'conveyor-control', description: 'PLC control of the blister-pack conveyor.', profile: 'plc-cyclic' }],
      components: [
        { id: 'line-restart-supervisor', componentType: 'Supervisor', description: 'Supervises and restarts the packaging line workers.' },
      ],
    },
  }),
  defineRuleFixture({
    code: 'PLC_CYCLIC_CONCURRENCY_VIOLATION',
    expectFire: false,
    reason: 'An Orchestrator runs inside the single scan cycle; only the concurrent stereotypes (Actor/Supervisor) are forbidden in plc-cyclic.',
    scenario:
      'The conveyor scan orchestrator drives the jam-clearing logic inside the plc-cyclic conveyor control subsystem\'s scan cycle.',
    tree: {
      system: { name: 'PharmaLine', vision: 'Packaging line automation for the hospital pharmacy.' },
      subsystems: [{ id: 'conveyor-control', description: 'PLC control of the blister-pack conveyor.', profile: 'plc-cyclic' }],
      components: [
        { id: 'conveyor-scan-orchestrator', componentType: 'Orchestrator', description: 'Drives the jam-clearing logic within the scan cycle.' },
      ],
    },
  }),

  // -------------------------------------------------------------------------
  // BACKEND_STEREOTYPE_IN_FRONTEND
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'BACKEND_STEREOTYPE_IN_FRONTEND',
    severity: 'warning',
    anchoredTo: 'session-heartbeat-actor',
    expectFire: true,
    scenario:
      'A session heartbeat actor, a backend runtime stereotype, is modeled inside the frontend-reactive booking web UI.',
    tree: {
      system: SYSTEM,
      projectType: 'frontend-reactive',
      subsystems: [{ id: 'booking-web-ui', description: 'The patient-facing booking web frontend.' }],
      components: [
        { id: 'session-heartbeat-actor', componentType: 'Actor', description: 'Sends periodic session heartbeats to keep bookings alive.' },
      ],
    },
  }),
  defineRuleFixture({
    code: 'BACKEND_STEREOTYPE_IN_FRONTEND',
    expectFire: false,
    reason: 'In a backend-profiled subsystem an Actor is an ordinary runtime block; the sanity warning exists only for frontend subsystems.',
    scenario:
      'The session heartbeat actor runs inside the backend scheduling subsystem, where runtime actors belong.',
    tree: {
      system: SYSTEM,
      subsystems: [{ id: 'scheduling', description: 'Appointment booking and slot management.' }],
      components: [
        { id: 'session-heartbeat-actor', componentType: 'Actor', description: 'Sends periodic session heartbeats to keep bookings alive.' },
      ],
    },
  }),

  // -------------------------------------------------------------------------
  // PROFILE_FORBIDDEN_STEREOTYPE (pack-registered doctrine)
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'PROFILE_FORBIDDEN_STEREOTYPE',
    severity: 'error',
    anchoredTo: 'queue-polling-actor',
    expectFire: true,
    scenario:
      'The check-in kiosk subsystem runs under the pack-registered clinic-kiosk profile, which forbids Actors, yet models a queue polling actor.',
    tree: {
      system: SYSTEM,
      subsystems: [{ id: 'kiosk-checkin', description: 'Self-service check-in kiosks in the clinic lobby.', profile: 'clinic-kiosk' }],
      components: [
        { id: 'queue-polling-actor', componentType: 'Actor', description: 'Polls the waiting-queue feed in the background.' },
      ],
      packs: KIOSK_PACKS,
      files: KIOSK_PACK_FILES,
    },
  }),
  defineRuleFixture({
    code: 'PROFILE_FORBIDDEN_STEREOTYPE',
    expectFire: false,
    reason: 'An Orchestrator is not in the clinic-kiosk profile\'s forbiddenStereotypes list, so the pack doctrine has nothing to flag.',
    scenario:
      'The check-in kiosk subsystem refreshes its queue through a queue refresh orchestrator, which the clinic-kiosk profile permits.',
    tree: {
      system: SYSTEM,
      subsystems: [{ id: 'kiosk-checkin', description: 'Self-service check-in kiosks in the clinic lobby.', profile: 'clinic-kiosk' }],
      components: [
        { id: 'queue-refresh-orchestrator', componentType: 'Orchestrator', description: 'Refreshes the waiting-queue view on demand.' },
      ],
      packs: KIOSK_PACKS,
      files: KIOSK_PACK_FILES,
    },
  }),

  // -------------------------------------------------------------------------
  // PROFILE_DISCOURAGED_STEREOTYPE (pack-registered doctrine)
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'PROFILE_DISCOURAGED_STEREOTYPE',
    severity: 'warning',
    anchoredTo: 'kiosk-watchdog-supervisor',
    expectFire: true,
    scenario:
      'The check-in kiosk subsystem models a watchdog supervisor although the clinic-kiosk profile discourages supervision trees on kiosk deployments.',
    tree: {
      system: SYSTEM,
      subsystems: [{ id: 'kiosk-checkin', description: 'Self-service check-in kiosks in the clinic lobby.', profile: 'clinic-kiosk' }],
      components: [
        { id: 'kiosk-watchdog-supervisor', componentType: 'Supervisor', description: 'Watches kiosk shell processes and restarts them on failure.' },
      ],
      packs: KIOSK_PACKS,
      files: KIOSK_PACK_FILES,
    },
  }),
  defineRuleFixture({
    code: 'PROFILE_DISCOURAGED_STEREOTYPE',
    expectFire: false,
    reason: 'An Orchestrator is not in the clinic-kiosk profile\'s discouragedStereotypes list.',
    scenario:
      'The check-in kiosk subsystem drives its flows through a check-in orchestrator, which the clinic-kiosk profile leaves undisputed.',
    tree: {
      system: SYSTEM,
      subsystems: [{ id: 'kiosk-checkin', description: 'Self-service check-in kiosks in the clinic lobby.', profile: 'clinic-kiosk' }],
      components: [
        { id: 'checkin-flow-orchestrator', componentType: 'Orchestrator', description: 'Drives the self-service check-in flow.' },
      ],
      packs: KIOSK_PACKS,
      files: KIOSK_PACK_FILES,
    },
  }),

  // -------------------------------------------------------------------------
  // UNKNOWN_PROFILE — subsystem profile behavior
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'UNKNOWN_PROFILE',
    severity: 'warning',
    anchoredTo: 'claims',
    expectFire: true,
    scenario:
      'The claims subsystem declares the profile hexagonal-onion, which is neither a built-in profile nor registered by any loaded extension pack.',
    tree: {
      system: SYSTEM,
      subsystems: [{ id: 'claims', description: 'Insurance claim intake and adjudication.', profile: 'hexagonal-onion' }],
    },
  }),
  defineRuleFixture({
    code: 'UNKNOWN_PROFILE',
    expectFire: false,
    reason: 'The declared subsystem profile (backend) is a built-in, so profile doctrine is being enforced and nothing is unknown.',
    scenario:
      'The claims subsystem declares the built-in backend profile.',
    tree: {
      system: SYSTEM,
      subsystems: [{ id: 'claims', description: 'Insurance claim intake and adjudication.', profile: 'backend' }],
    },
  }),

  // -------------------------------------------------------------------------
  // UNKNOWN_PROFILE — projectType behavior
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'UNKNOWN_PROFILE',
    severity: 'warning',
    expectFire: true,
    scenario:
      'The project.yaml declares projectType terraform-modules, which is neither a built-in profile, a composite project kind, nor pack-registered.',
    tree: {
      system: SYSTEM,
      projectType: 'terraform-modules',
      subsystems: [{ id: 'claims', description: 'Insurance claim intake and adjudication.' }],
    },
  }),
  defineRuleFixture({
    code: 'UNKNOWN_PROFILE',
    expectFire: false,
    reason: 'projectType fullstack is one of the documented composite project kinds, which the rule accepts alongside built-in profiles.',
    scenario:
      'The project declares the composite projectType fullstack while its claims subsystem runs backend doctrine.',
    tree: {
      system: SYSTEM,
      projectType: 'fullstack',
      subsystems: [{ id: 'claims', description: 'Insurance claim intake and adjudication.', profile: 'backend' }],
    },
  }),
];
