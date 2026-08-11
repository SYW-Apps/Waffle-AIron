/**
 * Durability family (src/core/rules/semantic-edges.ts,
 * durabilityDeclarationRule + durabilityRule): the declaration axis and the
 * round-trip consequence.
 *
 * Documented intents pinned here:
 *  - DURABILITY_ON_NON_STORE (error): durability is a Store property; state
 *    lives in Stores.
 *  - MISSING_DURABILITY (warning): every Store declares one of the four modes
 *    (durable | read-through | ram-projection | cache) — exemption from the
 *    round-trip is by declaration, never by omission.
 *  - MISSING_EFFECT_TAG (warning): a durable Store's contract methods carry
 *    effect: read | write so writes can be paired with read-backs.
 *  - MISSING_HYDRATION (error): a durable Store that is written must have a
 *    read-back reachable from a lifecycle INIT flow. The boot graph follows
 *    only edges the init narratives actually TAKE: dispatch tables are NOT
 *    flooded (a capability merely offered by a reached portal is not a
 *    boot-time read — though explicit dispatch steps are followed) and
 *    register edges are NOT taken (registration defers the invocation).
 *    read-through / ram-projection / cache are exempt by definition.
 */
import { defineRuleFixture } from '../harness.js';

export default [
  // -------------------------------------------------------------------------
  // DURABILITY_ON_NON_STORE
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'DURABILITY_ON_NON_STORE',
    severity: 'error',
    anchoredTo: 'notification-orchestrator',
    expectFire: true,
    scenario:
      'The notification orchestrator declares durability durable, but durability is a Store property — held state never lives inside a workflow component.',
    tree: {
      subsystems: [{ id: 'notifications', description: 'Outbound customer notifications.' }],
      components: [
        {
          id: 'notification-orchestrator',
          componentType: 'Orchestrator',
          description: 'Sequences outbound notification sends.',
          durability: 'durable',
        },
      ],
      interfaces: [
        {
          id: 'inotification_orchestrator',
          component: 'notification-orchestrator',
          methods: [{ name: 'sendDigest', description: 'Send the daily digest to all opted-in customers.' }],
        },
      ],
    },
  }),
  defineRuleFixture({
    code: 'DURABILITY_ON_NON_STORE',
    expectFire: false,
    reason: 'The durability declaration sits on the dedicated log Store; the orchestrator holds no state of its own.',
    scenario:
      'The notification log Store carries the durability declaration while the orchestrator stays stateless.',
    tree: {
      subsystems: [{ id: 'notifications', description: 'Outbound customer notifications.' }],
      components: [
        {
          id: 'notification-orchestrator',
          componentType: 'Orchestrator',
          description: 'Sequences outbound notification sends.',
          dependsOn: ['notification-log-store'],
        },
        {
          id: 'notification-log-store',
          componentType: 'Store',
          description: 'Record of every notification sent, for dedup and audit.',
          durability: 'read-through',
        },
      ],
      interfaces: [
        {
          id: 'inotification_orchestrator',
          component: 'notification-orchestrator',
          methods: [{ name: 'sendDigest', description: 'Send the daily digest to all opted-in customers.' }],
        },
        {
          id: 'inotification_log_store',
          component: 'notification-log-store',
          methods: [{ name: 'recordSend', description: 'Record one notification send for dedup and audit.', effect: 'write' }],
        },
      ],
    },
  }),

  // -------------------------------------------------------------------------
  // MISSING_DURABILITY
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'MISSING_DURABILITY',
    severity: 'warning',
    anchoredTo: 'shipment-manifest-store',
    expectFire: true,
    scenario:
      'The shipment manifest Store declares no durability mode, so the round-trip machinery cannot know whether restart-survival is promised.',
    tree: {
      subsystems: [{ id: 'fulfillment', description: 'Parcel manifests and carrier hand-off.' }],
      components: [
        {
          id: 'shipment-manifest-store',
          componentType: 'Store',
          description: 'Holds the manifest of parcels per outbound truck.',
        },
      ],
      interfaces: [
        {
          id: 'ishipment_manifest_store',
          component: 'shipment-manifest-store',
          methods: [
            { name: 'addParcel', description: 'Add a parcel to the open manifest of a truck.', effect: 'write' },
            { name: 'getManifest', description: 'Read the current manifest for a truck.', effect: 'read' },
          ],
        },
      ],
    },
  }),
  defineRuleFixture({
    code: 'MISSING_DURABILITY',
    expectFire: false,
    reason: 'The Store declares read-through durability explicitly, so the round-trip machinery knows its promise.',
    scenario:
      'The shipment manifest Store declares read-through durability — every read hits the backing medium.',
    tree: {
      subsystems: [{ id: 'fulfillment', description: 'Parcel manifests and carrier hand-off.' }],
      components: [
        {
          id: 'shipment-manifest-store',
          componentType: 'Store',
          description: 'Holds the manifest of parcels per outbound truck.',
          durability: 'read-through',
        },
      ],
      interfaces: [
        {
          id: 'ishipment_manifest_store',
          component: 'shipment-manifest-store',
          methods: [
            { name: 'addParcel', description: 'Add a parcel to the open manifest of a truck.', effect: 'write' },
            { name: 'getManifest', description: 'Read the current manifest for a truck.', effect: 'read' },
          ],
        },
      ],
    },
  }),

  // -------------------------------------------------------------------------
  // MISSING_EFFECT_TAG
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'MISSING_EFFECT_TAG',
    severity: 'warning',
    anchoredTo: 'audit-trail-store',
    expectFire: true,
    scenario:
      'The durable audit-trail Store leaves getEvents untagged, so the round-trip rule cannot pair its writes with read-backs over that method.',
    tree: {
      subsystems: [
        {
          id: 'audit',
          description: 'Tamper-evident audit trail of privileged actions.',
          lifecycle: [
            { phase: 'init', component: 'audit-bootstrap', method: 'initialize', description: 'Hydrate the audit tail at boot.' },
          ],
        },
      ],
      components: [
        {
          id: 'audit-trail-store',
          componentType: 'Store',
          description: 'Durable log of privileged actions with an in-memory tail.',
          durability: 'durable',
        },
        {
          id: 'audit-bootstrap',
          componentType: 'Orchestrator',
          description: 'Boot wiring for the audit subsystem.',
          dependsOn: ['audit-trail-store'],
        },
      ],
      interfaces: [
        {
          id: 'iaudit_trail_store',
          component: 'audit-trail-store',
          methods: [
            { name: 'appendEvent', description: 'Append one privileged-action event to the trail.', effect: 'write' },
            { name: 'getEvents', description: 'Read a page of audit events for review.' },
            { name: 'loadTail', description: 'Load the recent tail of the trail into memory.', effect: 'read' },
          ],
        },
        {
          id: 'iaudit_bootstrap',
          component: 'audit-bootstrap',
          methods: [{ name: 'initialize', description: 'Hydrate the audit tail from the persisted trail.' }],
        },
      ],
      implementations: [
        {
          id: 'audit_bootstrap_impl',
          contract: 'iaudit_bootstrap',
          methods: [
            {
              name: 'initialize',
              narrative: [
                {
                  stepNumber: 1,
                  type: 'call',
                  description: 'Read the recent audit tail back into memory.',
                  targetComponent: 'audit-trail-store',
                  targetMethod: 'loadTail',
                },
                { stepNumber: 2, type: 'return', description: 'Report the audit subsystem ready.', outcome: 'success' },
              ],
            },
          ],
        },
      ],
    },
  }),
  defineRuleFixture({
    code: 'MISSING_EFFECT_TAG',
    expectFire: false,
    reason: 'Every contract method of the durable Store carries an effect tag, so writes and read-backs are pairable.',
    scenario:
      'The durable audit-trail Store tags all three contract methods with their read or write effect.',
    tree: {
      subsystems: [
        {
          id: 'audit',
          description: 'Tamper-evident audit trail of privileged actions.',
          lifecycle: [
            { phase: 'init', component: 'audit-bootstrap', method: 'initialize', description: 'Hydrate the audit tail at boot.' },
          ],
        },
      ],
      components: [
        {
          id: 'audit-trail-store',
          componentType: 'Store',
          description: 'Durable log of privileged actions with an in-memory tail.',
          durability: 'durable',
        },
        {
          id: 'audit-bootstrap',
          componentType: 'Orchestrator',
          description: 'Boot wiring for the audit subsystem.',
          dependsOn: ['audit-trail-store'],
        },
      ],
      interfaces: [
        {
          id: 'iaudit_trail_store',
          component: 'audit-trail-store',
          methods: [
            { name: 'appendEvent', description: 'Append one privileged-action event to the trail.', effect: 'write' },
            { name: 'getEvents', description: 'Read a page of audit events for review.', effect: 'read' },
            { name: 'loadTail', description: 'Load the recent tail of the trail into memory.', effect: 'read' },
          ],
        },
        {
          id: 'iaudit_bootstrap',
          component: 'audit-bootstrap',
          methods: [{ name: 'initialize', description: 'Hydrate the audit tail from the persisted trail.' }],
        },
      ],
      implementations: [
        {
          id: 'audit_bootstrap_impl',
          contract: 'iaudit_bootstrap',
          methods: [
            {
              name: 'initialize',
              narrative: [
                {
                  stepNumber: 1,
                  type: 'call',
                  description: 'Read the recent audit tail back into memory.',
                  targetComponent: 'audit-trail-store',
                  targetMethod: 'loadTail',
                },
                { stepNumber: 2, type: 'return', description: 'Report the audit subsystem ready.', outcome: 'success' },
              ],
            },
          ],
        },
      ],
    },
  }),

  // -------------------------------------------------------------------------
  // MISSING_HYDRATION — fire: no init entrypoint at all
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'MISSING_HYDRATION',
    severity: 'error',
    anchoredTo: 'inventory-store',
    expectFire: true,
    scenario:
      'Stock intake writes adjustments into the durable inventory Store, but no subsystem declares a lifecycle init flow at all — after a restart the persisted ledger would never be read back.',
    tree: {
      subsystems: [{ id: 'inventory', description: 'Warehouse stock levels and adjustments.' }],
      components: [
        {
          id: 'inventory-store',
          componentType: 'Store',
          description: 'Durable ledger of stock adjustments with an in-memory projection.',
          durability: 'durable',
        },
        {
          id: 'stock-intake-orchestrator',
          componentType: 'Orchestrator',
          description: 'Applies inbound deliveries to the stock ledger.',
          dependsOn: ['inventory-store'],
        },
      ],
      interfaces: [
        {
          id: 'iinventory_store',
          component: 'inventory-store',
          methods: [
            { name: 'saveAdjustment', description: 'Persist one stock adjustment to the ledger.', effect: 'write' },
            { name: 'loadAll', description: 'Read every persisted adjustment back into the in-memory ledger.', effect: 'read' },
          ],
        },
        {
          id: 'istock_intake_orchestrator',
          component: 'stock-intake-orchestrator',
          methods: [{ name: 'receiveStock', description: 'Apply an inbound delivery to the stock ledger.' }],
        },
      ],
      implementations: [
        {
          id: 'stock_intake_orchestrator_impl',
          contract: 'istock_intake_orchestrator',
          methods: [
            {
              name: 'receiveStock',
              narrative: [
                {
                  stepNumber: 1,
                  type: 'call',
                  description: 'Persist the delivery as a stock adjustment.',
                  targetComponent: 'inventory-store',
                  targetMethod: 'saveAdjustment',
                },
              ],
            },
          ],
        },
      ],
    },
  }),

  // -------------------------------------------------------------------------
  // MISSING_HYDRATION — fire: the boot walk must NOT follow register edges
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'MISSING_HYDRATION',
    severity: 'error',
    anchoredTo: 'inventory-store',
    expectFire: true,
    scenario:
      'The init flow only REGISTERS the ledger reload as a deferred callback with the runtime scheduler — registration hands the read to the runtime for later, so no boot-time read-back ever executes.',
    tree: {
      subsystems: [
        {
          id: 'inventory',
          description: 'Warehouse stock levels and adjustments.',
          lifecycle: [
            { phase: 'init', component: 'inventory-bootstrap', method: 'initialize', description: 'Boot wiring for the stock ledger.' },
          ],
        },
      ],
      components: [
        {
          id: 'inventory-store',
          componentType: 'Store',
          description: 'Durable ledger of stock adjustments with an in-memory projection.',
          durability: 'durable',
        },
        {
          id: 'inventory-bootstrap',
          componentType: 'Orchestrator',
          description: 'Boot wiring for the inventory subsystem.',
          dependsOn: ['inventory-store'],
        },
        {
          id: 'stock-intake-orchestrator',
          componentType: 'Orchestrator',
          description: 'Applies inbound deliveries to the stock ledger.',
          dependsOn: ['inventory-store'],
        },
      ],
      interfaces: [
        {
          id: 'iinventory_store',
          component: 'inventory-store',
          methods: [
            { name: 'saveAdjustment', description: 'Persist one stock adjustment to the ledger.', effect: 'write' },
            { name: 'loadAll', description: 'Read every persisted adjustment back into the in-memory ledger.', effect: 'read' },
          ],
        },
        {
          id: 'iinventory_bootstrap',
          component: 'inventory-bootstrap',
          methods: [{ name: 'initialize', description: 'Wire the ledger reload into the runtime at boot.' }],
        },
        {
          id: 'istock_intake_orchestrator',
          component: 'stock-intake-orchestrator',
          methods: [{ name: 'receiveStock', description: 'Apply an inbound delivery to the stock ledger.' }],
        },
      ],
      implementations: [
        {
          id: 'inventory_bootstrap_impl',
          contract: 'iinventory_bootstrap',
          methods: [
            {
              name: 'initialize',
              narrative: [
                {
                  stepNumber: 1,
                  type: 'register',
                  description: 'Register the ledger reload as a lazy rehydrate hook with the runtime scheduler.',
                  targetComponent: 'inventory-store',
                  targetMethod: 'loadAll',
                },
                { stepNumber: 2, type: 'return', description: 'Report the inventory subsystem wired.', outcome: 'success' },
              ],
            },
          ],
        },
        {
          id: 'stock_intake_orchestrator_impl',
          contract: 'istock_intake_orchestrator',
          methods: [
            {
              name: 'receiveStock',
              narrative: [
                {
                  stepNumber: 1,
                  type: 'call',
                  description: 'Persist the delivery as a stock adjustment.',
                  targetComponent: 'inventory-store',
                  targetMethod: 'saveAdjustment',
                },
              ],
            },
          ],
        },
      ],
    },
  }),
  defineRuleFixture({
    code: 'MISSING_HYDRATION',
    expectFire: false,
    reason: 'The init narrative takes a real call edge to the read-effect loadAll, so the persisted ledger is read back at boot.',
    scenario:
      'The inventory init flow calls loadAll directly, reading every persisted adjustment back into the in-memory ledger at boot.',
    tree: {
      subsystems: [
        {
          id: 'inventory',
          description: 'Warehouse stock levels and adjustments.',
          lifecycle: [
            { phase: 'init', component: 'inventory-bootstrap', method: 'initialize', description: 'Boot wiring for the stock ledger.' },
          ],
        },
      ],
      components: [
        {
          id: 'inventory-store',
          componentType: 'Store',
          description: 'Durable ledger of stock adjustments with an in-memory projection.',
          durability: 'durable',
        },
        {
          id: 'inventory-bootstrap',
          componentType: 'Orchestrator',
          description: 'Boot wiring for the inventory subsystem.',
          dependsOn: ['inventory-store'],
        },
        {
          id: 'stock-intake-orchestrator',
          componentType: 'Orchestrator',
          description: 'Applies inbound deliveries to the stock ledger.',
          dependsOn: ['inventory-store'],
        },
      ],
      interfaces: [
        {
          id: 'iinventory_store',
          component: 'inventory-store',
          methods: [
            { name: 'saveAdjustment', description: 'Persist one stock adjustment to the ledger.', effect: 'write' },
            { name: 'loadAll', description: 'Read every persisted adjustment back into the in-memory ledger.', effect: 'read' },
          ],
        },
        {
          id: 'iinventory_bootstrap',
          component: 'inventory-bootstrap',
          methods: [{ name: 'initialize', description: 'Hydrate the ledger from persisted adjustments at boot.' }],
        },
        {
          id: 'istock_intake_orchestrator',
          component: 'stock-intake-orchestrator',
          methods: [{ name: 'receiveStock', description: 'Apply an inbound delivery to the stock ledger.' }],
        },
      ],
      implementations: [
        {
          id: 'inventory_bootstrap_impl',
          contract: 'iinventory_bootstrap',
          methods: [
            {
              name: 'initialize',
              narrative: [
                {
                  stepNumber: 1,
                  type: 'call',
                  description: 'Read every persisted adjustment back into the in-memory ledger.',
                  targetComponent: 'inventory-store',
                  targetMethod: 'loadAll',
                },
                { stepNumber: 2, type: 'return', description: 'Report the inventory subsystem hydrated.', outcome: 'success' },
              ],
            },
          ],
        },
        {
          id: 'stock_intake_orchestrator_impl',
          contract: 'istock_intake_orchestrator',
          methods: [
            {
              name: 'receiveStock',
              narrative: [
                {
                  stepNumber: 1,
                  type: 'call',
                  description: 'Persist the delivery as a stock adjustment.',
                  targetComponent: 'inventory-store',
                  targetMethod: 'saveAdjustment',
                },
              ],
            },
          ],
        },
      ],
    },
  }),

  // -------------------------------------------------------------------------
  // MISSING_HYDRATION — fire: the boot walk must NOT flood dispatch tables
  // (a capability merely OFFERED by a reached portal is not a boot-time read)
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'MISSING_HYDRATION',
    severity: 'error',
    anchoredTo: 'stock-ledger-store',
    expectFire: true,
    scenario:
      'The init flow roots the ops portal, whose dispatch table merely OFFERS a ledger.reload capability that would hydrate the durable ledger — but no init narrative actually takes that edge, so boot never reads the ledger back.',
    tree: {
      subsystems: [
        {
          id: 'stock-ledger',
          description: 'Durable stock ledger behind a repository facade.',
          lifecycle: [
            { phase: 'init', component: 'stock-ops-portal', method: 'healthcheck', description: 'Readiness probe run at boot.' },
          ],
        },
      ],
      components: [
        {
          id: 'stock-ops-portal',
          componentType: 'Portal',
          portalType: 'HTTP_API',
          description: 'Operations portal offering ledger admin capabilities.',
          dependsOn: ['stock-ledger-repository'],
          dispatch: [
            {
              capability: 'ledger.reload',
              component: 'stock-ledger-repository',
              method: 'reloadLedger',
              description: 'Reload the stock ledger from its persisted adjustments.',
            },
          ],
        },
        {
          id: 'stock-ledger-repository',
          componentType: 'Repository',
          description: 'Facade over the durable stock ledger store.',
          owns: ['stock-ledger-store'],
        },
        {
          id: 'stock-ledger-store',
          componentType: 'Store',
          description: 'Durable ledger of stock adjustments with an in-memory projection.',
          durability: 'durable',
        },
      ],
      interfaces: [
        {
          id: 'istock_ops_portal',
          component: 'stock-ops-portal',
          methods: [{ name: 'healthcheck', description: 'Report readiness of the ledger services.' }],
        },
        {
          id: 'istock_ledger_repository',
          component: 'stock-ledger-repository',
          methods: [{ name: 'reloadLedger', description: 'Reload the ledger projection from persisted adjustments.' }],
        },
        {
          id: 'istock_ledger_store',
          component: 'stock-ledger-store',
          methods: [
            { name: 'saveAdjustment', description: 'Persist one stock adjustment to the ledger.', effect: 'write' },
            { name: 'loadAll', description: 'Read every persisted adjustment back into the projection.', effect: 'read' },
          ],
        },
      ],
      implementations: [
        {
          id: 'stock_ops_portal_impl',
          contract: 'istock_ops_portal',
          methods: [
            {
              name: 'healthcheck',
              narrative: [{ stepNumber: 1, type: 'local', description: 'Report readiness of the ledger services.' }],
            },
          ],
        },
        {
          id: 'stock_ledger_repository_impl',
          contract: 'istock_ledger_repository',
          methods: [
            {
              name: 'reloadLedger',
              narrative: [
                {
                  stepNumber: 1,
                  type: 'call',
                  description: 'Forward the reload to the owned ledger store.',
                  targetComponent: 'stock-ledger-store',
                  targetMethod: 'loadAll',
                },
              ],
            },
          ],
        },
      ],
    },
  }),
  defineRuleFixture({
    code: 'MISSING_HYDRATION',
    expectFire: false,
    reason:
      'The init narrative takes an EXPLICIT dispatch step through the portal, and explicit dispatch steps in the init flow are followed — the capability resolves to the repository reload, which reads the store back.',
    scenario:
      'The ledger bootstrap init flow explicitly dispatches ledger.reload through the ops portal, hydrating the durable ledger through the repository facade.',
    tree: {
      subsystems: [
        {
          id: 'stock-ledger',
          description: 'Durable stock ledger behind a repository facade.',
          lifecycle: [
            { phase: 'init', component: 'ledger-bootstrap', method: 'initialize', description: 'Boot hydration of the stock ledger.' },
          ],
        },
      ],
      components: [
        {
          id: 'stock-ops-portal',
          componentType: 'Portal',
          portalType: 'HTTP_API',
          description: 'Operations portal offering ledger admin capabilities.',
          dependsOn: ['stock-ledger-repository'],
          dispatch: [
            {
              capability: 'ledger.reload',
              component: 'stock-ledger-repository',
              method: 'reloadLedger',
              description: 'Reload the stock ledger from its persisted adjustments.',
            },
          ],
        },
        {
          id: 'stock-ledger-repository',
          componentType: 'Repository',
          description: 'Facade over the durable stock ledger store.',
          owns: ['stock-ledger-store'],
        },
        {
          id: 'stock-ledger-store',
          componentType: 'Store',
          description: 'Durable ledger of stock adjustments with an in-memory projection.',
          durability: 'durable',
        },
        {
          id: 'ledger-bootstrap',
          componentType: 'Orchestrator',
          description: 'Boot wiring for the stock ledger.',
          dependsOn: ['stock-ops-portal'],
        },
      ],
      interfaces: [
        {
          id: 'istock_ops_portal',
          component: 'stock-ops-portal',
          methods: [{ name: 'healthcheck', description: 'Report readiness of the ledger services.' }],
        },
        {
          id: 'istock_ledger_repository',
          component: 'stock-ledger-repository',
          methods: [{ name: 'reloadLedger', description: 'Reload the ledger projection from persisted adjustments.' }],
        },
        {
          id: 'istock_ledger_store',
          component: 'stock-ledger-store',
          methods: [
            { name: 'saveAdjustment', description: 'Persist one stock adjustment to the ledger.', effect: 'write' },
            { name: 'loadAll', description: 'Read every persisted adjustment back into the projection.', effect: 'read' },
          ],
        },
        {
          id: 'iledger_bootstrap',
          component: 'ledger-bootstrap',
          methods: [{ name: 'initialize', description: 'Hydrate the ledger projection at boot.' }],
        },
      ],
      implementations: [
        {
          id: 'stock_ops_portal_impl',
          contract: 'istock_ops_portal',
          methods: [
            {
              name: 'healthcheck',
              narrative: [{ stepNumber: 1, type: 'local', description: 'Report readiness of the ledger services.' }],
            },
          ],
        },
        {
          id: 'stock_ledger_repository_impl',
          contract: 'istock_ledger_repository',
          methods: [
            {
              name: 'reloadLedger',
              narrative: [
                {
                  stepNumber: 1,
                  type: 'call',
                  description: 'Forward the reload to the owned ledger store.',
                  targetComponent: 'stock-ledger-store',
                  targetMethod: 'loadAll',
                },
              ],
            },
          ],
        },
        {
          id: 'ledger_bootstrap_impl',
          contract: 'iledger_bootstrap',
          methods: [
            {
              name: 'initialize',
              narrative: [
                {
                  stepNumber: 1,
                  type: 'dispatch',
                  description: 'Route the ledger reload through the ops portal at boot.',
                  targetComponent: 'stock-ops-portal',
                  capability: 'ledger.reload',
                },
                { stepNumber: 2, type: 'return', description: 'Report boot hydration complete.', outcome: 'success' },
              ],
            },
          ],
        },
      ],
    },
  }),

  // -------------------------------------------------------------------------
  // MISSING_HYDRATION — the three exempt durability modes
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'MISSING_HYDRATION',
    expectFire: false,
    reason: 'cache durability declares the state evictable and loss-safe, so no boot read-back is required.',
    scenario:
      'The carrier-rate cache Store is written by the quote orchestrator with no init flow, but its cache durability makes loss behavior-preserving.',
    tree: {
      subsystems: [{ id: 'rate-shopping', description: 'Carrier rate quoting with a TTL rate cache.' }],
      components: [
        {
          id: 'carrier-rate-cache',
          componentType: 'Store',
          description: 'TTL cache of recent carrier rate quotes.',
          durability: 'cache',
        },
        {
          id: 'quote-orchestrator',
          componentType: 'Orchestrator',
          description: 'Fetches quotes and memoizes them in the rate cache.',
          dependsOn: ['carrier-rate-cache'],
        },
      ],
      interfaces: [
        {
          id: 'icarrier_rate_cache',
          component: 'carrier-rate-cache',
          methods: [
            { name: 'putRate', description: 'Memoize one carrier rate under its lane key.', effect: 'write' },
            { name: 'getRate', description: 'Look up a memoized carrier rate by lane.', effect: 'read' },
          ],
        },
        {
          id: 'iquote_orchestrator',
          component: 'quote-orchestrator',
          methods: [{ name: 'quoteLane', description: 'Quote a shipping lane, memoizing fresh rates.' }],
        },
      ],
      implementations: [
        {
          id: 'quote_orchestrator_impl',
          contract: 'iquote_orchestrator',
          methods: [
            {
              name: 'quoteLane',
              narrative: [
                {
                  stepNumber: 1,
                  type: 'call',
                  description: 'Memoize the freshly fetched rate for the lane.',
                  targetComponent: 'carrier-rate-cache',
                  targetMethod: 'putRate',
                },
              ],
            },
          ],
        },
      ],
    },
  }),
  defineRuleFixture({
    code: 'MISSING_HYDRATION',
    expectFire: false,
    reason: 'ram-projection durability declares the state rebuilt rather than restored, so the round-trip does not apply.',
    scenario:
      'The leaderboard projection Store is written on every score event and rebuilt from the event stream, never restored from disk.',
    tree: {
      subsystems: [{ id: 'gamification', description: 'Player scores and leaderboards.' }],
      components: [
        {
          id: 'leaderboard-projection-store',
          componentType: 'Store',
          description: 'In-memory leaderboard rebuilt from the score event stream.',
          durability: 'ram-projection',
        },
        {
          id: 'score-orchestrator',
          componentType: 'Orchestrator',
          description: 'Applies score events to the leaderboard projection.',
          dependsOn: ['leaderboard-projection-store'],
        },
      ],
      interfaces: [
        {
          id: 'ileaderboard_projection_store',
          component: 'leaderboard-projection-store',
          methods: [
            { name: 'recordScore', description: 'Fold one score event into the leaderboard.', effect: 'write' },
            { name: 'topPlayers', description: 'Read the current top players.', effect: 'read' },
          ],
        },
        {
          id: 'iscore_orchestrator',
          component: 'score-orchestrator',
          methods: [{ name: 'applyScore', description: 'Apply a validated score event to the leaderboard.' }],
        },
      ],
      implementations: [
        {
          id: 'score_orchestrator_impl',
          contract: 'iscore_orchestrator',
          methods: [
            {
              name: 'applyScore',
              narrative: [
                {
                  stepNumber: 1,
                  type: 'call',
                  description: 'Fold the score event into the leaderboard projection.',
                  targetComponent: 'leaderboard-projection-store',
                  targetMethod: 'recordScore',
                },
              ],
            },
          ],
        },
      ],
    },
  }),
  defineRuleFixture({
    code: 'MISSING_HYDRATION',
    expectFire: false,
    reason: 'read-through durability keeps no RAM copy — every read hits the backing medium, so every read IS the read-back.',
    scenario:
      'The merchant-config Store persists settings with no RAM copy; reads go to the backing medium, so no init hydration is needed.',
    tree: {
      subsystems: [{ id: 'merchant-settings', description: 'Per-merchant configuration records.' }],
      components: [
        {
          id: 'merchant-config-store',
          componentType: 'Store',
          description: 'File-backed per-merchant configuration records.',
          durability: 'read-through',
        },
        {
          id: 'settings-orchestrator',
          componentType: 'Orchestrator',
          description: 'Validates and applies merchant setting changes.',
          dependsOn: ['merchant-config-store'],
        },
      ],
      interfaces: [
        {
          id: 'imerchant_config_store',
          component: 'merchant-config-store',
          methods: [
            { name: 'saveSetting', description: 'Persist one merchant setting change.', effect: 'write' },
            { name: 'getSetting', description: 'Read one merchant setting from the backing record.', effect: 'read' },
          ],
        },
        {
          id: 'isettings_orchestrator',
          component: 'settings-orchestrator',
          methods: [{ name: 'updateSetting', description: 'Validate and persist a merchant setting change.' }],
        },
      ],
      implementations: [
        {
          id: 'settings_orchestrator_impl',
          contract: 'isettings_orchestrator',
          methods: [
            {
              name: 'updateSetting',
              narrative: [
                {
                  stepNumber: 1,
                  type: 'call',
                  description: 'Persist the validated setting change.',
                  targetComponent: 'merchant-config-store',
                  targetMethod: 'saveSetting',
                },
              ],
            },
          ],
        },
      ],
    },
  }),
];
