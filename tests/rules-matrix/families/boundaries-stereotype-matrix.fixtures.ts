/**
 * The full stereotype × stereotype `dependsOn` matrix sweep for the
 * intra-subsystem matrix rules in src/core/rules/doctrine/:
 * logic-dependency-class.ts, data-block-dependencies.ts and
 * entrypoint-dependencies.ts.
 *
 * Every pair over {Portal, Orchestrator (workflow), pure logic, read logic,
 * Supervisor, Actor, Store, Index, Query, Registry, Adapter, Observer} + the
 * Repository pattern gets exactly ONE fixture: illegal edges FIRE their
 * documented code, legal edges get a QUIET control on the code that would
 * police that consumer. A View row (frontend profile) rides along for
 * ARCHITECTURE_VIOLATION_VIEW_DEP, which entrypoint-dependencies registers.
 * Logic is an Orchestrator: pure logic declares dependencyClass pure, read
 * logic dependencyClass read, and an Orchestrator with no class is a workflow.
 *
 * The legal/illegal verdicts are derived from the rules' DOCUMENTED tables —
 * three rule descriptions + narratives and the architecture
 * standard — never from trial runs:
 *
 *  - Portals/Observers are top-level entry points/subscribers and can never be
 *    depended upon (ARCHITECTURE_VIOLATION_PORTAL_DEP, any consumer). That is
 *    the edge's ONE finding: no consumer-side code reports it again.
 *  - A Portal dispatches to Orchestrators (and Supervisors) and may READ
 *    through Index/Repository faces; raw Store/Registry/Query and Adapters stay
 *    out of reach (ARCHITECTURE_VIOLATION_PORTAL_FORBIDDEN_DEP).
 *  - An Observer forwards to one Orchestrator/Supervisor and may use a
 *    message-bus Adapter to subscribe; Store/Registry/Repository/Index/Query
 *    are forbidden (ARCHITECTURE_VIOLATION_PORTAL_FORBIDDEN_DEP).
 *  - Pure logic depends only on pure logic; read logic also on read logic,
 *    Repositories, Indexes and Adapters (DEPENDENCY_CLASS_VIOLATION). Any block
 *    may use pure logic.
 *  - A Store may depend only on another Store, a backend Adapter or pure logic
 *    (ARCHITECTURE_VIOLATION_STORE_DEP).
 *  - A Registry is the write path to its Store: only that Store, a backend
 *    Adapter, or pure logic validating the write (the standard §7
 *    validate→write path); warning while the check is new
 *    (ARCHITECTURE_VIOLATION_REGISTRY_DEP).
 *  - An Adapter is a sink toward the system: pure logic at most, never a Store
 *    or any other Orchestrator (ARCHITECTURE_VIOLATION_ADAPTER_DEP).
 *  - An Index is a read projection and a Query a computed read over its Store:
 *    only a Store, a backend Adapter or pure logic
 *    (ARCHITECTURE_VIOLATION_INDEX_DEP / ARCHITECTURE_VIOLATION_QUERY_DEP).
 *  - A View is a passive presenter: persistence, boundary and non-pure logic
 *    blocks are all forbidden (ARCHITECTURE_VIOLATION_VIEW_DEP).
 *  - A Supervisor reaches data only through workflows: Store/Registry/
 *    Repository/Index/Query/View are forbidden
 *    (ARCHITECTURE_VIOLATION_SUPERVISOR_DEP).
 *  - A live Actor is reached through a Supervisor that supervises it: any
 *    non-Supervisor depending on an Actor without also depending on such a
 *    Supervisor is ACTOR_REACHED_WITHOUT_SUPERVISOR. No pair tree carries a
 *    Supervisor of the target Actor, so every non-Supervisor → Actor pair fires;
 *    the quiet shape is pinned by the explicit control after the sweep.
 *  - A workflow Orchestrator, an Actor and the Repository facade carry no
 *    consumer-side restriction of their own.
 *
 * Where a pair trips both a consumer-side code and ACTOR_REACHED_WITHOUT_SUPERVISOR
 * (e.g. Store → Actor), the fixture asserts the MORE SPECIFIC consumer-side code.
 *
 * All pairs are miniature slices of one realistic clinic-booking system
 * (MediBook) with per-pair role names, as the harness requires.
 */
import { defineRuleFixture, type FixtureSpecInput, type FixtureTree, type RuleFixture } from '../harness.js';

const PORTAL_DEP = 'ARCHITECTURE_VIOLATION_PORTAL_DEP';
const PORTAL_FORBIDDEN_DEP = 'ARCHITECTURE_VIOLATION_PORTAL_FORBIDDEN_DEP';
const CLASS_VIOLATION = 'DEPENDENCY_CLASS_VIOLATION';
const STORE_DEP = 'ARCHITECTURE_VIOLATION_STORE_DEP';
const REGISTRY_DEP = 'ARCHITECTURE_VIOLATION_REGISTRY_DEP';
const ADAPTER_DEP = 'ARCHITECTURE_VIOLATION_ADAPTER_DEP';
const INDEX_DEP = 'ARCHITECTURE_VIOLATION_INDEX_DEP';
const QUERY_DEP = 'ARCHITECTURE_VIOLATION_QUERY_DEP';
const VIEW_DEP = 'ARCHITECTURE_VIOLATION_VIEW_DEP';
const SUPERVISOR_DEP = 'ARCHITECTURE_VIOLATION_SUPERVISOR_DEP';
const ACTOR_UNSUPERVISED = 'ACTOR_REACHED_WITHOUT_SUPERVISOR';

/** A matrix role: a stereotype, with logic split by its dependencyClass. */
type MatrixType =
  | 'Portal' | 'Workflow' | 'PureLogic' | 'ReadLogic' | 'Supervisor' | 'Actor' | 'Store' | 'Index'
  | 'Query' | 'Registry' | 'Adapter' | 'Observer' | 'Repository' | 'View';

/** The roles the sweep mandates (View rides along separately). */
const SWEEP: Exclude<MatrixType, 'View'>[] = [
  'Portal', 'Workflow', 'PureLogic', 'ReadLogic', 'Supervisor', 'Actor', 'Store', 'Index',
  'Query', 'Registry', 'Adapter', 'Observer', 'Repository',
];

/** How a scenario names each role's stereotype. */
const STEREOTYPE_LABEL: Record<MatrixType, string> = {
  Portal: 'Portal', Workflow: 'workflow Orchestrator', PureLogic: 'pure Orchestrator', ReadLogic: 'read Orchestrator',
  Supervisor: 'Supervisor', Actor: 'Actor', Store: 'Store', Index: 'Index', Query: 'Query', Registry: 'Registry',
  Adapter: 'Adapter', Observer: 'Observer', Repository: 'Repository', View: 'View',
};

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
  componentType: string,
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
  Workflow: role('appointment-orchestrator', 'Orchestrator', 'the appointment booking orchestrator',
    'Coordinates the appointment booking workflow end to end.'),
  PureLogic: role('slot-matching-arbiter', 'Orchestrator', 'the slot-matching arbiter',
    'Pure logic matching visit requests to open clinician slots from the values it is handed.', { dependencyClass: 'pure' }),
  ReadLogic: role('availability-projector', 'Orchestrator', 'the clinician availability projector',
    'Read logic projecting clinician availability from the scheduling data.', { dependencyClass: 'read' }),
  Supervisor: role('intake-shift-supervisor', 'Supervisor', 'the intake shift supervisor',
    'Supervises intake worker processes and restarts failed booking runs.'),
  Actor: role('reminder-dispatch-actor', 'Actor', 'the reminder dispatch actor',
    'Background actor working the queued visit-reminder jobs.'),
  Store: role('appointment-store', 'Store', 'the appointment store',
    'Holds the booked appointment records.'),
  Index: role('open-slot-index', 'Index', 'the open-slot read index',
    'Read projection answering open-slot availability queries.'),
  Query: role('overdue-follow-up-query', 'Query', 'the overdue follow-up query',
    'Computed read listing the visits past their follow-up date.'),
  Registry: role('appointment-registry', 'Registry', 'the appointment write registry',
    'Validated write path for appointment records.'),
  Adapter: role('sms-notify-adapter', 'Adapter', 'the SMS notification adapter',
    'Wraps the SMS provider API behind a notification interface.'),
  Observer: role('cancellation-observer', 'Observer', 'the cancellation event observer',
    'Subscribes to cancellation events on the clinic message bus.'),
  Repository: role('patient-chart-repository', 'Repository', 'the patient-chart repository facade',
    'Facade over the patient chart store and its write registry.',
    { owns: ['patient-chart-store', 'patient-chart-registry'] },
    [
      { id: 'patient-chart-store', componentType: 'Store', description: 'Holds the patient chart records.' },
      { id: 'patient-chart-registry', componentType: 'Registry', description: 'Validated write path for patient chart records.' },
    ]),
};

const TARGETS: Record<MatrixType, MatrixRole> = {
  Portal: role('clinician-console-portal', 'Portal', 'the clinician console portal',
    'Clinician-facing console surface for managing the day schedule.', { portalType: 'Custom' }),
  Workflow: role('schedule-rebalance-orchestrator', 'Orchestrator', 'the schedule rebalancing orchestrator',
    'Rebalances clinician schedules when slots free up.'),
  PureLogic: role('eligibility-arbiter', 'Orchestrator', 'the insurance eligibility arbiter',
    'Pure logic deciding a patient\'s insurance eligibility from the facts it is handed.', { dependencyClass: 'pure' }),
  ReadLogic: role('waitlist-projector', 'Orchestrator', 'the waitlist projector',
    'Read logic projecting the waitlist order from the booking data.', { dependencyClass: 'read' }),
  Supervisor: role('triage-queue-supervisor', 'Supervisor', 'the triage queue supervisor',
    'Supervises the triage queue workers.'),
  Actor: role('waitlist-promotion-actor', 'Actor', 'the waitlist promotion actor',
    'Background actor promoting waitlisted patients into freed slots.'),
  Store: role('patient-record-store', 'Store', 'the patient record store',
    'Holds the patient master records.'),
  Index: role('clinician-roster-index', 'Index', 'the clinician roster read index',
    'Read projection over the clinician roster.'),
  Query: role('no-show-rate-query', 'Query', 'the no-show rate query',
    'Computed read of each clinician\'s no-show rate.'),
  Registry: role('patient-record-registry', 'Registry', 'the patient record write registry',
    'Validated write path for patient master records.'),
  Adapter: role('insurance-claim-adapter', 'Adapter', 'the insurance claim adapter',
    'Wraps the insurer claim API behind a claims interface.'),
  Observer: role('no-show-observer', 'Observer', 'the no-show event observer',
    'Subscribes to no-show events on the clinic message bus.'),
  Repository: role('visit-history-repository', 'Repository', 'the visit-history repository facade',
    'Facade over the visit history store and its write registry.',
    { owns: ['visit-history-store', 'visit-history-registry'] },
    [
      { id: 'visit-history-store', componentType: 'Store', description: 'Holds the historical visit records.' },
      { id: 'visit-history-registry', componentType: 'Registry', description: 'Validated write path for visit history records.' },
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
const within = (target: MatrixType, types: MatrixType[]): boolean => types.includes(target);

function verdictFor(consumer: MatrixType, target: MatrixType): Verdict | null {
  // The universal rule first: Portals and Observers are entry points/subscribers
  // and can never be dependencies. That is the edge's one finding.
  if (target === 'Portal' || target === 'Observer') {
    return err(PORTAL_DEP);
  }
  // Consumer-side matrices next: where both a consumer-side code and the Actor
  // rule would fire, the more specific consumer-side code is asserted.
  if (consumer === 'Portal' && within(target, ['Store', 'Registry', 'Adapter', 'Query'])) {
    return err(PORTAL_FORBIDDEN_DEP);
  }
  if (consumer === 'Observer' && within(target, ['Store', 'Registry', 'Repository', 'Index', 'Query'])) {
    return err(PORTAL_FORBIDDEN_DEP);
  }
  if (consumer === 'PureLogic' && target !== 'PureLogic') {
    return err(CLASS_VIOLATION);
  }
  if (consumer === 'ReadLogic' && !within(target, ['PureLogic', 'ReadLogic', 'Repository', 'Index', 'Adapter'])) {
    return err(CLASS_VIOLATION);
  }
  if (consumer === 'Store' && !within(target, ['Store', 'Adapter', 'PureLogic'])) {
    return err(STORE_DEP);
  }
  if (consumer === 'Registry' && !within(target, ['Store', 'Adapter', 'PureLogic'])) {
    return { code: REGISTRY_DEP, severity: 'warning' }; // warning while the check is new (documented)
  }
  if (consumer === 'Adapter' && within(target, ['Store', 'Workflow', 'ReadLogic'])) {
    return err(ADAPTER_DEP);
  }
  if (consumer === 'Index' && !within(target, ['Store', 'Adapter', 'PureLogic'])) {
    return err(INDEX_DEP);
  }
  if (consumer === 'Query' && !within(target, ['Store', 'Adapter', 'PureLogic'])) {
    return err(QUERY_DEP);
  }
  if (consumer === 'View' && within(target, ['Store', 'Registry', 'Index', 'Query', 'Adapter', 'Repository', 'Workflow', 'ReadLogic'])) {
    return err(VIEW_DEP);
  }
  if (consumer === 'Supervisor' && within(target, ['Store', 'Registry', 'Repository', 'Index', 'Query', 'View'])) {
    return err(SUPERVISOR_DEP);
  }
  // A live Actor is reached through a Supervisor that supervises it; no pair
  // tree carries one, so any non-Supervisor consumer is unsupervised.
  if (target === 'Actor' && consumer !== 'Supervisor') {
    return err(ACTOR_UNSUPERVISED);
  }
  return null;
}

/** The code a LEGAL edge's control asserts quiet: the consumer's own matrix code. */
function quietCodeFor(consumer: MatrixType): string {
  switch (consumer) {
    case 'Portal':
    case 'Observer': return PORTAL_FORBIDDEN_DEP;
    // A workflow Orchestrator declares no class, so no class bounds its edges.
    case 'Workflow':
    case 'PureLogic':
    case 'ReadLogic': return CLASS_VIOLATION;
    case 'Store': return STORE_DEP;
    case 'Index': return INDEX_DEP;
    case 'Query': return QUERY_DEP;
    case 'Registry': return REGISTRY_DEP;
    case 'Adapter': return ADAPTER_DEP;
    case 'View': return VIEW_DEP;
    case 'Supervisor': return SUPERVISOR_DEP;
    // Actors and the Repository facade have no consumer-side code; the only
    // rule that could ever bite their legal edges is PORTAL_DEP.
    default: return PORTAL_DEP;
  }
}

/** Doc-sourced notes for the interesting sanctioned edges (control `reason`s). */
const LEGAL_NOTES: Record<string, string> = {
  'Portal->Index': 'Portal reads may go through an Index read face without per-entity Orchestrator ceremony; writes route through Orchestrators (policed separately by PORTAL_WRITE_SHORTCUT).',
  'Portal->Repository': 'Portal reads may go through the Repository facade; only write-effect calls are the shortcut PORTAL_WRITE_SHORTCUT polices.',
  'Portal->Workflow': 'A Portal dispatches to Orchestrators — the sanctioned front-door shape.',
  'Portal->Supervisor': 'A Portal coordinates through Orchestrators and Supervisors per the documented matrix.',
  'Observer->Workflow': 'An Observer forwards to one Orchestrator — the documented forwarding shape.',
  'Observer->Supervisor': 'An Observer may forward to a Supervisor per the documented matrix.',
  'Observer->Adapter': 'An Observer may use a message-bus Adapter to subscribe (documented explicitly).',
  'PureLogic->PureLogic': 'Pure logic depends on other pure logic — the one dependency its class allows.',
  'ReadLogic->PureLogic': 'Read logic may use pure logic (documented explicitly).',
  'ReadLogic->ReadLogic': 'Read logic may build on other read logic (documented explicitly).',
  'ReadLogic->Repository': 'Read logic may read through a Repository facade (documented explicitly).',
  'ReadLogic->Index': 'Read logic may read through an Index (documented explicitly).',
  'ReadLogic->Adapter': 'Read logic may read through an Adapter (documented explicitly).',
  'Store->Store': 'A Store may depend on another Store (documented explicitly).',
  'Store->Adapter': 'A Store may depend on its backend Adapter (documented explicitly).',
  'Store->PureLogic': 'Any block may use pure logic, a Store included.',
  'Index->Store': 'An Index is a read projection over its Store — the documented shape.',
  'Index->Adapter': 'An Index may depend on a backend Adapter (documented explicitly).',
  'Index->PureLogic': 'Any block may use pure logic, an Index included.',
  'Query->Store': 'A Query computes reads over its Store — the documented shape.',
  'Query->Adapter': 'A Query may read through a backend Adapter where one serves it (documented explicitly).',
  'Query->PureLogic': 'A Query may compute with pure logic (documented explicitly).',
  'Registry->Store': 'A Registry is the write path to its Store — the documented shape.',
  'Registry->Adapter': 'A Registry may depend on a backend Adapter (documented explicitly).',
  'Registry->PureLogic': 'The standard §7 validate→write path: a Registry may consult pure validation logic before writing its Store (documented explicitly).',
  'Adapter->PureLogic': 'An Adapter may use pure logic (documented explicitly).',
  'Supervisor->Actor': 'A Supervisor depending on an Actor supervises it — the documented process shape.',
  'Supervisor->Workflow': 'A Supervisor reaches data only through workflows — the documented shape.',
  'Supervisor->Adapter': 'A Supervisor may depend on Adapters (documented explicitly).',
  'Supervisor->Supervisor': 'A Supervisor may depend on other Supervisors (documented explicitly).',
  'View->PureLogic': 'A View may use pure logic — all the logic a passive presenter is allowed.',
  'View->View': 'A composite View embedding another View stays inside the presentation layer, which is all the View rule demands.',
};

// ---------------------------------------------------------------------------
// Fixture assembly
// ---------------------------------------------------------------------------

const SYSTEM = {
  name: 'MediBook',
  vision: 'Clinic appointment booking platform covering scheduling, patient records, and partner integrations.',
};

const SUBSYSTEM_DESCRIPTIONS: Record<string, string> = {
  'patient-scheduling': 'Appointment booking and slot management for the clinic.',
  'booking-web-ui': 'The patient-facing booking web frontend.',
};

function pairTree(consumer: MatrixRole, target: MatrixRole, subsystem: string, projectType?: string): FixtureTree {
  return {
    system: SYSTEM,
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
  const edge =
    `In the MediBook clinic-booking system, ${consumer.phrase} (${STEREOTYPE_LABEL[consumerType]}) declares a dependsOn edge on ` +
    `${target.phrase} (${STEREOTYPE_LABEL[targetType]})`;
  if (verdict) {
    return defineRuleFixture({
      code: verdict.code,
      severity: verdict.severity,
      anchoredTo: consumer.id,
      expectFire: true,
      scenario: `${edge}, an edge the documented stereotype matrix forbids.`,
      tree,
    });
  }
  const quietCode = quietCodeFor(consumerType);
  return defineRuleFixture({
    code: quietCode,
    expectFire: false,
    reason:
      LEGAL_NOTES[`${consumerType}->${targetType}`]
      ?? `The documented stereotype matrix places no restriction on a ${STEREOTYPE_LABEL[consumerType]} depending on a ${STEREOTYPE_LABEL[targetType]}, so ${quietCode} must stay quiet on this edge.`,
    scenario: `${edge}, an edge the documented stereotype matrix sanctions.`,
    tree,
  });
}

const fixtures: RuleFixture[] = [];

// The mandated 13 × 13 sweep (backend profile, one subsystem — the
// cross-subsystem boundary rules are covered by the boundaries-cross-subsystem
// family; this sweep pins the INTRA-subsystem interaction matrix).
for (const consumerType of SWEEP) {
  for (const targetType of SWEEP) {
    fixtures.push(pairFixture(consumerType, targetType, CONSUMERS[consumerType], TARGETS[targetType], 'patient-scheduling'));
  }
}

// The View row (frontend-reactive profile, so the View itself is legal): the
// same rule module registers ARCHITECTURE_VIOLATION_VIEW_DEP. Targets are the
// 13 sweep roles plus a sibling View (the documented-legal composite).
for (const targetType of [...SWEEP, 'View' as const]) {
  fixtures.push(pairFixture('View', targetType, VIEW_CONSUMER, TARGETS[targetType], 'booking-web-ui', 'frontend-reactive'));
}

// The supervised shape the sweep cannot express in a pair: a workflow reaching
// a live Actor also depends on the Supervisor that supervises that Actor.
fixtures.push(defineRuleFixture({
  code: ACTOR_UNSUPERVISED,
  expectFire: false,
  reason: 'The workflow also depends on the Supervisor that depends on the Actor, so it reaches the live Actor through the Supervisor that supervises it — the documented process shape.',
  scenario:
    'In the MediBook clinic-booking system, the appointment booking orchestrator reaches the waitlist promotion actor together with the waitlist supervisor that supervises it.',
  tree: {
    system: SYSTEM,
    subsystems: [{ id: 'patient-scheduling', description: SUBSYSTEM_DESCRIPTIONS['patient-scheduling'] }],
    components: [
      { ...CONSUMERS.Workflow.spec, dependsOn: [TARGETS.Actor.id, 'waitlist-supervisor'] },
      TARGETS.Actor.spec,
      {
        id: 'waitlist-supervisor',
        componentType: 'Supervisor',
        description: 'Supervises the waitlist promotion actors and restarts a failed promotion.',
        dependsOn: [TARGETS.Actor.id],
      },
    ],
  },
}));

export default fixtures;
