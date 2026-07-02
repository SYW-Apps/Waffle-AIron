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
import { buildCanvasModel, renderCanvasHtml } from '../../src/core/canvas.js';

const now = new Date().toISOString();

describe('interactive canvas generation', () => {
  let proj: string;
  afterEach(() => {
    setProjectRoot(null);
    invalidateSpecCache();
    if (proj) fs.rmSync(proj, { recursive: true, force: true });
  });

  function buildFixture() {
    proj = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-canvas-test-'));
    fs.mkdirSync(path.join(proj, '.wai', 'specs'), { recursive: true });
    setProjectRoot(proj);

    saveSystemSpec({
      schemaVersion: '1.0.0',
      name: 'CanvasSys',
      vision: 'canvas test system',
      targetLanguage: 'typescript',
      boundaries: [],
      globalRequirements: [],
      createdAt: now,
      updatedAt: now,
    });
    saveSubsystemSpec({
      id: 'billing',
      name: 'Billing',
      description: 'billing context',
      parentSystem: 'CanvasSys',
      publicInterfaces: [{ type: 'REST', details: 'api', component: 'billing-portal' }],
      trustedLinks: [{ subsystem: 'shipping', reason: 'latency fast lane' }],
      createdAt: now,
      updatedAt: now,
    });
    saveSubsystemSpec({
      id: 'shipping',
      name: 'Shipping',
      description: 'shipping context',
      parentSystem: 'CanvasSys',
      publicInterfaces: [],
      trustedLinks: [],
      createdAt: now,
      updatedAt: now,
    });

    const comp = (over: Record<string, unknown>) => ({
      id: '', name: '', description: 'd', subsystem: 'billing',
      componentType: 'Orchestrator' as const, owns: [] as string[], dependsOn: [] as string[],
      createdAt: now, updatedAt: now, ...over,
    });
    saveComponentSpec(comp({ id: 'billing-portal', name: 'Billing Portal', componentType: 'Portal', portalType: 'HTTP_API', dependsOn: ['billing-orchestrator'] }) as any);
    saveComponentSpec(comp({ id: 'billing-orchestrator', name: 'Billing Orchestrator', dependsOn: ['billing-repo'] }) as any);
    saveComponentSpec(comp({ id: 'billing-store', name: 'Billing Store', componentType: 'Store' }) as any);
    saveComponentSpec(comp({ id: 'billing-repo', name: 'Billing Repository', componentType: 'Repository', owns: ['billing-store'] }) as any);
    saveComponentSpec(comp({ id: 'shipping-client', name: 'Shipping Billing Client', subsystem: 'shipping', componentType: 'Adapter', dependsOn: ['billing-portal'] }) as any);

    saveInterfaceSpec({
      id: 'ibilling-portal', name: 'IBillingPortal', description: 'contract', component: 'billing-portal',
      methods: [{
        name: 'charge', description: 'charge', signature: 'charge(customerId: string): Promise<void>', returns: 'Promise<void>',
        params: [{ name: 'customerId', type: 'string' }],
        endpoint: { transport: 'HTTP', method: 'POST', path: '/charge' },
      }],
      createdAt: now, updatedAt: now,
    });
    saveImplementationSpec({
      id: 'billing-portal-impl', name: 'Impl', description: 'impl', contract: 'ibilling-portal',
      methods: [{
        name: 'charge',
        narrative: [{ stepNumber: 1, description: 'Dispatch', type: 'call', targetComponent: 'billing-orchestrator', targetMethod: 'process' }],
      }],
      createdAt: now, updatedAt: now,
    });
  }

  it('builds a model with containment, public marking, cross edges, and narratives', () => {
    buildFixture();
    const model = buildCanvasModel([
      { severity: 'warning', code: 'UNUSED_COMPONENT', message: 'unused', specId: 'billing-store' },
    ]);

    expect(model.system.name).toBe('CanvasSys');
    expect(model.system.targetLanguage).toBe('typescript');

    const portal = model.components.find(c => c.id === 'billing-portal')!;
    expect(portal.public).toBe(true);
    expect(portal.interfaces[0].methods[0].endpoint).toEqual({ transport: 'HTTP', method: 'POST', path: '/charge' });
    expect(portal.interfaces[0].methods[0].params).toEqual([{ name: 'customerId', type: 'string' }]);
    expect(portal.narratives[0].steps[0].call).toEqual({ component: 'billing-orchestrator', method: 'process' });
    expect(portal.narratives[0].steps[0].kind).toBe('call');

    const store = model.components.find(c => c.id === 'billing-store')!;
    expect(store.owner).toBe('billing-repo');

    const crossEdge = model.edges.find(e => e.from === 'shipping-client');
    expect(crossEdge).toEqual({ from: 'shipping-client', to: 'billing-portal', cross: true });

    const billing = model.subsystems.find(s => s.id === 'billing')!;
    expect(billing.trustedLinks).toEqual([{ subsystem: 'shipping', reason: 'latency fast lane' }]);

    expect(model.issues).toHaveLength(1);
  });

  it('renders a self-contained HTML canvas with the embedded model and no external references', () => {
    buildFixture();
    const html = renderCanvasHtml(buildCanvasModel());

    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('CanvasSys — architecture canvas');
    expect(html).toContain('var MODEL = ');
    expect(html).toContain('billing-orchestrator');
    // cytoscape is embedded inline (vendored), not fetched
    expect(html).toContain('Cytoscape Consortium');
    // strictly self-contained: no external URLs of any kind
    expect(html).not.toMatch(/src\s*=\s*["']https?:/);
    expect(html).not.toMatch(/href\s*=\s*["']https?:/);
    // script-injection safety: embedded JSON cannot close the script tag
    expect(html.split('var MODEL = ')[1].split('\n')[0]).not.toContain('</script>');
  });
});
