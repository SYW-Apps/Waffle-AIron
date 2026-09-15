import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as yaml from 'js-yaml';
import { validateSddTree } from '../../src/core/validation.js';
import type { ValidationIssue } from '../../src/core/validation.js';
import { invalidateSpecCache } from '../../src/core/specs.js';
import { setProjectRoot } from '../../src/utils/fs.js';
import type { RulesConfig } from '../../src/models/project.js';

// ---------------------------------------------------------------------------
// Wiring-family fixes: one reproduction per reported misbehaviour in the
// wiring rules (dependency cycles, unused detection, untyped seams, prose
// claims, invariant backing, event topology, dispatch tables). Each tree is a
// real .wai project validated through validateSddTree, as the CLI does.
// ---------------------------------------------------------------------------

const STAMP = { createdAt: '2026-09-15T00:00:00Z', updatedAt: '2026-09-15T00:00:00Z' };
const RULES: RulesConfig = {
  noOverlappingOwnership: true,
  requireOwnedPaths: true,
  metaAgentTags: ['meta'],
  enforceReproducibility: true,
};

type Spec = Record<string, unknown>;

function createProject() {
  invalidateSpecCache();
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-wiring-fixes-')));
  const specs = path.join(root, '.wai', 'specs');
  for (const d of ['subsystems', 'components', 'interfaces', 'implementations', 'types']) {
    fs.mkdirSync(path.join(specs, d), { recursive: true });
  }
  const dump = (file: string, data: unknown) => fs.writeFileSync(file, yaml.dump(data, { noRefs: true, lineWidth: 200 }));
  dump(path.join(root, '.wai', 'project.yaml'), {
    schemaVersion: '1.0.0',
    name: 'wiring-fixes',
    targets: [{ type: 'claude', outputDir: '.claude/agents', enabled: true }],
    rules: RULES,
    extensions: { packs: [], useGlobalPacks: false },
    ...STAMP,
  });
  dump(path.join(specs, '.index.yaml'), { schemaVersion: '1.0.0', name: 'TestSystem', vision: 'Exercises the wiring rules.', ...STAMP });
  const write = (dir: string, id: string, data: Spec) =>
    dump(path.join(specs, dir, `${id}.yaml`), { schemaVersion: '1.0.0', ...data, ...STAMP });

  return {
    subsystem: (id: string, extra: Spec = {}) =>
      write('subsystems', id, { id, name: id, description: `The ${id} subsystem.`, parentSystem: 'TestSystem', ...extra }),
    component: (id: string, subsystem: string, componentType: string, extra: Spec = {}) =>
      write('components', id, { id, name: id, description: `The ${id} component.`, subsystem, componentType, dependsOn: [], owns: [], ...extra }),
    contract: (id: string, component: string, methods: Spec[], extra: Spec = {}) =>
      write('interfaces', id, {
        id,
        name: id,
        description: `A contract of ${component}.`,
        component,
        methods: methods.map(m => ({
          description: `${String(m.name)} does its one job, observably and carefully.`,
          signature: `${String(m.name)}(): void`,
          returns: 'void',
          ...m,
        })),
        ...extra,
      }),
    impl: (id: string, contract: string, methods: Spec[], extra: Spec = {}) =>
      write('implementations', id, { id, name: id, description: `Realizes ${contract}.`, contract, methods, ...extra }),
    entity: (id: string, extra: Spec) =>
      write('types', id, { kind: 'entity', id, name: id, description: `The ${id} entity.`, ...extra }),
    validate: (opts: { scopeSubsystem?: string } = {}) => {
      invalidateSpecCache();
      setProjectRoot(root);
      try {
        return validateSddTree({ rules: RULES, projectType: 'backend', ...opts });
      } finally {
        setProjectRoot(null);
        invalidateSpecCache();
      }
    },
    cleanup: () => {
      try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* win file locks */ }
    },
  };
}

type Project = ReturnType<typeof createProject>;

const withCode = (res: { issues: ValidationIssue[] }, code: string) => res.issues.filter(i => i.code === code);

function inProject(build: (proj: Project) => void, check: (proj: Project) => void): void {
  const proj = createProject();
  try {
    build(proj);
    check(proj);
  } finally {
    proj.cleanup();
  }
}

// ---------------------------------------------------------------------------
// dependency-cycles
// ---------------------------------------------------------------------------

describe('dependency-cycles — a scoped run reports the cycles of its scope', () => {
  it('reports an in-scope cycle although an out-of-scope cycle comes first in the search', () => {
    inProject(proj => {
      proj.subsystem('accounting');
      proj.subsystem('shipping');
      proj.component('accounting-journal-orch', 'accounting', 'Orchestrator', { dependsOn: ['accounting-posting-orch'] });
      proj.component('accounting-posting-orch', 'accounting', 'Orchestrator', { dependsOn: ['accounting-journal-orch'] });
      proj.component('shipping-label-orch', 'shipping', 'Orchestrator', { dependsOn: ['shipping-quote-orch'] });
      proj.component('shipping-quote-orch', 'shipping', 'Orchestrator', { dependsOn: ['shipping-label-orch'] });
    }, proj => {
      const cycles = withCode(proj.validate({ scopeSubsystem: 'shipping' }), 'CIRCULAR_DEPENDENCY');
      expect(cycles).toHaveLength(1);
      expect(cycles[0].specId).toMatch(/^shipping-/);
      expect(cycles[0].message).toMatch(/shipping-(label|quote)-orch -> shipping-(quote|label)-orch -> shipping-(label|quote)-orch/);
    });
  });

  it('reports a cycle that passes through the scope even when the search closes an out-of-scope cycle on the way', () => {
    inProject(proj => {
      proj.subsystem('catalog');
      proj.subsystem('pricing');
      // catalog-facade <-> catalog-indexer is catalog's own cycle; catalog-facade ->
      // pricing-rules -> catalog-indexer -> catalog-facade runs through pricing.
      proj.component('catalog-facade', 'catalog', 'Orchestrator', { dependsOn: ['catalog-indexer', 'pricing-rules'] });
      proj.component('catalog-indexer', 'catalog', 'Orchestrator', { dependsOn: ['catalog-facade'] });
      proj.component('pricing-rules', 'pricing', 'Orchestrator', { dependsOn: ['catalog-indexer'] });
    }, proj => {
      const cycles = withCode(proj.validate({ scopeSubsystem: 'pricing' }), 'CIRCULAR_DEPENDENCY');
      expect(cycles).toHaveLength(1);
      expect(cycles[0].specId).toBe('pricing-rules');
      expect(cycles[0].message).toContain('pricing-rules -> catalog-indexer -> catalog-facade -> pricing-rules');
    });
  });

  it('an unscoped run still reports only the first cycle, with its full path', () => {
    inProject(proj => {
      proj.subsystem('accounting');
      proj.component('accounting-journal-orch', 'accounting', 'Orchestrator', { dependsOn: ['accounting-posting-orch'] });
      proj.component('accounting-posting-orch', 'accounting', 'Orchestrator', { dependsOn: ['accounting-journal-orch'] });
      proj.component('accounting-ledger-orch', 'accounting', 'Orchestrator', { dependsOn: ['accounting-close-orch'] });
      proj.component('accounting-close-orch', 'accounting', 'Orchestrator', { dependsOn: ['accounting-ledger-orch'] });
    }, proj => {
      const cycles = withCode(proj.validate(), 'CIRCULAR_DEPENDENCY');
      expect(cycles).toHaveLength(1);
      expect(cycles[0].severity).toBe('error');
    });
  });
});

// ---------------------------------------------------------------------------
// unused-detection
// ---------------------------------------------------------------------------

// returns-portal.openReturn calls refund-orch.issueRefund; refund-orch's second
// contract (irefund-admin) declares voidRefund, which nothing calls, and
// reconcileRefunds, whose invokedBy states no caller; restock-orch is unreached.
function returnsDesk(proj: Project, subsystemExtra: Spec = {}) {
  proj.subsystem('returns-desk', subsystemExtra);
  proj.component('returns-portal', 'returns-desk', 'Portal', { portalType: 'Custom', dependsOn: ['refund-orch'] });
  proj.component('refund-orch', 'returns-desk', 'Orchestrator');
  proj.component('restock-orch', 'returns-desk', 'Orchestrator', { dependencyClass: 'pure' });
  proj.contract('ireturns-portal', 'returns-portal', [{ name: 'openReturn' }]);
  proj.contract('irefund-orch', 'refund-orch', [{ name: 'issueRefund' }]);
  proj.contract('irefund-admin', 'refund-orch', [{ name: 'voidRefund' }, { name: 'reconcileRefunds', invokedBy: { kind: 'runtime' } }]);
  proj.contract('irestock-orch', 'restock-orch', [{ name: 'restock' }]);
  proj.impl('returns-portal-impl', 'ireturns-portal', [{
    name: 'openReturn',
    narrative: [{ stepNumber: 1, type: 'call', description: 'Hand the return to the refund workflow', targetComponent: 'refund-orch', targetMethod: 'issueRefund' }],
  }]);
}

describe('unused-detection — draft context and anchors', () => {
  it('a draft subsystem is draft context for UNUSED_COMPONENT, UNUSED_METHOD and INVOKED_BY_UNDESCRIBED', () => {
    inProject(proj => returnsDesk(proj, { status: 'draft' }), proj => {
      const res = proj.validate();
      const unusedComponent = withCode(res, 'UNUSED_COMPONENT').find(i => i.specId === 'restock-orch');
      const unusedMethod = withCode(res, 'UNUSED_METHOD').find(i => i.message.includes('"voidRefund"'));
      const undescribed = withCode(res, 'INVOKED_BY_UNDESCRIBED').find(i => i.message.includes('"reconcileRefunds"'));
      expect(unusedComponent?.draftContext).toBe(true);
      expect(unusedMethod?.draftContext).toBe(true);
      expect(undescribed?.draftContext).toBe(true);
    });
  });

  it('a complete subsystem is not draft context for the same findings', () => {
    inProject(proj => returnsDesk(proj), proj => {
      const res = proj.validate();
      expect(withCode(res, 'UNUSED_COMPONENT').find(i => i.specId === 'restock-orch')?.draftContext).toBeUndefined();
      expect(withCode(res, 'UNUSED_METHOD').find(i => i.message.includes('"voidRefund"'))?.draftContext).toBeUndefined();
    });
  });

  it('UNUSED_METHOD is reported on the interface that declares the method, like INVOKED_BY_*', () => {
    inProject(proj => returnsDesk(proj), proj => {
      const unused = withCode(proj.validate(), 'UNUSED_METHOD').filter(i => i.message.includes('"voidRefund"'));
      expect(unused).toHaveLength(1);
      expect(unused[0].specId).toBe('irefund-admin');
    });
  });
});

// ---------------------------------------------------------------------------
// untyped-seams
// ---------------------------------------------------------------------------

function partnerApi(proj: Project, methods: Spec[]) {
  proj.subsystem('partner-api', { publicInterfaces: [{ type: 'Custom', details: 'Partner claim ingress', component: 'partner-portal' }] });
  proj.component('partner-portal', 'partner-api', 'Portal', { portalType: 'Custom' });
  proj.contract('ipartner-portal', 'partner-portal', methods);
}

describe('untyped-seams — every published method is judged, prose signatures included', () => {
  it('flags a published method whose prose signature takes a bare Json, without structured params', () => {
    inProject(proj => partnerApi(proj, [
      { name: 'submitClaim', signature: 'submitClaim(claim: Json): string', returns: 'string' },
      { name: 'lookupClaim', signature: 'lookupClaim(claimId: string): string', returns: 'string' },
    ]), proj => {
      const seams = withCode(proj.validate(), 'UNTYPED_SEAM');
      expect(seams).toHaveLength(1);
      expect(seams[0].specId).toBe('ipartner-portal');
      expect(seams[0].message).toContain('Method "submitClaim"');
    });
  });

  it('a prose signature and the same structured params reach the same verdict', () => {
    inProject(proj => partnerApi(proj, [
      { name: 'proseBag', signature: 'proseBag(options: object): string', returns: 'string' },
      { name: 'structuredBag', signature: 'structuredBag(options: object): string', returns: 'string', params: [{ name: 'options', type: 'object' }] },
      { name: 'proseTyped', signature: 'proseTyped(claimId: string): string', returns: 'string' },
      { name: 'structuredTyped', signature: 'structuredTyped(claimId: string): string', returns: 'string', params: [{ name: 'claimId', type: 'string' }] },
    ]), proj => {
      const flagged = withCode(proj.validate(), 'UNTYPED_SEAM').map(i => /Method "(\w+)"/.exec(i.message)?.[1]).sort();
      expect(flagged).toEqual(['proseBag', 'structuredBag']);
    });
  });
});

// ---------------------------------------------------------------------------
// prose-claims
// ---------------------------------------------------------------------------

describe('prose-claims — phrasings, register edges and quoted values', () => {
  it('"persisting" and "persistence" are persistence claims', () => {
    inProject(proj => {
      proj.subsystem('cart');
      proj.component('cart-orch', 'cart', 'Orchestrator');
      proj.contract('icart-orch', 'cart-orch', [{ name: 'checkpointCart' }, { name: 'describeCart' }]);
      proj.impl('cart-orch-impl', 'icart-orch', [
        { name: 'checkpointCart', narrative: [{ stepNumber: 1, type: 'local', description: 'Keep persisting the cart checkpoint between shopper sessions' }] },
        { name: 'describeCart', detail: 'intent', intent: 'Owns the persistence of the shopper cart across sessions and devices, returning the current lines.', narrative: [] },
      ]);
    }, proj => {
      const claims = withCode(proj.validate(), 'UNREALIZED_CLAIM').map(i => i.message);
      expect(claims.some(m => m.includes('"persisting"'))).toBe(true);
      expect(claims.some(m => m.includes('"persistence"'))).toBe(true);
    });
  });

  it('a register step handing a data-layer method to the runtime is a structural edge', () => {
    inProject(proj => {
      proj.subsystem('sessions');
      proj.component('session-orch', 'sessions', 'Orchestrator', { dependsOn: ['session-store'] });
      proj.component('session-store', 'sessions', 'Store', { durability: 'read-through' });
      proj.contract('isession-orch', 'session-orch', [{ name: 'startSession' }]);
      proj.contract('isession-store', 'session-store', [{ name: 'flush', effect: 'write' }]);
      proj.impl('session-orch-impl', 'isession-orch', [{
        name: 'startSession',
        narrative: [
          { stepNumber: 1, type: 'local', description: 'The open session is persisted whenever the runtime flushes' },
          { stepNumber: 2, type: 'register', description: 'Hand the store flush to the runtime shutdown hook', targetComponent: 'session-store', targetMethod: 'flush' },
        ],
      }]);
    }, proj => {
      expect(withCode(proj.validate(), 'UNREALIZED_CLAIM')).toEqual([]);
    });
  });

  it('a claim phrase inside quotes or backticks names a value and is not a claim; an apostrophe does not open a quote', () => {
    inProject(proj => {
      proj.subsystem('settings');
      proj.component('settings-orch', 'settings', 'Orchestrator');
      proj.contract('isettings-orch', 'settings-orch', [{ name: 'describeMode' }, { name: 'applySettings' }]);
      proj.impl('settings-orch-impl', 'isettings-orch', [
        {
          name: 'describeMode',
          narrative: [
            { stepNumber: 1, type: 'local', description: 'Set the durability mode to "durable" on the new store record' },
            { stepNumber: 2, type: 'local', description: "Reply with the message 'Settings persisted' to the operator" },
            { stepNumber: 3, type: 'local', description: 'Show the `persisted` flag in the audit view' },
            { stepNumber: 4, type: 'local', description: "The store's mode becomes 'durable' for the operator's view" },
          ],
        },
        {
          name: 'applySettings',
          narrative: [{ stepNumber: 1, type: 'local', description: "The operator's settings are persisted for the next boot" }],
        },
      ]);
    }, proj => {
      const claims = withCode(proj.validate(), 'UNREALIZED_CLAIM');
      expect(claims).toHaveLength(1);
      expect(claims[0].message).toContain('"applySettings"');
    });
  });
});

// ---------------------------------------------------------------------------
// invariant-backing
// ---------------------------------------------------------------------------

const SLUG_UNIQUE = { id: 'slug-unique', description: 'A unit slug is unique among the children of its parent unit.' };

describe('invariant-backing — draft context', () => {
  it('DUPLICATE_INVARIANT_ID and a no-owner INVARIANT_UNANCHORED carry the entity\'s draft subsystem as draft context', () => {
    inProject(proj => {
      proj.subsystem('org-chart', { status: 'draft' });
      proj.entity('org-unit', { subsystem: 'org-chart', invariants: [SLUG_UNIQUE, SLUG_UNIQUE] });
    }, proj => {
      const res = proj.validate();
      expect(withCode(res, 'DUPLICATE_INVARIANT_ID')[0]?.draftContext).toBe(true);
      expect(withCode(res, 'INVARIANT_UNANCHORED')[0]?.draftContext).toBe(true);
    });
  });

  it('the draft entity is draft context for the owner-side findings too', () => {
    inProject(proj => {
      proj.subsystem('org-drafts', { status: 'draft' });
      proj.subsystem('org-core');
      proj.component('unit-registry', 'org-core', 'Registry');
      proj.component('member-registry', 'org-core', 'Registry');
      proj.contract('iunit-registry', 'unit-registry', [{ name: 'createUnit', effect: 'write' }]);
      proj.contract('imember-registry', 'member-registry', [{ name: 'listMembers', effect: 'read' }]);
      proj.impl('unit-registry-impl', 'iunit-registry', [
        { name: 'createUnit', narrative: [{ stepNumber: 1, type: 'local', description: 'Record the unit under its parent' }] },
      ]);
      proj.entity('org-unit', { subsystem: 'org-drafts', componentClass: 'unit-registry', invariants: [SLUG_UNIQUE] });
      proj.entity('org-member', { subsystem: 'org-drafts', componentClass: 'member-registry', invariants: [{ id: 'one-home-unit', description: 'A member belongs to exactly one home unit at a time.' }] });
    }, proj => {
      const res = proj.validate();
      expect(withCode(res, 'UNASSERTED_INVARIANT')[0]?.draftContext).toBe(true);
      expect(withCode(res, 'INVARIANT_UNANCHORED').find(i => i.specId === 'org-member')?.draftContext).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// event-topology
// ---------------------------------------------------------------------------

describe('event-topology — one finding per topic per component', () => {
  it('a topic both declared and bound to a MessageBus endpoint on one component reports once, naming both', () => {
    inProject(proj => {
      proj.subsystem('orders');
      proj.component('order-events-portal', 'orders', 'Portal', {
        portalType: 'MessageBus',
        emits: [{ topic: 'orders.placed', event: 'OrderPlaced' }],
      });
      proj.component('settlement-portal', 'orders', 'Portal', {
        portalType: 'MessageBus',
        subscribesTo: [{ topic: 'payments.settled', event: 'PaymentSettled' }],
      });
      proj.contract('iorder-events-portal', 'order-events-portal', [{
        name: 'announceOrder',
        endpoint: { transport: 'MessageBus', topic: 'orders.placed', event: 'OrderPlaced', direction: 'publish' },
      }]);
      proj.contract('isettlement-portal', 'settlement-portal', [{
        name: 'onPaymentSettled',
        endpoint: { transport: 'MessageBus', topic: 'payments.settled', event: 'PaymentSettled', direction: 'subscribe' },
      }]);
    }, proj => {
      const res = proj.validate();
      const unconsumed = withCode(res, 'UNCONSUMED_TOPIC');
      expect(unconsumed).toHaveLength(1);
      expect(unconsumed[0].message).toContain('emits declaration');
      expect(unconsumed[0].message).toContain('MessageBus endpoint on iorder-events-portal.announceOrder');
      const unsourced = withCode(res, 'UNSOURCED_SUBSCRIPTION');
      expect(unsourced).toHaveLength(1);
      expect(unsourced[0].message).toContain('subscribesTo declaration');
      expect(unsourced[0].message).toContain('MessageBus endpoint on isettlement-portal.onPaymentSettled');
    });
  });
});

// ---------------------------------------------------------------------------
// dispatch-tables
// ---------------------------------------------------------------------------

describe('dispatch-tables — no guarantee finding against a method that does not exist', () => {
  it('a dispatch step asserting a guarantee on an unserved binding reports only UNSERVED_CAPABILITY', () => {
    inProject(proj => {
      proj.subsystem('payments');
      proj.component('payments-portal', 'payments', 'Portal', {
        portalType: 'Custom',
        dependsOn: ['charge-executor'],
        dispatch: [
          { capability: 'payment.capture', component: 'charge-executor', method: 'captureCharge' },
          { capability: 'payment.refund', component: 'refund-executor', method: 'refundCharge' },
        ],
      });
      proj.component('charge-executor', 'payments', 'Orchestrator', { dependencyClass: 'pure' });
      proj.component('payment-orch', 'payments', 'Orchestrator', { dependsOn: ['payments-portal'] });
      proj.contract('icharge-executor', 'charge-executor', [{ name: 'authorizeCharge' }]);
      proj.contract('ipayment-orch', 'payment-orch', [{ name: 'capturePayment' }]);
      proj.impl('payment-orch-impl', 'ipayment-orch', [{
        name: 'capturePayment',
        narrative: [
          { stepNumber: 1, type: 'dispatch', description: 'Capture the charge through the portal', targetComponent: 'payments-portal', capability: 'payment.capture', assertsGuarantees: ['idempotent'] },
          { stepNumber: 2, type: 'dispatch', description: 'Refund the charge through the portal', targetComponent: 'payments-portal', capability: 'payment.refund', assertsGuarantees: ['idempotent'] },
        ],
      }]);
    }, proj => {
      const res = proj.validate();
      const unserved = withCode(res, 'UNSERVED_CAPABILITY').map(i => i.message).join('\n');
      expect(unserved).toContain('captureCharge');
      expect(unserved).toContain('refund-executor');
      expect(withCode(res, 'NARRATIVE_SEMANTIC_UNBACKED')).toEqual([]);
    });
  });
});
