import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import realCytoscape from 'cytoscape';
import { setProjectRoot } from '../../src/utils/fs.js';
import {
  saveSystemSpec,
  saveSubsystemSpec,
  saveComponentSpec,
  saveTypeSpec,
  invalidateSpecCache,
} from '../../src/core/specs.js';
import { buildCanvasModel, renderCanvasHtml } from '../../src/core/canvas.js';

const now = new Date().toISOString();

// ---------------------------------------------------------------------------
// Runtime check for the generated canvas: extract the REAL inline scripts from
// canvas.html and execute them against headless cytoscape + a minimal DOM
// shim. A typo or ReferenceError in the template's JS fails here instead of
// only surfacing in a browser — and the shim captures event handlers so we
// can drive toggles (Internals) and assert the resulting graph.
// ---------------------------------------------------------------------------

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function makeDomShim() {
  const elements: Record<string, any> = {};
  const handlers: Record<string, (ev: any) => void> = {};
  const stub = (id: string) => {
    if (!elements[id]) {
      elements[id] = {
        _id: id,
        textContent: '',
        innerHTML: '',
        checked: false,
        value: '',
        style: {},
        classList: { add() {}, remove() {}, toggle() {} },
        addEventListener(ev: string, fn: (e: any) => void) { handlers[id + ':' + ev] = fn; },
        getAttribute() { return null; },
        querySelectorAll() { return []; },
        appendChild() {},
        removeChild() {},
        remove() {},
        click() {},
      };
    }
    return elements[id];
  };
  const document = {
    getElementById: stub,
    createElement() {
      let text = '';
      return {
        set textContent(v: string) { text = String(v); },
        get innerHTML() { return escapeHtml(text); },
        addEventListener() {},
        click() {},
        remove() {},
        href: '',
        download: '',
      };
    },
    addEventListener() {},
    body: {
      appendChild() {},
      setAttribute() {},
      removeAttribute() {},
      classList: { add() {}, remove() {}, toggle() {} },
    },
  };
  const fire = (id: string, ev: string, payload: any) => {
    const h = handlers[id + ':' + ev];
    if (!h) throw new Error(`no handler bound for ${id}:${ev}`);
    h(payload);
  };
  return { document, elements, fire };
}

/** Extract and execute the generated canvas scripts against headless cytoscape. */
function bootCanvas(html: string) {
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  const { document, elements, fire } = makeDomShim();
  const cyInstances: any[] = [];
  const cytoscape = (opts: any) => {
    const inst = realCytoscape({ ...opts, container: undefined, headless: true, styleEnabled: false });
    cyInstances.push(inst);
    return inst;
  };
  new Function('cytoscape', 'document', `${scripts[1]}\n${scripts[2]}`)(cytoscape, document);
  return { cy: cyInstances[0], elements, fire };
}

const idPrefix = (cy: any, p: string) => cy.nodes().filter((n: any) => n.id().indexOf(p) === 0);

describe('canvas runtime (headless execution of the generated scripts)', () => {
  let proj: string;
  afterEach(() => {
    setProjectRoot(null);
    invalidateSpecCache();
    if (proj) fs.rmSync(proj, { recursive: true, force: true });
  });

  it('renders the scoped system view, keeps arrows with Internals on, and shows inner relations', () => {
    proj = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-canvas-rt-'));
    fs.mkdirSync(path.join(proj, '.wai', 'specs'), { recursive: true });
    setProjectRoot(proj);

    saveSystemSpec({
      schemaVersion: '1.0.0', name: 'RtSys', vision: 'v',
      boundaries: [], globalRequirements: [], createdAt: now, updatedAt: now,
    });
    saveSubsystemSpec({
      id: 'billing', name: 'Billing', description: 'd', parentSystem: 'RtSys',
      publicInterfaces: [{ type: 'REST', details: 'api', component: 'billing-portal' }],
      trustedLinks: [], createdAt: now, updatedAt: now,
    });
    saveSubsystemSpec({
      id: 'shipping', name: 'Shipping', description: 'd', parentSystem: 'RtSys',
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

    const html = renderCanvasHtml(buildCanvasModel([
      { severity: 'warning', code: 'UNUSED_COMPONENT', message: 'unused', specId: 'billing-store' },
    ]));

    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
    expect(scripts).toHaveLength(3);

    const { document, elements, fire } = makeDomShim();
    let cyInstances: any[] = [];
    const cytoscape = (opts: any) => {
      const inst = realCytoscape({ ...opts, container: undefined, headless: true, styleEnabled: false });
      cyInstances.push(inst);
      return inst;
    };

    const run = new Function('cytoscape', 'document', `${scripts[1]}\n${scripts[2]}`);
    run(cytoscape, document); // throws on any template JS error

    const cy = cyInstances[0];
    expect(cy).toBeDefined();

    // System view: two top-level subsystem boxes + ONE cross-subsystem arrow.
    expect(cy.nodes().length).toBe(2);
    expect(cy.edges().length).toBe(1);
    expect(cy.getElementById('s~billing').hasClass('subsysBox')).toBe(true);
    expect(cy.getElementById('s~billing').hasClass('drillable')).toBe(true);
    const viewEdge = cy.edges()[0];
    expect(viewEdge.source().id()).toBe('s~shipping');
    expect(viewEdge.target().id()).toBe('s~billing');
    expect(viewEdge.hasClass('cross')).toBe(true);

    // Enable Internals: subsystem-level arrows must SURVIVE, children render as
    // inner tiles, and intra-container relations appear as inner edges.
    fire('internalsToggle', 'change', { target: { checked: true } });

    expect(cy.getElementById('i~component~billing-portal').length).toBe(1);
    expect(cy.getElementById('i~component~billing-portal').parent().id()).toBe('s~billing');
    expect(cy.getElementById('i~component~shipping-client').parent().id()).toBe('s~shipping');

    const crossEdges = cy.edges().filter((e: any) => e.hasClass('cross'));
    expect(crossEdges.length).toBe(1); // the view-level arrow survived
    const pureInner = cy.edges().filter((e: any) => e.hasClass('inneredge') && !e.hasClass('toghost'));
    expect(pureInner.length).toBe(1); // billing-portal → billing-repo inside billing
    expect(pureInner[0].source().id()).toBe('i~component~billing-portal');
    expect(pureInner[0].target().id()).toBe('i~component~billing-repo');

    // Each external relation gets its own small PORT node INSIDE the container
    // (one per external counterpart), connected with short dashed edges that
    // never leave the box. Incoming and outgoing ports carry distinct classes.
    const outProxy = cy.getElementById('p~out~s~shipping~billing-portal');
    expect(outProxy.length).toBe(1);
    expect(outProxy.parent().id()).toBe('s~shipping');
    expect(outProxy.hasClass('proxyOut')).toBe(true);
    const inProxy = cy.getElementById('p~in~s~billing~shipping-client');
    expect(inProxy.length).toBe(1);
    expect(inProxy.parent().id()).toBe('s~billing');
    expect(inProxy.hasClass('proxyIn')).toBe(true);
    const stubs = cy.edges().filter((e: any) => e.hasClass('inneredge') && e.hasClass('toghost'));
    expect(stubs.length).toBe(2);
    expect(stubs.filter((e: any) => e.source().id() === 'i~component~shipping-client' && e.target().id() === outProxy.id()).length).toBe(1);
    expect(stubs.filter((e: any) => e.source().id() === inProxy.id() && e.target().id() === 'i~component~billing-portal').length).toBe(1);

    // Hovering a port reveals the actual cross-boundary line. Since BOTH
    // containers render their internals, the two matching ports connect
    // PORT-TO-PORT (not port-to-parent-box); leaving hides the line again.
    outProxy.emit('mouseover');
    let reveals = cy.edges().filter((e: any) => e.hasClass('revealEdge'));
    expect(reveals.length).toBe(1);
    expect(reveals[0].source().id()).toBe(outProxy.id());
    expect(reveals[0].target().id()).toBe(inProxy.id());
    outProxy.emit('mouseout');
    reveals = cy.edges().filter((e: any) => e.hasClass('revealEdge'));
    expect(reveals.length).toBe(0);

    // The IN port of the same relation reveals the SAME line (same endpoints,
    // same direction) — the two ports share it.
    inProxy.emit('mouseover');
    reveals = cy.edges().filter((e: any) => e.hasClass('revealEdge'));
    expect(reveals.length).toBe(1);
    expect(reveals[0].source().id()).toBe(outProxy.id());
    expect(reveals[0].target().id()).toBe(inProxy.id());
    inProxy.emit('mouseout');

    // Tapping a port SELECTS it: visible focus (sel class), counterpart
    // details in the sidebar, and the reveal line pinned across mouseout.
    outProxy.emit('tap');
    expect(outProxy.hasClass('sel')).toBe(true);
    expect(elements['panel'].innerHTML).toContain('Billing Portal');
    expect(elements['panel'].innerHTML).toContain('external dependency');
    outProxy.emit('mouseout');
    reveals = cy.edges().filter((e: any) => e.hasClass('revealEdge'));
    expect(reveals.length).toBe(1); // pinned while selected

    // Hovering the OTHER end of the pinned relation does not stack a twin
    // line — both ports share the one pinned line, which survives mouseout.
    inProxy.emit('mouseover');
    reveals = cy.edges().filter((e: any) => e.hasClass('revealEdge'));
    expect(reveals.length).toBe(1);
    expect(reveals[0].hasClass('revealPin')).toBe(true);
    inProxy.emit('mouseout');
    reveals = cy.edges().filter((e: any) => e.hasClass('revealEdge'));
    expect(reveals.length).toBe(1);

    cy.emit('tap'); // background tap: deselect + unpin
    expect(outProxy.hasClass('sel')).toBe(false);
    reveals = cy.edges().filter((e: any) => e.hasClass('revealEdge'));
    expect(reveals.length).toBe(0);

    // header issue counter was populated by the app script (0 errors / 1 warning)
    expect(elements['issueCount'].textContent).toBe('0e/1w');
  });

  it('sidebar describes the current view scope when nothing is selected, and focus spotlights a selection', () => {
    proj = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-canvas-scope-'));
    fs.mkdirSync(path.join(proj, '.wai', 'specs'), { recursive: true });
    setProjectRoot(proj);

    saveSystemSpec({ schemaVersion: '1.0.0', name: 'RtSys', vision: 'root vision', boundaries: [], globalRequirements: [], createdAt: now, updatedAt: now });
    saveSubsystemSpec({ id: 'billing', name: 'Billing', description: 'the billing subsystem', parentSystem: 'RtSys', publicInterfaces: [{ type: 'REST', details: 'api', component: 'billing-portal' }], trustedLinks: [], createdAt: now, updatedAt: now });
    saveSubsystemSpec({ id: 'shipping', name: 'Shipping', description: 'ships', parentSystem: 'RtSys', publicInterfaces: [], trustedLinks: [], createdAt: now, updatedAt: now });
    const comp = (over: Record<string, unknown>) => ({ id: '', name: '', description: 'd', subsystem: 'billing', componentType: 'Orchestrator' as const, owns: [] as string[], dependsOn: [] as string[], createdAt: now, updatedAt: now, ...over });
    saveComponentSpec(comp({ id: 'billing-portal', name: 'Billing Portal', componentType: 'Portal', portalType: 'HTTP_API' }) as any);
    saveComponentSpec(comp({ id: 'shipping-client', name: 'Shipping Client', subsystem: 'shipping', componentType: 'Adapter', dependsOn: ['billing-portal'] }) as any);

    const { cy, elements } = bootCanvas(renderCanvasHtml(buildCanvasModel()));

    // System view, one cross edge (shipping → billing). Tapping billing (the
    // TARGET) spotlights the edge as INCOMING ("used by")...
    cy.getElementById('s~billing').emit('tap');
    expect(elements['panel'].innerHTML).toContain('Billing');
    const edge = cy.edges()[0];
    expect(edge.hasClass('edgeIn')).toBe(true);
    expect(edge.hasClass('edgeOut')).toBe(false);
    // ...a background tap clears the spotlight (back to the system scope)...
    cy.emit('tap');
    expect(edge.hasClass('edgeIn')).toBe(false);
    expect(elements['panel'].innerHTML).toContain('RtSys');
    // ...and tapping shipping (the SOURCE) colours the same edge as OUTGOING.
    cy.getElementById('s~shipping').emit('tap');
    expect(edge.hasClass('edgeOut')).toBe(true);
    expect(edge.hasClass('edgeIn')).toBe(false);
    cy.emit('tap');

    // Drill into the subsystem: with nothing selected, the sidebar now
    // describes THAT scope (not the root system), tagged "current view".
    cy.getElementById('s~billing').emit('dbltap');
    expect(elements['panel'].innerHTML).toContain('Billing');
    expect(elements['panel'].innerHTML).toContain('the billing subsystem');
    expect(elements['panel'].innerHTML).toContain('current view');
    expect(elements['panel'].innerHTML).not.toContain('root vision');
  });

  it('degrades a huge ERD to a subsystem overview, then drills back to full detail', () => {
    proj = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-canvas-erd-'));
    fs.mkdirSync(path.join(proj, '.wai', 'specs'), { recursive: true });
    setProjectRoot(proj);

    saveSystemSpec({ schemaVersion: '1.0.0', name: 'BigSys', vision: 'v', boundaries: [], globalRequirements: [], createdAt: now, updatedAt: now });
    const subs = ['alpha', 'beta', 'gamma'];
    subs.forEach(sid => saveSubsystemSpec({ id: sid, name: sid.toUpperCase(), description: 'd', parentSystem: 'BigSys', publicInterfaces: [], trustedLinks: [], createdAt: now, updatedAt: now }));
    // 3 × 140 = 420 types — above the cluster threshold (400).
    subs.forEach(sid => {
      for (let i = 0; i < 140; i++) {
        saveTypeSpec({ id: sid + '_t' + i, name: sid + 'T' + i, kind: 'value-object', subsystem: sid, fields: [], methods: [], createdAt: now, updatedAt: now } as any);
      }
    });

    const { cy, elements, fire } = bootCanvas(renderCanvasHtml(buildCanvasModel()));
    fire('openTypesBtn', 'click', {});

    // Overview: one node per subsystem cluster, no per-type tables, and a notice.
    expect(idPrefix(cy, 'TC~').length).toBe(3);
    expect(idPrefix(cy, 'T~').length).toBe(0);
    expect(elements['typesWarn'].innerHTML).toContain('subsystem overview');

    // Drill into a cluster → its 140 types render (still names-only for perf:
    // header boxes, no field-row nodes) — everything is reachable.
    cy.getElementById('TC~alpha').emit('dbltap');
    expect(idPrefix(cy, 'TC~').length).toBe(0);
    expect(idPrefix(cy, 'T~').length).toBe(140);
    expect(idPrefix(cy, 'TF~').length).toBe(0);
    expect(elements['typesWarn'].innerHTML).toContain('names only');

    // Breadcrumbs stay in TYPES mode while scoped: every ancestor crumb
    // navigates to the parent's types (data-ck="types"), never its components.
    expect(elements['crumbs'].innerHTML).toContain('data-ck="types"');
    expect(elements['crumbs'].innerHTML).not.toContain('data-ck="subsystem"');
    expect(elements['crumbs'].innerHTML).toContain('Types (ERD)');
  }, 30000); // 420 spec writes on Windows under parallel load are I/O-heavy

  it('the layout picker switches algorithms: component relayout and ERD grid flattens groups', () => {
    proj = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-canvas-layout-'));
    fs.mkdirSync(path.join(proj, '.wai', 'specs'), { recursive: true });
    setProjectRoot(proj);

    saveSystemSpec({ schemaVersion: '1.0.0', name: 'RtSys', vision: 'v', boundaries: [], globalRequirements: [], createdAt: now, updatedAt: now });
    saveSubsystemSpec({ id: 'billing', name: 'Billing', description: 'd', parentSystem: 'RtSys', publicInterfaces: [{ type: 'REST', details: 'api', component: 'billing-portal' }], trustedLinks: [], createdAt: now, updatedAt: now });
    saveSubsystemSpec({ id: 'shipping', name: 'Shipping', description: 'd', parentSystem: 'RtSys', publicInterfaces: [], trustedLinks: [], createdAt: now, updatedAt: now });
    const comp = (over: Record<string, unknown>) => ({ id: '', name: '', description: 'd', subsystem: 'billing', componentType: 'Orchestrator' as const, owns: [] as string[], dependsOn: [] as string[], createdAt: now, updatedAt: now, ...over });
    saveComponentSpec(comp({ id: 'billing-portal', name: 'Billing Portal', componentType: 'Portal', portalType: 'HTTP_API' }) as any);
    saveComponentSpec(comp({ id: 'shipping-client', name: 'Shipping Client', subsystem: 'shipping', componentType: 'Adapter', dependsOn: ['billing-portal'] }) as any);
    ['billing', 'billing', 'shipping', 'shipping'].forEach((sid, i) => saveTypeSpec({ id: sid + '_t' + i, name: sid + 'T' + i, kind: 'value-object', subsystem: sid, fields: [], methods: [], createdAt: now, updatedAt: now } as any));

    const { cy, elements, fire } = bootCanvas(renderCanvasHtml(buildCanvasModel()));

    // Component view: switching to Force relayouts in place (no nodes lost) and
    // the header reflects the active layout.
    expect(cy.nodes().length).toBe(2);
    fire('layoutForce', 'click');
    expect(cy.nodes().length).toBe(2);
    expect(elements['layoutBtn'].textContent).toContain('Force');
    // Concentric is a size-aware preset (no crash, nodes retained).
    fire('layoutConcentric', 'click');
    expect(cy.nodes().length).toBe(2);
    expect(elements['layoutBtn'].textContent).toContain('Concentric');
    fire('layoutLayered', 'click');

    // ERD: layered groups the two subsystems (group boxes present)...
    fire('openTypesBtn', 'click');
    expect(idPrefix(cy, 'TG~').length).toBeGreaterThan(0);
    expect(idPrefix(cy, 'T~').length).toBe(4);
    // ...Grid places the tables flat (no subsystem group boxes), same tables.
    fire('layoutGrid', 'click');
    expect(idPrefix(cy, 'TG~').length).toBe(0);
    expect(idPrefix(cy, 'T~').length).toBe(4);
    expect(elements['layoutBtn'].textContent).toContain('Grid');
  });

  it('places externals outside the graph bounds, and internals follow the layout', () => {
    proj = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-canvas-ext-'));
    fs.mkdirSync(path.join(proj, '.wai', 'specs'), { recursive: true });
    setProjectRoot(proj);

    saveSystemSpec({ schemaVersion: '1.0.0', name: 'RtSys', vision: 'v', boundaries: [], globalRequirements: [], createdAt: now, updatedAt: now });
    saveSubsystemSpec({ id: 'billing', name: 'Billing', description: 'd', parentSystem: 'RtSys', publicInterfaces: [{ type: 'REST', details: 'api', component: 'billing-portal' }], trustedLinks: [], createdAt: now, updatedAt: now });
    saveSubsystemSpec({ id: 'shipping', name: 'Shipping', description: 'd', parentSystem: 'RtSys', publicInterfaces: [], trustedLinks: [], createdAt: now, updatedAt: now });
    const comp = (over: Record<string, unknown>) => ({ id: '', name: '', description: 'd', subsystem: 'billing', componentType: 'Orchestrator' as const, owns: [] as string[], dependsOn: [] as string[], createdAt: now, updatedAt: now, ...over });
    saveComponentSpec(comp({ id: 'billing-portal', name: 'Billing Portal', componentType: 'Portal', portalType: 'HTTP_API' }) as any);
    ['b2', 'b3', 'b4', 'b5'].forEach(id => saveComponentSpec(comp({ id: id, name: id }) as any));
    // An out-of-billing component depends INTO billing → an incoming external.
    saveComponentSpec(comp({ id: 'shipping-core', name: 'Shipping Core', subsystem: 'shipping', componentType: 'Adapter', dependsOn: ['billing-portal'] }) as any);

    const { cy, fire } = bootCanvas(renderCanvasHtml(buildCanvasModel()));

    // Internals + Grid: subsystem children render as inner tiles (the grid inner
    // path runs without breaking the compound structure).
    fire('internalsToggle', 'change', { target: { checked: true } });
    fire('layoutGrid', 'click');
    expect(cy.getElementById('i~component~billing-portal').length).toBe(1);
    fire('internalsToggle', 'change', { target: { checked: false } });

    // Concentric, drilled into billing: the incoming external is a ghost placed
    // OUTSIDE the (centred) component bounds — never dropped in the middle.
    fire('layoutConcentric', 'click');
    cy.getElementById('s~billing').emit('dbltap');
    const ghost = cy.getElementById('x~subsystem~shipping');
    expect(ghost.length).toBe(1);
    let minLeft = Infinity, minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    cy.nodes().filter((n: any) => n.id().indexOf('c~') === 0).forEach((n: any) => {
      const px = n.position('x'), py = n.position('y'), hw = (n.data('w') || 0) / 2, hh = (n.data('h') || 0) / 2;
      minLeft = Math.min(minLeft, px - hw);
      minX = Math.min(minX, px - hw); maxX = Math.max(maxX, px + hw);
      minY = Math.min(minY, py - hh); maxY = Math.max(maxY, py + hh);
    });
    expect(ghost.position('x')).toBeLessThan(minLeft);
    // Concentric is stretched into a landscape ellipse (wider than tall).
    expect(maxX - minX).toBeGreaterThan(maxY - minY);
  });
});
