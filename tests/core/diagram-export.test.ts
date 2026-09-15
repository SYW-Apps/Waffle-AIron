import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { setProjectRoot } from '../../src/utils/fs.js';
import {
  saveSystemSpec,
  saveSubsystemSpec,
  saveComponentSpec,
  invalidateSpecCache,
} from '../../src/core/specs.js';
import { buildCanvasModel } from '../../src/core/canvas.js';
import { generateDrawioXml, generateExcalidrawScene } from '../../src/core/diagram-export.js';
import { computeLayout } from '../../src/core/canvas-layout.js';

const now = new Date().toISOString();

describe('editable diagram exports (draw.io / Excalidraw)', () => {
  let proj: string;
  afterEach(() => {
    setProjectRoot(null);
    invalidateSpecCache();
    if (proj) fs.rmSync(proj, { recursive: true, force: true });
  });

  function buildFixture() {
    proj = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-export-test-'));
    fs.mkdirSync(path.join(proj, '.wai', 'specs'), { recursive: true });
    setProjectRoot(proj);

    saveSystemSpec({
      schemaVersion: '1.0.0', name: 'ExportSys', vision: 'v',
      boundaries: [], globalRequirements: [], createdAt: now, updatedAt: now,
    });
    saveSubsystemSpec({
      id: 'billing', name: 'Billing', description: 'd', parentSystem: 'ExportSys',
      publicInterfaces: [{ type: 'REST', details: 'api', component: 'billing-portal' }],
      trustedLinks: [], createdAt: now, updatedAt: now,
    });
    saveSubsystemSpec({
      id: 'shipping', name: 'Shipping', description: 'd', parentSystem: 'ExportSys',
      publicInterfaces: [], trustedLinks: [], createdAt: now, updatedAt: now,
    });

    const comp = (over: Record<string, unknown>) => ({
      id: '', name: '', description: 'd', subsystem: 'billing',
      componentType: 'Orchestrator' as const, owns: [] as string[], dependsOn: [] as string[],
      createdAt: now, updatedAt: now, ...over,
    });
    saveComponentSpec(comp({ id: 'billing-portal', name: 'Billing Portal', componentType: 'Portal', portalType: 'HTTP_API', dependsOn: ['billing-repo'] }) as any);
    saveComponentSpec(comp({ id: 'billing-store', name: 'Billing Store', componentType: 'Store' }) as any);
    saveComponentSpec(comp({ id: 'billing-repo', name: 'Billing Repository', componentType: 'Repository', owns: ['billing-store'] }) as any);
    saveComponentSpec(comp({ id: 'shipping-client', name: 'Shipping Client', subsystem: 'shipping', componentType: 'Adapter', dependsOn: ['billing-portal'] }) as any);
  }

  it('computeLayout nests members inside patterns and places every visible component', () => {
    buildFixture();
    const model = buildCanvasModel();
    const L = computeLayout(model, {});

    const repo = L.boxes['billing-repo'];
    const store = L.boxes['billing-store'];
    expect(repo).toBeDefined();
    expect(store).toBeDefined();
    // member nests strictly inside the pattern box
    expect(store.x).toBeGreaterThan(repo.x);
    expect(store.y).toBeGreaterThan(repo.y);
    expect(store.x + store.w).toBeLessThanOrEqual(repo.x + repo.w);
    expect(store.y + store.h).toBeLessThanOrEqual(repo.y + repo.h);
    // components sit inside their subsystem container
    const billing = L.subs['billing'];
    expect(repo.x).toBeGreaterThan(billing.x);
    expect(repo.y).toBeGreaterThan(billing.y);
  });

  it('generates draw.io XML with containers, nesting, and boundary-hop styling', () => {
    buildFixture();
    const xml = generateDrawioXml(buildCanvasModel());

    expect(xml).toContain('<mxGraphModel');
    // subsystem is a draggable container
    expect(xml).toMatch(/id="sub_billing"[^>]*value="Billing"[^>]*style="[^"]*container=1/);
    // component labeled with its stereotype, parented to its subsystem
    expect(xml).toMatch(/id="comp_billing-portal"[^>]*«Portal\/HTTP_API»[^>]*parent="sub_billing"/);
    // pattern member parented to the pattern cell (moves with it in draw.io)
    expect(xml).toMatch(/id="comp_billing-store"[^>]*parent="comp_billing-repo"/);
    // published component gets the bold border
    expect(xml).toMatch(/id="comp_billing-portal"[^>]*strokeWidth=3/);
    // cross-subsystem edge is red and thicker
    expect(xml).toMatch(/strokeColor=#c26767[^"]*"[^>]*edge="1"[^>]*source="comp_shipping-client"[^>]*target="comp_billing-portal"/);
  });

  it('generates a valid Excalidraw scene with bound labels and bound arrows', () => {
    buildFixture();
    const scene = JSON.parse(generateExcalidrawScene(buildCanvasModel()));

    expect(scene.type).toBe('excalidraw');
    expect(scene.version).toBe(2);

    const rects = scene.elements.filter((e: any) => e.type === 'rectangle');
    const texts = scene.elements.filter((e: any) => e.type === 'text');
    const arrows = scene.elements.filter((e: any) => e.type === 'arrow');
    expect(rects.length).toBeGreaterThanOrEqual(6); // 2 subsystems + 4 components
    expect(arrows.length).toBe(2);

    // labels are container-bound so they travel with their boxes
    const portalRect = rects.find((r: any) => r.id === 'comp-billing-portal');
    expect(portalRect).toBeDefined();
    const portalLabel = texts.find((t: any) => t.containerId === 'comp-billing-portal');
    expect(portalLabel.text).toContain('Billing Portal');
    expect(portalRect.boundElements.some((b: any) => b.type === 'text')).toBe(true);

    // arrows bind to both endpoints so Excalidraw re-routes them on drag
    const crossArrow = arrows.find((a: any) => a.strokeColor === '#c26767');
    expect(crossArrow.startBinding.elementId).toBe('comp-shipping-client');
    expect(crossArrow.endBinding.elementId).toBe('comp-billing-portal');
    expect(portalRect.boundElements.some((b: any) => b.type === 'arrow')).toBe(true);

    // deterministic output: same tree, same scene (stable seeds/ids)
    const again = JSON.parse(generateExcalidrawScene(buildCanvasModel()));
    expect(again.elements.length).toBe(scene.elements.length);
    expect(again.elements[0].seed).toBe(scene.elements[0].seed);
  });

  it('colours a Query apart from its Store and from logic, in both exports', () => {
    // Hand-built: the exporters take any model of this shape, and the tree
    // under test needs no saved specs.
    const comp = (id: string, componentType: string, over: Record<string, unknown> = {}) => ({
      id, name: id, subsystem: 'auction', componentType, public: false,
      owns: [] as string[], dependsOn: [] as string[], ...over,
    });
    const model = {
      system: { name: 'AuctionSys' },
      generatedAt: now,
      subsystems: [{ id: 'auction', name: 'Auction' }],
      components: [
        comp('lot_repository', 'Repository', { owns: ['lot_store', 'bid_history'] }),
        comp('lot_store', 'Store', { owner: 'lot_repository' }),
        comp('bid_history', 'Query', { owner: 'lot_repository', dependsOn: ['lot_store'] }),
        comp('bidding', 'Orchestrator', { dependsOn: ['lot_repository'] }),
      ],
      edges: [{ from: 'bidding', to: 'lot_repository', cross: false }],
    };

    const xml = generateDrawioXml(model as any);
    const fillOf = (id: string) => new RegExp(`id="comp_${id}"[^>]*style="[^"]*fillColor=(#[0-9a-f]{6})`).exec(xml)?.[1];
    expect(fillOf('bid_history')).toBeDefined();
    expect(fillOf('bid_history')).not.toBe(fillOf('lot_store'));
    expect(fillOf('bid_history')).not.toBe(fillOf('bidding'));

    const scene = JSON.parse(generateExcalidrawScene(model as any));
    const rect = (id: string) => scene.elements.find((e: any) => e.id === 'comp-' + id);
    expect(rect('bid_history').backgroundColor).toBe(fillOf('bid_history'));
  });

  it('draws a retired Gateway as a plain box beside the Portal it listed, marked retired like a Specialist', () => {
    // As buildCanvasModel hands it over: the Gateway still lists what it owned,
    // but no member records it as owner, since a Gateway is no pattern.
    const comp = (id: string, componentType: string, over: Record<string, unknown> = {}) => ({
      id, name: id, subsystem: 'auction', componentType, public: false,
      owns: [] as string[], dependsOn: [] as string[], ...over,
    });
    const model = {
      system: { name: 'AuctionSys' },
      generatedAt: now,
      subsystems: [{ id: 'auction', name: 'Auction' }],
      components: [
        comp('edge_gateway', 'Gateway', { owns: ['edge_portal'], dependsOn: ['bidding'] }),
        comp('edge_portal', 'Portal', { dependsOn: ['bidding'] }),
        comp('pricing_specialist', 'Specialist'),
        comp('bidding', 'Orchestrator', { dependsOn: ['pricing_specialist'] }),
      ],
      edges: [
        { from: 'edge_gateway', to: 'bidding', cross: false },
        { from: 'edge_portal', to: 'bidding', cross: false },
        { from: 'bidding', to: 'pricing_specialist', cross: false },
      ],
    };

    const L = computeLayout(model as any, {});
    expect({ w: L.boxes['edge_gateway'].w, h: L.boxes['edge_gateway'].h }).toEqual({ w: 190, h: 52 });

    const xml = generateDrawioXml(model as any);
    const styleOf = (id: string) => new RegExp(`id="comp_${id}"[^>]*style="([^"]*)"`).exec(xml)?.[1] ?? '';
    const fillOf = (id: string) => /fillColor=(#[0-9a-f]{6})/.exec(styleOf(id))?.[1];
    expect(styleOf('edge_gateway')).not.toContain('container=1');
    expect(xml).toMatch(/id="comp_edge_portal"[^>]*parent="sub_auction"/);
    expect(fillOf('edge_gateway')).toBe(fillOf('pricing_specialist'));
    expect(fillOf('pricing_specialist')).not.toBe(fillOf('bidding'));

    const scene = JSON.parse(generateExcalidrawScene(model as any));
    const rect = (id: string) => scene.elements.find((e: any) => e.id === 'comp-' + id);
    expect(rect('edge_gateway').strokeStyle).toBe('solid');
    expect(rect('edge_gateway').backgroundColor).toBe(fillOf('pricing_specialist'));
  });
});
