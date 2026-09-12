/**
 * The full stereotype × stereotype `dependsOn` matrix sweep for the
 * dependency-boundary rules in src/core/rules/stereotype-deps.ts.
 *
 * Every pair over {Portal, Orchestrator, Supervisor, Actor, Store, Index,
 * Registry, Adapter, Observer, Specialist} + patterns {Repository, Gateway}
 * gets exactly ONE fixture: illegal edges FIRE their documented code, legal
 * edges get a QUIET control on the code that would police that consumer.
 * A View row (frontend profile) rides along for ARCHITECTURE_VIOLATION_VIEW_DEP,
 * which the same rule module registers.
 *
 * The legal/illegal verdicts are derived from the rules' DOCUMENTED tables —
 * the stereotype-deps rule description + per-stereotype doc comments and the
 * architecture standard in .claude/CLAUDE.md — never from trial runs:
 *
 *  - Portals/Observers are top-level entry points/subscribers and can never be
 *    depended upon (ARCHITECTURE_VIOLATION_PORTAL_DEP, any consumer).
 *  - A Portal dispatches to Orchestrators (and Supervisors) and may READ
 *    through Index/Repository faces; raw Store/Registry and Adapters stay out
 *    of reach (ARCHITECTURE_VIOLATION_PORTAL_FORBIDDEN_DEP).
 *  - An Observer forwards to one Orchestrator/Supervisor and may use a
 *    message-bus Adapter to subscribe; Store/Registry/Repository/Index are
 *    forbidden (ARCHITECTURE_VIOLATION_PORTAL_FORBIDDEN_DEP).
 *  - A Specialist is the wildcard block and stays a PURE capability: it may
 *    use Repository facades, Indexes, Adapters, and other Specialists, but
 *    never workflow/runtime blocks (Orchestrator, Supervisor, Actor) and
 *    never persistence directly (Store, Registry) — all storage, even
 *    in-memory, goes through the Store/Registry/Index/Repository mechanism,
 *    reached from a Specialist only via the Repository facade
 *    (ARCHITECTURE_VIOLATION_SPECIALIST_DEP).
 *  - A Store may depend only on another Store or a backend Adapter
 *    (ARCHITECTURE_VIOLATION_STORE_DEP).
 *  - A Registry is the write path to its Store: only that Store, a backend
 *    Adapter, or a validation Specialist (the standard §7 validate→write
 *    path); warning while the check is new
 *    (ARCHITECTURE_VIOLATION_REGISTRY_DEP).
 *  - An Adapter is a sink toward the system: never Orchestrators or Stores
 *    (ARCHITECTURE_VIOLATION_ADAPTER_DEP).
 *  - An Index is a read projection: only its Store or a backend Adapter
 *    (ARCHITECTURE_VIOLATION_INDEX_DEP).
 *  - A View is a pure presenter, decoupled from logic and persistence:
 *    Store/Registry/Index/Adapter/Portal/Observer/Repository/Gateway/
 *    Orchestrator are all forbidden (ARCHITECTURE_VIOLATION_VIEW_DEP).
 *  - Orchestrator/Supervisor/Actor (the workflow/runtime layer) and the
 *    pattern facades Repository/Gateway carry no consumer-side restriction of
 *    their own — only the universal "never depend on a Portal/Observer" rule
 *    applies to their edges.
 *
 * Where a pair trips both a consumer-side code and PORTAL_DEP (e.g.
 * Store → Portal), the fixture asserts the MORE SPECIFIC consumer-side code.
 *
 * All pairs are miniature slices of one realistic clinic-booking system
 * (MediBook) with per-pair role names, as the harness requires.
 */
import { defineRuleFixture, type FixtureSpecInput, type FixtureTree, type RuleFixture } from '../harness.js';

const PORTAL_DEP = 'ARCHITECTURE_VIOLATION_PORTAL_DEP';
const PORTAL_FORBIDDEN_DEP = 'ARCHITECTURE_VIOLATION_PORTAL_FORBIDDEN_DEP';
const SPECIALIST_DEP = 'ARCHITECTURE_VIOLATION_SPECIALIST_DEP';
const STORE_DEP = 'ARCHITECTURE_VIOLATION_STORE_DEP';
const REGISTRY_DEP = 'ARCHITECTURE_VIOLATION_REGISTRY_DEP';
const ADAPTER_DEP = 'ARCHITECTURE_VIOLATION_ADAPTER_DEP';
const INDEX_DEP = 'ARCHITECTURE_VIOLATION_INDEX_DEP';
const VIEW_DEP = 'ARCHITECTURE_VIOLATION_VIEW_DEP';

type MatrixType =
  | 'Portal' | 'Orchestrator' | 'Supervisor' | 'Actor' | 'Store' | 'Index'
  | 'Registry' | 'Adapter' | 'Observer' | 'Specialist' | 'Repository' | 'Gateway' | 'View';

/** The stereotypes the maintainer's sweep mandates (View rides along separately). */
const SWEEP: Exclude<MatrixType, 'View'>[] = [
  'Portal', 'Orchestrator', 'Supervisor', 'Actor', 'Store', 'Index',
  'Registry', 'Adapter', 'Observer', 'Specialist', 'Repository', 'Gateway',
];

interface MatrixRole {
  id: string;
  /** Scenario phrase, e.g. "the patient-facing booking API portal". */
  phrase: string;
  spec: FixtureSpecInput;
  /** Owned member specs when the role is a pattern (materialized into the tree). */
  members?: FixtureSpecInput[];
}

function role(
  id: string,
  componentType: MatrixType,
  phrase: string,
  description: string,
  fields: Record<string, unknown> = {},
  members?: FixtureSpecInput[],
): MatrixRole {
  return { id, phrase, spec: { id, componentType, description, ...fields }, members };
}

// ---------------------------------------------------------------------------
// Consumer roles (the component declaring the dependsOn edge) and target roles
// (the component depended upon) — two disjoint casts so same-stereotype pairs
// (Store → Store, Adapter → Adapter, …) are two distinct real components.
// ---------------------------------------------------------------------------

const CONSUMERS: Record<Exclude<MatrixType, 'View'>, MatrixRole> = {
  Portal: role('booking-api-portal', 'Portal', 'the patient-facing booking API portal',
    'Patient-facing API surface receiving appointment booking requests.', { portalType: 'Custom' }),
  Orchestrator: role('appointment-orchestrator', 'Orchestrator', 'the appointment booking orchestrator',
    'Coordinates the appointment booking workflow end to end.'),
  Supervisor: role('intake-shift-supervisor', 'Supervisor', 'the intake shift supervisor',
    'Supervises intake worker processes and restarts failed booking runs.'),
  Actor: role('reminder-dispatch-actor', 'Actor', 'the reminder dispatch actor',
    'Background actor working the queued visit-reminder jobs.'),
  Store: role('appointment-store', 'Store', 'the appointment store',
    'Holds the booked appointment records.'),
  Index: role('open-slot-index', 'Index', 'the open-slot read index',
    'Read projection answering open-slot availability queries.'),
  Registry: role('appointment-registry', 'Registry', 'the appointment write registry',
    'Validated write path for appointment records.'),
  Adapter: role('sms-notify-adapter', 'Adapter', 'the SMS notification adapter',
    'Wraps the SMS provider API behind a notification interface.'),
  Observer: role('cancellation-observer', 'Observer', 'the cancellation event observer',
    'Subscribes to cancellation events on the clinic message bus.'),
  Specialist: role('slot-matching-specialist', 'Specialist', 'the slot-matching specialist',
    'Pure capability matching visit requests to open clinician slots.'),
  Repository: role('patient-chart-repository', 'Repository', 'the patient-chart repository facade',
    'Facade over the patient chart store and its write registry.',
    { owns: ['patient-chart-store', 'patient-chart-registry'] },
    [
      { id: 'patient-chart-store', componentType: 'Store', description: 'Holds the patient chart records.' },
      { id: 'patient-chart-registry', componentType: 'Registry', description: 'Validated write path for patient chart records.' },
    ]),
  Gateway: role('partner-booking-gateway', 'Gateway', 'the partner booking gateway facade',
    'Facade bundling the partner booking portal and its orchestrator.',
    { owns: ['partner-booking-portal', 'partner-booking-orchestrator'] },
    [
      { id: 'partner-booking-portal', componentType: 'Portal', portalType: 'Custom', description: 'Inbound surface for partner clinic booking requests.' },
      { id: 'partner-booking-orchestrator', componentType: 'Orchestrator', description: 'Drives partner-initiated booking flows.' },
    ]),
};

const TARGETS: Record<MatrixType, MatrixRole> = {
  Portal: role('clinician-console-portal', 'Portal', 'the clinician console portal',
    'Clinician-facing console surface for managing the day schedule.', { portalType: 'Custom' }),
  Orchestrator: role('schedule-rebalance-orchestrator', 'Orchestrator', 'the schedule rebalancing orchestrator',
    'Rebalances clinician schedules when slots free up.'),
  Supervisor: role('triage-queue-supervisor', 'Supervisor', 'the triage queue supervisor',
    'Supervises the triage queue workers.'),
  Actor: role('waitlist-promotion-actor', 'Actor', 'the waitlist promotion actor',
    'Background actor promoting waitlisted patients into freed slots.'),
  Store: role('patient-record-store', 'Store', 'the patient record store',
    'Holds the patient master records.'),
  Index: role('clinician-roster-index', 'Index', 'the clinician roster read index',
    'Read projection over the clinician roster.'),
  Registry: role('patient-record-registry', 'Registry', 'the patient record write registry',
    'Validated write path for patient master records.'),
  Adapter: role('insurance-claim-adapter', 'Adapter', 'the insurance claim adapter',
    'Wraps the insurer claim API behind a claims interface.'),
  Observer: role('no-show-observer', 'Observer', 'the no-show event observer',
    'Subscribes to no-show events on the clinic message bus.'),
  Specialist: role('eligibility-check-specialist', 'Specialist', 'the insurance eligibility specialist',
    'Pure capability checking a patient\'s insurance eligibility.'),
  Repository: role('visit-history-repository', 'Repository', 'the visit-history repository facade',
    'Facade over the visit history store and its write registry.',
    { owns: ['visit-history-store', 'visit-history-registry'] },
    [
      { id: 'visit-history-store', componentType: 'Store', description: 'Holds the historical visit records.' },
      { id: 'visit-history-registry', componentType: 'Registry', description: 'Validated write path for visit history records.' },
    ]),
  Gateway: role('lab-orders-gateway', 'Gateway', 'the lab orders gateway facade',
    'Facade bundling the lab orders portal and its orchestrator.',
    { owns: ['lab-orders-portal', 'lab-orders-orchestrator'] },
    [
      { id: 'lab-orders-portal', componentType: 'Portal', portalType: 'Custom', description: 'Inbound surface for lab order submissions.' },
      { id: 'lab-orders-orchestrator', componentType: 'Orchestrator', description: 'Drives the lab order fulfillment flow.' },
    ]),
  View: role('visit-timeline-view', 'View', 'the visit timeline view',
    'Renders the visit timeline panel of the booking UI.'),
};

/** View consumer for the frontend-profile row. */
const VIEW_CONSUMER = role('visit-summary-view', 'View', 'the visit summary view',
  'Renders the visit summary panel of the booking UI.');

// ---------------------------------------------------------------------------
// The documented verdict per (consumer, target) pair — see the header comment
// for the doc sources. Returns null for a legal edge.
// ---------------------------------------------------------------------------

interface Verdict { code: string; severity: 'error' | 'warning'; }
const err = (code: string): Verdict => ({ code, severity: 'error' });

function verdictFor(consumer: MatrixType, target: MatrixType): Verdict | null {
  // Consumer-side matrices first: where both a consumer-side code and the
  // universal PORTAL_DEP would fire, the more specific code is asserted.
  if (consumer === 'Specialist' && (['Portal', 'Observer', 'Orchestrator', 'Store', 'Registry', 'Supervisor', 'Actor'] as MatrixType[]).includes(target)) {
    return err(SPECIALIST_DEP);
  }
  if (consumer === 'Store' && !(['Store', 'Adapter'] as MatrixType[]).includes(target)) {
    return err(STORE_DEP);
  }
  if (consumer === 'Index' && !(['Store', 'Adapter'] as MatrixType[]).includes(target)) {
    return err(INDEX_DEP);
  }
  if (consumer === 'Registry' && !(['Store', 'Adapter', 'Specialist'] as MatrixType[]).includes(target)) {
    return { code: REGISTRY_DEP, severity: 'warning' }; // warning while the check is new (documented)
  }
  if (consumer === 'Portal' && (['Store', 'Registry', 'Adapter'] as MatrixType[]).includes(target)) {
    return err(PORTAL_FORBIDDEN_DEP);
  }
  if (consumer === 'Observer' && (['Store', 'Registry', 'Repository', 'Index'] as MatrixType[]).includes(target)) {
    return err(PORTAL_FORBIDDEN_DEP);
  }
  if (consumer === 'Adapter' && (['Orchestrator', 'Store'] as MatrixType[]).includes(target)) {
    return err(ADAPTER_DEP);
  }
  if (consumer === 'View' && (['Store', 'Registry', 'Index', 'Adapter', 'Portal', 'Observer', 'Repository', 'Gateway', 'Orchestrator'] as MatrixType[]).includes(target)) {
    return err(VIEW_DEP);
  }
  // The universal rule: Portals and Observers are entry points/subscribers and
  // can never be dependencies, whoever the consumer is.
  if (target === 'Portal' || target === 'Observer') {
    return err(PORTAL_DEP);
  }
  return null;
}

/** The code a LEGAL edge's control asserts quiet: the consumer's own matrix code. */
function quietCodeFor(consumer: MatrixType): string {
  switch (consumer) {
    case 'Portal':
    case 'Observer': return PORTAL_FORBIDDEN_DEP;
    case 'Specialist': return SPECIALIST_DEP;
    case 'Store': return STORE_DEP;
    case 'Index': return INDEX_DEP;
    case 'Registry': return REGISTRY_DEP;
    case 'Adapter': return ADAPTER_DEP;
    case 'View': return VIEW_DEP;
    // Workflow/runtime blocks and pattern facades have no consumer-side code;
    // the only rule that could ever bite their edges is PORTAL_DEP.
    default: return PORTAL_DEP;
  }
}

/** Doc-sourced notes for the interesting sanctioned edges (control `reason`s). */
const LEGAL_NOTES: Record<string, string> = {
  'Portal->Index': 'Portal reads may go through an Index read face without per-entity Orchestrator ceremony; writes route through Orchestrators (policed separately by PORTAL_WRITE_SHORTCUT).',
  'Portal->Repository': 'Portal reads may go through the Repository facade; only write-effect calls are the shortcut PORTAL_WRITE_SHORTCUT polices.',
  'Portal->Orchestrator': 'A Portal dispatches to Orchestrators — the sanctioned front-door shape.',
  'Portal->Supervisor': 'A Portal coordinates through Orchestrators and Supervisors per the documented matrix.',
  'Observer->Orchestrator': 'An Observer forwards to one Orchestrator — the documented forwarding shape.',
  'Observer->Supervisor': 'An Observer may forward to a Supervisor per the documented matrix.',
  'Observer->Adapter': 'An Observer may use a message-bus Adapter to subscribe (documented explicitly).',
  'Specialist->Repository': 'Specialists may use Repositories (documented explicitly).',
  'Specialist->Index': 'Specialists may use Indexes (documented explicitly).',
  'Specialist->Adapter': 'Specialists may use Adapters (documented explicitly).',
  'Store->Store': 'A Store may depend on another Store (documented explicitly).',
  'Store->Adapter': 'A Store may depend on its backend Adapter (documented explicitly).',
  'Index->Store': 'An Index is a read projection over its Store — the documented shape.',
  'Index->Adapter': 'An Index may depend on a backend Adapter (documented explicitly).',
  'Registry->Store': 'A Registry is the write path to its Store — the documented shape.',
  'Registry->Adapter': 'A Registry may depend on a backend Adapter (documented explicitly).',
  'Registry->Specialist': 'The standard §7 validate→write path: a Registry may consult a validation Specialist before writing its Store (documented explicitly).',
  'View->View': 'A composite View embedding another View stays inside the presentation layer, which is all the View rule demands.',
};

// ---------------------------------------------------------------------------
// Fixture assembly
// ---------------------------------------------------------------------------

const SUBSYSTEM_DESCRIPTIONS: Record<string, string> = {
  'patient-scheduling': 'Appointment booking and slot management for the clinic.',
  'booking-web-ui': 'The patient-facing booking web frontend.',
};

function pairTree(consumer: MatrixRole, target: MatrixRole, subsystem: string, projectType?: string): FixtureTree {
  return {
    system: {
      name: 'MediBook',
      vision: 'Clinic appointment booking platform covering scheduling, patient records, and partner integrations.',
    },
    subsystems: [{ id: subsystem, description: SUBSYSTEM_DESCRIPTIONS[subsystem] }],
    components: [
      { ...consumer.spec, subsystem, dependsOn: [target.id] },
      { ...target.spec, subsystem },
      ...(consumer.members ?? []).map(m => ({ ...m, subsystem })),
      ...(target.members ?? []).map(m => ({ ...m, subsystem })),
    ],
    ...(projectType ? { projectType } : {}),
  };
}

function pairFixture(
  consumerType: MatrixType,
  targetType: MatrixType,
  consumer: MatrixRole,
  target: MatrixRole,
  subsystem: string,
  projectType?: string,
): RuleFixture {
  const verdict = verdictFor(consumerType, targetType);
  const tree = pairTree(consumer, target, subsystem, projectType);
  if (verdict) {
    return defineRuleFixture({
      code: verdict.code,
      severity: verdict.severity,
      anchoredTo: consumer.id,
      expectFire: true,
      scenario:
        `In the MediBook clinic-booking system, ${consumer.phrase} (${consumerType}) declares a dependsOn edge on ` +
        `${target.phrase} (${targetType}), an edge the documented stereotype matrix forbids.`,
      tree,
    });
  }
  const quietCode = quietCodeFor(consumerType);
  return defineRuleFixture({
    code: quietCode,
    expectFire: false,
    reason:
      LEGAL_NOTES[`${consumerType}->${targetType}`]
      ?? `The documented stereotype matrix places no restriction on a ${consumerType} depending on a ${targetType}, so ${quietCode} must stay quiet on this edge.`,
    scenario:
      `In the MediBook clinic-booking system, ${consumer.phrase} (${consumerType}) declares a dependsOn edge on ` +
      `${target.phrase} (${targetType}), an edge the documented stereotype matrix sanctions.`,
    tree,
  });
}

const fixtures: RuleFixture[] = [];

// The mandated 12 × 12 sweep (backend profile, one subsystem — the
// cross-subsystem boundary rules are covered by the boundaries-cross-subsystem
// family; this sweep pins the INTRA-subsystem interaction matrix).
for (const consumerType of SWEEP) {
  for (const targetType of SWEEP) {
    fixtures.push(pairFixture(consumerType, targetType, CONSUMERS[consumerType], TARGETS[targetType], 'patient-scheduling'));
  }
}

// The View row (frontend-reactive profile, so the View itself is legal): the
// same rule module registers ARCHITECTURE_VIOLATION_VIEW_DEP. Targets are the
// 12 sweep stereotypes plus a sibling View (the documented-legal composite).
for (const targetType of [...SWEEP, 'View' as const]) {
  fixtures.push(pairFixture('View', targetType, VIEW_CONSUMER, TARGETS[targetType], 'booking-web-ui', 'frontend-reactive'));
}

export default fixtures;
