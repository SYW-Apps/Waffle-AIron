/**
 * Invariant-registry family (src/core/rules/invariants.ts): entities declare
 * domain invariants, anchored through componentClass; every write-effect
 * contract method of the owning component must carry a narrative step
 * asserting each invariant. An HONEST lint over declarations — a green run
 * means every write path visibly claims the invariant, never that it is
 * enforced.
 *
 * Documented intents pinned here:
 *  - DUPLICATE_INVARIANT_ID (error): invariant ids unique within the entity.
 *  - INVARIANT_UNANCHORED (warning): invariants with no resolvable owning
 *    component, or an owner with no declared write-effect methods.
 *  - UNASSERTED_INVARIANT (warning): a write method with no asserting step.
 *  - UNKNOWN_INVARIANT_REF (error): an assertion naming an undeclared
 *    invariant.
 */
import { defineRuleFixture } from '../harness.js';

export default [
  // -------------------------------------------------------------------------
  // DUPLICATE_INVARIANT_ID
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'DUPLICATE_INVARIANT_ID',
    severity: 'error',
    anchoredTo: 'catalog-entry',
    expectFire: true,
    scenario:
      'The CatalogEntry entity declares the slug-unique invariant twice, making references to it ambiguous.',
    tree: {
      subsystems: [{ id: 'catalog', description: 'Product catalog entries and their storage.' }],
      components: [
        {
          id: 'catalog-store',
          componentType: 'Store',
          description: 'Backing store owning the catalog entry lifecycle.',
          durability: 'read-through',
        },
      ],
      interfaces: [
        {
          id: 'icatalog_store',
          component: 'catalog-store',
          methods: [
            { name: 'saveEntry', description: 'Persist a catalog entry after validating its slug.', effect: 'write' },
            { name: 'getEntry', description: 'Read one catalog entry by id.', effect: 'read' },
          ],
        },
      ],
      types: [
        {
          id: 'catalog-entry',
          name: 'CatalogEntry',
          kind: 'entity',
          subsystem: 'catalog',
          componentClass: 'catalog-store',
          description: 'One product entry in the merchant catalog.',
          fields: [
            { name: 'slug', type: 'string', description: 'URL slug of the entry.' },
            { name: 'parentCategoryId', type: 'string', description: 'Owning category.' },
          ],
          invariants: [
            { id: 'slug-unique', description: 'The slug is unique among sibling entries of the same parent category.' },
            { id: 'slug-unique', description: 'Duplicate declaration of the slug uniqueness property.' },
          ],
        },
      ],
      implementations: [
        {
          id: 'catalog_store_impl',
          contract: 'icatalog_store',
          methods: [
            {
              name: 'saveEntry',
              narrative: [
                {
                  stepNumber: 1,
                  type: 'local',
                  description: 'Reject the write when another sibling already uses the slug.',
                  assertsInvariants: ['catalog-entry.slug-unique'],
                },
                { stepNumber: 2, type: 'local', description: 'Write the entry row to the backing table.' },
              ],
            },
            {
              name: 'getEntry',
              narrative: [{ stepNumber: 1, type: 'local', description: 'Read the entry row from the backing table.' }],
            },
          ],
        },
      ],
    },
  }),
  defineRuleFixture({
    code: 'DUPLICATE_INVARIANT_ID',
    expectFire: false,
    reason: 'The two invariants carry distinct ids, so every reference is unambiguous.',
    scenario:
      'The CatalogEntry entity declares slug-unique and price-non-negative as two distinct invariants.',
    tree: {
      subsystems: [{ id: 'catalog', description: 'Product catalog entries and their storage.' }],
      components: [
        {
          id: 'catalog-store',
          componentType: 'Store',
          description: 'Backing store owning the catalog entry lifecycle.',
          durability: 'read-through',
        },
      ],
      interfaces: [
        {
          id: 'icatalog_store',
          component: 'catalog-store',
          methods: [
            { name: 'saveEntry', description: 'Persist a catalog entry after validating its slug.', effect: 'write' },
            { name: 'getEntry', description: 'Read one catalog entry by id.', effect: 'read' },
          ],
        },
      ],
      types: [
        {
          id: 'catalog-entry',
          name: 'CatalogEntry',
          kind: 'entity',
          subsystem: 'catalog',
          componentClass: 'catalog-store',
          description: 'One product entry in the merchant catalog.',
          fields: [
            { name: 'slug', type: 'string', description: 'URL slug of the entry.' },
            { name: 'priceCents', type: 'number', description: 'Listed price in cents.' },
          ],
          invariants: [
            { id: 'slug-unique', description: 'The slug is unique among sibling entries of the same parent category.' },
            { id: 'price-non-negative', description: 'The listed price is never negative.' },
          ],
        },
      ],
      implementations: [
        {
          id: 'catalog_store_impl',
          contract: 'icatalog_store',
          methods: [
            {
              name: 'saveEntry',
              narrative: [
                {
                  stepNumber: 1,
                  type: 'local',
                  description: 'Reject the write when another sibling already uses the slug.',
                  assertsInvariants: ['catalog-entry.slug-unique'],
                },
                {
                  stepNumber: 2,
                  type: 'local',
                  description: 'Reject the write when the listed price is negative.',
                  assertsInvariants: ['catalog-entry.price-non-negative'],
                },
                { stepNumber: 3, type: 'local', description: 'Write the entry row to the backing table.' },
              ],
            },
            {
              name: 'getEntry',
              narrative: [{ stepNumber: 1, type: 'local', description: 'Read the entry row from the backing table.' }],
            },
          ],
        },
      ],
    },
  }),

  // -------------------------------------------------------------------------
  // INVARIANT_UNANCHORED — no componentClass, and no write-effect methods
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'INVARIANT_UNANCHORED',
    severity: 'warning',
    anchoredTo: 'catalog-entry',
    expectFire: true,
    scenario:
      'The CatalogEntry entity declares the slug-unique invariant but links no owning component, so there is no write path to hold the property against.',
    tree: {
      subsystems: [{ id: 'catalog', description: 'Product catalog entries and their storage.' }],
      components: [
        {
          id: 'catalog-store',
          componentType: 'Store',
          description: 'Backing store owning the catalog entry lifecycle.',
          durability: 'read-through',
        },
      ],
      interfaces: [
        {
          id: 'icatalog_store',
          component: 'catalog-store',
          methods: [
            { name: 'saveEntry', description: 'Persist a catalog entry after validating its slug.', effect: 'write' },
          ],
        },
      ],
      types: [
        {
          id: 'catalog-entry',
          name: 'CatalogEntry',
          kind: 'entity',
          subsystem: 'catalog',
          description: 'One product entry in the merchant catalog.',
          fields: [{ name: 'slug', type: 'string', description: 'URL slug of the entry.' }],
          invariants: [
            { id: 'slug-unique', description: 'The slug is unique among sibling entries of the same parent category.' },
          ],
        },
      ],
    },
  }),
  defineRuleFixture({
    code: 'INVARIANT_UNANCHORED',
    severity: 'warning',
    anchoredTo: 'catalog-entry',
    expectFire: true,
    scenario:
      'The CatalogEntry invariant is anchored to the catalog store, but none of that store\'s contract methods declare effect: write, so the validator cannot identify the write paths that must assert it.',
    tree: {
      subsystems: [{ id: 'catalog', description: 'Product catalog entries and their storage.' }],
      components: [
        {
          id: 'catalog-store',
          componentType: 'Store',
          description: 'Backing store owning the catalog entry lifecycle.',
          durability: 'read-through',
        },
      ],
      interfaces: [
        {
          id: 'icatalog_store',
          component: 'catalog-store',
          methods: [
            { name: 'saveEntry', description: 'Persist a catalog entry after validating its slug.' },
            { name: 'getEntry', description: 'Read one catalog entry by id.', effect: 'read' },
          ],
        },
      ],
      types: [
        {
          id: 'catalog-entry',
          name: 'CatalogEntry',
          kind: 'entity',
          subsystem: 'catalog',
          componentClass: 'catalog-store',
          description: 'One product entry in the merchant catalog.',
          fields: [{ name: 'slug', type: 'string', description: 'URL slug of the entry.' }],
          invariants: [
            { id: 'slug-unique', description: 'The slug is unique among sibling entries of the same parent category.' },
          ],
        },
      ],
    },
  }),
  defineRuleFixture({
    code: 'INVARIANT_UNANCHORED',
    expectFire: false,
    reason:
      'The entity links its owning store via componentClass and that store declares a write-effect method, so the invariant has an identifiable write path.',
    scenario:
      'The CatalogEntry invariant is anchored to the catalog store, whose saveEntry write method asserts it.',
    tree: {
      subsystems: [{ id: 'catalog', description: 'Product catalog entries and their storage.' }],
      components: [
        {
          id: 'catalog-store',
          componentType: 'Store',
          description: 'Backing store owning the catalog entry lifecycle.',
          durability: 'read-through',
        },
      ],
      interfaces: [
        {
          id: 'icatalog_store',
          component: 'catalog-store',
          methods: [
            { name: 'saveEntry', description: 'Persist a catalog entry after validating its slug.', effect: 'write' },
            { name: 'getEntry', description: 'Read one catalog entry by id.', effect: 'read' },
          ],
        },
      ],
      types: [
        {
          id: 'catalog-entry',
          name: 'CatalogEntry',
          kind: 'entity',
          subsystem: 'catalog',
          componentClass: 'catalog-store',
          description: 'One product entry in the merchant catalog.',
          fields: [{ name: 'slug', type: 'string', description: 'URL slug of the entry.' }],
          invariants: [
            { id: 'slug-unique', description: 'The slug is unique among sibling entries of the same parent category.' },
          ],
        },
      ],
      implementations: [
        {
          id: 'catalog_store_impl',
          contract: 'icatalog_store',
          methods: [
            {
              name: 'saveEntry',
              narrative: [
                {
                  stepNumber: 1,
                  type: 'local',
                  description: 'Reject the write when another sibling already uses the slug.',
                  assertsInvariants: ['catalog-entry.slug-unique'],
                },
                { stepNumber: 2, type: 'local', description: 'Write the entry row to the backing table.' },
              ],
            },
            {
              name: 'getEntry',
              narrative: [{ stepNumber: 1, type: 'local', description: 'Read the entry row from the backing table.' }],
            },
          ],
        },
      ],
    },
  }),

  // -------------------------------------------------------------------------
  // UNASSERTED_INVARIANT
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'UNASSERTED_INVARIANT',
    severity: 'warning',
    anchoredTo: 'catalog_store_impl',
    expectFire: true,
    scenario:
      'The saveEntry write path of the catalog store carries no narrative step asserting the declared slug-unique invariant — nobody considered the property on this write.',
    tree: {
      subsystems: [{ id: 'catalog', description: 'Product catalog entries and their storage.' }],
      components: [
        {
          id: 'catalog-store',
          componentType: 'Store',
          description: 'Backing store owning the catalog entry lifecycle.',
          durability: 'read-through',
        },
      ],
      interfaces: [
        {
          id: 'icatalog_store',
          component: 'catalog-store',
          methods: [
            { name: 'saveEntry', description: 'Persist a catalog entry after validating its slug.', effect: 'write' },
          ],
        },
      ],
      types: [
        {
          id: 'catalog-entry',
          name: 'CatalogEntry',
          kind: 'entity',
          subsystem: 'catalog',
          componentClass: 'catalog-store',
          description: 'One product entry in the merchant catalog.',
          fields: [{ name: 'slug', type: 'string', description: 'URL slug of the entry.' }],
          invariants: [
            { id: 'slug-unique', description: 'The slug is unique among sibling entries of the same parent category.' },
          ],
        },
      ],
      implementations: [
        {
          id: 'catalog_store_impl',
          contract: 'icatalog_store',
          methods: [
            {
              name: 'saveEntry',
              narrative: [{ stepNumber: 1, type: 'local', description: 'Write the entry row to the backing table.' }],
            },
          ],
        },
      ],
    },
  }),
  defineRuleFixture({
    code: 'UNASSERTED_INVARIANT',
    expectFire: false,
    reason: 'The write path carries a step marked with assertsInvariants for the declared invariant, so the intent is visible.',
    scenario:
      'The saveEntry narrative asserts the slug-unique invariant before writing the entry row.',
    tree: {
      subsystems: [{ id: 'catalog', description: 'Product catalog entries and their storage.' }],
      components: [
        {
          id: 'catalog-store',
          componentType: 'Store',
          description: 'Backing store owning the catalog entry lifecycle.',
          durability: 'read-through',
        },
      ],
      interfaces: [
        {
          id: 'icatalog_store',
          component: 'catalog-store',
          methods: [
            { name: 'saveEntry', description: 'Persist a catalog entry after validating its slug.', effect: 'write' },
          ],
        },
      ],
      types: [
        {
          id: 'catalog-entry',
          name: 'CatalogEntry',
          kind: 'entity',
          subsystem: 'catalog',
          componentClass: 'catalog-store',
          description: 'One product entry in the merchant catalog.',
          fields: [{ name: 'slug', type: 'string', description: 'URL slug of the entry.' }],
          invariants: [
            { id: 'slug-unique', description: 'The slug is unique among sibling entries of the same parent category.' },
          ],
        },
      ],
      implementations: [
        {
          id: 'catalog_store_impl',
          contract: 'icatalog_store',
          methods: [
            {
              name: 'saveEntry',
              narrative: [
                {
                  stepNumber: 1,
                  type: 'local',
                  description: 'Reject the write when another sibling already uses the slug.',
                  assertsInvariants: ['catalog-entry.slug-unique'],
                },
                { stepNumber: 2, type: 'local', description: 'Write the entry row to the backing table.' },
              ],
            },
          ],
        },
      ],
    },
  }),

  // -------------------------------------------------------------------------
  // UNKNOWN_INVARIANT_REF
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'UNKNOWN_INVARIANT_REF',
    severity: 'error',
    anchoredTo: 'catalog_store_impl',
    expectFire: true,
    scenario:
      'A saveEntry step asserts catalog-entry.price-positive, but the entity declares no such invariant — the assertion reference dangles.',
    tree: {
      subsystems: [{ id: 'catalog', description: 'Product catalog entries and their storage.' }],
      components: [
        {
          id: 'catalog-store',
          componentType: 'Store',
          description: 'Backing store owning the catalog entry lifecycle.',
          durability: 'read-through',
        },
      ],
      interfaces: [
        {
          id: 'icatalog_store',
          component: 'catalog-store',
          methods: [
            { name: 'saveEntry', description: 'Persist a catalog entry after validating its slug.', effect: 'write' },
          ],
        },
      ],
      types: [
        {
          id: 'catalog-entry',
          name: 'CatalogEntry',
          kind: 'entity',
          subsystem: 'catalog',
          componentClass: 'catalog-store',
          description: 'One product entry in the merchant catalog.',
          fields: [{ name: 'slug', type: 'string', description: 'URL slug of the entry.' }],
          invariants: [
            { id: 'slug-unique', description: 'The slug is unique among sibling entries of the same parent category.' },
          ],
        },
      ],
      implementations: [
        {
          id: 'catalog_store_impl',
          contract: 'icatalog_store',
          methods: [
            {
              name: 'saveEntry',
              narrative: [
                {
                  stepNumber: 1,
                  type: 'local',
                  description: 'Reject the write when another sibling already uses the slug.',
                  assertsInvariants: ['catalog-entry.slug-unique'],
                },
                {
                  stepNumber: 2,
                  type: 'local',
                  description: 'Reject the write when the listed price is negative.',
                  assertsInvariants: ['catalog-entry.price-positive'],
                },
                { stepNumber: 3, type: 'local', description: 'Write the entry row to the backing table.' },
              ],
            },
          ],
        },
      ],
    },
  }),
  defineRuleFixture({
    code: 'UNKNOWN_INVARIANT_REF',
    expectFire: false,
    reason: 'Every assertsInvariants reference resolves to a declared invariant on the entity.',
    scenario:
      'The saveEntry narrative asserts only the declared slug-unique invariant, so every reference resolves.',
    tree: {
      subsystems: [{ id: 'catalog', description: 'Product catalog entries and their storage.' }],
      components: [
        {
          id: 'catalog-store',
          componentType: 'Store',
          description: 'Backing store owning the catalog entry lifecycle.',
          durability: 'read-through',
        },
      ],
      interfaces: [
        {
          id: 'icatalog_store',
          component: 'catalog-store',
          methods: [
            { name: 'saveEntry', description: 'Persist a catalog entry after validating its slug.', effect: 'write' },
          ],
        },
      ],
      types: [
        {
          id: 'catalog-entry',
          name: 'CatalogEntry',
          kind: 'entity',
          subsystem: 'catalog',
          componentClass: 'catalog-store',
          description: 'One product entry in the merchant catalog.',
          fields: [{ name: 'slug', type: 'string', description: 'URL slug of the entry.' }],
          invariants: [
            { id: 'slug-unique', description: 'The slug is unique among sibling entries of the same parent category.' },
          ],
        },
      ],
      implementations: [
        {
          id: 'catalog_store_impl',
          contract: 'icatalog_store',
          methods: [
            {
              name: 'saveEntry',
              narrative: [
                {
                  stepNumber: 1,
                  type: 'local',
                  description: 'Reject the write when another sibling already uses the slug.',
                  assertsInvariants: ['catalog-entry.slug-unique'],
                },
                { stepNumber: 2, type: 'local', description: 'Write the entry row to the backing table.' },
              ],
            },
          ],
        },
      ],
    },
  }),
];
