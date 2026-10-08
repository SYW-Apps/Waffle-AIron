import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { setProjectRoot } from '../../src/utils/fs.js';
import {
  saveSpec,
  invalidateSpecCache,
  loadComponentSpec,
  loadSpec,
  scanAllSpecs,
  updateSpec,
} from '../../src/core/specs.js';
import { deleteSpec, updateSpecGated, writeSpec } from '../../src/core/authoring.js';
import { renameField, renameParam } from '../../src/core/provision.js';
import { specIndexReferencesTo, specIndexSubtreeOf } from '../../src/models/specs.js';

// ---------------------------------------------------------------------------
// Round-7 trial findings on the authoring tools (tinkerer N1/N2, solo-app,
// platform): every test here failed on dev.111.
//
//  - N1: a delta's `id` wrote a second spec beside the first, and `subsystem`
//    moved the folder leaving every reference behind — both "1 change".
//  - N2: deleting a subsystem, component or type removed only its index file
//    and answered "Successfully deleted", orphaning everything under it.
//  - A reorder was a silent no-op; a mixed list read as "set"; an unset of a
//    defaulted list contradicted itself; a dry run promised writes the write
//    refused.
//  - A Portal -> Store dependsOn and a duplicate route were written without a
//    word, the dry run included.
//  - A parameter or field renamed back to its own former name was accepted,
//    and the tree then carried RENAME_TRACE_CONFLICT.
// ---------------------------------------------------------------------------

const now = '2026-10-01T00:00:00.000Z';
const PROJECT = { schemaVersion: '1.0.0', name: 'r7', targets: [{ type: 'claude', outputDir: '.claude/agents', enabled: true }], createdAt: now, updatedAt: now };
const projects: string[] = [];
afterEach(() => {
  for (const p of projects.splice(0)) fs.rmSync(p, { recursive: true, force: true });
  invalidateSpecCache();
});

/** A nested-layout tree: two subsystems, a Repository owning a Store, a Portal, a workflow, a type the contracts use. */
function seed(): string {
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-r7-authoring-'));
  projects.push(proj);
  fs.mkdirSync(path.join(proj, '.wai', 'specs'), { recursive: true });
  fs.writeFileSync(path.join(proj, '.wai', 'project.yaml'), JSON.stringify(PROJECT));
  setProjectRoot(proj);
  invalidateSpecCache();
  saveSpec('system', {
    schemaVersion: '1.0.0', name: 'Shortener', vision: 'Shortens links and counts hits.',
    boundaries: [{ name: 'first', description: 'a' }, { name: 'second', description: 'b' }],
    globalRequirements: ['one', 'two', 'three'], databases: [], createdAt: now, updatedAt: now,
  } as never);
  for (const id of ['links', 'analytics']) {
    saveSpec('subsystem', {
      schemaVersion: '1.0.0', id, name: id, description: `${id} subsystem`, parentSystem: 'Shortener',
      publicInterfaces: [], trustedLinks: [], status: 'complete', createdAt: now, updatedAt: now,
    } as never);
  }
  const component = (id: string, subsystem: string, componentType: string, extra: Record<string, unknown> = {}): void => {
    saveSpec('component', {
      id, name: id, description: `${id} component`, subsystem, componentType, owns: [], dependsOn: [],
      status: 'complete', createdAt: now, updatedAt: now, ...extra,
    } as never);
  };
  component('link_store', 'links', 'Store', { durability: 'ram-projection' });
  component('hit_store', 'analytics', 'Store', { durability: 'ram-projection' });
  component('link_repository', 'links', 'Repository', { owns: ['link_store'] });
  component('link_workflow', 'links', 'Orchestrator', { dependsOn: ['link_repository'] });
  component('stats_portal', 'analytics', 'Portal', { transport: 'HTTP', dependsOn: ['link_workflow'] });
  saveSpec('type', {
    kind: 'value-object', id: 'hit_stats', name: 'HitStats', subsystem: 'analytics',
    fields: [{ name: 'hits', type: 'int' }], methods: [], createdAt: now, updatedAt: now,
  } as never);
  saveSpec('interface', {
    id: 'ilink_repository', name: 'Repo', description: 'repo', component: 'link_repository',
    methods: [{ name: 'find', description: 'finds', params: [{ name: 'code', type: 'string', previousNames: ['shortCode'] }], returns: 'string' }],
    status: 'draft', createdAt: now, updatedAt: now,
  } as never);
  saveSpec('implementation', {
    id: 'link_repository_impl', name: 'RepoImpl', description: 'repo impl', contract: 'ilink_repository',
    technologies: ['postgres', 'redis'],
    methods: [{ name: 'find', narrative: [] }], status: 'draft', createdAt: now, updatedAt: now,
  } as never);
  saveSpec('interface', {
    id: 'istats_portal', name: 'Stats', description: 'stats', component: 'stats_portal',
    methods: [
      { name: 'statsFor', description: 'stats', params: [{ name: 'code', type: 'string' }], returns: 'HitStats', endpoint: { transport: 'HTTP', method: 'GET', path: '/stats/{code}' } },
      { name: 'topLinks', description: 'top', params: [], returns: 'list<HitStats>', endpoint: { transport: 'HTTP', method: 'GET', path: '/top' } },
    ],
    status: 'draft', createdAt: now, updatedAt: now,
  } as never);
  invalidateSpecCache();
  return proj;
}

/** Every spec file under the tree, relative, sorted. */
function files(proj: string): string[] {
  const root = path.join(proj, '.wai', 'specs');
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else out.push(path.relative(root, p).split(path.sep).join('/'));
    }
  };
  walk(root);
  return out.sort();
}

describe('N1: a delta never changes which spec it is or where it lives', () => {
  it('refuses a new id, naming the rename tool, and writes no twin', () => {
    const proj = seed();
    const before = files(proj);
    expect(() => updateSpecGated('component', 'stats_portal', { id: 'renamed_by_update' }))
      .toThrow(/"id" is the spec's identity.*sdd_rename_component.*Nothing was written/s);
    expect(() => updateSpecGated('component', 'stats_portal', { id: 'renamed_by_update' }, true)).toThrow(/sdd_rename_component/);
    expect(files(proj)).toEqual(before);
    expect(() => updateSpecGated('type', 'hit_stats', { id: 'other' })).toThrow(/sdd_rename_type/);
  });

  it('refuses moving a component or a type to another subsystem, saying no tool does it yet', () => {
    const proj = seed();
    const before = files(proj);
    expect(() => updateSpecGated('component', 'stats_portal', { subsystem: 'links' }))
      .toThrow(/"subsystem" is where the component lives.*no tool moves a component to another subsystem.*\(owed\)/s);
    expect(() => updateSpecGated('type', 'hit_stats', { subsystem: 'links' })).toThrow(/no tool moves a type/);
    expect(() => updateSpecGated('type', 'hit_stats', { unset: ['subsystem'] })).toThrow(/no tool moves a type/);
    expect(files(proj)).toEqual(before);
  });

  it('refuses a contract changing component and an implementation changing contract, naming sdd_move_methods', () => {
    seed();
    expect(() => updateSpecGated('interface', 'istats_portal', { component: 'link_workflow' })).toThrow(/sdd_move_methods/);
    expect(() => updateSpecGated('implementation', 'link_repository_impl', { contract: 'istats_portal' })).toThrow(/sdd_move_methods/);
    expect(() => updateSpecGated('component', 'link_store', { createdAt: '2020-01-01T00:00:00.000Z' })).toThrow(/"createdAt"/);
  });

  it('accepts a restated id or subsystem, and still repairs a stray whose subsystem the tree does not have', () => {
    seed();
    expect(() => updateSpecGated('component', 'stats_portal', { id: 'stats_portal', subsystem: 'analytics', description: 'still editable' })).not.toThrow();
    saveSpec('component', { id: 'stray', name: 'Stray', description: 'd', subsystem: 'ghost', componentType: 'Orchestrator', owns: [], dependsOn: [], status: 'draft', createdAt: now, updatedAt: now } as never);
    invalidateSpecCache();
    expect(() => updateSpecGated('component', 'stray', { subsystem: 'links' })).not.toThrow();
    invalidateSpecCache();
    expect(loadComponentSpec('stray')?.subsystem).toBe('links');
  });
});

describe('N2: deleting a container takes its subtree, and is refused while others reference it', () => {
  it('plans exactly what goes and what references it (spec_index.subtreeOf / referencesTo)', () => {
    seed();
    const index = scanAllSpecs({ memberDepth: 0 });
    expect(specIndexSubtreeOf(index, 'component', 'link_repository')).toEqual([
      { kind: 'component', id: 'link_store' },
      { kind: 'implementation', id: 'link_repository_impl' },
      { kind: 'interface', id: 'ilink_repository' },
      { kind: 'component', id: 'link_repository' },
    ]);
    const refs = specIndexReferencesTo(index, specIndexSubtreeOf(index, 'component', 'link_repository'));
    expect(refs).toEqual([{ kind: 'component', id: 'link_workflow', position: 'dependsOn', target: { kind: 'component', id: 'link_repository' } }]);
    const typeRefs = specIndexReferencesTo(index, specIndexSubtreeOf(index, 'type', 'hit_stats'));
    expect(typeRefs.map((r) => `${r.id} ${r.position}`).sort()).toEqual(['istats_portal methods.statsFor', 'istats_portal methods.topLinks']);
  });

  it('a dry run lists the plan and removes nothing', () => {
    const proj = seed();
    const before = files(proj);
    const plan = deleteSpec('subsystem', 'links', true);
    expect(plan.dryRun).toBe(true);
    expect(plan.deleted).toBe(false);
    expect(plan.removed.map((r) => `${r.kind}:${r.id}`)).toEqual([
      'component:link_store', 'implementation:link_repository_impl', 'interface:ilink_repository', 'component:link_repository',
      'component:link_workflow', 'subsystem:links',
    ]);
    expect(plan.references).toEqual([{ kind: 'component', id: 'stats_portal', position: 'dependsOn', target: { kind: 'component', id: 'link_workflow' } }]);
    expect(files(proj)).toEqual(before);
  });

  it('refuses a referenced deletion, naming each reference, and removes nothing', () => {
    const proj = seed();
    const before = files(proj);
    expect(() => deleteSpec('type', 'hit_stats')).toThrow(/Refusing to delete type "hit_stats".*interface "istats_portal" \(methods\.statsFor\).*force: true.*Nothing was deleted/s);
    expect(files(proj)).toEqual(before);
  });

  it('deletes a component with its contract, implementation and owned members, leaving no file behind', () => {
    const proj = seed();
    // The one referrer edited first, as the refusal says.
    updateSpecGated('component', 'link_workflow', { dependsOn: [{ value: 'link_repository', action: 'delete' }] });
    const deletion = deleteSpec('component', 'link_repository');
    expect(deletion.deleted).toBe(true);
    expect(deletion.references).toEqual([]);
    invalidateSpecCache();
    for (const [kind, id] of [['component', 'link_store'], ['interface', 'ilink_repository'], ['implementation', 'link_repository_impl'], ['component', 'link_repository']] as const) {
      expect(loadSpec(kind, id), `${kind} ${id}`).toBeNull();
    }
    expect(files(proj).filter((f) => f.includes('link_repository') || f.includes('link_store'))).toEqual([]);
  });

  it('force deletes a whole subsystem and answers the references it left dangling', () => {
    const proj = seed();
    const deletion = deleteSpec('subsystem', 'links', false, true);
    expect(deletion.deleted).toBe(true);
    expect(deletion.references.map((r) => r.id)).toEqual(['stats_portal']);
    expect(files(proj).filter((f) => f.startsWith('links/'))).toEqual([]);
    invalidateSpecCache();
    expect(loadSpec('subsystem', 'links')).toBeNull();
  });
});

describe('list edits: reorder, element-level reports, unset, and a dry run that is refused like the write', () => {
  it('applies a reorder of a plain list and of an identified list, and reports it', () => {
    seed();
    const tech = updateSpecGated('implementation', 'link_repository_impl', { technologies: ['redis', 'postgres'] });
    expect(tech.written).toBe(true);
    expect(tech.changes).toEqual([expect.objectContaining({ path: 'technologies', change: 'reordered' })]);
    expect((loadSpec('implementation', 'link_repository_impl') as { technologies: string[] }).technologies).toEqual(['redis', 'postgres']);
    const req = updateSpec('system', 'system', { globalRequirements: ['three', 'two', 'one'] });
    expect(req.changes.map((c) => c.change)).toEqual(['reordered']);
    const bounds = updateSpec('system', 'system', { boundaries: [{ name: 'second' }, { name: 'first' }] });
    expect(bounds.changes).toEqual([expect.objectContaining({ path: 'boundaries', change: 'reordered' })]);
    // A delta that adds still appends.
    updateSpec('system', 'system', { globalRequirements: ['four'] });
    expect((loadSpec('system', 'system') as { globalRequirements: unknown[] }).globalRequirements).toEqual(['three', 'two', 'one', 'four']);
  });

  it('reports a mixed list edit value by value, never as the whole list set', () => {
    seed();
    const report = updateSpec('system', 'system', { globalRequirements: ['five', { value: 'two', action: 'delete' }, { description: 'six' }] });
    expect(report.changes.map((c) => `${c.change} ${c.after ?? c.before}`)).toEqual(['removed two', 'added five', 'added {"description":"six"}']);
    expect(report.changes.some((c) => c.change === 'set')).toBe(false);
  });

  it('an unset of a defaulted list reports the removal without a contradicting NO EFFECT', () => {
    seed();
    const report = updateSpecGated('component', 'link_workflow', { unset: ['dependsOn'] }, true);
    expect(report.changes.map((c) => c.change)).toEqual(['cleared']);
    expect(report.ineffective).toEqual([]);
  });

  it('a dry run is refused exactly when the write is (an object in a plain list, an unset required field)', () => {
    seed();
    for (const [kind, id, delta] of [
      ['implementation', 'link_repository_impl', { technologies: [{ name: 'redis', role: 'store', version: '7' }] }],
      ['system', 'system', { unset: ['vision'] }],
    ] as const) {
      let dry = '';
      let write = '';
      try { updateSpecGated(kind, id, delta as never, true); } catch (e) { dry = String(e); }
      try { updateSpecGated(kind, id, delta as never); } catch (e) { write = String(e); }
      expect(dry, `${kind} dry run`).not.toBe('');
      expect(dry).toBe(write);
    }
  });
});

describe('property: a dry run and the write give the same verdict and the same report', () => {
  // A small deterministic generator (no extra dependency): deltas drawn from
  // the edits the trials made — adds, deletes, reorders, unsets, renames of
  // identity, bad shapes — each run as a dry run and then for real on a fresh tree.
  const pick = <T>(rnd: () => number, xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)];
  const deltas: ReadonlyArray<() => [string, string, Record<string, unknown>]> = [
    () => ['system', 'system', { globalRequirements: ['two', 'one', 'three'] }],
    () => ['system', 'system', { globalRequirements: ['seven'] }],
    () => ['system', 'system', { globalRequirements: [{ value: 'nine', action: 'delete' }] }],
    () => ['system', 'system', { unset: ['vision'] }],
    () => ['system', 'system', { boundaries: [{ name: 'second' }, { name: 'first' }] }],
    () => ['implementation', 'link_repository_impl', { technologies: [{ name: 'x' }] }],
    () => ['implementation', 'link_repository_impl', { technologies: [{ value: 'redis', action: 'delete' }, 'kafka'] }],
    () => ['component', 'link_workflow', { unset: ['dependsOn'] }],
    () => ['component', 'link_workflow', { dependsOn: ['link_store'] }],
    () => ['component', 'stats_portal', { dependsOn: ['hit_store'] }],
    () => ['component', 'stats_portal', { id: 'elsewhere' }],
    () => ['component', 'stats_portal', { description: 'x'.repeat(300) }],
    () => ['interface', 'istats_portal', { methods: [{ name: 'topLinks', endpoint: { transport: 'HTTP', method: 'GET', path: '/stats/{other}' } }] }],
    () => ['interface', 'istats_portal', { methods: [{ name: 'topLinks' }, { name: 'statsFor' }] }],
    () => ['type', 'hit_stats', { fields: [{ name: 'hits', type: 'number' }] }],
  ];
  it('holds for 30 random deltas', () => {
    let s = 7;
    const rnd = (): number => { s = (s * 16807) % 2147483647; return s / 2147483647; };
    const outcome = (dryRun: boolean, kind: string, id: string, delta: Record<string, unknown>): unknown => {
      try {
        const r = updateSpecGated(kind as never, id, JSON.parse(JSON.stringify(delta)), dryRun);
        return { changes: r.changes, ineffective: r.ineffective, notices: r.notices, respellings: r.respellings };
      } catch (e) {
        return { refused: String(e) };
      }
    };
    for (let n = 0; n < 30; n++) {
      const [kind, id, delta] = pick(rnd, deltas)();
      seed();
      const dry = outcome(true, kind, id, delta);
      const write = outcome(false, kind, id, delta);
      expect(dry, `${kind} ${id} ${JSON.stringify(delta)}`).toEqual(write);
    }
  }, 180_000);
});

describe('the gate reports the design errors a write introduces', () => {
  it('refuses a Portal -> Store dependsOn on a delta, its dry run, and a create', () => {
    seed();
    for (const dryRun of [true, false]) {
      expect(() => updateSpecGated('component', 'stats_portal', { dependsOn: ['hit_store'] }, dryRun))
        .toThrow(/would introduce an error.*ARCHITECTURE_VIOLATION_PORTAL_FORBIDDEN_DEP.*Nothing was written/s);
    }
    invalidateSpecCache();
    expect(loadComponentSpec('stats_portal')?.dependsOn).toEqual(['link_workflow']);
    expect(() => writeSpec({
      kind: 'component',
      spec: { id: 'admin_portal', name: 'Admin', description: 'admin', subsystem: 'analytics', componentType: 'Portal', transport: 'HTTP', owns: [], dependsOn: ['hit_store'] } as never,
      fields: ['id', 'name', 'description', 'subsystem', 'componentType', 'transport', 'owns', 'dependsOn'],
    })).toThrow(/ARCHITECTURE_VIOLATION_PORTAL_FORBIDDEN_DEP/);
  });

  it('refuses a duplicate route bound by a delta (the sdd_set_endpoints path)', () => {
    seed();
    expect(() => updateSpecGated('interface', 'istats_portal', { methods: [{ name: 'topLinks', endpoint: { transport: 'HTTP', method: 'GET', path: '/stats/{other}' } }] }))
      .toThrow(/ENDPOINT_ROUTE_DUPLICATE/);
  });

  it('does not refuse what the tree already held, nor a code the project tuned down', () => {
    const proj = seed();
    // A violation already on disk does not block an unrelated edit.
    saveSpec('component', { ...(loadComponentSpec('stats_portal') as object), dependsOn: ['link_workflow', 'hit_store'] } as never);
    invalidateSpecCache();
    expect(() => updateSpecGated('component', 'stats_portal', { description: 'unrelated' })).not.toThrow();
    // Tuned to a warning: written, and said as a notice.
    fs.writeFileSync(path.join(proj, '.wai', 'project.yaml'), JSON.stringify({
      ...PROJECT, rules: { sddRuleSeverity: { ARCHITECTURE_VIOLATION_PORTAL_FORBIDDEN_DEP: 'warning' } },
    }));
    const report = updateSpecGated('component', 'link_workflow', { description: 'x' });
    expect(report.written).toBe(true);
    saveSpec('component', { ...(loadComponentSpec('stats_portal') as object), dependsOn: ['link_workflow'] } as never);
    invalidateSpecCache();
    const tuned = updateSpecGated('component', 'stats_portal', { dependsOn: ['hit_store'] });
    expect(tuned.written).toBe(true);
    expect(tuned.notices.some((n) => n.startsWith('ARCHITECTURE_VIOLATION_PORTAL_FORBIDDEN_DEP'))).toBe(true);
  });
});

describe('a rename back to a retired name is refused, its own trace included', () => {
  it('a parameter back to a name it had', () => {
    seed();
    expect(() => renameParam('link_repository', 'find', 'code', 'shortCode', true)).toThrow(/name-retired:.*"code".*lists "shortCode".*its own name/s);
  });

  it('a field back to a name it had', () => {
    seed();
    updateSpec('type', 'hit_stats', { fields: [{ name: 'hits', previousNames: ['count'] }] });
    expect(() => renameField('hit_stats', 'hits', 'count', true)).toThrow(/name-retired:.*"hits".*lists "count"/s);
  });
});
