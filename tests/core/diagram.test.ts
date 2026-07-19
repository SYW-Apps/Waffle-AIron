import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { setProjectRoot } from '../../src/utils/fs.js';
import {
  saveSystemSpec,
  saveSubsystemSpec,
  saveComponentSpec,
  saveInterfaceSpec,
  saveImplementationSpec,
  invalidateSpecCache,
} from '../../src/core/specs.js';
import {
  generateComponentDiagram,
  generateSequenceDiagram,
  generateDiagramSet,
} from '../../src/core/diagram.js';

const now = new Date().toISOString();

describe('diagram generation from the spec tree', () => {
  let proj: string;
  afterEach(() => {
    setProjectRoot(null);
    invalidateSpecCache();
    if (proj) fs.rmSync(proj, { recursive: true, force: true });
  });

  function buildFixture() {
    proj = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-diagram-test-'));
    fs.mkdirSync(path.join(proj, '.wai', 'specs'), { recursive: true });
    setProjectRoot(proj);

    saveSystemSpec({
      schemaVersion: '1.0.0',
      name: 'DiagramSys',
      vision: 'test',
      boundaries: [],
      globalRequirements: [],
      createdAt: now,
      updatedAt: now,
    });
    saveSubsystemSpec({
      id: 'billing',
      name: 'Billing',
      description: 'billing',
      parentSystem: 'DiagramSys',
      publicInterfaces: [{ type: 'REST', details: 'api', component: 'billing-portal' }],
      createdAt: now,
      updatedAt: now,
    });
    saveSubsystemSpec({
      id: 'shipping',
      name: 'Shipping',
      description: 'shipping',
      parentSystem: 'DiagramSys',
      publicInterfaces: [],
      createdAt: now,
      updatedAt: now,
    });

    const comp = (over: Record<string, unknown>) => ({
      id: '',
      name: '',
      description: 'd',
      subsystem: 'billing',
      componentType: 'Orchestrator' as const,
      owns: [] as string[],
      dependsOn: [] as string[],
      createdAt: now,
      updatedAt: now,
      ...over,
    });

    saveComponentSpec(comp({ id: 'billing-portal', name: 'Billing Portal', componentType: 'Portal', portalType: 'HTTP_API', dependsOn: ['billing-orchestrator'] }) as any);
    saveComponentSpec(comp({ id: 'billing-orchestrator', name: 'Billing Orchestrator', componentType: 'Orchestrator', dependsOn: ['billing-repo'] }) as any);
    saveComponentSpec(comp({ id: 'billing-store', name: 'Billing Store', componentType: 'Store' }) as any);
    saveComponentSpec(comp({ id: 'billing-repo', name: 'Billing Repository', componentType: 'Repository', owns: ['billing-store'] }) as any);
    saveComponentSpec(comp({ id: 'billing-client', name: 'Billing Client', subsystem: 'shipping', componentType: 'Adapter', dependsOn: ['billing-portal'] }) as any);

    saveInterfaceSpec({
      id: 'ibilling-portal',
      name: 'IBillingPortal',
      description: 'contract',
      component: 'billing-portal',
      methods: [{ name: 'authorize', description: 'auth', signature: 'authorize(): void', returns: 'void', endpoint: { transport: 'HTTP', method: 'POST', path: '/authorize' } }],
      createdAt: now,
      updatedAt: now,
    });
    saveInterfaceSpec({
      id: 'ibilling-orchestrator',
      name: 'IBillingOrchestrator',
      description: 'contract',
      component: 'billing-orchestrator',
      methods: [{ name: 'process', description: 'process', signature: 'process(): void', returns: 'void' }],
      createdAt: now,
      updatedAt: now,
    });

    saveImplementationSpec({
      id: 'billing-portal-impl',
      name: 'Portal Impl',
      description: 'impl',
      contract: 'ibilling-portal',
      methods: [{
        name: 'authorize',
        narrative: [
          { stepNumber: 1, description: 'Dispatch to workflow', type: 'call', targetComponent: 'billing-orchestrator', targetMethod: 'process' },
        ],
      }],
      createdAt: now,
      updatedAt: now,
    });
    saveImplementationSpec({
      id: 'billing-orchestrator-impl',
      name: 'Orchestrator Impl',
      description: 'impl',
      contract: 'ibilling-orchestrator',
      methods: [{
        name: 'process',
        narrative: [
          { stepNumber: 1, description: 'Validate the request payload', type: 'local' },
          { stepNumber: 2, description: 'Persist via repository', type: 'call', targetComponent: 'billing-repo', targetMethod: 'save' },
        ],
      }],
      createdAt: now,
      updatedAt: now,
    });
  }

  it('renders a component diagram with subgraphs, stereotype shapes, owns and boundary edges', () => {
    buildFixture();
    const mmd = generateComponentDiagram();

    expect(mmd).toContain('flowchart LR');
    expect(mmd).toContain('subgraph');
    expect(mmd).toContain('Billing Portal<br/>«Portal»');
    // owns → dashed containment edge
    expect(mmd).toMatch(/billing_repo -\. owns \.-> billing_store/);
    // cross-subsystem dependency → thick edge
    expect(mmd).toMatch(/billing_client ==> billing_portal/);
    // same-subsystem dependency → normal edge
    expect(mmd).toMatch(/billing_portal --> billing_orchestrator/);
    // stereotype classes + public surface marking
    expect(mmd).toContain('classDef entry');
    expect(mmd).toMatch(/class .*billing_portal.* publicSurface/);
  });

  it('scopes a component diagram to a subsystem plus its external neighbors', () => {
    buildFixture();
    const mmd = generateComponentDiagram({ subsystem: 'shipping' });
    expect(mmd).toContain('Billing Client');
    // neighbor from the other subsystem is present for boundary context…
    expect(mmd).toContain('Billing Portal');
    // …but unrelated internals of the other subsystem are not
    expect(mmd).not.toContain('Billing Store');
  });

  it('renders a sequence diagram from L5 narratives with recursive call expansion', () => {
    buildFixture();
    const mmd = generateSequenceDiagram('billing-portal', 'authorize');

    expect(mmd).toContain('sequenceDiagram');
    expect(mmd).toContain('participant billing_portal as Billing Portal «Portal»');
    // expanded call (activation) into the orchestrator narrative
    expect(mmd).toMatch(/billing_portal->>\+billing_orchestrator: process\(\)/);
    // the orchestrator's local step appears as a note
    expect(mmd).toContain('Note over billing_orchestrator: Validate the request payload');
    // non-expandable call (no narrative on repo) renders as a plain arrow
    expect(mmd).toMatch(/billing_orchestrator->>billing_repo: save\(\)/);
    // return edge closes the activation
    expect(mmd).toMatch(/billing_orchestrator-->>-billing_portal: return/);
  });

  it('generates the full diagram set with an entry per subsystem and per entrypoint narrative', () => {
    buildFixture();
    const files = generateDiagramSet();
    const paths = files.map(f => f.relPath);

    expect(paths).toContain('system.md');
    expect(paths).toContain('subsystems/billing.md');
    expect(paths).toContain('sequences/billing-portal.authorize.md');
  });

  it('fails clearly when the method has no narrative yet', () => {
    buildFixture();
    expect(() => generateSequenceDiagram('billing-store', 'save')).toThrow(/No L4 narrative/);
  });

  it('renders flow structures: loop/try as Mermaid blocks, branch/return as annotated markers', () => {
    buildFixture();
    saveImplementationSpec({
      id: 'billing-orchestrator-impl',
      name: 'Orchestrator Impl',
      description: 'impl',
      contract: 'ibilling-orchestrator',
      methods: [{
        name: 'process',
        narrative: [
          { stepNumber: 1, description: 'request is valid', type: 'branch', condition: 'payload valid', onFalseStep: 6 },
          { stepNumber: 2, description: 'guard persistence', type: 'try', endStep: 4, catches: [{ error: 'StoreError', step: 5 }] },
          { stepNumber: 3, description: 'retry each pending item', type: 'loop', loopKind: 'forEach', over: 'pending items', endStep: 4 },
          { stepNumber: 4, description: 'persist one', type: 'call', targetComponent: 'billing-repo', targetMethod: 'save' },
          { stepNumber: 5, description: 'persistence failed', type: 'throw', error: 'StoreError' },
          { stepNumber: 6, description: 'reject the request', type: 'return', outcome: 'invalid' },
        ],
      }],
      createdAt: now,
      updatedAt: now,
    } as any);
    invalidateSpecCache();

    const mmd = generateSequenceDiagram('billing-orchestrator', 'process');
    expect(mmd).toContain('◇ if payload valid — else → step 6');
    expect(mmd).toContain('critical guard persistence');
    expect(mmd).toContain('loop pending items');
    expect(mmd).toMatch(/billing_orchestrator->>billing_repo: save\(\)/);
    expect(mmd).toContain('⚠ on StoreError → step 5');
    expect(mmd).toContain('⚡ throw StoreError');
    expect(mmd).toContain('⏎ return — invalid');
    // both regions (try + loop) end at step 4 → two closing `end` lines
    expect(mmd.split('\n').filter(l => l.trim() === 'end')).toHaveLength(2);
  });

  it('renders parallel regions as par/and fragments and detached calls as async arrows with no return', () => {
    buildFixture();
    // An expandable detached target: the notifier has its own narrative, so
    // the walk can prove no activation/return is emitted for detached calls.
    saveComponentSpec({
      id: 'billing-notifier', name: 'Billing Notifier', description: 'd', subsystem: 'billing',
      componentType: 'Actor', owns: [], dependsOn: [], createdAt: now, updatedAt: now,
    } as any);
    saveInterfaceSpec({
      id: 'ibilling-notifier',
      name: 'IBillingNotifier',
      description: 'contract',
      component: 'billing-notifier',
      methods: [{ name: 'send', description: 'send', signature: 'send(): void', returns: 'void' }],
      createdAt: now,
      updatedAt: now,
    });
    saveImplementationSpec({
      id: 'billing-notifier-impl',
      name: 'Notifier Impl',
      description: 'impl',
      contract: 'ibilling-notifier',
      methods: [{
        name: 'send',
        narrative: [{ stepNumber: 1, description: 'Deliver the notification', type: 'local' }],
      }],
      createdAt: now,
      updatedAt: now,
    });
    saveImplementationSpec({
      id: 'billing-orchestrator-impl',
      name: 'Orchestrator Impl',
      description: 'impl',
      contract: 'ibilling-orchestrator',
      methods: [{
        name: 'process',
        narrative: [
          { stepNumber: 1, description: 'Validate the request', type: 'local' },
          { stepNumber: 2, description: 'Fan out side effects', type: 'parallel', endStep: 6, branches: [{ step: 3, name: 'notify' }, { step: 5, name: 'audit' }] },
          { stepNumber: 3, description: 'Fire the notification', type: 'call', targetComponent: 'billing-notifier', targetMethod: 'send', detach: true },
          { stepNumber: 4, description: 'Format the receipt', type: 'local' },
          { stepNumber: 5, description: 'Persist the audit record', type: 'call', targetComponent: 'billing-repo', targetMethod: 'save' },
          { stepNumber: 6, description: 'Record the audit trail', type: 'local' },
          { stepNumber: 7, description: 'done', type: 'return', outcome: 'done' },
        ],
      }],
      createdAt: now,
      updatedAt: now,
    } as any);
    invalidateSpecCache();

    const mmd = generateSequenceDiagram('billing-orchestrator', 'process');
    // par fragment opens at the header (first arm's name folded into the label)…
    expect(mmd).toContain('par Fan out side effects — notify');
    // …the second arm's entry starts its `and` block…
    expect(mmd).toContain('and audit');
    // …and the region closes exactly once after endStep.
    expect(mmd.split('\n').filter(l => l.trim() === 'end')).toHaveLength(1);
    // Detached call: async OPEN arrow, annotated, no activation…
    expect(mmd).toMatch(/billing_orchestrator-\)billing_notifier: send\(\) — detached/);
    expect(mmd).not.toContain('->>+billing_notifier');
    // …still expanded (the callee's own steps show)…
    expect(mmd).toContain('Note over billing_notifier: Deliver the notification');
    // …but NO return arrow — failure does not propagate to the caller's flow.
    expect(mmd).not.toContain('billing_notifier-->>-');
    // The synchronous arm call is unchanged.
    expect(mmd).toMatch(/billing_orchestrator->>billing_repo: save\(\)/);
  });
});
