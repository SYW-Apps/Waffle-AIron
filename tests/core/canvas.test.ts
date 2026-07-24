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
  saveTypeSpec,
  invalidateSpecCache,
} from '../../src/core/specs.js';
import { buildCanvasModel, renderCanvasHtml } from '../../src/core/canvas.js';

const now = new Date().toISOString();

// ---------------------------------------------------------------------------
// Engine execution harness: the interactive engine only ever runs in a browser
// (cytoscape + DOM), but its whole load path is guarded for a windowless
// context (`inBrowser`), so we CAN execute it in Node with a stubbed DOM and a
// stub cytoscape constructor that captures the elements built by
// buildElements() — real structural assertions instead of source greps.
// Extraction mirrors scripts/gen-canvas-engine.mjs (the engine lives inside a
// template literal in canvas.ts; evaluating it as one recovers the real code).
// ---------------------------------------------------------------------------
const REPO_ROOT = path.resolve(__dirname, '..', '..');
let engineBody: string | null = null;
function loadEngineBody(): string {
  if (engineBody) return engineBody;
  const lines = fs
    .readFileSync(path.join(REPO_ROOT, 'src', 'core', 'canvas.ts'), 'utf8')
    .replace(/\r\n/g, '\n')
    .split('\n');
  const at = (re: RegExp, from = 0) => {
    for (let i = from; i < lines.length; i++) if (re.test(lines[i])) return i;
    throw new Error('engine marker not found: ' + re);
  };
  const cyLib = at(/^<script>__CYTOSCAPE_LIB__<\/script>$/);
  const iifeOpen = at(/^\(function \(\) \{$/, cyLib);
  const iifeClose = at(/^\}\)\(\);$/, iifeOpen);
  // Skip `(function () {`, `'use strict';`, and the two __DRAWIO/EXCALIDRAW__
  // decls (export handlers only — never called on the load path).
  engineBody = new Function('return `' + lines.slice(iifeOpen + 4, iifeClose).join('\n') + '`')() as string;
  return engineBody;
}

interface CyEle {
  data: { id?: string; parent?: string; source?: string; target?: string; label?: string; w?: number; h?: number };
  classes?: string;
  position?: { x: number; y: number };
}
function runEngine(model: unknown, opts: { internals?: boolean } = {}): CyEle[] {
  const makeElement = () => ({
    addEventListener() {}, removeEventListener() {},
    querySelectorAll() { return []; }, querySelector() { return null; },
    appendChild() {}, insertBefore() {}, remove() {},
    style: { display: '', setProperty() {}, removeProperty() {} },
    classList: { add() {}, remove() {} },
    setAttribute() {}, getAttribute() { return null; },
    getBoundingClientRect() { return { width: 0, height: 0 }; },
    innerHTML: '', textContent: '', checked: false, value: '', title: '', className: '',
  });
  const els = new Map<string, ReturnType<typeof makeElement>>();
  const documentStub = {
    getElementById(id: string) { if (!els.has(id)) els.set(id, makeElement()); return els.get(id); },
    createElement() { return makeElement(); },
    addEventListener() {}, removeEventListener() {},
    body: makeElement(),
    documentElement: makeElement(),
  };
  const localStorageStub = {
    getItem: () => JSON.stringify({ positionsByView: {}, theme: 'syw', internals: opts.internals !== false }),
    setItem() {},
  };
  // One self-returning collection stub covers every load-path traversal.
  const coll: Record<string, unknown> = {};
  Object.assign(coll, {
    length: 0,
    forEach() {}, map() { return []; },
    orphans() { return coll; }, toArray() { return []; },
    removeClass() { return coll; }, addClass() { return coll; },
    filter() { return coll; }, not() { return coll; }, union() { return coll; },
    connectedEdges() { return coll; }, connectedNodes() { return coll; },
    descendants() { return coll; }, ancestors() { return coll; },
    nodes() { return coll; }, edges() { return coll; },
    boundingBox() { return { x1: 0, y1: 0, x2: 0, y2: 0, w: 0, h: 0 }; },
    contains() { return false; }, isParent() { return false; }, isChild() { return false; },
    id() { return ''; }, data() { return undefined; }, position() { return { x: 0, y: 0 }; },
  });
  const captured: { elements: CyEle[] | null } = { elements: null };
  const cytoscapeStub = (init: { elements: CyEle[] }) => {
    captured.elements = init.elements;
    let locked = false;
    return {
      autolock(v?: boolean) { if (v === undefined) return locked; locked = v; },
      on() {}, batch(fn: () => void) { fn(); }, add() {}, remove() {},
      elements() { return coll; }, nodes() { return coll; }, edges() { return coll; },
      getElementById() { return coll; }, fit() {}, style() {}, animate() {}, resize() {},
      layout() { return { run() {} }; }, png() { return ''; }, destroy() {},
    };
  };
  const run = new Function('MODEL', 'opts', 'window', 'document', 'localStorage', 'cytoscape', loadEngineBody());
  run(model, undefined, undefined, documentStub, localStorageStub, cytoscapeStub);
  if (!captured.elements) throw new Error('engine never handed elements to cytoscape');
  return captured.elements;
}

/** A landscape-shaped model (units → deep frames, projects → leaf components)
 *  mirroring what web/src/views/Environment.tsx produces. */
function deepModel(): { subsystems: { id: string; deepInternals?: boolean }[] } & Record<string, unknown> {
  const sub = (id: string, name: string, deep: boolean) => ({
    id, name, description: '', trustedLinks: [], ...(deep ? { deepInternals: true } : {}),
  });
  const proj = (id: string, subsystem: string, dependsOn: string[]) => ({
    id, name: id.toUpperCase(), description: '', subsystem, componentType: 'project',
    public: false, owns: [], dependsOn, interfaces: [], narratives: [], intents: [],
  });
  return {
    system: { name: 'DeepSys' },
    generatedAt: now,
    subsystems: [
      sub('unit:org', 'Org', true),
      sub('unit:org::it', 'IT', true),
      sub('unit:org::it::tools', 'Tools', true),
      sub('unit:empty', 'Empty', true),
      sub('unit:org2', 'Org2', true),
      sub('unit:plain', 'Plain', false),
    ],
    components: [
      proj('proj-a', 'unit:org', ['proj-b']),
      proj('proj-b', 'unit:org::it::tools', []),
      proj('proj-c', 'unit:plain', ['proj-b']),
      proj('proj-d', 'unit:org2', ['proj-b']),
    ],
    edges: [
      { from: 'proj-a', to: 'proj-b', cross: true },
      { from: 'proj-c', to: 'proj-b', cross: true },
      { from: 'proj-d', to: 'proj-b', cross: true },
    ],
    types: [], typeEdges: [], dataEdges: [], issues: [],
  };
}

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

  it('derives ERD edge cardinality from field type shapes and the optional flag', () => {
    buildFixture();
    saveTypeSpec({
      kind: 'value-object', id: 'line-item', name: 'LineItem', description: 'one invoice line',
      fields: [{ name: 'sku', type: 'string', optional: false }],
      methods: [], createdAt: now, updatedAt: now,
    } as any);
    saveTypeSpec({
      kind: 'value-object', id: 'discount', name: 'Discount', description: 'optional rebate',
      fields: [{ name: 'pct', type: 'number', optional: false }],
      methods: [], createdAt: now, updatedAt: now,
    } as any);
    saveTypeSpec({
      kind: 'entity', id: 'invoice', name: 'Invoice', description: 'a bill',
      fields: [
        { name: 'items', type: 'LineItem[]', optional: false },
        { name: 'discount', type: 'Discount', optional: true },
      ],
      methods: [], createdAt: now, updatedAt: now,
    } as any);
    invalidateSpecCache();

    const model = buildCanvasModel();
    const items = model.typeEdges.find(e => e.field === 'items')!;
    expect(items).toMatchObject({ from: 'invoice', to: 'line-item', card: '*' });
    const disc = model.typeEdges.find(e => e.field === 'discount')!;
    expect(disc).toMatchObject({ from: 'invoice', to: 'discount', card: '0..1' });
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

  it('renders themed line-style controls with distinct curved edge routing', () => {
    buildFixture();
    const html = renderCanvasHtml(buildCanvasModel());

    expect(html).toContain('class="selectControl"');
    expect(html).toContain('Curved Bezier');
    expect(html).toContain("'curve-style': 'unbundled-bezier'");
    expect(html).toContain("'control-point-distances': [78]");
    expect(html).toContain("'control-point-distances': 'data(cpDist)'");
    expect(html).toContain("'curve-style': 'straight'");
    expect(html).toContain("'curve-style': 'taxi'");
    expect(html).toContain("'taxi-turn': 'data(taxiTurn)'");
  });

  // The engine executes only in a browser (cytoscape + DOM), so these tests
  // assert over the SHIPPED ENGINE SOURCE the way the rest of this file does:
  // the deep-expansion branch exists, is gated on the per-subsystem model flag
  // (+ the Internals state), and the classic fixed-one-layer path is intact.
  it('deep-expansion: engine gates recursion on subsystem.deepInternals and keeps the classic one-layer path', () => {
    buildFixture();
    const html = renderCanvasHtml(buildCanvasModel());

    // Opt-in flag plumbing + defensive recursion cap.
    expect(html).toContain('s.deepInternals');
    expect(html).toContain('var DEEP_MAX_DEPTH = 6');
    // Recursive bottom-up sizing and the view-level direct-edge context.
    expect(html).toContain('function deepContainerLayout(subId, depth)');
    expect(html).toContain('function buildDeepContext(scope, entries)');
    // The deep path is unreachable with Internals off or without deep entries…
    expect(html).toContain('if (!state.internals) return null;');
    // …and nested containers emit as compound children with subsystem-box
    // classes (drillable only when non-empty).
    expect(html).toContain("classes: 'subsysBox' + (tile.sub.tiles.length ? ' drillable' : '')");
    // Direct leaf-to-leaf lines are deduped per pair and suppress a fully
    // covered aggregated container edge (prefer the leaf lines).
    expect(html).toContain("classes: 'inneredge' + (d.cross ? ' cross' : '')");
    expect(html).toContain('deepCtx.directTopCount[key] >= e.n');
    // Legacy one-layer emission (fixed INNER_W×INNER_H tiles) is untouched for
    // unflagged models — the per-project canvas keeps today's behavior.
    expect(html).toContain('id: IN(tile.kid.kind, tile.kid.id), parent: aid');
    expect(html).toContain('w: INNER_W, h: INNER_H, tw: INNER_W - 10');
  });

  it('deep-expansion: buildCanvasModel never sets the flag; a flagged model embeds it for the engine', () => {
    buildFixture();
    const model = buildCanvasModel();
    // Spec-built models NEVER carry deepInternals (backward compatible).
    expect(model.subsystems.every(s => s.deepInternals === undefined)).toBe(true);
    expect(renderCanvasHtml(model)).not.toContain('"deepInternals"');

    // An adapter-built model (the hosted environment) ships the flag through
    // to the embedded MODEL the engine reads.
    model.subsystems.find(s => s.id === 'billing')!.deepInternals = true;
    const html = renderCanvasHtml(model);
    expect(html.split('var MODEL = ')[1].split('\n')[0]).toContain('"deepInternals":true');
  });

  it('mountCanvas remounts idempotently — shadow-root reuse contract (realtime refetch)', () => {
    // attachShadow throws on a host that already has a shadow root and a shadow
    // root can never be detached, so a realtime-refetch REMOUNT must reuse and
    // clear the existing root; destroy must clear the SHADOW tree (rootEl), not
    // the host's empty light DOM. Locks the generated wrapper's contract — the
    // drift test guarantees this file matches the generator.
    const engine = fs.readFileSync(path.join(REPO_ROOT, 'web', 'src', 'canvas', 'engine.ts'), 'utf8');
    expect(engine).toContain('host.shadowRoot || host.attachShadow');
    expect(engine.match(/rootEl\.innerHTML = '';/g)?.length).toBeGreaterThanOrEqual(2); // mount clear + destroy clear
    expect(engine).not.toContain("host.innerHTML = '';");
  });

  it('flow modal lays branches out in lanes with orthogonal long edges (not a single column)', () => {
    buildFixture();
    const html = renderCanvasHtml(buildCanvasModel());

    // Structured lane assignment: then-blocks / case blocks / loop bodies
    // shift into their own lane…
    expect(html).toContain('laneAdd');
    expect(html).toContain('graph.lane[s.n]');
    // …and long edges (false/case/jump/error) route orthogonally instead of
    // cutting straight through the nodes stacked between source and target.
    expect(html).toContain("'taxi-direction': 'downward'");
  });
});

describe('unit deep-expansion (executed engine)', () => {
  it('renders a deep-flagged subsystem chain as nested compound boxes with direct leaf-to-leaf relation lines', () => {
    const eles = runEngine(deepModel());
    const byId = new Map(eles.map(e => [e.data.id, e]));

    // Nested compound structure: org box → IT box → Tools box → leaf tile.
    expect(byId.get('s~unit:org')!.classes).toContain('subsysBox');
    expect(byId.get('i~component~proj-a')!.data.parent).toBe('s~unit:org');
    expect(byId.get('s~unit:org::it')!.data.parent).toBe('s~unit:org');
    expect(byId.get('s~unit:org::it')!.classes).toContain('drillable');
    expect(byId.get('s~unit:org::it::tools')!.data.parent).toBe('s~unit:org::it');
    expect(byId.get('i~component~proj-b')!.data.parent).toBe('s~unit:org::it::tools');
    // Leaf tiles keep the fixed tile size — never expanded further.
    expect(byId.get('i~component~proj-b')!.data.w).toBe(130);
    // Compound parents get no explicit position (cytoscape derives it)…
    expect(byId.get('s~unit:org')!.position).toBeUndefined();
    // …while an EMPTY deep subsystem is still a positioned (min-size) box.
    expect(byId.get('s~unit:empty')!.position).toBeDefined();
    expect(byId.get('s~unit:empty')!.classes).toContain('subsysBox');
    expect(byId.get('s~unit:empty')!.classes).not.toContain('drillable');

    // Direct relation lines between concrete endpoints, crossing nested
    // boundaries, deduped per pair, styled as inner edges.
    const direct = eles.filter(e => (e.data.id || '').startsWith('dd'));
    expect(direct.map(e => ({ s: e.data.source, t: e.data.target }))).toEqual([
      { s: 'i~component~proj-a', t: 'i~component~proj-b' },
      { s: 'i~component~proj-d', t: 'i~component~proj-b' },
    ]);
    for (const d of direct) expect(d.classes).toContain('inneredge');

    // Deep box ⇄ deep box: the aggregated container edge is fully covered by
    // direct lines → suppressed. Mixed (non-deep plain → deep org) keeps the
    // aggregated edge AND the port machinery at the deep box only.
    const agg = eles.filter(e => (e.data.id || '').match(/^e\d+$/));
    expect(agg.map(e => ({ s: e.data.source, t: e.data.target }))).toEqual([
      { s: 's~unit:plain', t: 's~unit:org' },
    ]);
    // In-port on the OUTERMOST deep box, stub connected to the DEEPEST leaf.
    expect(byId.get('p~in~s~unit:org~proj-c')!.data.parent).toBe('s~unit:org');
    const stub = eles.find(e => e.data.source === 'p~in~s~unit:org~proj-c');
    expect(stub!.data.target).toBe('i~component~proj-b');
    // The non-deep sibling keeps today's one-layer internals untouched.
    expect(byId.get('i~component~proj-c')!.data.parent).toBe('s~unit:plain');
    expect(byId.get('p~out~s~unit:plain~proj-b')!.data.parent).toBe('s~unit:plain');
  });

  it('without deepInternals flags the same model takes the legacy one-layer path (no nesting, no direct lines)', () => {
    const model = deepModel();
    for (const s of model.subsystems) delete s.deepInternals;
    const eles = runEngine(model);
    const byId = new Map(eles.map(e => [e.data.id, e]));

    // No deep artifacts anywhere: no nested subsystem compounds, no direct
    // deep edges — the flag alone gates the whole feature.
    expect(eles.some(e => (e.data.id || '').startsWith('dd'))).toBe(false);
    expect(eles.filter(e => (e.data.id || '').startsWith('s~')).every(e => e.data.parent === undefined)).toBe(true);
    // Classic Internals: ONE interior layer — the org box shows its direct
    // children (a project tile + a child-SUBSYSTEM tile), grandchildren stay
    // hidden.
    expect(byId.get('i~component~proj-a')!.data.parent).toBe('s~unit:org');
    expect(byId.get('i~subsystem~unit:org::it')!.data.parent).toBe('s~unit:org');
    expect(byId.has('i~component~proj-b')).toBe(false);
    // An empty subsystem without the flag renders nothing at all (hasKids
    // false ⇒ plain box), exactly as before.
    expect(byId.get('s~unit:empty')!.position).toBeDefined();
  });

  it('with Internals off, deep flags are inert — plain boxes, no tiles', () => {
    const eles = runEngine(deepModel(), { internals: false });
    expect(eles.some(e => (e.data.id || '').startsWith('i~'))).toBe(false);
    expect(eles.some(e => (e.data.id || '').startsWith('dd'))).toBe(false);
    const org = eles.find(e => e.data.id === 's~unit:org');
    expect(org!.position).toBeDefined();
    expect(org!.data.label).toContain('Org');
  });
});
