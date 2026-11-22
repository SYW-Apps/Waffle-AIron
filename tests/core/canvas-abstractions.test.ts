import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import * as path from 'path';
import { setProjectRoot } from '../../src/utils/fs.js';
import { invalidateSpecCache } from '../../src/core/specs.js';
import { writeSpecFile } from '../../src/core/spec-files.js';
import { InterfaceSpecSchema } from '../../src/models/index.js';
import { buildCanvasModel, renderCanvasHtml, type CanvasModel } from '../../src/core/canvas.js';
import { buildDrawioXml, buildExcalidrawScene } from '../../src/core/diagram-export.js';
import { computeLayout } from '../../src/core/canvas-layout.js';
import {
  tempDir, isolateGlobals, projectYaml, system, subsystem, component, specs,
} from '../helpers/stage8-family.js';

// ---------------------------------------------------------------------------
// The canvas draws an abstraction: an `abstract` mark on its node and an
// `implements` edge from each implementer to it — a relation of the design,
// kept apart from a dependency between the same two components, and never
// drawn for an `alias::name` extension point of another project. Real temp
// directories; the contract's `implements` is written through the schema.
// ---------------------------------------------------------------------------

const STAMP = '2026-11-22T00:00:00.000Z';
const cleanups: (() => void)[] = [];
beforeEach(() => {
  cleanups.push(isolateGlobals(cleanups));
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
  setProjectRoot(null);
  invalidateSpecCache();
  for (const c of cleanups.splice(0).reverse()) {
    try { c(); } catch { /* windows file locks */ }
  }
});

function contractOf(root: string, comp: string, implementsList?: string[]): void {
  writeSpecFile(specs(root, 'ship', comp, '.interface.yaml'), InterfaceSpecSchema.parse({
    id: `i${comp}`, name: `i${comp}`, description: `The ${comp} contract`, component: comp,
    methods: [{ name: 'quote', description: 'Quote a parcel', signature: 'quote(weight: number): number', returns: 'number' }],
    ...(implementsList ? { implements: implementsList } : {}),
    status: 'complete', createdAt: STAMP, updatedAt: STAMP,
  }));
}

/** A shipping subsystem: `carrier` (abstract) with two implementers and a caller. */
function writeShipping(): string {
  const root = tempDir(cleanups, 'wairon-abstractions-');
  projectYaml(root, { id: 'shipping', name: 'Shipping' });
  system(root, 'Shipping');
  subsystem(root, 'Shipping', 'ship');
  component(root, 'ship', 'carrier', 'Orchestrator', [], { abstract: true });
  component(root, 'ship', 'dhl', 'Orchestrator');
  component(root, 'ship', 'ups', 'Orchestrator', ['carrier']);
  component(root, 'ship', 'checkout', 'Orchestrator', ['carrier']);
  contractOf(root, 'carrier');
  contractOf(root, 'dhl', ['carrier']);
  contractOf(root, 'ups', ['carrier', 'vendor::pricing']);
  contractOf(root, 'checkout');
  return root;
}

function modelAt(dir: string): CanvasModel {
  setProjectRoot(dir);
  invalidateSpecCache();
  return buildCanvasModel([]);
}

const edgesOf = (m: CanvasModel, from: string, to: string) => m.edges.filter((e) => e.from === from && e.to === to);

describe('canvas abstractions', () => {
  it('marks an abstraction and no other component', () => {
    const model = modelAt(writeShipping());
    const marked = model.components.filter((c) => c.abstract).map((c) => c.id);
    expect(marked).toEqual(['carrier']);
  });

  it('draws one implements edge per local implemented abstraction, from the implementer', () => {
    const model = modelAt(writeShipping());
    expect(edgesOf(model, 'dhl', 'carrier'), JSON.stringify(model.edges)).toEqual([expect.objectContaining({ kind: 'implements', cross: false })]);
    // An extension point of another project is no node of this canvas: only the local one is drawn.
    expect(model.edges.filter((e) => e.kind === 'implements').map((e) => `${e.from}->${e.to}`).sort()).toEqual(['dhl->carrier', 'ups->carrier']);
  });

  it('keeps the implements edge apart from a dependency between the same two components', () => {
    const model = modelAt(writeShipping());
    const pair = edgesOf(model, 'ups', 'carrier').map((e) => e.kind).sort();
    expect(pair).toEqual(['depends', 'implements']);
    expect(edgesOf(model, 'checkout', 'carrier')).toEqual([expect.objectContaining({ kind: 'depends' })]);
  });

  it('writes the mark beside the stereotype on the node itself, not only in the detail panel', () => {
    const html = renderCanvasHtml(modelAt(writeShipping()));
    const label = html.split('\n').find((line) => line.trim().startsWith('label = c.name +'));
    expect(label).toContain("(c.abstract ? 'abstract ' : '')");
  });

  it('carries the realization into the draw.io and Excalidraw exports, and out of subsystem ordering', () => {
    const model = modelAt(writeShipping());
    const layout = computeLayout(model as never, {});
    const drawio = buildDrawioXml(model, layout);
    expect(drawio).toContain('dashed=1;endArrow=block;endFill=0');
    expect(drawio).toContain('«abstract Orchestrator»');
    const scene = JSON.parse(buildExcalidrawScene(model, layout));
    expect(scene.elements.some((e: { endArrowhead?: string }) => e.endArrowhead === 'triangle_outline')).toBe(true);
  });
});

describe('canvas abstractions of a contained member project', () => {
  /** A family whose member project `pets` holds an abstraction chain: animal, dog (implements animal), retriever (implements dog). */
  function writeFamily(): string {
    const root = tempDir(cleanups, 'wairon-abstractions-family-');
    projectYaml(root, { id: 'fam', name: 'Fam', members: { pets: 'pets' } });
    system(root, 'Fam');
    const pets = path.join(root, 'pets');
    projectYaml(pets, { id: 'pets', name: 'Pets' });
    system(pets, 'Pets');
    subsystem(pets, 'Pets', 'zoo');
    component(pets, 'zoo', 'animal', 'Orchestrator', [], { abstract: true });
    component(pets, 'zoo', 'dog', 'Orchestrator', [], { abstract: true });
    component(pets, 'zoo', 'retriever', 'Orchestrator');
    for (const [comp, implementsList] of [['animal', undefined], ['dog', ['animal']], ['retriever', ['dog']]] as const) {
      writeSpecFile(specs(pets, 'zoo', comp, '.interface.yaml'), InterfaceSpecSchema.parse({
        id: `i${comp}`, name: `i${comp}`, description: `The ${comp} contract`, component: comp,
        methods: [{ name: 'speak', description: 'Make a sound', signature: 'speak(): void', returns: 'void' }],
        ...(implementsList ? { implements: implementsList } : {}),
        status: 'complete', createdAt: STAMP, updatedAt: STAMP,
      }));
    }
    return root;
  }

  it('draws one implements edge per link of the chain, between the member\'s own components', () => {
    const model = modelAt(writeFamily());
    expect(model.edges.filter((e) => e.kind === 'implements').map((e) => `${e.from}->${e.to}`).sort(), JSON.stringify(model.edges))
      .toEqual(['pets::dog->pets::animal', 'pets::retriever->pets::dog']);
  });
});
