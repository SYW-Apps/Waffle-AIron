/**
 * Type shape (code↔spec for the DATA) — src/core/rules/conformance/type-shape.ts.
 *
 * Documented intents pinned here (rule description + module doc comment):
 *  - UNREALIZED_TYPE_FIELD (warning): a type spec declares a field the shape at
 *    its sourcePath does not carry. `typeRealization` only ever asked whether
 *    the type EXISTS, so the spec could describe data the code does not have
 *    and nothing broke at a call site to correct it.
 *  - UNDECLARED_TYPE_FIELD (warning): the shape carries a field the type spec
 *    does not declare — data the design never described, so no diagram draws it
 *    and no brief hands it to an implementer.
 *  - TYPE_FIELD_OPTIONALITY (warning): the two disagree about whether a field
 *    may be absent, which is one of them telling a reader the data is
 *    guaranteed when it is not, or the reverse.
 *
 * The quiet shapes, each with a control:
 *  - a shape that EXTENDS another is judged on what it shows and never on what
 *    it omits, because its inherited members are not in that file to count —
 *    but a member it DOES list is one it answers for, so optionality still is
 *    (the two extending trees below are near-identical and differ only there);
 *  - a member the code writes METHOD-style is behaviour on the axis
 *    `typeRealization` already judges, not undeclared state;
 *  - a DERIVED shape resolves one hop to the BASE `.object({…})` call, so a
 *    schema refined afterwards is still read as its own keys — taking the first
 *    object literal instead would read `.refine(fn, { message })` as a
 *    one-field shape called `message`, which is why that tree is asserted from
 *    both presence sides;
 *  - `.default(x)` FILLS a missing key, so the field is REQUIRED in the value
 *    the type finally holds — the shape the spec describes — while
 *    `.optional()` is what actually lets a key be absent.
 */
import { defineRuleFixture, type FixtureTree } from '../harness.js';

/** The planner module every tree below links its contract to, so the type specs are the only thing in question. */
const PLANNER_MODULE = `
export interface DepotRoute { id: string; }
export function planConsignment(route: DepotRoute): void { void route; }
`;

/** The one spec'd component each tree needs so its implementation has a contract. */
const plannerSpecs = {
  subsystems: [{ id: 'cold-chain', description: 'Temperature-controlled consignments from the depot to a pharmacy.' }],
  components: [{
    id: 'consignment-planner',
    componentType: 'Orchestrator',
    subsystem: 'cold-chain',
    description: 'Plans a temperature-controlled consignment onto the next depot route with capacity.',
  }],
  interfaces: [{
    id: 'iconsignment_planner',
    component: 'consignment-planner',
    methods: [{ name: 'planConsignment', description: 'Plan a consignment onto the next depot route.' }],
  }],
  implementations: [{
    id: 'consignment_planner_impl',
    contract: 'iconsignment_planner',
    sourcePath: 'src/cold-chain/planner.ts',
    methods: [{
      name: 'planConsignment',
      narrative: [{ stepNumber: 1, type: 'local', description: 'Place the consignment on the next depot route with capacity.' }],
    }],
  }],
};

/**
 * The schema tree, read from both presence sides below. `ColdChainConsignment`
 * is derived one hop from a schema that is REFINED after its object call, so
 * its members are the base object's keys — exactly the spec's two fields. Were
 * the hop to stop at the first object literal it met, it would take the refine
 * OPTIONS instead: the shape would read as one field called `message`, which
 * fires UNDECLARED_TYPE_FIELD for `message` and UNREALIZED_TYPE_FIELD for both
 * declared fields at once. One tree, asserted twice, because silence on either
 * half alone would leave the other free.
 */
const REFINED_CONSIGNMENT_SCHEMA: FixtureTree = {
  ...plannerSpecs,
  types: [{
    id: 'cold-chain-consignment',
    name: 'ColdChainConsignment',
    subsystem: 'cold-chain',
    sourcePath: 'src/cold-chain/consignment.ts',
    fields: [
      { name: 'id', type: 'string', key: 'primary', description: 'The consignment reference printed on the seal.' },
      { name: 'pharmacyId', type: 'string', description: 'The pharmacy the consignment is bound for.' },
    ],
  }],
  files: {
    'src/cold-chain/planner.ts': PLANNER_MODULE,
    'src/cold-chain/consignment.ts': `
import { z } from 'zod';

export const ColdChainConsignmentSchema = z
  .object({
    id: z.string(),
    pharmacyId: z.string(),
  })
  .refine((consignment) => consignment.id.startsWith('CC-'), { message: 'a consignment reference starts with CC-' });

export type ColdChainConsignment = z.infer<typeof ColdChainConsignmentSchema>;
`,
  },
};

/**
 * The extending tree, read from two codes below. `ColdChainConsignment` takes
 * its identity fields from `DepotMovement` and lists only the seal timestamp of
 * its own, so presence cannot be asked of it — the members it does not list are
 * not in this file to count — while the one member it DOES list is a member it
 * answers for. The optionality fixture below is this tree with the spec's
 * `sealedAt` called required instead, and nothing else changed.
 */
const EXTENDED_CONSIGNMENT: FixtureTree = {
  ...plannerSpecs,
  types: [{
    id: 'cold-chain-consignment',
    name: 'ColdChainConsignment',
    subsystem: 'cold-chain',
    sourcePath: 'src/cold-chain/consignment.ts',
    fields: [
      { name: 'id', type: 'string', key: 'primary', description: 'The consignment reference printed on the seal.' },
      { name: 'pharmacyId', type: 'string', description: 'The pharmacy the consignment is bound for.' },
      { name: 'sealedAt', type: 'string', optional: true, description: 'When the cold box was sealed at the depot, once it has been.' },
    ],
  }],
  files: {
    'src/cold-chain/planner.ts': PLANNER_MODULE,
    'src/cold-chain/consignment.ts': `
export interface DepotMovement {
  id: string;
  pharmacyId: string;
}

export interface ColdChainConsignment extends DepotMovement {
  sealedAt?: string;
}
`,
  },
};

export default [
  // -------------------------------------------------------------------------
  // UNREALIZED_TYPE_FIELD — fire: the spec describes data the interface lacks
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'UNREALIZED_TYPE_FIELD',
    severity: 'warning',
    anchoredTo: 'cold-chain-consignment',
    expectFire: true,
    scenario:
      'The cold-chain consignment entity models a seal timestamp and a breach count, but the interface at its sourcePath carries neither — the ERD and every brief hand an implementer two fields the record does not have.',
    tree: {
      ...plannerSpecs,
      types: [{
        id: 'cold-chain-consignment',
        name: 'ColdChainConsignment',
        subsystem: 'cold-chain',
        sourcePath: 'src/cold-chain/consignment.ts',
        fields: [
          { name: 'id', type: 'string', key: 'primary', description: 'The consignment reference printed on the seal.' },
          { name: 'pharmacyId', type: 'string', description: 'The pharmacy the consignment is bound for.' },
          { name: 'sealedAt', type: 'string', description: 'When the cold box was sealed at the depot.' },
          { name: 'breachCount', type: 'number', description: 'How many times the box left its temperature band in transit.' },
        ],
      }],
      files: {
        'src/cold-chain/planner.ts': PLANNER_MODULE,
        'src/cold-chain/consignment.ts': `
export interface ColdChainConsignment {
  id: string;
  pharmacyId: string;
}
`,
      },
    },
  }),

  // -------------------------------------------------------------------------
  // UNREALIZED_TYPE_FIELD — control: the interface carries every declared field
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'UNREALIZED_TYPE_FIELD',
    expectFire: false,
    reason: 'The shape at the type\'s sourcePath carries every field the spec declares, which is the whole of the claim.',
    scenario:
      'The cold-chain consignment entity models a seal timestamp and a breach count, and the interface at its sourcePath declares both.',
    tree: {
      ...plannerSpecs,
      types: [{
        id: 'cold-chain-consignment',
        name: 'ColdChainConsignment',
        subsystem: 'cold-chain',
        sourcePath: 'src/cold-chain/consignment.ts',
        fields: [
          { name: 'id', type: 'string', key: 'primary', description: 'The consignment reference printed on the seal.' },
          { name: 'pharmacyId', type: 'string', description: 'The pharmacy the consignment is bound for.' },
          { name: 'sealedAt', type: 'string', description: 'When the cold box was sealed at the depot.' },
          { name: 'breachCount', type: 'number', description: 'How many times the box left its temperature band in transit.' },
        ],
      }],
      files: {
        'src/cold-chain/planner.ts': PLANNER_MODULE,
        'src/cold-chain/consignment.ts': `
export interface ColdChainConsignment {
  id: string;
  pharmacyId: string;
  sealedAt: string;
  breachCount: number;
}
`,
      },
    },
  }),

  // -------------------------------------------------------------------------
  // UNREALIZED_TYPE_FIELD — control: a shape that EXTENDS another is never
  // judged on what it omits.
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'UNREALIZED_TYPE_FIELD',
    expectFire: false,
    reason:
      'The interface extends the depot movement it shares its identity fields with, so those members exist but are not in this file to count — presence and absence are different questions for a shape that inherits, and only what it shows can be judged.',
    scenario:
      'The cold-chain consignment interface takes its consignment reference and pharmacy from the depot movement it extends, and lists only the seal timestamp of its own.',
    tree: EXTENDED_CONSIGNMENT,
  }),

  // -------------------------------------------------------------------------
  // UNREALIZED_TYPE_FIELD — control: the derived hop lands on the BASE object
  // call, past the refinement wrapped around it.
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'UNREALIZED_TYPE_FIELD',
    expectFire: false,
    reason:
      'The derived shape resolves one hop to the BASE `.object({…})` call, whose keys are the spec\'s two fields. Stopping at the first object literal would take the refine OPTIONS instead and report both declared fields as missing from a shape that only ever held `message`.',
    scenario:
      'The cold-chain consignment type is inferred from a schema that is refined after its object call, and the spec declares exactly the base object\'s two keys.',
    tree: REFINED_CONSIGNMENT_SCHEMA,
  }),

  // -------------------------------------------------------------------------
  // UNDECLARED_TYPE_FIELD — fire: the record grew a field the design never
  // described.
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'UNDECLARED_TYPE_FIELD',
    severity: 'warning',
    anchoredTo: 'cold-chain-consignment',
    expectFire: true,
    scenario:
      'Somebody added a courier note and a repacking flag to the cold-chain consignment interface without modelling them, so the record carries two fields no diagram draws and no brief hands to an implementer.',
    tree: {
      ...plannerSpecs,
      types: [{
        id: 'cold-chain-consignment',
        name: 'ColdChainConsignment',
        subsystem: 'cold-chain',
        sourcePath: 'src/cold-chain/consignment.ts',
        fields: [
          { name: 'id', type: 'string', key: 'primary', description: 'The consignment reference printed on the seal.' },
          { name: 'pharmacyId', type: 'string', description: 'The pharmacy the consignment is bound for.' },
        ],
      }],
      files: {
        'src/cold-chain/planner.ts': PLANNER_MODULE,
        'src/cold-chain/consignment.ts': `
export interface ColdChainConsignment {
  id: string;
  pharmacyId: string;
  courierNotes: string;
  repackedAtHub: boolean;
}
`,
      },
    },
  }),

  // -------------------------------------------------------------------------
  // UNDECLARED_TYPE_FIELD — control: a member the code writes METHOD-style is
  // behaviour, on the axis typeRealization already judges.
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'UNDECLARED_TYPE_FIELD',
    expectFire: false,
    reason:
      'A method signature is not data. Counting `isBreached(): boolean` as an undeclared field would accuse every behavioural interface in a tree of carrying state it never held, and the spec models it where it belongs — as a pure method of the type.',
    scenario:
      'The cold-chain consignment interface answers whether the box left its temperature band, written as a method signature and modelled as one of the type\'s pure methods.',
    tree: {
      ...plannerSpecs,
      types: [{
        id: 'cold-chain-consignment',
        name: 'ColdChainConsignment',
        subsystem: 'cold-chain',
        sourcePath: 'src/cold-chain/consignment.ts',
        fields: [
          { name: 'id', type: 'string', key: 'primary', description: 'The consignment reference printed on the seal.' },
          { name: 'pharmacyId', type: 'string', description: 'The pharmacy the consignment is bound for.' },
        ],
        methods: [{
          name: 'isBreached',
          signature: 'isBreached(): boolean',
          returns: 'boolean',
          description: 'Whether the cold box left its temperature band at any point in transit.',
        }],
      }],
      files: {
        'src/cold-chain/planner.ts': PLANNER_MODULE,
        'src/cold-chain/consignment.ts': `
export interface ColdChainConsignment {
  id: string;
  pharmacyId: string;
  isBreached(): boolean;
}
`,
      },
    },
  }),

  // -------------------------------------------------------------------------
  // UNDECLARED_TYPE_FIELD — control: the same refined schema, read from the
  // other presence side.
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'UNDECLARED_TYPE_FIELD',
    expectFire: false,
    reason:
      'The base `.object({…})` call carries exactly the two keys the spec declares. Taking the first object literal the chain offers would read the refine options as the shape and report a field called `message` that the record never had.',
    scenario:
      'The cold-chain consignment type is inferred from a schema refined after its object call, and every key of that base object is a field the spec declares.',
    tree: REFINED_CONSIGNMENT_SCHEMA,
  }),

  // -------------------------------------------------------------------------
  // TYPE_FIELD_OPTIONALITY — fire: the spec guarantees what the code lets you
  // omit.
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'TYPE_FIELD_OPTIONALITY',
    severity: 'warning',
    anchoredTo: 'cold-chain-consignment',
    expectFire: true,
    scenario:
      'The cold-chain consignment entity promises a seal timestamp on every consignment, while the interface at its sourcePath lets the field be omitted — a promise the data does not keep.',
    tree: {
      ...plannerSpecs,
      types: [{
        id: 'cold-chain-consignment',
        name: 'ColdChainConsignment',
        subsystem: 'cold-chain',
        sourcePath: 'src/cold-chain/consignment.ts',
        fields: [
          { name: 'id', type: 'string', key: 'primary', description: 'The consignment reference printed on the seal.' },
          { name: 'sealedAt', type: 'string', description: 'When the cold box was sealed at the depot.' },
        ],
      }],
      files: {
        'src/cold-chain/planner.ts': PLANNER_MODULE,
        'src/cold-chain/consignment.ts': `
export interface ColdChainConsignment {
  id: string;
  sealedAt?: string;
}
`,
      },
    },
  }),

  // -------------------------------------------------------------------------
  // TYPE_FIELD_OPTIONALITY — fire: a member an EXTENDING shape DOES list is a
  // member it answers for. The control above is this tree with `sealedAt`
  // modelled optional, and nothing else changed.
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'TYPE_FIELD_OPTIONALITY',
    severity: 'warning',
    anchoredTo: 'cold-chain-consignment',
    expectFire: true,
    scenario:
      'The cold-chain consignment interface inherits its identity fields from the depot movement it extends and lets its own seal timestamp be omitted, while the entity promises one on every consignment.',
    tree: {
      ...EXTENDED_CONSIGNMENT,
      types: [{
        ...EXTENDED_CONSIGNMENT.types![0],
        fields: [
          { name: 'id', type: 'string', key: 'primary', description: 'The consignment reference printed on the seal.' },
          { name: 'pharmacyId', type: 'string', description: 'The pharmacy the consignment is bound for.' },
          { name: 'sealedAt', type: 'string', description: 'When the cold box was sealed at the depot.' },
        ],
      }],
    },
  }),

  // -------------------------------------------------------------------------
  // TYPE_FIELD_OPTIONALITY — control: a wrapper that FILLS a missing key leaves
  // the field required in the value the type finally holds.
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'TYPE_FIELD_OPTIONALITY',
    expectFire: false,
    reason:
      '`.default(0)` fills a missing breach count, so the value the type finally holds always has one and the spec is right to call it required — only `.optional()` lets a key actually be absent, which is what the courier note is modelled as. Reading the filled key as optional is what doubles a tree\'s optionality drift on its own.',
    scenario:
      'The cold-chain consignment type is inferred from a schema that defaults the breach count to zero and leaves the courier note genuinely optional, and the entity models them exactly that way.',
    tree: {
      ...plannerSpecs,
      types: [{
        id: 'cold-chain-consignment',
        name: 'ColdChainConsignment',
        subsystem: 'cold-chain',
        sourcePath: 'src/cold-chain/consignment.ts',
        fields: [
          { name: 'id', type: 'string', key: 'primary', description: 'The consignment reference printed on the seal.' },
          { name: 'breachCount', type: 'number', description: 'How many times the box left its temperature band in transit.' },
          { name: 'courierNotes', type: 'string', optional: true, description: 'What the courier wrote on handover, when they wrote anything.' },
        ],
      }],
      files: {
        'src/cold-chain/planner.ts': PLANNER_MODULE,
        'src/cold-chain/consignment.ts': `
import { z } from 'zod';

export const ColdChainConsignmentSchema = z.object({
  id: z.string(),
  breachCount: z.number().default(0),
  courierNotes: z.string().optional(),
});

export type ColdChainConsignment = z.infer<typeof ColdChainConsignmentSchema>;
`,
      },
    },
  }),
];
