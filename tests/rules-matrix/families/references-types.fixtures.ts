/**
 * Type definition and reference integrity (src/core/rules/type-references.ts,
 * with the extraction heuristics of src/core/rules/type-analysis.ts).
 *
 * Documented intents pinned here:
 *  - INVALID_SUBSYSTEM_REFERENCE (error): a type's owning `subsystem` must
 *    reference an existing subsystem.
 *  - UNDEFINED_TYPE_REFERENCE (error): every type mentioned in a type FIELD or
 *    an interface METHOD SIGNATURE must resolve to a builtin, an in-scope
 *    generic parameter, or a defined TypeSpec. Behaviors covered: the
 *    type-field path, the prose-signature path, and the structured-params path
 *    (params are AUTHORITATIVE when present — the prose signature is
 *    display-only and never tokenized), plus a generics-in-scope control.
 *  - HOLLOW_TYPE (warning): a type with neither fields nor methods is a
 *    placeholder that informs neither implementers nor the ERD.
 */
import { defineRuleFixture } from '../harness.js';

export default [
  // -------------------------------------------------------------------------
  // INVALID_SUBSYSTEM_REFERENCE
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'INVALID_SUBSYSTEM_REFERENCE',
    severity: 'error',
    anchoredTo: 'freight-quote',
    expectFire: true,
    scenario:
      'The freight quote entity still claims the retired pricing subsystem as its owner after the subsystem was renamed to quoting.',
    tree: {
      subsystems: [{ id: 'quoting', description: 'Carrier quote computation and persistence.' }],
      types: [
        {
          id: 'freight-quote',
          kind: 'entity',
          // The defect: "pricing" does not exist; the subsystem is "quoting".
          subsystem: 'pricing',
          fields: [
            { name: 'quoteId', type: 'string', description: 'Stable quote identifier.' },
            { name: 'totalCents', type: 'int', description: 'Quoted price in cents.' },
          ],
        },
      ],
    },
  }),
  defineRuleFixture({
    code: 'INVALID_SUBSYSTEM_REFERENCE',
    expectFire: false,
    reason: 'The type references the quoting subsystem that actually exists.',
    scenario:
      'The freight quote entity names the existing quoting subsystem as its owner.',
    tree: {
      subsystems: [{ id: 'quoting', description: 'Carrier quote computation and persistence.' }],
      types: [
        {
          id: 'freight-quote',
          kind: 'entity',
          subsystem: 'quoting',
          fields: [
            { name: 'quoteId', type: 'string', description: 'Stable quote identifier.' },
            { name: 'totalCents', type: 'int', description: 'Quoted price in cents.' },
          ],
        },
      ],
    },
  }),

  // -------------------------------------------------------------------------
  // UNDEFINED_TYPE_REFERENCE — type-field path
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'UNDEFINED_TYPE_REFERENCE',
    severity: 'error',
    anchoredTo: 'freight-quote',
    expectFire: true,
    scenario:
      'The freight quote entity has a carrier field typed CarrierProfile, but no CarrierProfile type is defined anywhere in the tree.',
    tree: {
      subsystems: [{ id: 'quoting', description: 'Carrier quote computation and persistence.' }],
      types: [
        {
          id: 'freight-quote',
          kind: 'entity',
          subsystem: 'quoting',
          fields: [
            { name: 'quoteId', type: 'string', description: 'Stable quote identifier.' },
            // The defect: CarrierProfile is not defined.
            { name: 'carrier', type: 'CarrierProfile', description: 'The carrier this quote was priced against.' },
          ],
        },
      ],
    },
  }),
  defineRuleFixture({
    code: 'UNDEFINED_TYPE_REFERENCE',
    expectFire: false,
    reason: 'CarrierProfile resolves to the defined carrier-profile type; suffix matching accepts the CamelCase reference.',
    scenario:
      'The freight quote entity references CarrierProfile, which is defined as the carrier-profile value object in the same tree.',
    tree: {
      subsystems: [{ id: 'quoting', description: 'Carrier quote computation and persistence.' }],
      types: [
        {
          id: 'freight-quote',
          kind: 'entity',
          subsystem: 'quoting',
          fields: [
            { name: 'quoteId', type: 'string', description: 'Stable quote identifier.' },
            { name: 'carrier', type: 'CarrierProfile', description: 'The carrier this quote was priced against.' },
          ],
        },
        {
          id: 'carrier-profile',
          kind: 'value-object',
          subsystem: 'quoting',
          name: 'CarrierProfile',
          fields: [
            { name: 'scacCode', type: 'string', description: 'Standard carrier alpha code.' },
            { name: 'displayName', type: 'string', description: 'Human-readable carrier name.' },
          ],
        },
      ],
    },
  }),

  // -------------------------------------------------------------------------
  // UNDEFINED_TYPE_REFERENCE — prose method-signature path
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'UNDEFINED_TYPE_REFERENCE',
    severity: 'error',
    anchoredTo: 'idock_scheduler',
    expectFire: true,
    scenario:
      'The dock scheduler contract returns a BookingReceipt in its method signature, but no BookingReceipt type is defined in the tree.',
    tree: {
      subsystems: [{ id: 'dock-scheduling', description: 'Dock slot scheduling for inbound trailers.' }],
      components: [
        {
          id: 'dock-scheduler',
          componentType: 'Orchestrator',
          subsystem: 'dock-scheduling',
          description: 'Assigns inbound trailers to dock slots.',
        },
      ],
      interfaces: [
        {
          id: 'idock_scheduler',
          component: 'dock-scheduler',
          methods: [
            {
              name: 'reserveSlot',
              description: 'Reserve a dock slot for an inbound trailer.',
              // The defect: BookingReceipt is not defined.
              signature: 'reserveSlot(trailerId: string): Promise<BookingReceipt>',
              returns: 'Promise<BookingReceipt>',
            },
          ],
        },
      ],
    },
  }),
  defineRuleFixture({
    code: 'UNDEFINED_TYPE_REFERENCE',
    expectFire: false,
    reason: 'BookingReceipt is defined as the booking-receipt value object, so the signature reference resolves.',
    scenario:
      'The dock scheduler contract returns a BookingReceipt that is defined as the booking-receipt value object in the tree.',
    tree: {
      subsystems: [{ id: 'dock-scheduling', description: 'Dock slot scheduling for inbound trailers.' }],
      components: [
        {
          id: 'dock-scheduler',
          componentType: 'Orchestrator',
          subsystem: 'dock-scheduling',
          description: 'Assigns inbound trailers to dock slots.',
        },
      ],
      interfaces: [
        {
          id: 'idock_scheduler',
          component: 'dock-scheduler',
          methods: [
            {
              name: 'reserveSlot',
              description: 'Reserve a dock slot for an inbound trailer.',
              signature: 'reserveSlot(trailerId: string): Promise<BookingReceipt>',
              returns: 'Promise<BookingReceipt>',
            },
          ],
        },
      ],
      types: [
        {
          id: 'booking-receipt',
          kind: 'value-object',
          subsystem: 'dock-scheduling',
          name: 'BookingReceipt',
          fields: [
            { name: 'slotId', type: 'string', description: 'Reserved dock slot identifier.' },
            { name: 'windowStart', type: 'datetime', description: 'Start of the reserved window.' },
          ],
        },
      ],
    },
  }),

  // -------------------------------------------------------------------------
  // UNDEFINED_TYPE_REFERENCE — generics-in-scope control (documented exemption)
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'UNDEFINED_TYPE_REFERENCE',
    expectFire: false,
    reason: 'T is a generic parameter declared on the method itself, which the documented intent exempts from type resolution.',
    scenario:
      'The dock scheduler contract declares a generic probe method whose T type variable is in scope from its own signature.',
    tree: {
      subsystems: [{ id: 'dock-scheduling', description: 'Dock slot scheduling for inbound trailers.' }],
      components: [
        {
          id: 'dock-scheduler',
          componentType: 'Orchestrator',
          subsystem: 'dock-scheduling',
          description: 'Assigns inbound trailers to dock slots.',
        },
      ],
      interfaces: [
        {
          id: 'idock_scheduler',
          component: 'dock-scheduler',
          methods: [
            {
              name: 'annotateSlot',
              description: 'Attach an arbitrary annotation payload to a reserved slot.',
              signature: 'annotateSlot<T>(slotId: string, payload: T): Promise<T>',
              returns: 'Promise<T>',
            },
          ],
        },
      ],
    },
  }),

  // -------------------------------------------------------------------------
  // UNDEFINED_TYPE_REFERENCE — structured-params path (params authoritative)
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'UNDEFINED_TYPE_REFERENCE',
    severity: 'error',
    anchoredTo: 'idock_scheduler',
    expectFire: true,
    scenario:
      'The dock scheduler contract types its structured dock parameter as DockAssignment, which no type in the tree defines.',
    tree: {
      subsystems: [{ id: 'dock-scheduling', description: 'Dock slot scheduling for inbound trailers.' }],
      components: [
        {
          id: 'dock-scheduler',
          componentType: 'Orchestrator',
          subsystem: 'dock-scheduling',
          description: 'Assigns inbound trailers to dock slots.',
        },
      ],
      interfaces: [
        {
          id: 'idock_scheduler',
          component: 'dock-scheduler',
          methods: [
            {
              name: 'assignDock',
              description: 'Assign a trailer to a concrete dock.',
              signature: 'assignDock(assignment: DockAssignment): void',
              returns: 'void',
              // The defect: the authoritative structured param names an undefined type.
              params: [{ name: 'assignment', type: 'DockAssignment', description: 'The dock assignment to apply.' }],
            },
          ],
        },
      ],
    },
  }),
  defineRuleFixture({
    code: 'UNDEFINED_TYPE_REFERENCE',
    expectFire: false,
    reason:
      'Structured params are authoritative and resolve to the defined dock-assignment type; the stale prose signature is display-only and never tokenized, exactly as documented.',
    scenario:
      'The dock scheduler contract declares clean structured params while its stale prose signature still mentions a RawDockRecord that was long deleted.',
    tree: {
      subsystems: [{ id: 'dock-scheduling', description: 'Dock slot scheduling for inbound trailers.' }],
      components: [
        {
          id: 'dock-scheduler',
          componentType: 'Orchestrator',
          subsystem: 'dock-scheduling',
          description: 'Assigns inbound trailers to dock slots.',
        },
      ],
      interfaces: [
        {
          id: 'idock_scheduler',
          component: 'dock-scheduler',
          methods: [
            {
              name: 'assignDock',
              description: 'Assign a trailer to a concrete dock.',
              // Display-only prose: RawDockRecord must NOT be tokenized because params exist.
              signature: 'assignDock(assignment: RawDockRecord): void',
              returns: 'void',
              params: [{ name: 'assignment', type: 'DockAssignment', description: 'The dock assignment to apply.' }],
            },
          ],
        },
      ],
      types: [
        {
          id: 'dock-assignment',
          kind: 'value-object',
          subsystem: 'dock-scheduling',
          name: 'DockAssignment',
          fields: [
            { name: 'dockId', type: 'string', description: 'Target dock identifier.' },
            { name: 'trailerId', type: 'string', description: 'Assigned trailer identifier.' },
          ],
        },
      ],
    },
  }),

  // -------------------------------------------------------------------------
  // HOLLOW_TYPE
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'HOLLOW_TYPE',
    severity: 'warning',
    anchoredTo: 'customs-clearance-token',
    expectFire: true,
    scenario:
      'The customs clearance token value object declares neither fields nor methods — a name-only placeholder that informs neither implementers nor the ERD.',
    tree: {
      subsystems: [{ id: 'customs', description: 'Customs clearance handling for cross-border freight.' }],
      types: [
        {
          id: 'customs-clearance-token',
          kind: 'value-object',
          subsystem: 'customs',
          // The defect: no fields, no methods.
        },
      ],
    },
  }),
  defineRuleFixture({
    code: 'HOLLOW_TYPE',
    expectFire: false,
    reason: 'The type declares the shape it models, so it informs implementers and participates in the ERD.',
    scenario:
      'The customs clearance token value object declares its token value and expiry fields.',
    tree: {
      subsystems: [{ id: 'customs', description: 'Customs clearance handling for cross-border freight.' }],
      types: [
        {
          id: 'customs-clearance-token',
          kind: 'value-object',
          subsystem: 'customs',
          fields: [
            { name: 'tokenValue', type: 'string', description: 'Opaque clearance token issued by the broker.' },
            { name: 'expiresAt', type: 'datetime', description: 'Instant the clearance lapses.' },
          ],
        },
      ],
    },
  }),
];
