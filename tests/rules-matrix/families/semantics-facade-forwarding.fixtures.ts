/**
 * Facade-forwarding family (src/core/rules/facade-forwarding.ts, standard
 * §7): a Repository/Gateway facade method with an authored narrative must be
 * PURE 1:1 forwarding — exactly one call step, targeting one of the pattern's
 * owned members. More steps, a non-call step, or a call leaving the pattern
 * means logic lives on the facade, which belongs inside a member block.
 */
import { defineRuleFixture } from '../harness.js';

export default [
  defineRuleFixture({
    code: 'FACADE_FORWARDING',
    severity: 'warning',
    anchoredTo: 'customer_repository_impl',
    expectFire: true,
    scenario:
      'The customer repository facade looks up a customer via its owned index and then filters columns in a second local step — logic living on the facade instead of inside a member.',
    tree: {
      subsystems: [{ id: 'crm', description: 'Customer records behind a repository facade.' }],
      components: [
        {
          id: 'customer-repository',
          componentType: 'Repository',
          description: 'Facade over the customer store and its lookup index.',
          owns: ['customer-store', 'customer-index'],
        },
        {
          id: 'customer-store',
          componentType: 'Store',
          description: 'Backing store of customer records.',
          durability: 'read-through',
        },
        {
          id: 'customer-index',
          componentType: 'Index',
          description: 'Lookup index over customer records by email.',
        },
      ],
      interfaces: [
        {
          id: 'icustomer_repository',
          component: 'customer-repository',
          methods: [{ name: 'findByEmail', description: 'Find one customer record by email address.' }],
        },
        {
          id: 'icustomer_store',
          component: 'customer-store',
          methods: [{ name: 'getById', description: 'Read one customer record by id.', effect: 'read' }],
        },
        {
          id: 'icustomer_index',
          component: 'customer-index',
          methods: [{ name: 'lookupByEmail', description: 'Resolve a customer id from an email address.' }],
        },
      ],
      implementations: [
        {
          id: 'customer_repository_impl',
          contract: 'icustomer_repository',
          methods: [
            {
              name: 'findByEmail',
              narrative: [
                {
                  stepNumber: 1,
                  type: 'call',
                  description: 'Resolve the customer id through the owned email index.',
                  targetComponent: 'customer-index',
                  targetMethod: 'lookupByEmail',
                },
                { stepNumber: 2, type: 'local', description: 'Strip internal columns from the record before returning it.' },
              ],
            },
          ],
        },
      ],
    },
  }),
  defineRuleFixture({
    code: 'FACADE_FORWARDING',
    severity: 'warning',
    anchoredTo: 'customer_repository_impl',
    expectFire: true,
    scenario:
      'The customer repository facade forwards its lookup to the directory-sync adapter, a component the pattern does not own — the call leaves the pattern.',
    tree: {
      subsystems: [{ id: 'crm', description: 'Customer records behind a repository facade.' }],
      components: [
        {
          id: 'customer-repository',
          componentType: 'Repository',
          description: 'Facade over the customer store and its lookup index.',
          owns: ['customer-store', 'customer-index'],
          dependsOn: ['directory-sync-adapter'],
        },
        {
          id: 'customer-store',
          componentType: 'Store',
          description: 'Backing store of customer records.',
          durability: 'read-through',
        },
        {
          id: 'customer-index',
          componentType: 'Index',
          description: 'Lookup index over customer records by email.',
        },
        {
          id: 'directory-sync-adapter',
          componentType: 'Adapter',
          description: 'Wraps the external corporate directory API.',
        },
      ],
      interfaces: [
        {
          id: 'icustomer_repository',
          component: 'customer-repository',
          methods: [{ name: 'findByEmail', description: 'Find one customer record by email address.' }],
        },
        {
          id: 'icustomer_store',
          component: 'customer-store',
          methods: [{ name: 'getById', description: 'Read one customer record by id.', effect: 'read' }],
        },
        {
          id: 'icustomer_index',
          component: 'customer-index',
          methods: [{ name: 'lookupByEmail', description: 'Resolve a customer id from an email address.' }],
        },
        {
          id: 'idirectory_sync_adapter',
          component: 'directory-sync-adapter',
          methods: [{ name: 'fetchProfile', description: 'Fetch a directory profile from the corporate directory.' }],
        },
      ],
      implementations: [
        {
          id: 'customer_repository_impl',
          contract: 'icustomer_repository',
          methods: [
            {
              name: 'findByEmail',
              narrative: [
                {
                  stepNumber: 1,
                  type: 'call',
                  description: 'Fetch the profile from the corporate directory instead of the owned members.',
                  targetComponent: 'directory-sync-adapter',
                  targetMethod: 'fetchProfile',
                },
              ],
            },
          ],
        },
      ],
    },
  }),
  defineRuleFixture({
    code: 'FACADE_FORWARDING',
    expectFire: false,
    reason: 'The facade narrative is exactly one call step to an owned member — pure 1:1 forwarding as §7 requires.',
    scenario:
      'The customer repository facade forwards findByEmail as a single call to its owned email index.',
    tree: {
      subsystems: [{ id: 'crm', description: 'Customer records behind a repository facade.' }],
      components: [
        {
          id: 'customer-repository',
          componentType: 'Repository',
          description: 'Facade over the customer store and its lookup index.',
          owns: ['customer-store', 'customer-index'],
        },
        {
          id: 'customer-store',
          componentType: 'Store',
          description: 'Backing store of customer records.',
          durability: 'read-through',
        },
        {
          id: 'customer-index',
          componentType: 'Index',
          description: 'Lookup index over customer records by email.',
        },
      ],
      interfaces: [
        {
          id: 'icustomer_repository',
          component: 'customer-repository',
          methods: [{ name: 'findByEmail', description: 'Find one customer record by email address.' }],
        },
        {
          id: 'icustomer_store',
          component: 'customer-store',
          methods: [{ name: 'getById', description: 'Read one customer record by id.', effect: 'read' }],
        },
        {
          id: 'icustomer_index',
          component: 'customer-index',
          methods: [{ name: 'lookupByEmail', description: 'Resolve a customer id from an email address.' }],
        },
      ],
      implementations: [
        {
          id: 'customer_repository_impl',
          contract: 'icustomer_repository',
          methods: [
            {
              name: 'findByEmail',
              narrative: [
                {
                  stepNumber: 1,
                  type: 'call',
                  description: 'Forward the lookup to the owned email index.',
                  targetComponent: 'customer-index',
                  targetMethod: 'lookupByEmail',
                },
              ],
            },
          ],
        },
      ],
    },
  }),
];
