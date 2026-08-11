/**
 * Graph family (src/core/rules/graph.ts): dependency cycles + unused-detection.
 *
 * Documented intents pinned here:
 *  - CIRCULAR_DEPENDENCY (error): "The component dependsOn graph must be a DAG."
 *  - UNUSED_COMPONENT / UNUSED_METHOD / UNUSED_TYPE (warnings): reachability is
 *    walked from every entrypoint — Portals, Observers, published components,
 *    declared lifecycle entrypoints, and invokedBy-declared methods — over
 *    call steps, register handoffs, and dispatch-table routing. Types are
 *    referenced by fields and signatures.
 *  - INVOKED_BY_UNDESCRIBED (warning): invokedBy caller prose missing or
 *    placeholder-thin — the entrypoint claim must stay reviewable.
 *  - INVOKED_BY_REDUNDANT (warning): invokedBy on a method the INTERNAL walk
 *    already reaches — a stale declaration.
 *
 * Reachability shapes deliberately covered (recent-feature origin questions):
 * Portal-rooted chains, dispatch-table flooding, lifecycle entrypoints,
 * register handoffs (reached via registrar; stale when registrar unreached),
 * invokedBy seeding + propagation, and the detail-dial fallback (an
 * intent-level method must not false-flag its collaborators).
 */
import { defineRuleFixture } from '../harness.js';

export default [
  // -------------------------------------------------------------------------
  // CIRCULAR_DEPENDENCY
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'CIRCULAR_DEPENDENCY',
    severity: 'error',
    expectFire: true,
    scenario:
      'The invoice orchestrator and the dunning orchestrator each declare the other as a dependency, so the payments dependsOn graph is no longer a DAG.',
    tree: {
      subsystems: [{ id: 'payments', description: 'Invoice issuing and overdue-payment dunning.' }],
      components: [
        {
          id: 'invoice-orchestrator',
          componentType: 'Orchestrator',
          description: 'Issues invoices and schedules their collection.',
          dependsOn: ['dunning-orchestrator'],
        },
        {
          id: 'dunning-orchestrator',
          componentType: 'Orchestrator',
          description: 'Escalates overdue invoices through reminder tiers.',
          dependsOn: ['invoice-orchestrator'],
        },
      ],
    },
  }),
  defineRuleFixture({
    code: 'CIRCULAR_DEPENDENCY',
    expectFire: false,
    reason: 'The dependency edge runs one way only (invoicing drives dunning), so the graph is a DAG.',
    scenario:
      'The invoice orchestrator depends on the dunning orchestrator, and the dunning orchestrator has no back-edge.',
    tree: {
      subsystems: [{ id: 'payments', description: 'Invoice issuing and overdue-payment dunning.' }],
      components: [
        {
          id: 'invoice-orchestrator',
          componentType: 'Orchestrator',
          description: 'Issues invoices and schedules their collection.',
          dependsOn: ['dunning-orchestrator'],
        },
        {
          id: 'dunning-orchestrator',
          componentType: 'Orchestrator',
          description: 'Escalates overdue invoices through reminder tiers.',
          dependsOn: [],
        },
      ],
    },
  }),

  // -------------------------------------------------------------------------
  // UNUSED_COMPONENT — Portal-rooted chain with an orphan
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'UNUSED_COMPONENT',
    severity: 'warning',
    anchoredTo: 'gift-wrap-specialist',
    expectFire: true,
    scenario:
      'The checkout portal drives the checkout orchestrator, but the gift-wrap specialist is wired into no narrative at all — no execution chain from the portal ever reaches it.',
    tree: {
      subsystems: [{ id: 'storefront', description: 'Customer-facing shop: checkout and order intake.' }],
      components: [
        {
          id: 'checkout-portal',
          componentType: 'Portal',
          portalType: 'HTTP_API',
          description: 'Public HTTP entry for placing orders.',
          dependsOn: ['checkout-orchestrator'],
        },
        {
          id: 'checkout-orchestrator',
          componentType: 'Orchestrator',
          description: 'Validates the cart and drives order placement.',
        },
        {
          id: 'gift-wrap-specialist',
          componentType: 'Specialist',
          description: 'Computes gift-wrap plans for gift-marked items.',
        },
      ],
      interfaces: [
        {
          id: 'icheckout_portal',
          component: 'checkout-portal',
          methods: [{ name: 'placeOrder', description: 'Accept a new order from the storefront client.' }],
        },
        {
          id: 'icheckout_orchestrator',
          component: 'checkout-orchestrator',
          methods: [{ name: 'submitOrder', description: 'Validate the cart and reserve stock for the order.' }],
        },
        {
          id: 'igift_wrap_specialist',
          component: 'gift-wrap-specialist',
          methods: [{ name: 'wrapItems', description: 'Compute the wrap plan for each gift-marked item.' }],
        },
      ],
      implementations: [
        {
          id: 'checkout_portal_impl',
          contract: 'icheckout_portal',
          methods: [
            {
              name: 'placeOrder',
              narrative: [
                {
                  stepNumber: 1,
                  type: 'call',
                  description: 'Forward the incoming order to the checkout workflow.',
                  targetComponent: 'checkout-orchestrator',
                  targetMethod: 'submitOrder',
                },
              ],
            },
          ],
        },
        {
          id: 'checkout_orchestrator_impl',
          contract: 'icheckout_orchestrator',
          methods: [
            {
              name: 'submitOrder',
              narrative: [
                { stepNumber: 1, type: 'local', description: 'Validate the cart and reserve stock for each line item.' },
                { stepNumber: 2, type: 'return', description: 'Confirm the placed order to the caller.', outcome: 'success' },
              ],
            },
          ],
        },
        {
          id: 'gift_wrap_specialist_impl',
          contract: 'igift_wrap_specialist',
          methods: [
            {
              name: 'wrapItems',
              narrative: [{ stepNumber: 1, type: 'local', description: 'Fold the wrap plan for each gift-marked item.' }],
            },
          ],
        },
      ],
    },
  }),
  defineRuleFixture({
    code: 'UNUSED_COMPONENT',
    expectFire: false,
    reason: 'The orchestrator narrative now calls the specialist, so a Portal-rooted execution chain reaches every component.',
    scenario:
      'The checkout orchestrator calls the gift-wrap specialist for gift-marked items, completing the portal-rooted chain.',
    tree: {
      subsystems: [{ id: 'storefront', description: 'Customer-facing shop: checkout and order intake.' }],
      components: [
        {
          id: 'checkout-portal',
          componentType: 'Portal',
          portalType: 'HTTP_API',
          description: 'Public HTTP entry for placing orders.',
          dependsOn: ['checkout-orchestrator'],
        },
        {
          id: 'checkout-orchestrator',
          componentType: 'Orchestrator',
          description: 'Validates the cart and drives order placement.',
          dependsOn: ['gift-wrap-specialist'],
        },
        {
          id: 'gift-wrap-specialist',
          componentType: 'Specialist',
          description: 'Computes gift-wrap plans for gift-marked items.',
        },
      ],
      interfaces: [
        {
          id: 'icheckout_portal',
          component: 'checkout-portal',
          methods: [{ name: 'placeOrder', description: 'Accept a new order from the storefront client.' }],
        },
        {
          id: 'icheckout_orchestrator',
          component: 'checkout-orchestrator',
          methods: [{ name: 'submitOrder', description: 'Validate the cart and reserve stock for the order.' }],
        },
        {
          id: 'igift_wrap_specialist',
          component: 'gift-wrap-specialist',
          methods: [{ name: 'wrapItems', description: 'Compute the wrap plan for each gift-marked item.' }],
        },
      ],
      implementations: [
        {
          id: 'checkout_portal_impl',
          contract: 'icheckout_portal',
          methods: [
            {
              name: 'placeOrder',
              narrative: [
                {
                  stepNumber: 1,
                  type: 'call',
                  description: 'Forward the incoming order to the checkout workflow.',
                  targetComponent: 'checkout-orchestrator',
                  targetMethod: 'submitOrder',
                },
              ],
            },
          ],
        },
        {
          id: 'checkout_orchestrator_impl',
          contract: 'icheckout_orchestrator',
          methods: [
            {
              name: 'submitOrder',
              narrative: [
                { stepNumber: 1, type: 'local', description: 'Validate the cart and reserve stock for each line item.' },
                {
                  stepNumber: 2,
                  type: 'call',
                  description: 'Compute the wrap plan for gift-marked items.',
                  targetComponent: 'gift-wrap-specialist',
                  targetMethod: 'wrapItems',
                },
                { stepNumber: 3, type: 'return', description: 'Confirm the placed order to the caller.', outcome: 'success' },
              ],
            },
          ],
        },
        {
          id: 'gift_wrap_specialist_impl',
          contract: 'igift_wrap_specialist',
          methods: [
            {
              name: 'wrapItems',
              narrative: [{ stepNumber: 1, type: 'local', description: 'Fold the wrap plan for each gift-marked item.' }],
            },
          ],
        },
      ],
    },
  }),

  // -------------------------------------------------------------------------
  // UNUSED_COMPONENT — dispatch-table flooding (the table IS the served surface)
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'UNUSED_COMPONENT',
    expectFire: false,
    reason:
      'The ledger rebuilder is bound in the ops portal dispatch table; reaching the portal reaches every capability binding — the table is the portal\'s served surface, so no static call step is required.',
    scenario:
      'The ledger rebuilder is reachable only through the ops portal dispatch table binding for the ledger.rebuild capability, and unused-detection floods the table.',
    tree: {
      subsystems: [{ id: 'back-office', description: 'Operational tooling for the finance back office.' }],
      components: [
        {
          id: 'ops-portal',
          componentType: 'Portal',
          portalType: 'HTTP_API',
          description: 'Generic operations portal dispatching admin capabilities inward.',
          dependsOn: ['ledger-rebuilder'],
          dispatch: [
            {
              capability: 'ledger.rebuild',
              component: 'ledger-rebuilder',
              method: 'rebuild',
              description: 'Rebuild the projected ledger from the event archive.',
            },
          ],
        },
        {
          id: 'ledger-rebuilder',
          componentType: 'Actor',
          description: 'Replays the event archive into a fresh ledger projection.',
        },
      ],
      interfaces: [
        {
          id: 'iops_portal',
          component: 'ops-portal',
          methods: [{ name: 'showStatus', description: 'Render the current rebuild status for operators.' }],
        },
        {
          id: 'iledger_rebuilder',
          component: 'ledger-rebuilder',
          methods: [{ name: 'rebuild', description: 'Replay the event archive into a fresh ledger projection.' }],
        },
      ],
      implementations: [
        {
          id: 'ops_portal_impl',
          contract: 'iops_portal',
          methods: [
            {
              name: 'showStatus',
              narrative: [{ stepNumber: 1, type: 'local', description: 'Render the current rebuild status for operators.' }],
            },
          ],
        },
        {
          id: 'ledger_rebuilder_impl',
          contract: 'iledger_rebuilder',
          methods: [
            {
              name: 'rebuild',
              narrative: [{ stepNumber: 1, type: 'local', description: 'Replay the event archive into a fresh ledger projection.' }],
            },
          ],
        },
      ],
    },
  }),

  // -------------------------------------------------------------------------
  // UNUSED_COMPONENT — lifecycle entrypoints as reachability roots
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'UNUSED_COMPONENT',
    severity: 'warning',
    anchoredTo: 'session-sweeper',
    expectFire: true,
    scenario:
      'The session sweeper is meant to run on a nightly schedule, but the identity subsystem declares no lifecycle entrypoint for it, so no modeled flow ever reaches it.',
    tree: {
      subsystems: [{ id: 'identity', description: 'Authentication sessions and their upkeep.' }],
      components: [
        {
          id: 'login-portal',
          componentType: 'Portal',
          portalType: 'HTTP_API',
          description: 'Public authentication endpoint.',
        },
        {
          id: 'session-sweeper',
          componentType: 'Actor',
          description: 'Deletes sessions whose expiry passed the grace window.',
        },
      ],
      interfaces: [
        {
          id: 'ilogin_portal',
          component: 'login-portal',
          methods: [{ name: 'authenticate', description: 'Verify the presented credentials against the directory.' }],
        },
        {
          id: 'isession_sweeper',
          component: 'session-sweeper',
          methods: [{ name: 'sweepExpired', description: 'Delete sessions whose expiry passed the grace window.' }],
        },
      ],
      implementations: [
        {
          id: 'login_portal_impl',
          contract: 'ilogin_portal',
          methods: [
            {
              name: 'authenticate',
              narrative: [{ stepNumber: 1, type: 'local', description: 'Verify the presented credentials against the directory.' }],
            },
          ],
        },
        {
          id: 'session_sweeper_impl',
          contract: 'isession_sweeper',
          methods: [
            {
              name: 'sweepExpired',
              narrative: [{ stepNumber: 1, type: 'local', description: 'Delete sessions whose expiry passed the grace window.' }],
            },
          ],
        },
      ],
    },
  }),
  defineRuleFixture({
    code: 'UNUSED_COMPONENT',
    expectFire: false,
    reason:
      'The scheduled lifecycle entrypoint declares the runtime timer as the flow root, so the sweeper is a reachability root instead of dead weight.',
    scenario:
      'The identity subsystem declares a scheduled lifecycle entrypoint rooting the nightly session sweep, making the sweeper statically reachable.',
    tree: {
      subsystems: [
        {
          id: 'identity',
          description: 'Authentication sessions and their upkeep.',
          lifecycle: [
            {
              phase: 'scheduled',
              component: 'session-sweeper',
              method: 'sweepExpired',
              description: 'Nightly cleanup tick clearing expired sessions.',
            },
          ],
        },
      ],
      components: [
        {
          id: 'login-portal',
          componentType: 'Portal',
          portalType: 'HTTP_API',
          description: 'Public authentication endpoint.',
        },
        {
          id: 'session-sweeper',
          componentType: 'Actor',
          description: 'Deletes sessions whose expiry passed the grace window.',
        },
      ],
      interfaces: [
        {
          id: 'ilogin_portal',
          component: 'login-portal',
          methods: [{ name: 'authenticate', description: 'Verify the presented credentials against the directory.' }],
        },
        {
          id: 'isession_sweeper',
          component: 'session-sweeper',
          methods: [{ name: 'sweepExpired', description: 'Delete sessions whose expiry passed the grace window.' }],
        },
      ],
      implementations: [
        {
          id: 'login_portal_impl',
          contract: 'ilogin_portal',
          methods: [
            {
              name: 'authenticate',
              narrative: [{ stepNumber: 1, type: 'local', description: 'Verify the presented credentials against the directory.' }],
            },
          ],
        },
        {
          id: 'session_sweeper_impl',
          contract: 'isession_sweeper',
          methods: [
            {
              name: 'sweepExpired',
              narrative: [{ stepNumber: 1, type: 'local', description: 'Delete sessions whose expiry passed the grace window.' }],
            },
          ],
        },
      ],
    },
  }),

  // -------------------------------------------------------------------------
  // UNUSED_COMPONENT — register handoffs: reached via the registrar; stale
  // (still unused) when the registrar itself is unreached.
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'UNUSED_COMPONENT',
    expectFire: false,
    reason:
      'A registered callback is reached wherever its registering narrative is reached — the init flow roots the bootstrap, whose register step hands the rotation worker to the runtime.',
    scenario:
      'The key-management init flow reaches the token bootstrap, whose register step hands the key-rotation worker callback to the runtime timer wheel.',
    tree: {
      subsystems: [
        {
          id: 'key-management',
          description: 'Signing-key lifecycle: bootstrap and rotation.',
          lifecycle: [
            {
              phase: 'init',
              component: 'token-bootstrap',
              method: 'configureRotation',
              description: 'Boot-time wiring of the signing-key rotation schedule.',
            },
          ],
        },
      ],
      components: [
        {
          id: 'token-bootstrap',
          componentType: 'Orchestrator',
          description: 'Wires the signing-key rotation schedule at boot.',
          dependsOn: ['key-rotation-worker'],
        },
        {
          id: 'key-rotation-worker',
          componentType: 'Actor',
          description: 'Mints fresh signing keys and retires the oldest.',
        },
      ],
      interfaces: [
        {
          id: 'itoken_bootstrap',
          component: 'token-bootstrap',
          methods: [{ name: 'configureRotation', description: 'Wire the signing-key rotation schedule into the runtime.' }],
        },
        {
          id: 'ikey_rotation_worker',
          component: 'key-rotation-worker',
          methods: [{ name: 'rotateKeys', description: 'Mint a fresh signing key and retire the oldest one.' }],
        },
      ],
      implementations: [
        {
          id: 'token_bootstrap_impl',
          contract: 'itoken_bootstrap',
          methods: [
            {
              name: 'configureRotation',
              narrative: [
                {
                  stepNumber: 1,
                  type: 'register',
                  description: 'Hand the key-rotation callback to the runtime timer wheel.',
                  targetComponent: 'key-rotation-worker',
                  targetMethod: 'rotateKeys',
                },
                { stepNumber: 2, type: 'return', description: 'Report the rotation schedule as configured.', outcome: 'success' },
              ],
            },
          ],
        },
        {
          id: 'key_rotation_worker_impl',
          contract: 'ikey_rotation_worker',
          methods: [
            {
              name: 'rotateKeys',
              narrative: [{ stepNumber: 1, type: 'local', description: 'Mint a fresh signing key and retire the oldest one.' }],
            },
          ],
        },
      ],
    },
  }),
  defineRuleFixture({
    code: 'UNUSED_COMPONENT',
    severity: 'warning',
    anchoredTo: 'key-rotation-worker',
    expectFire: true,
    scenario:
      'The rotation worker is only registered by the token bootstrap, but nothing roots the bootstrap itself, so the registered callback stays unreached along with its registrar.',
    tree: {
      subsystems: [{ id: 'key-management', description: 'Signing-key lifecycle: bootstrap and rotation.' }],
      components: [
        {
          id: 'token-bootstrap',
          componentType: 'Orchestrator',
          description: 'Wires the signing-key rotation schedule at boot.',
          dependsOn: ['key-rotation-worker'],
        },
        {
          id: 'key-rotation-worker',
          componentType: 'Actor',
          description: 'Mints fresh signing keys and retires the oldest.',
        },
      ],
      interfaces: [
        {
          id: 'itoken_bootstrap',
          component: 'token-bootstrap',
          methods: [{ name: 'configureRotation', description: 'Wire the signing-key rotation schedule into the runtime.' }],
        },
        {
          id: 'ikey_rotation_worker',
          component: 'key-rotation-worker',
          methods: [{ name: 'rotateKeys', description: 'Mint a fresh signing key and retire the oldest one.' }],
        },
      ],
      implementations: [
        {
          id: 'token_bootstrap_impl',
          contract: 'itoken_bootstrap',
          methods: [
            {
              name: 'configureRotation',
              narrative: [
                {
                  stepNumber: 1,
                  type: 'register',
                  description: 'Hand the key-rotation callback to the runtime timer wheel.',
                  targetComponent: 'key-rotation-worker',
                  targetMethod: 'rotateKeys',
                },
                { stepNumber: 2, type: 'return', description: 'Report the rotation schedule as configured.', outcome: 'success' },
              ],
            },
          ],
        },
        {
          id: 'key_rotation_worker_impl',
          contract: 'ikey_rotation_worker',
          methods: [
            {
              name: 'rotateKeys',
              narrative: [{ stepNumber: 1, type: 'local', description: 'Mint a fresh signing key and retire the oldest one.' }],
            },
          ],
        },
      ],
    },
  }),

  // -------------------------------------------------------------------------
  // UNUSED_COMPONENT — the detail-dial fallback: an intent-level method with
  // no narrative floods its component's dependsOn/owns (lower declared
  // fidelity must not false-flag collaborators); a full-detail method gets NO
  // fallback (its missing narrative is a reported gap, unused stays strong).
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'UNUSED_COMPONENT',
    expectFire: false,
    reason:
      'The close-period method is explicitly dialed to intent, so its missing narrative triggers the component-granularity fallback over dependsOn — the specialist must not be false-flagged for a deliberately lower-fidelity method.',
    scenario:
      'The billing orchestrator closePeriod method is dialed to intent with prose only, and its declared dependency on the ledger-adjustment specialist keeps the specialist reachable.',
    tree: {
      subsystems: [{ id: 'billing', description: 'Accounting-period management and ledger adjustments.' }],
      components: [
        {
          id: 'billing-portal',
          componentType: 'Portal',
          portalType: 'HTTP_API',
          description: 'Back-office HTTP entry for accounting operations.',
          dependsOn: ['billing-orchestrator'],
        },
        {
          id: 'billing-orchestrator',
          componentType: 'Orchestrator',
          description: 'Drives the accounting-period close.',
          dependsOn: ['ledger-adjustment-specialist'],
        },
        {
          id: 'ledger-adjustment-specialist',
          componentType: 'Specialist',
          description: 'Applies accrual and rounding adjustments to open ledgers.',
        },
      ],
      interfaces: [
        {
          id: 'ibilling_portal',
          component: 'billing-portal',
          methods: [{ name: 'closeBooks', description: 'Trigger the close of the current accounting period.' }],
        },
        {
          id: 'ibilling_orchestrator',
          component: 'billing-orchestrator',
          methods: [{ name: 'closePeriod', description: 'Freeze postings and close the open accounting period.' }],
        },
        {
          id: 'iledger_adjustment_specialist',
          component: 'ledger-adjustment-specialist',
          methods: [{ name: 'applyAdjustments', description: 'Apply accrual and rounding adjustments to each open ledger.' }],
        },
      ],
      implementations: [
        {
          id: 'billing_portal_impl',
          contract: 'ibilling_portal',
          methods: [
            {
              name: 'closeBooks',
              narrative: [
                {
                  stepNumber: 1,
                  type: 'call',
                  description: 'Kick off the period close workflow.',
                  targetComponent: 'billing-orchestrator',
                  targetMethod: 'closePeriod',
                },
              ],
            },
          ],
        },
        {
          id: 'billing_orchestrator_impl',
          contract: 'ibilling_orchestrator',
          methods: [
            {
              name: 'closePeriod',
              detail: 'intent',
              intent:
                'Close the open accounting period: freeze postings, run the adjustment pass over every open ledger via the adjustment specialist, and emit the close report.',
              narrative: [],
            },
          ],
        },
        {
          id: 'ledger_adjustment_specialist_impl',
          contract: 'iledger_adjustment_specialist',
          methods: [
            {
              name: 'applyAdjustments',
              narrative: [{ stepNumber: 1, type: 'local', description: 'Apply accrual and rounding adjustments to each open ledger line.' }],
            },
          ],
        },
      ],
    },
  }),
  defineRuleFixture({
    code: 'UNUSED_COMPONENT',
    severity: 'warning',
    anchoredTo: 'ledger-adjustment-specialist',
    expectFire: true,
    scenario:
      'The billing orchestrator closePeriod method sits at the full-detail floor with no narrative, so no fallback flooding applies and the ledger-adjustment specialist is correctly reported unreached.',
    tree: {
      subsystems: [{ id: 'billing', description: 'Accounting-period management and ledger adjustments.' }],
      components: [
        {
          id: 'billing-portal',
          componentType: 'Portal',
          portalType: 'HTTP_API',
          description: 'Back-office HTTP entry for accounting operations.',
          dependsOn: ['billing-orchestrator'],
        },
        {
          id: 'billing-orchestrator',
          componentType: 'Orchestrator',
          description: 'Drives the accounting-period close.',
          dependsOn: ['ledger-adjustment-specialist'],
        },
        {
          id: 'ledger-adjustment-specialist',
          componentType: 'Specialist',
          description: 'Applies accrual and rounding adjustments to open ledgers.',
        },
      ],
      interfaces: [
        {
          id: 'ibilling_portal',
          component: 'billing-portal',
          methods: [{ name: 'closeBooks', description: 'Trigger the close of the current accounting period.' }],
        },
        {
          id: 'ibilling_orchestrator',
          component: 'billing-orchestrator',
          methods: [{ name: 'closePeriod', description: 'Freeze postings and close the open accounting period.' }],
        },
        {
          id: 'iledger_adjustment_specialist',
          component: 'ledger-adjustment-specialist',
          methods: [{ name: 'applyAdjustments', description: 'Apply accrual and rounding adjustments to each open ledger.' }],
        },
      ],
      implementations: [
        {
          id: 'billing_portal_impl',
          contract: 'ibilling_portal',
          methods: [
            {
              name: 'closeBooks',
              narrative: [
                {
                  stepNumber: 1,
                  type: 'call',
                  description: 'Kick off the period close workflow.',
                  targetComponent: 'billing-orchestrator',
                  targetMethod: 'closePeriod',
                },
              ],
            },
          ],
        },
        {
          id: 'billing_orchestrator_impl',
          contract: 'ibilling_orchestrator',
          methods: [{ name: 'closePeriod', narrative: [] }],
        },
        {
          id: 'ledger_adjustment_specialist_impl',
          contract: 'iledger_adjustment_specialist',
          methods: [
            {
              name: 'applyAdjustments',
              narrative: [{ stepNumber: 1, type: 'local', description: 'Apply accrual and rounding adjustments to each open ledger line.' }],
            },
          ],
        },
      ],
    },
  }),

  // -------------------------------------------------------------------------
  // UNUSED_COMPONENT — invokedBy seeding + propagation
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'UNUSED_COMPONENT',
    expectFire: false,
    reason:
      'invokedBy seeds the webhook handler as an entrypoint (a typed acknowledgment of the external caller), and reachability propagates through its narrative into the signature verifier.',
    scenario:
      'The webhook orchestrator declares its external payment-provider caller via invokedBy, and its narrative call keeps the signature-verifier specialist reachable.',
    tree: {
      subsystems: [{ id: 'webhooks', description: 'Inbound webhook processing from external providers.' }],
      components: [
        {
          id: 'webhook-orchestrator',
          componentType: 'Orchestrator',
          description: 'Processes signed webhook events from the payment provider.',
          dependsOn: ['signature-verifier-specialist'],
        },
        {
          id: 'signature-verifier-specialist',
          componentType: 'Specialist',
          description: 'Verifies HMAC signatures on inbound webhook payloads.',
        },
      ],
      interfaces: [
        {
          id: 'iwebhook_orchestrator',
          component: 'webhook-orchestrator',
          methods: [
            {
              name: 'processEvent',
              description: 'Verify and apply one signed webhook event.',
              invokedBy: {
                kind: 'external',
                caller:
                  'The upstream payment provider POSTs signed webhook events directly to this handler through the platform ingress.',
              },
            },
          ],
        },
        {
          id: 'isignature_verifier_specialist',
          component: 'signature-verifier-specialist',
          methods: [{ name: 'verifySignature', description: 'Verify the HMAC signature of an inbound payload.' }],
        },
      ],
      implementations: [
        {
          id: 'webhook_orchestrator_impl',
          contract: 'iwebhook_orchestrator',
          methods: [
            {
              name: 'processEvent',
              narrative: [
                {
                  stepNumber: 1,
                  type: 'call',
                  description: 'Verify the HMAC signature before trusting the payload.',
                  targetComponent: 'signature-verifier-specialist',
                  targetMethod: 'verifySignature',
                },
                { stepNumber: 2, type: 'local', description: 'Apply the verified event to the order state machine.' },
              ],
            },
          ],
        },
        {
          id: 'signature_verifier_specialist_impl',
          contract: 'isignature_verifier_specialist',
          methods: [
            {
              name: 'verifySignature',
              narrative: [{ stepNumber: 1, type: 'local', description: 'Recompute the HMAC over the payload and compare digests.' }],
            },
          ],
        },
      ],
    },
  }),

  // -------------------------------------------------------------------------
  // UNUSED_METHOD
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'UNUSED_METHOD',
    severity: 'warning',
    anchoredTo: 'checkout-orchestrator',
    expectFire: true,
    scenario:
      'The checkout orchestrator is reached through the portal for order placement, but its cancelOrder contract method is never called by any narrative step.',
    tree: {
      subsystems: [{ id: 'storefront', description: 'Customer-facing shop: checkout and order intake.' }],
      components: [
        {
          id: 'checkout-portal',
          componentType: 'Portal',
          portalType: 'HTTP_API',
          description: 'Public HTTP entry for placing orders.',
          dependsOn: ['checkout-orchestrator'],
        },
        {
          id: 'checkout-orchestrator',
          componentType: 'Orchestrator',
          description: 'Validates the cart and drives order placement and cancellation.',
        },
      ],
      interfaces: [
        {
          id: 'icheckout_portal',
          component: 'checkout-portal',
          methods: [{ name: 'placeOrder', description: 'Accept a new order from the storefront client.' }],
        },
        {
          id: 'icheckout_orchestrator',
          component: 'checkout-orchestrator',
          methods: [
            { name: 'submitOrder', description: 'Validate the cart and reserve stock for the order.' },
            { name: 'cancelOrder', description: 'Cancel a placed order and release its reserved stock.' },
          ],
        },
      ],
      implementations: [
        {
          id: 'checkout_portal_impl',
          contract: 'icheckout_portal',
          methods: [
            {
              name: 'placeOrder',
              narrative: [
                {
                  stepNumber: 1,
                  type: 'call',
                  description: 'Forward the incoming order to the checkout workflow.',
                  targetComponent: 'checkout-orchestrator',
                  targetMethod: 'submitOrder',
                },
              ],
            },
          ],
        },
        {
          id: 'checkout_orchestrator_impl',
          contract: 'icheckout_orchestrator',
          methods: [
            {
              name: 'submitOrder',
              narrative: [{ stepNumber: 1, type: 'local', description: 'Validate the cart and reserve stock for each line item.' }],
            },
            {
              name: 'cancelOrder',
              narrative: [{ stepNumber: 1, type: 'local', description: 'Mark the order cancelled and release the reserved stock.' }],
            },
          ],
        },
      ],
    },
  }),
  defineRuleFixture({
    code: 'UNUSED_METHOD',
    expectFire: false,
    reason: 'Both orchestrator methods are called from the portal narratives, so every contract method is on an execution chain.',
    scenario:
      'The checkout portal exposes both placement and abort endpoints, each forwarding to its orchestrator method, so no contract method is left unwired.',
    tree: {
      subsystems: [{ id: 'storefront', description: 'Customer-facing shop: checkout and order intake.' }],
      components: [
        {
          id: 'checkout-portal',
          componentType: 'Portal',
          portalType: 'HTTP_API',
          description: 'Public HTTP entry for placing and aborting orders.',
          dependsOn: ['checkout-orchestrator'],
        },
        {
          id: 'checkout-orchestrator',
          componentType: 'Orchestrator',
          description: 'Validates the cart and drives order placement and cancellation.',
        },
      ],
      interfaces: [
        {
          id: 'icheckout_portal',
          component: 'checkout-portal',
          methods: [
            { name: 'placeOrder', description: 'Accept a new order from the storefront client.' },
            { name: 'abortOrder', description: 'Abort a previously placed order on customer request.' },
          ],
        },
        {
          id: 'icheckout_orchestrator',
          component: 'checkout-orchestrator',
          methods: [
            { name: 'submitOrder', description: 'Validate the cart and reserve stock for the order.' },
            { name: 'cancelOrder', description: 'Cancel a placed order and release its reserved stock.' },
          ],
        },
      ],
      implementations: [
        {
          id: 'checkout_portal_impl',
          contract: 'icheckout_portal',
          methods: [
            {
              name: 'placeOrder',
              narrative: [
                {
                  stepNumber: 1,
                  type: 'call',
                  description: 'Forward the incoming order to the checkout workflow.',
                  targetComponent: 'checkout-orchestrator',
                  targetMethod: 'submitOrder',
                },
              ],
            },
            {
              name: 'abortOrder',
              narrative: [
                {
                  stepNumber: 1,
                  type: 'call',
                  description: 'Forward the cancellation to the checkout workflow.',
                  targetComponent: 'checkout-orchestrator',
                  targetMethod: 'cancelOrder',
                },
              ],
            },
          ],
        },
        {
          id: 'checkout_orchestrator_impl',
          contract: 'icheckout_orchestrator',
          methods: [
            {
              name: 'submitOrder',
              narrative: [{ stepNumber: 1, type: 'local', description: 'Validate the cart and reserve stock for each line item.' }],
            },
            {
              name: 'cancelOrder',
              narrative: [{ stepNumber: 1, type: 'local', description: 'Mark the order cancelled and release the reserved stock.' }],
            },
          ],
        },
      ],
    },
  }),
  defineRuleFixture({
    code: 'UNUSED_METHOD',
    expectFire: false,
    reason:
      'The rebuild method is bound in the reached portal\'s dispatch table — the runtime dispatches into table bindings even though no static call step names them.',
    scenario:
      'The ledger rebuilder rebuild method is reachable only through the ops portal dispatch-table binding, which unused-detection treats as the portal\'s served surface.',
    tree: {
      subsystems: [{ id: 'back-office', description: 'Operational tooling for the finance back office.' }],
      components: [
        {
          id: 'ops-portal',
          componentType: 'Portal',
          portalType: 'HTTP_API',
          description: 'Generic operations portal dispatching admin capabilities inward.',
          dependsOn: ['ledger-rebuilder'],
          dispatch: [
            {
              capability: 'ledger.rebuild',
              component: 'ledger-rebuilder',
              method: 'rebuild',
              description: 'Rebuild the projected ledger from the event archive.',
            },
          ],
        },
        {
          id: 'ledger-rebuilder',
          componentType: 'Actor',
          description: 'Replays the event archive into a fresh ledger projection.',
        },
      ],
      interfaces: [
        {
          id: 'iops_portal',
          component: 'ops-portal',
          methods: [{ name: 'showStatus', description: 'Render the current rebuild status for operators.' }],
        },
        {
          id: 'iledger_rebuilder',
          component: 'ledger-rebuilder',
          methods: [{ name: 'rebuild', description: 'Replay the event archive into a fresh ledger projection.' }],
        },
      ],
      implementations: [
        {
          id: 'ops_portal_impl',
          contract: 'iops_portal',
          methods: [
            {
              name: 'showStatus',
              narrative: [{ stepNumber: 1, type: 'local', description: 'Render the current rebuild status for operators.' }],
            },
          ],
        },
        {
          id: 'ledger_rebuilder_impl',
          contract: 'iledger_rebuilder',
          methods: [
            {
              name: 'rebuild',
              narrative: [{ stepNumber: 1, type: 'local', description: 'Replay the event archive into a fresh ledger projection.' }],
            },
          ],
        },
      ],
    },
  }),

  // -------------------------------------------------------------------------
  // UNUSED_TYPE
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'UNUSED_TYPE',
    severity: 'warning',
    anchoredTo: 'carrier-quote',
    expectFire: true,
    scenario:
      'The CarrierQuote value object is defined, but the rate shopper contract returns loose strings instead, so no field or signature ever references the type.',
    tree: {
      subsystems: [{ id: 'logistics', description: 'Carrier rate shopping for outbound parcels.' }],
      components: [
        {
          id: 'rate-shopper',
          componentType: 'Specialist',
          description: 'Fetches and compares carrier rate quotes for a shipping lane.',
        },
      ],
      interfaces: [
        {
          id: 'irate_shopper',
          component: 'rate-shopper',
          methods: [
            {
              name: 'fetchQuotes',
              description: 'Fetch current rate quotes from all connected carriers for a lane.',
              params: [{ name: 'lane', type: 'string' }],
              returns: 'Promise<string>',
            },
          ],
        },
      ],
      types: [
        {
          id: 'carrier-quote',
          name: 'CarrierQuote',
          kind: 'value-object',
          description: 'One carrier\'s priced offer for a shipping lane.',
          fields: [
            { name: 'carrier', type: 'string', description: 'Carrier identifier.' },
            { name: 'totalCents', type: 'number', description: 'Quoted price in cents.' },
          ],
        },
      ],
    },
  }),
  defineRuleFixture({
    code: 'UNUSED_TYPE',
    expectFire: false,
    reason: 'The contract\'s structured return references CarrierQuote, so the type is wired into a signature.',
    scenario:
      'The rate shopper contract returns CarrierQuote values, so the defined value object is referenced by a method signature.',
    tree: {
      subsystems: [{ id: 'logistics', description: 'Carrier rate shopping for outbound parcels.' }],
      components: [
        {
          id: 'rate-shopper',
          componentType: 'Specialist',
          description: 'Fetches and compares carrier rate quotes for a shipping lane.',
        },
      ],
      interfaces: [
        {
          id: 'irate_shopper',
          component: 'rate-shopper',
          methods: [
            {
              name: 'fetchQuotes',
              description: 'Fetch current rate quotes from all connected carriers for a lane.',
              params: [{ name: 'lane', type: 'string' }],
              returns: 'Promise<CarrierQuote[]>',
            },
          ],
        },
      ],
      types: [
        {
          id: 'carrier-quote',
          name: 'CarrierQuote',
          kind: 'value-object',
          description: 'One carrier\'s priced offer for a shipping lane.',
          fields: [
            { name: 'carrier', type: 'string', description: 'Carrier identifier.' },
            { name: 'totalCents', type: 'number', description: 'Quoted price in cents.' },
          ],
        },
      ],
    },
  }),

  // -------------------------------------------------------------------------
  // INVOKED_BY_UNDESCRIBED
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'INVOKED_BY_UNDESCRIBED',
    severity: 'warning',
    anchoredTo: 'icart_sweeper',
    expectFire: true,
    scenario:
      'The cart sweeper declares a runtime invoker but states no caller prose at all, leaving the entrypoint claim unreviewable.',
    tree: {
      subsystems: [{ id: 'commerce-maintenance', description: 'Background upkeep of commerce state.' }],
      components: [
        {
          id: 'cart-sweeper',
          componentType: 'Actor',
          description: 'Removes carts abandoned beyond the retention window.',
        },
      ],
      interfaces: [
        {
          id: 'icart_sweeper',
          component: 'cart-sweeper',
          methods: [
            {
              name: 'sweepExpiredCarts',
              description: 'Remove carts abandoned beyond the retention window.',
              invokedBy: { kind: 'runtime' },
            },
          ],
        },
      ],
      implementations: [
        {
          id: 'cart_sweeper_impl',
          contract: 'icart_sweeper',
          methods: [
            {
              name: 'sweepExpiredCarts',
              narrative: [{ stepNumber: 1, type: 'local', description: 'Delete carts whose last activity predates the retention window.' }],
            },
          ],
        },
      ],
    },
  }),
  defineRuleFixture({
    code: 'INVOKED_BY_UNDESCRIBED',
    expectFire: false,
    reason: 'The caller prose states WHO invokes the method and when, so the entrypoint claim is reviewable.',
    scenario:
      'The cart sweeper declares its runtime invoker with substantive caller prose naming the cron scheduler and its nightly window.',
    tree: {
      subsystems: [{ id: 'commerce-maintenance', description: 'Background upkeep of commerce state.' }],
      components: [
        {
          id: 'cart-sweeper',
          componentType: 'Actor',
          description: 'Removes carts abandoned beyond the retention window.',
        },
      ],
      interfaces: [
        {
          id: 'icart_sweeper',
          component: 'cart-sweeper',
          methods: [
            {
              name: 'sweepExpiredCarts',
              description: 'Remove carts abandoned beyond the retention window.',
              invokedBy: {
                kind: 'runtime',
                caller:
                  'The platform cron scheduler fires this nightly at 02:00 UTC, after the traffic trough, to clear abandoned carts.',
              },
            },
          ],
        },
      ],
      implementations: [
        {
          id: 'cart_sweeper_impl',
          contract: 'icart_sweeper',
          methods: [
            {
              name: 'sweepExpiredCarts',
              narrative: [{ stepNumber: 1, type: 'local', description: 'Delete carts whose last activity predates the retention window.' }],
            },
          ],
        },
      ],
    },
  }),

  // -------------------------------------------------------------------------
  // INVOKED_BY_REDUNDANT
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'INVOKED_BY_REDUNDANT',
    severity: 'warning',
    anchoredTo: 'iwebhook_orchestrator',
    expectFire: true,
    scenario:
      'The webhook handler declares an external invoker, but the events portal narrative already calls it, so the internal walk reaches the method and the declaration is stale.',
    tree: {
      subsystems: [{ id: 'webhooks', description: 'Inbound webhook processing from external providers.' }],
      components: [
        {
          id: 'events-portal',
          componentType: 'Portal',
          portalType: 'HTTP_API',
          description: 'HTTP ingress for provider webhook deliveries.',
          dependsOn: ['webhook-orchestrator'],
        },
        {
          id: 'webhook-orchestrator',
          componentType: 'Orchestrator',
          description: 'Processes signed webhook events from the payment provider.',
        },
      ],
      interfaces: [
        {
          id: 'ievents_portal',
          component: 'events-portal',
          methods: [{ name: 'receiveEvent', description: 'Accept a webhook delivery from the provider network.' }],
        },
        {
          id: 'iwebhook_orchestrator',
          component: 'webhook-orchestrator',
          methods: [
            {
              name: 'processEvent',
              description: 'Verify and apply one signed webhook event.',
              invokedBy: {
                kind: 'external',
                caller:
                  'The upstream payment provider POSTs signed webhook events directly to this handler during regional failover.',
              },
            },
          ],
        },
      ],
      implementations: [
        {
          id: 'events_portal_impl',
          contract: 'ievents_portal',
          methods: [
            {
              name: 'receiveEvent',
              narrative: [
                {
                  stepNumber: 1,
                  type: 'call',
                  description: 'Hand the delivery to the webhook processing workflow.',
                  targetComponent: 'webhook-orchestrator',
                  targetMethod: 'processEvent',
                },
              ],
            },
          ],
        },
        {
          id: 'webhook_orchestrator_impl',
          contract: 'iwebhook_orchestrator',
          methods: [
            {
              name: 'processEvent',
              narrative: [{ stepNumber: 1, type: 'local', description: 'Verify the signature and apply the event to the order state machine.' }],
            },
          ],
        },
      ],
    },
  }),
  defineRuleFixture({
    code: 'INVOKED_BY_REDUNDANT',
    expectFire: false,
    reason:
      'No internal narrative reaches the handler — the external provider genuinely is its only caller, so the declaration is exactly what invokedBy exists for.',
    scenario:
      'The events portal only acknowledges deliveries into an async queue, so the webhook handler\'s declared external caller is its sole entry.',
    tree: {
      subsystems: [{ id: 'webhooks', description: 'Inbound webhook processing from external providers.' }],
      components: [
        {
          id: 'events-portal',
          componentType: 'Portal',
          portalType: 'HTTP_API',
          description: 'HTTP ingress for provider webhook deliveries.',
        },
        {
          id: 'webhook-orchestrator',
          componentType: 'Orchestrator',
          description: 'Processes signed webhook events from the payment provider.',
        },
      ],
      interfaces: [
        {
          id: 'ievents_portal',
          component: 'events-portal',
          methods: [{ name: 'receiveEvent', description: 'Accept a webhook delivery from the provider network.' }],
        },
        {
          id: 'iwebhook_orchestrator',
          component: 'webhook-orchestrator',
          methods: [
            {
              name: 'processEvent',
              description: 'Verify and apply one signed webhook event.',
              invokedBy: {
                kind: 'external',
                caller:
                  'The upstream payment provider POSTs signed webhook events directly to this handler during regional failover.',
              },
            },
          ],
        },
      ],
      implementations: [
        {
          id: 'events_portal_impl',
          contract: 'ievents_portal',
          methods: [
            {
              name: 'receiveEvent',
              narrative: [{ stepNumber: 1, type: 'local', description: 'Acknowledge receipt and enqueue the delivery for the async pipeline.' }],
            },
          ],
        },
        {
          id: 'webhook_orchestrator_impl',
          contract: 'iwebhook_orchestrator',
          methods: [
            {
              name: 'processEvent',
              narrative: [{ stepNumber: 1, type: 'local', description: 'Verify the signature and apply the event to the order state machine.' }],
            },
          ],
        },
      ],
    },
  }),
];
