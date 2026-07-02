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
});
