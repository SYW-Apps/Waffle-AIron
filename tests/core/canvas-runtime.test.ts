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
  invalidateSpecCache,
} from '../../src/core/specs.js';
import { buildCanvasModel, renderCanvasHtml } from '../../src/core/canvas.js';

const now = new Date().toISOString();

// ---------------------------------------------------------------------------
// Runtime check for the generated canvas: extract the REAL inline scripts from
// canvas.html and execute them against headless cytoscape + a minimal DOM
// shim. A typo or ReferenceError in the template's JS then fails here instead
// of only surfacing in a browser.
// ---------------------------------------------------------------------------

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function makeDomShim() {
  const elements: Record<string, any> = {};
  const stub = (id: string) => {
    if (!elements[id]) {
      elements[id] = {
        textContent: '',
        innerHTML: '',
        checked: false,
        value: '',
        classList: { add() {}, remove() {} },
        addEventListener() {},
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
    body: {
      appendChild() {},
      setAttribute() {},
      removeAttribute() {},
      classList: { add() {}, remove() {}, toggle() {} },
    },
  };
  return { document, elements };
}

describe('canvas runtime (headless execution of the generated scripts)', () => {
  let proj: string;
  afterEach(() => {
    setProjectRoot(null);
    invalidateSpecCache();
    if (proj) fs.rmSync(proj, { recursive: true, force: true });
  });

  it('initializes without errors and builds the full element set', () => {
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
    const comp = (over: Record<string, unknown>) => ({
      id: '', name: '', description: 'd', subsystem: 'billing',
      componentType: 'Orchestrator' as const, owns: [] as string[], dependsOn: [] as string[],
      createdAt: now, updatedAt: now, ...over,
    });
    saveComponentSpec(comp({ id: 'billing-portal', name: 'Billing Portal', componentType: 'Portal', portalType: 'HTTP_API', dependsOn: ['billing-repo'] }) as any);
    saveComponentSpec(comp({ id: 'billing-store', name: 'Billing Store', componentType: 'Store' }) as any);
    saveComponentSpec(comp({ id: 'billing-repo', name: 'Billing Repository', componentType: 'Repository', owns: ['billing-store'] }) as any);

    const html = renderCanvasHtml(buildCanvasModel([
      { severity: 'warning', code: 'UNUSED_COMPONENT', message: 'unused', specId: 'billing-store' },
    ]));

    // scripts: [0] vendored cytoscape, [1] MODEL, [2] the app
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
    expect(scripts).toHaveLength(3);

    const { document, elements } = makeDomShim();
    let cyInstance: any = null;
    // Substitute the vendored bundle with the same library in headless mode
    // (no real DOM available; rendering styles are irrelevant here).
    const cytoscape = (opts: any) => {
      cyInstance = realCytoscape({ ...opts, container: undefined, headless: true, styleEnabled: false });
      return cyInstance;
    };

    const run = new Function('cytoscape', 'document', `${scripts[1]}\n${scripts[2]}`);
    run(cytoscape, document); // throws on any template JS error

    expect(cyInstance).not.toBeNull();
    // C4-style scoped navigation: the initial SYSTEM view renders only the
    // top-level subsystems — one drillable box, no internal edges leaked.
    expect(cyInstance.nodes().length).toBe(1);
    expect(cyInstance.edges().length).toBe(0);
    const subNode = cyInstance.getElementById('s~billing');
    expect(subNode.length).toBe(1);
    expect(subNode.hasClass('subsysBox')).toBe(true);
    expect(subNode.hasClass('drillable')).toBe(true);
    // header issue counter was populated by the app script (0 errors / 1 warning)
    expect(elements['issueCount'].textContent).toBe('0e/1w');
  });
});
