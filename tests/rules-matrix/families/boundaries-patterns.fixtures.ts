/**
 * Pattern-ownership fixtures (src/core/rules/patterns.ts).
 *
 * Documented intents pinned here:
 *  - EMPTY_PATTERN (error): a pattern must own member blocks.
 *  - BLOCK_OWNS_MEMBERS (error): building blocks never use `owns`.
 *  - INVALID_OWNED_MEMBER (error): owns must name existing components.
 *  - PATTERN_OWNS_PATTERN (error): patterns own only building blocks.
 *  - SHARED_OWNED_MEMBER (error): a block has exactly one owner.
 *  - REPOSITORY_CONTAINMENT (error): Repository owns only Store/Registry/
 *    Index/Adapter.
 *  - GATEWAY_CONTAINMENT (error): Gateway owns only Portal/Orchestrator/
 *    Specialist.
 *  - FEATURE_COMPONENT_CONTAINMENT (error): exactly one Orchestrator + one or
 *    more Views, nothing else.
 *  - ROUTER_COMPONENT_CONTAINMENT (error, two documented behaviors): must own
 *    a Portal facade AND at least one routed child.
 *  - VISIBILITY_VIOLATION (error): nobody reaches a block privately owned by
 *    ANOTHER pattern; the facade, the owner itself, and siblings are legal.
 *  - UNOWNED_STORE (warning): recommended shape for held state is a
 *    Repository; a standalone Store is the acknowledged lightweight form.
 *  - REGISTRY_WITHOUT_STORE (warning): a standalone Registry with no Store to
 *    write to is mistyped or orphaned; Repository-owned Registries reach
 *    their Store as a sibling and are exempt (documented).
 */
import { defineRuleFixture } from '../harness.js';

const SYSTEM = {
  name: 'MediBook',
  vision: 'Clinic appointment booking platform covering scheduling, pharmacy, and partner integrations.',
};

const PHARMACY_SUB = { id: 'pharmacy', description: 'Medication dispensing and refill management for the clinic.' };

const MEDICATION_STORE = { id: 'medication-store', componentType: 'Store', description: 'Holds the medication inventory records.' };
const MEDICATION_REGISTRY = { id: 'medication-registry', componentType: 'Registry', description: 'Validated write path for medication inventory records.' };

export default [
  // -------------------------------------------------------------------------
  // EMPTY_PATTERN
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'EMPTY_PATTERN',
    severity: 'error',
    anchoredTo: 'medication-repository',
    expectFire: true,
    scenario:
      'The medication repository pattern declares no owned member blocks, so there is no store, registry, or index behind its facade.',
    tree: {
      system: SYSTEM,
      subsystems: [PHARMACY_SUB],
      components: [
        { id: 'medication-repository', componentType: 'Repository', description: 'Facade meant to front the medication data blocks.', owns: [] },
      ],
    },
  }),
  defineRuleFixture({
    code: 'EMPTY_PATTERN',
    expectFire: false,
    reason: 'The Repository owns its member blocks via `owns`, which is exactly what the pattern definition prescribes.',
    scenario:
      'The medication repository pattern owns its medication store and write registry behind one facade.',
    tree: {
      system: SYSTEM,
      subsystems: [PHARMACY_SUB],
      components: [
        {
          id: 'medication-repository',
          componentType: 'Repository',
          description: 'Facade over the medication store and its write registry.',
          owns: ['medication-store', 'medication-registry'],
        },
        MEDICATION_STORE,
        MEDICATION_REGISTRY,
      ],
    },
  }),

  // -------------------------------------------------------------------------
  // BLOCK_OWNS_MEMBERS
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'BLOCK_OWNS_MEMBERS',
    severity: 'error',
    anchoredTo: 'dose-scheduling-orchestrator',
    expectFire: true,
    scenario:
      'The dose scheduling orchestrator, a building block, tries to privately own the dose plan store instead of depending on it.',
    tree: {
      system: SYSTEM,
      subsystems: [PHARMACY_SUB],
      components: [
        {
          id: 'dose-scheduling-orchestrator',
          componentType: 'Orchestrator',
          description: 'Schedules medication doses for admitted patients.',
          owns: ['dose-plan-store'],
        },
        { id: 'dose-plan-store', componentType: 'Store', description: 'Holds the planned dose schedules.' },
      ],
    },
  }),
  defineRuleFixture({
    code: 'BLOCK_OWNS_MEMBERS',
    expectFire: false,
    reason: 'The building block collaborates via dependsOn and owns nothing — only patterns use `owns`.',
    scenario:
      'The dose scheduling orchestrator depends on the dose plan store as a collaborator without claiming ownership.',
    tree: {
      system: SYSTEM,
      subsystems: [PHARMACY_SUB],
      components: [
        {
          id: 'dose-scheduling-orchestrator',
          componentType: 'Orchestrator',
          description: 'Schedules medication doses for admitted patients.',
          dependsOn: ['dose-plan-store'],
        },
        { id: 'dose-plan-store', componentType: 'Store', description: 'Holds the planned dose schedules.' },
      ],
    },
  }),

  // -------------------------------------------------------------------------
  // INVALID_OWNED_MEMBER
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'INVALID_OWNED_MEMBER',
    severity: 'error',
    anchoredTo: 'medication-repository',
    expectFire: true,
    scenario:
      'The medication repository claims ownership of a medication batch store that was deleted from the pharmacy subsystem.',
    tree: {
      system: SYSTEM,
      subsystems: [PHARMACY_SUB],
      components: [
        {
          id: 'medication-repository',
          componentType: 'Repository',
          description: 'Facade over the medication data blocks.',
          owns: ['medication-store', 'medication-batch-store'],
        },
        MEDICATION_STORE,
      ],
    },
  }),
  defineRuleFixture({
    code: 'INVALID_OWNED_MEMBER',
    expectFire: false,
    reason: 'Every owns entry resolves to an existing component of the tree.',
    scenario:
      'The medication repository owns exactly the medication store and registry components that exist in the pharmacy subsystem.',
    tree: {
      system: SYSTEM,
      subsystems: [PHARMACY_SUB],
      components: [
        {
          id: 'medication-repository',
          componentType: 'Repository',
          description: 'Facade over the medication data blocks.',
          owns: ['medication-store', 'medication-registry'],
        },
        MEDICATION_STORE,
        MEDICATION_REGISTRY,
      ],
    },
  }),

  // -------------------------------------------------------------------------
  // PATTERN_OWNS_PATTERN
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'PATTERN_OWNS_PATTERN',
    severity: 'error',
    anchoredTo: 'pharmacy-repository',
    expectFire: true,
    scenario:
      'The pharmacy repository tries to own the dispensing gateway, nesting one pattern inside another instead of composing them at the subsystem level.',
    tree: {
      system: SYSTEM,
      subsystems: [PHARMACY_SUB],
      components: [
        {
          id: 'pharmacy-repository',
          componentType: 'Repository',
          description: 'Facade over the pharmacy data blocks.',
          owns: ['medication-store', 'dispensing-gateway'],
        },
        MEDICATION_STORE,
        {
          id: 'dispensing-gateway',
          componentType: 'Gateway',
          description: 'Facade bundling the dispensing portal and its orchestrator.',
          owns: ['dispensing-portal', 'dispensing-orchestrator'],
        },
        { id: 'dispensing-portal', componentType: 'Portal', portalType: 'Custom', description: 'Inbound surface for dispensing requests.' },
        { id: 'dispensing-orchestrator', componentType: 'Orchestrator', description: 'Drives the dispensing workflow.' },
      ],
    },
  }),
  defineRuleFixture({
    code: 'PATTERN_OWNS_PATTERN',
    expectFire: false,
    reason: 'Both patterns own only building blocks and stand side by side in the subsystem — patterns compose at L1, never by nesting.',
    scenario:
      'The pharmacy repository and the dispensing gateway each own their building blocks and are composed side by side in the pharmacy subsystem.',
    tree: {
      system: SYSTEM,
      subsystems: [PHARMACY_SUB],
      components: [
        {
          id: 'pharmacy-repository',
          componentType: 'Repository',
          description: 'Facade over the pharmacy data blocks.',
          owns: ['medication-store'],
        },
        MEDICATION_STORE,
        {
          id: 'dispensing-gateway',
          componentType: 'Gateway',
          description: 'Facade bundling the dispensing portal and its orchestrator.',
          owns: ['dispensing-portal', 'dispensing-orchestrator'],
        },
        { id: 'dispensing-portal', componentType: 'Portal', portalType: 'Custom', description: 'Inbound surface for dispensing requests.' },
        { id: 'dispensing-orchestrator', componentType: 'Orchestrator', description: 'Drives the dispensing workflow.' },
      ],
    },
  }),

  // -------------------------------------------------------------------------
  // SHARED_OWNED_MEMBER
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'SHARED_OWNED_MEMBER',
    severity: 'error',
    expectFire: true,
    scenario:
      'Both the medication repository and the inventory repository claim private ownership of the same medication store.',
    tree: {
      system: SYSTEM,
      subsystems: [PHARMACY_SUB],
      components: [
        {
          id: 'medication-repository',
          componentType: 'Repository',
          description: 'Facade over the medication data blocks.',
          owns: ['medication-store'],
        },
        {
          id: 'inventory-repository',
          componentType: 'Repository',
          description: 'Facade over the stock inventory data blocks.',
          owns: ['medication-store'],
        },
        MEDICATION_STORE,
      ],
    },
  }),
  defineRuleFixture({
    code: 'SHARED_OWNED_MEMBER',
    expectFire: false,
    reason: 'Each repository owns its own store — every block has exactly one owner.',
    scenario:
      'The medication repository and the inventory repository each own their own distinct store.',
    tree: {
      system: SYSTEM,
      subsystems: [PHARMACY_SUB],
      components: [
        {
          id: 'medication-repository',
          componentType: 'Repository',
          description: 'Facade over the medication data blocks.',
          owns: ['medication-store'],
        },
        {
          id: 'inventory-repository',
          componentType: 'Repository',
          description: 'Facade over the stock inventory data blocks.',
          owns: ['stock-inventory-store'],
        },
        MEDICATION_STORE,
        { id: 'stock-inventory-store', componentType: 'Store', description: 'Holds the stock inventory records.' },
      ],
    },
  }),

  // -------------------------------------------------------------------------
  // REPOSITORY_CONTAINMENT
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'REPOSITORY_CONTAINMENT',
    severity: 'error',
    anchoredTo: 'medication-repository',
    expectFire: true,
    scenario:
      'The medication repository owns the refill reminder orchestrator, folding workflow logic into a pattern that may only contain data blocks.',
    tree: {
      system: SYSTEM,
      subsystems: [PHARMACY_SUB],
      components: [
        {
          id: 'medication-repository',
          componentType: 'Repository',
          description: 'Facade over the medication data blocks.',
          owns: ['medication-store', 'refill-reminder-orchestrator'],
        },
        MEDICATION_STORE,
        { id: 'refill-reminder-orchestrator', componentType: 'Orchestrator', description: 'Drives refill reminder campaigns.' },
      ],
    },
  }),
  defineRuleFixture({
    code: 'REPOSITORY_CONTAINMENT',
    expectFire: false,
    reason: 'The Repository owns exactly the documented member set: Store, Registry, Index, and (optionally) a backend Adapter.',
    scenario:
      'The medication repository owns its store, write registry, read index, and the backing database adapter — the full documented containment.',
    tree: {
      system: SYSTEM,
      subsystems: [PHARMACY_SUB],
      components: [
        {
          id: 'medication-repository',
          componentType: 'Repository',
          description: 'Facade over the medication data blocks.',
          owns: ['medication-store', 'medication-registry', 'medication-lookup-index', 'medication-db-adapter'],
        },
        MEDICATION_STORE,
        MEDICATION_REGISTRY,
        { id: 'medication-lookup-index', componentType: 'Index', description: 'Read projection for medication lookups.' },
        { id: 'medication-db-adapter', componentType: 'Adapter', description: 'Backend adapter to the pharmacy database.' },
      ],
    },
  }),

  // -------------------------------------------------------------------------
  // GATEWAY_CONTAINMENT
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'GATEWAY_CONTAINMENT',
    severity: 'error',
    anchoredTo: 'dispensing-gateway',
    expectFire: true,
    scenario:
      'The dispensing gateway owns the medication store directly, pulling a persistence block into a pattern that fronts only Portals, Orchestrators, and Specialists.',
    tree: {
      system: SYSTEM,
      subsystems: [PHARMACY_SUB],
      components: [
        {
          id: 'dispensing-gateway',
          componentType: 'Gateway',
          description: 'Facade bundling the dispensing entry points.',
          owns: ['dispensing-portal', 'medication-store'],
        },
        { id: 'dispensing-portal', componentType: 'Portal', portalType: 'Custom', description: 'Inbound surface for dispensing requests.' },
        MEDICATION_STORE,
      ],
    },
  }),
  defineRuleFixture({
    code: 'GATEWAY_CONTAINMENT',
    expectFire: false,
    reason: 'The Gateway owns exactly the documented member set: a Portal, Orchestrators, and Specialists.',
    scenario:
      'The dispensing gateway owns its portal, the dispensing orchestrator, and an interaction-check specialist — the documented containment.',
    tree: {
      system: SYSTEM,
      subsystems: [PHARMACY_SUB],
      components: [
        {
          id: 'dispensing-gateway',
          componentType: 'Gateway',
          description: 'Facade bundling the dispensing entry points.',
          owns: ['dispensing-portal', 'dispensing-orchestrator', 'interaction-check-specialist'],
        },
        { id: 'dispensing-portal', componentType: 'Portal', portalType: 'Custom', description: 'Inbound surface for dispensing requests.' },
        { id: 'dispensing-orchestrator', componentType: 'Orchestrator', description: 'Drives the dispensing workflow.' },
        { id: 'interaction-check-specialist', componentType: 'Specialist', description: 'Checks prescriptions for drug interactions.' },
      ],
    },
  }),

  // -------------------------------------------------------------------------
  // FEATURE_COMPONENT_CONTAINMENT (frontend profile so the slice is legal)
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'FEATURE_COMPONENT_CONTAINMENT',
    severity: 'error',
    anchoredTo: 'refill-request-feature',
    expectFire: true,
    scenario:
      'The refill request feature slice owns two orchestrators, which the pattern reads as a second feature hiding inside the slice.',
    tree: {
      system: SYSTEM,
      projectType: 'frontend-reactive',
      subsystems: [{ id: 'pharmacy-web-ui', description: 'The pharmacy self-service web frontend.' }],
      components: [
        {
          id: 'refill-request-feature',
          componentType: 'FeatureComponent',
          description: 'The refill request feature slice of the pharmacy UI.',
          owns: ['refill-request-orchestrator', 'refill-history-orchestrator', 'refill-request-view'],
        },
        { id: 'refill-request-orchestrator', componentType: 'Orchestrator', description: 'Logic hook driving the refill request flow.' },
        { id: 'refill-history-orchestrator', componentType: 'Orchestrator', description: 'Logic hook loading past refill requests.' },
        { id: 'refill-request-view', componentType: 'View', description: 'Renders the refill request form.' },
      ],
    },
  }),
  defineRuleFixture({
    code: 'FEATURE_COMPONENT_CONTAINMENT',
    expectFire: false,
    reason: 'Exactly one Orchestrator (the logic side) plus one or more Views (the UI faces) is the documented feature-slice shape.',
    scenario:
      'The refill request feature slice owns one logic orchestrator and its two view faces, the form and the confirmation panel.',
    tree: {
      system: SYSTEM,
      projectType: 'frontend-reactive',
      subsystems: [{ id: 'pharmacy-web-ui', description: 'The pharmacy self-service web frontend.' }],
      components: [
        {
          id: 'refill-request-feature',
          componentType: 'FeatureComponent',
          description: 'The refill request feature slice of the pharmacy UI.',
          owns: ['refill-request-orchestrator', 'refill-request-view', 'refill-confirmation-view'],
        },
        { id: 'refill-request-orchestrator', componentType: 'Orchestrator', description: 'Logic hook driving the refill request flow.' },
        { id: 'refill-request-view', componentType: 'View', description: 'Renders the refill request form.' },
        { id: 'refill-confirmation-view', componentType: 'View', description: 'Renders the refill confirmation panel.' },
      ],
    },
  }),

  // -------------------------------------------------------------------------
  // ROUTER_COMPONENT_CONTAINMENT — both documented behaviors
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'ROUTER_COMPONENT_CONTAINMENT',
    severity: 'error',
    anchoredTo: 'pharmacy-shell-router',
    expectFire: true,
    scenario:
      'The pharmacy shell router owns only its child views and lacks the Portal facade that should front the routing.',
    tree: {
      system: SYSTEM,
      projectType: 'frontend-reactive',
      subsystems: [{ id: 'pharmacy-web-ui', description: 'The pharmacy self-service web frontend.' }],
      components: [
        {
          id: 'pharmacy-shell-router',
          componentType: 'RouterComponent',
          description: 'Routes between the pharmacy UI\'s top-level pages.',
          owns: ['refill-request-view', 'order-status-view'],
        },
        { id: 'refill-request-view', componentType: 'View', description: 'Renders the refill request form.' },
        { id: 'order-status-view', componentType: 'View', description: 'Renders the order status page.' },
      ],
    },
  }),
  defineRuleFixture({
    code: 'ROUTER_COMPONENT_CONTAINMENT',
    severity: 'error',
    anchoredTo: 'pharmacy-shell-router',
    expectFire: true,
    scenario:
      'The pharmacy shell router owns its Portal facade but no child component or view to route to.',
    tree: {
      system: SYSTEM,
      projectType: 'frontend-reactive',
      subsystems: [{ id: 'pharmacy-web-ui', description: 'The pharmacy self-service web frontend.' }],
      components: [
        {
          id: 'pharmacy-shell-router',
          componentType: 'RouterComponent',
          description: 'Routes between the pharmacy UI\'s top-level pages.',
          owns: ['pharmacy-shell-portal'],
        },
        { id: 'pharmacy-shell-portal', componentType: 'Portal', portalType: 'Custom', description: 'The routing facade of the pharmacy UI shell.' },
      ],
    },
  }),
  defineRuleFixture({
    code: 'ROUTER_COMPONENT_CONTAINMENT',
    expectFire: false,
    reason: 'The RouterComponent owns its Portal facade and at least one routed child — both documented obligations are met.',
    scenario:
      'The pharmacy shell router owns its Portal facade plus the refill and order status views it routes between.',
    tree: {
      system: SYSTEM,
      projectType: 'frontend-reactive',
      subsystems: [{ id: 'pharmacy-web-ui', description: 'The pharmacy self-service web frontend.' }],
      components: [
        {
          id: 'pharmacy-shell-router',
          componentType: 'RouterComponent',
          description: 'Routes between the pharmacy UI\'s top-level pages.',
          owns: ['pharmacy-shell-portal', 'refill-request-view', 'order-status-view'],
        },
        { id: 'pharmacy-shell-portal', componentType: 'Portal', portalType: 'Custom', description: 'The routing facade of the pharmacy UI shell.' },
        { id: 'refill-request-view', componentType: 'View', description: 'Renders the refill request form.' },
        { id: 'order-status-view', componentType: 'View', description: 'Renders the order status page.' },
      ],
    },
  }),

  // -------------------------------------------------------------------------
  // VISIBILITY_VIOLATION
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'VISIBILITY_VIOLATION',
    severity: 'error',
    anchoredTo: 'refill-reminder-orchestrator',
    expectFire: true,
    scenario:
      'The refill reminder orchestrator reaches the medication store that the medication repository privately owns, bypassing the facade.',
    tree: {
      system: SYSTEM,
      subsystems: [PHARMACY_SUB],
      components: [
        {
          id: 'medication-repository',
          componentType: 'Repository',
          description: 'Facade over the medication data blocks.',
          owns: ['medication-store', 'medication-registry'],
        },
        MEDICATION_STORE,
        MEDICATION_REGISTRY,
        {
          id: 'refill-reminder-orchestrator',
          componentType: 'Orchestrator',
          description: 'Drives refill reminder campaigns.',
          dependsOn: ['medication-store'],
        },
      ],
    },
  }),
  defineRuleFixture({
    code: 'VISIBILITY_VIOLATION',
    expectFire: false,
    reason: 'The consumer depends on the pattern FACADE, which is the documented access path to privately owned members.',
    scenario:
      'The refill reminder orchestrator reads medication data through the medication repository facade.',
    tree: {
      system: SYSTEM,
      subsystems: [PHARMACY_SUB],
      components: [
        {
          id: 'medication-repository',
          componentType: 'Repository',
          description: 'Facade over the medication data blocks.',
          owns: ['medication-store', 'medication-registry'],
        },
        MEDICATION_STORE,
        MEDICATION_REGISTRY,
        {
          id: 'refill-reminder-orchestrator',
          componentType: 'Orchestrator',
          description: 'Drives refill reminder campaigns.',
          dependsOn: ['medication-repository'],
        },
      ],
    },
  }),
  defineRuleFixture({
    code: 'VISIBILITY_VIOLATION',
    expectFire: false,
    reason: 'A sibling member of the SAME pattern may reach a co-owned block (documented: the owning pattern and siblings are inside the visibility group).',
    scenario:
      'Inside the medication repository, the write registry reaches its sibling medication store to persist validated records.',
    tree: {
      system: SYSTEM,
      subsystems: [PHARMACY_SUB],
      components: [
        {
          id: 'medication-repository',
          componentType: 'Repository',
          description: 'Facade over the medication data blocks.',
          owns: ['medication-store', 'medication-registry'],
        },
        MEDICATION_STORE,
        { ...MEDICATION_REGISTRY, dependsOn: ['medication-store'] },
      ],
    },
  }),

  // -------------------------------------------------------------------------
  // UNOWNED_STORE
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'UNOWNED_STORE',
    severity: 'warning',
    anchoredTo: 'appointment-note-store',
    expectFire: true,
    scenario:
      'The appointment note store stands alone outside any Repository pattern, so the recommended held-state shape is not in place.',
    tree: {
      system: SYSTEM,
      subsystems: [{ id: 'scheduling', description: 'Appointment booking and slot management.' }],
      components: [
        { id: 'appointment-note-store', componentType: 'Store', description: 'Holds free-text notes attached to appointments.' },
      ],
    },
  }),
  defineRuleFixture({
    code: 'UNOWNED_STORE',
    expectFire: false,
    reason: 'The Store is owned by a Repository pattern — the RECOMMENDED shape for held state, so the advisory has nothing to say.',
    scenario:
      'The appointment note store lives inside the appointment note repository together with its write registry.',
    tree: {
      system: SYSTEM,
      subsystems: [{ id: 'scheduling', description: 'Appointment booking and slot management.' }],
      components: [
        {
          id: 'appointment-note-repository',
          componentType: 'Repository',
          description: 'Facade over the appointment note data blocks.',
          owns: ['appointment-note-store', 'appointment-note-registry'],
        },
        { id: 'appointment-note-store', componentType: 'Store', description: 'Holds free-text notes attached to appointments.' },
        { id: 'appointment-note-registry', componentType: 'Registry', description: 'Validated write path for appointment notes.' },
      ],
    },
  }),

  // -------------------------------------------------------------------------
  // REGISTRY_WITHOUT_STORE
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'REGISTRY_WITHOUT_STORE',
    severity: 'warning',
    anchoredTo: 'consent-form-registry',
    expectFire: true,
    scenario:
      'The consent form registry stands alone with no Store dependency, so its write path leads nowhere the durability machinery can see.',
    tree: {
      system: SYSTEM,
      subsystems: [{ id: 'patient-intake', description: 'Patient intake, eligibility, and consent handling.' }],
      components: [
        { id: 'consent-form-registry', componentType: 'Registry', description: 'Validated write path for patient consent forms.' },
      ],
    },
  }),
  defineRuleFixture({
    code: 'REGISTRY_WITHOUT_STORE',
    expectFire: false,
    reason: 'The Registry depends on the Store it writes to — the documented write-path wiring.',
    scenario:
      'The consent form registry writes validated consent forms into the consent form store it depends on.',
    tree: {
      system: SYSTEM,
      subsystems: [{ id: 'patient-intake', description: 'Patient intake, eligibility, and consent handling.' }],
      components: [
        {
          id: 'consent-form-registry',
          componentType: 'Registry',
          description: 'Validated write path for patient consent forms.',
          dependsOn: ['consent-form-store'],
        },
        { id: 'consent-form-store', componentType: 'Store', description: 'Holds the signed patient consent forms.' },
      ],
    },
  }),
  defineRuleFixture({
    code: 'REGISTRY_WITHOUT_STORE',
    expectFire: false,
    reason: 'Repository-owned Registries reach their Store as a sibling member and are exempt from the dependency requirement (documented).',
    scenario:
      'The consent form registry lives inside the consent form repository next to its sibling store, so the write path is the sibling edge.',
    tree: {
      system: SYSTEM,
      subsystems: [{ id: 'patient-intake', description: 'Patient intake, eligibility, and consent handling.' }],
      components: [
        {
          id: 'consent-form-repository',
          componentType: 'Repository',
          description: 'Facade over the consent form data blocks.',
          owns: ['consent-form-store', 'consent-form-registry'],
        },
        { id: 'consent-form-store', componentType: 'Store', description: 'Holds the signed patient consent forms.' },
        { id: 'consent-form-registry', componentType: 'Registry', description: 'Validated write path for patient consent forms.' },
      ],
    },
  }),
];
