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
  saveTypeSpec,
  invalidateSpecCache,
} from '../../src/core/specs.js';
import { buildGraphModel } from '../../src/core/diagram.js';

const now = new Date().toISOString();

// A minimal but complete spec tree: one system, one subsystem, two components
// (with a depends_on between them), one interface, and one type — enough to
// exercise every level-of-detail tier and edge kind of the graph projection.
describe('buildGraphModel — level-of-detail project graph', () => {
  let proj: string;

  afterEach(() => {
    setProjectRoot(null);
    invalidateSpecCache();
    if (proj) fs.rmSync(proj, { recursive: true, force: true });
  });

  function buildFixture() {
    proj = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-graph-test-'));
    fs.mkdirSync(path.join(proj, '.wai', 'specs'), { recursive: true });
    setProjectRoot(proj);

    saveSystemSpec({
      schemaVersion: '1.0.0',
      name: 'GraphSys',
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
      parentSystem: 'GraphSys',
      publicInterfaces: [{ type: 'REST', details: 'api', component: 'billing-portal' }],
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
    saveComponentSpec(comp({ id: 'billing-orchestrator', name: 'Billing Orchestrator', componentType: 'Orchestrator' }) as any);

    saveInterfaceSpec({
      id: 'ibilling-portal',
      name: 'IBillingPortal',
      description: 'contract',
      component: 'billing-portal',
      methods: [{ name: 'authorize', description: 'auth', signature: 'authorize(): void', returns: 'void' }],
      createdAt: now,
      updatedAt: now,
    });

    saveTypeSpec({
      kind: 'entity', id: 'invoice', name: 'Invoice', description: 'a bill',
      fields: [{ name: 'total', type: 'number', optional: false }],
      methods: [], createdAt: now, updatedAt: now,
    } as any);

    invalidateSpecCache();
  }

  /** No edge may reference a node that is not present at this level. */
  function assertNoDangling(model: ReturnType<typeof buildGraphModel>) {
    const ids = new Set(model.nodes.map(n => n.id));
    for (const e of model.edges) {
      expect(ids.has(e.from)).toBe(true);
      expect(ids.has(e.to)).toBe(true);
    }
  }

  it('level 0 yields just the project root; level 1 adds the subsystem tier', () => {
    buildFixture();

    // Level 0: the whole project collapsed to a single root node, no edges.
    const l0 = buildGraphModel(0);
    expect(l0.tier).toBe('project');
    expect(l0.scope).toBe('GraphSys');
    expect(l0.nodes).toEqual([{ id: 'GraphSys', label: 'GraphSys', kind: 'project', level: 0 }]);
    expect(l0.edges).toHaveLength(0);

    // Level 1: the root plus its subsystems, wired by project→subsystem contains.
    const l1 = buildGraphModel(1);
    expect(l1.level).toBe(1);
    expect(l1.nodes.map(n => n.id)).toEqual(['GraphSys', 'billing']);
    expect(l1.nodes.find(n => n.id === 'billing')).toMatchObject({
      kind: 'subsystem', level: 1, parentId: 'GraphSys',
    });
    expect(l1.edges).toContainEqual({ from: 'GraphSys', to: 'billing', edgeKind: 'contains' });
    // No deeper tier has surfaced yet.
    expect(l1.nodes.some(n => n.kind === 'component' || n.kind === 'interface' || n.kind === 'type')).toBe(false);
    assertNoDangling(l1);
  });

  it('level 2 adds components with subsystem→component contains edges and depends_on', () => {
    buildFixture();
    const model = buildGraphModel(2);

    expect(model.level).toBe(2);
    const components = model.nodes.filter(n => n.kind === 'component');
    expect(components.map(n => n.id).sort()).toEqual(['billing-orchestrator', 'billing-portal']);
    expect(components.every(n => n.level === 2 && n.parentId === 'billing')).toBe(true);
    // No interface/type nodes have surfaced yet.
    expect(model.nodes.some(n => n.kind === 'interface' || n.kind === 'type')).toBe(false);

    // Containment: the subsystem contains each component.
    expect(model.edges).toContainEqual({ from: 'billing', to: 'billing-portal', edgeKind: 'contains' });
    expect(model.edges).toContainEqual({ from: 'billing', to: 'billing-orchestrator', edgeKind: 'contains' });
    // Dependency: both endpoints are present at level 2, so the edge appears.
    expect(model.edges).toContainEqual({ from: 'billing-portal', to: 'billing-orchestrator', edgeKind: 'depends_on' });
    // The owns edge to the (still-hidden) interface must NOT leak through.
    expect(model.edges.some(e => e.edgeKind === 'owns')).toBe(false);
    assertNoDangling(model);
  });

  it('level 3 adds interfaces and types with component→interface owns edges', () => {
    buildFixture();
    const model = buildGraphModel(3);

    expect(model.level).toBe(3);
    const iface = model.nodes.find(n => n.kind === 'interface');
    expect(iface).toMatchObject({ id: 'ibilling-portal', level: 3, parentId: 'billing-portal' });
    const type = model.nodes.find(n => n.kind === 'type');
    expect(type).toMatchObject({ id: 'invoice', level: 3 });

    expect(model.edges).toContainEqual({ from: 'billing-portal', to: 'ibilling-portal', edgeKind: 'owns' });
    // The full edge set still stands (containment + dependency + ownership).
    expect(model.edges).toContainEqual({ from: 'billing', to: 'billing-portal', edgeKind: 'contains' });
    expect(model.edges).toContainEqual({ from: 'billing-portal', to: 'billing-orchestrator', edgeKind: 'depends_on' });
    assertNoDangling(model);
  });

  it('drops a depends_on edge until BOTH endpoints are included', () => {
    buildFixture();
    // At level 1 neither component exists, so the component→component edge is gone.
    const l1 = buildGraphModel(1);
    expect(l1.edges.some(e => e.edgeKind === 'depends_on')).toBe(false);
    // At level 2 both components are present, so the edge reappears exactly once.
    const l2 = buildGraphModel(2);
    expect(l2.edges.filter(e => e.edgeKind === 'depends_on')).toHaveLength(1);
  });

  it('echoes the requested level and never dangles at any depth', () => {
    buildFixture();
    for (const level of [0, 1, 2, 3, 4]) {
      const model = buildGraphModel(level);
      expect(model.level).toBe(level);
      expect(model.tier).toBe('project');
      expect(model.scope).toBe('GraphSys');
      assertNoDangling(model);
    }
  });
});
