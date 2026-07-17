import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runWithProjectRoot } from '../../src/utils/fs.js';
import { invalidateSpecCache } from '../../src/core/specs.js';
import { seedDemoTree, DEMO_SYSTEM_NAME } from '../../src/core/demo-seed.js';
import { buildCanvasModel, type CanvasModel } from '../../src/core/canvas.js';
import { runHostDemo } from '../../src/commands/host.js';
import { existingProjectRoot } from '../../src/server/projects.js';

// ---------------------------------------------------------------------------
// The demo-project seeder writes a rich, multi-layer example spec tree so the
// architecture canvas renders substantial content. These tests assert the
// seeded tree yields a fully-populated CanvasModel across all three views
// (components, the type ERD, and narrative flow), both when seeded directly and
// when driven through the `wairon host demo` command.
// ---------------------------------------------------------------------------

function stepKinds(model: CanvasModel, componentId: string, method: string): string[] {
  const comp = model.components.find((c) => c.id === componentId)!;
  const narr = comp.narratives.find((n) => n.method === method)!;
  return narr.steps.map((s) => s.kind);
}

describe('demo-project seeder', () => {
  const cleanups: string[] = [];
  const savedEnv = { ...process.env };

  afterEach(() => {
    invalidateSpecCache();
    process.env = { ...savedEnv };
    for (const dir of cleanups.splice(0)) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* windows file locks */
      }
    }
  });

  function seedInto(): CanvasModel {
    const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-demo-seed-'));
    cleanups.push(proj);
    fs.mkdirSync(path.join(proj, '.wai', 'specs'), { recursive: true });
    return runWithProjectRoot(proj, () => {
      seedDemoTree();
      return buildCanvasModel();
    });
  }

  it('fills the component view: 3 subsystems, a full layered slice, and cross-subsystem edges', () => {
    const model = seedInto();

    expect(model.system.name).toBe(DEMO_SYSTEM_NAME);
    expect(model.subsystems.map((s) => s.id).sort()).toEqual(['catalog', 'ordering', 'payments']);
    expect(model.components).toHaveLength(22);

    // A Repository owns exactly its Store + Registry + Index.
    const repo = model.components.find((c) => c.id === 'product-repo')!;
    expect(repo.componentType).toBe('Repository');
    expect(repo.owns.sort()).toEqual(['product-index', 'product-registry', 'product-store']);
    // Members carry their owner back-reference.
    expect(model.components.find((c) => c.id === 'product-store')!.owner).toBe('product-repo');

    // Layering: the Portal depends only on the Orchestrator (never a Store/Repo directly).
    const portal = model.components.find((c) => c.id === 'catalog-portal')!;
    expect(portal.dependsOn).toEqual(['catalog-orchestrator']);
    expect(portal.public).toBe(true);

    // Two cross-subsystem edges: a client Adapter → another subsystem's published Portal.
    const crossEdges = model.edges.filter((e) => e.cross);
    expect(crossEdges).toEqual(
      expect.arrayContaining([
        { from: 'catalog-client', to: 'catalog-portal', cross: true },
        { from: 'payments-client', to: 'payments-portal', cross: true },
      ]),
    );
  });

  it('fills the interface details: methods with structured params, returns, and HTTP endpoints', () => {
    const model = seedInto();
    const portal = model.components.find((c) => c.id === 'ordering-portal')!;
    const place = portal.interfaces[0].methods.find((m) => m.name === 'placeOrder')!;
    expect(place.params).toEqual([
      { name: 'customerId', type: 'string' },
      { name: 'items', type: 'OrderLine[]' },
    ]);
    expect(place.returns).toBe('Order');
    expect(place.endpoint).toMatchObject({ transport: 'HTTP', method: 'POST', path: '/orders' });
  });

  it('fills the ERD: typed tables, primary/unique keys, and FK reference edges with cardinality', () => {
    const model = seedInto();
    expect(model.types.map((t) => t.id).sort()).toEqual(
      ['category', 'money', 'order', 'order-line', 'payment', 'product'],
    );

    const product = model.types.find((t) => t.id === 'product')!;
    expect(product.fields.find((f) => f.name === 'id')!.key).toBe('primary');
    expect(product.fields.find((f) => f.name === 'sku')!.key).toBe('unique');

    // FK reference edges are derived from field type strings; cardinality from shape/optional.
    const edge = (field: string) => model.typeEdges.find((e) => e.field === field);
    expect(edge('category')).toMatchObject({ from: 'product', to: 'category', card: '1' });
    expect(edge('amount')).toMatchObject({ from: 'payment', to: 'money', card: '1' });
    expect(edge('lines')).toMatchObject({ from: 'order', to: 'order-line', card: '*' });
    expect(edge('payment')).toMatchObject({ from: 'order', to: 'payment', card: '0..1' });
    // Cross-subsystem reference: an ordering value-object references a catalog entity.
    expect(edge('productId')).toMatchObject({ from: 'order-line', to: 'product', card: '1' });
    expect(model.typeEdges.length).toBeGreaterThanOrEqual(5);

    // Data-coupling edges light up when one subsystem uses another's types.
    expect(model.dataEdges.length).toBeGreaterThan(0);
  });

  it('fills the flow view: narratives mixing every step kind', () => {
    const model = seedInto();
    const totalNarratives = model.components.reduce((n, c) => n + c.narratives.length, 0);
    expect(totalNarratives).toBeGreaterThanOrEqual(10);

    // A branch + loop + throw + call in one checkout narrative.
    const checkout = stepKinds(model, 'ordering-orchestrator', 'checkout');
    expect(checkout).toEqual(expect.arrayContaining(['local', 'loop', 'call', 'branch', 'throw', 'return']));
    // A multiway dispatch (switch) + jump in pricing.
    expect(stepKinds(model, 'pricing-specialist', 'quote')).toEqual(expect.arrayContaining(['switch', 'jump', 'return']));
    // A guarded region (try) in settlement.
    expect(stepKinds(model, 'payments-orchestrator', 'settle')).toEqual(expect.arrayContaining(['try', 'call', 'return']));

    // A cross-component call step targets another component's method (flow drill-in).
    const checkoutNarr = model.components
      .find((c) => c.id === 'ordering-orchestrator')!
      .narratives.find((n) => n.method === 'checkout')!;
    expect(checkoutNarr.steps.find((s) => s.kind === 'call')!.call).toMatchObject({ component: 'catalog-client' });

    // Intent-only methods (the detail dial) are captured too.
    const repo = model.components.find((c) => c.id === 'product-repo')!;
    expect(repo.intents.length).toBeGreaterThan(0);
  });

  it('host demo provisions a hosted project and seeds it (idempotent with --force)', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-demo-host-'));
    cleanups.push(dataDir);
    process.env.WAIRON_ADMIN_TOKEN = 'test-admin-secret';

    await runHostDemo({ id: 'demo', dataDir });
    const root = existingProjectRoot(dataDir, 'demo')!;
    expect(root).toBeTruthy();
    expect(fs.existsSync(path.join(root, '.wai', 'specs'))).toBe(true);

    const model = runWithProjectRoot(root, () => {
      invalidateSpecCache();
      return buildCanvasModel();
    });
    expect(model.system.name).toBe(DEMO_SYSTEM_NAME);
    expect(model.components).toHaveLength(22);
    expect(model.types).toHaveLength(6);

    // Re-running without --force refuses to clobber the existing project.
    await expect(runHostDemo({ id: 'demo', dataDir })).rejects.toThrow(/already exists/);

    // With --force it destroys and reseeds cleanly (still 22 components, not doubled).
    await runHostDemo({ id: 'demo', dataDir, force: true });
    const reseeded = runWithProjectRoot(existingProjectRoot(dataDir, 'demo')!, () => {
      invalidateSpecCache();
      return buildCanvasModel();
    });
    expect(reseeded.components).toHaveLength(22);
  });
});
