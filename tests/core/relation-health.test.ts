import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { setProjectRoot } from '../../src/utils/fs.js';
import { invalidateSpecCache } from '../../src/core/specs.js';
import { familyRelations } from '../../src/core/validation.js';
import { pinExternals } from '../../src/core/surfaces.js';
import { advanceMember } from '../../src/core/index.js';
import { buildCanvasModel, type CanvasModel } from '../../src/core/canvas.js';
import { runDiagram } from '../../src/commands/diagram.js';
import { relationHealth, type ExternalStatus, type ProjectRelations } from '../../src/models/index.js';
import {
  tempDir, isolateGlobals, bareFrom, pushChange, component, writeLedger, renameLedgerMethod, writeShop,
} from '../helpers/stage8-family.js';

// ---------------------------------------------------------------------------
// Relation health on the canvas: ExternalStatus.health(), the family's
// relations (family_validator.relations) for every shape a relation takes — a
// referenced project member (git through a LOCAL bare repository, and a `../`
// sibling), a contained project member (judged from the consumer's own gate),
// a declared external drawn as its own node, an unreachable producer — and the
// canvas model and the `wairon diagram` page that carry them. Real temp
// directories; HOME, USERPROFILE, APPDATA, LOCALAPPDATA and WAIRON_CACHE_DIR
// redirected. Nothing on the path under test is mocked.
// ---------------------------------------------------------------------------

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

function bind(dir: string): void {
  setProjectRoot(dir);
  invalidateSpecCache();
}

/** The family's relations and the canvas model built over them, at a bound root. */
function canvasAt(dir: string): { relations: ProjectRelations[]; model: CanvasModel } {
  bind(dir);
  const relations = familyRelations();
  bind(dir);
  return { relations, model: buildCanvasModel([], relations) };
}

/** The one relation the checkout's consumption edge names. */
function checkoutRelation(model: CanvasModel) {
  const edge = model.edges.find((e) => e.from === 'checkout' && e.consumption);
  expect(edge, JSON.stringify(model.edges)).toBeDefined();
  const relation = model.relations?.find((r) => r.id === edge!.relation);
  expect(relation, JSON.stringify(model.relations)).toBeDefined();
  return { edge: edge!, relation: relation! };
}

const status = (over: Partial<ExternalStatus>): ExternalStatus => ({
  alias: 'x', project: 'x', sourceKind: 'path', pinned: true, reachable: true, stale: false, uses: [], ...over,
});

describe('ExternalStatus.health() — incompatible > unavailable > drifted > ok', () => {
  it('a known break outranks the unknown, the unknown a benign change; ok only when everything compared unchanged', () => {
    const unchanged = { publicName: 'p', member: 'm', state: 'unchanged' as const };
    expect(relationHealth(status({ uses: [unchanged] }))).toBe('ok');
    expect(relationHealth(status({ uses: [unchanged], drifted: true }))).toBe('drifted');
    expect(relationHealth(status({ uses: [unchanged, { state: 'unlocked' }], drifted: true }))).toBe('unavailable');
    expect(relationHealth(status({ uses: [{ state: 'unavailable' }], drifted: true }))).toBe('unavailable');
    expect(relationHealth(status({ reachable: false, uses: [] }))).toBe('unavailable');
    expect(relationHealth(status({ outOfReach: true, uses: [unchanged] }))).toBe('unavailable');
    expect(relationHealth(status({ uses: [{ state: 'unavailable' }, { publicName: 'p', state: 'changed' }], reachable: true, drifted: true }))).toBe('incompatible');
    expect(relationHealth(status({ uses: [{ publicName: 'p', state: 'removed' }], reachable: false }))).toBe('incompatible');
  });
});

describe('family_validator.relations — a referenced project member', () => {
  it('git, through a local bare repository: ok at the pin with its commit, incompatible once the pinned commit renames a used method', () => {
    const base = tempDir(cleanups, 'wairon-rh-git-');
    const work = path.join(base, 'ledger-work');
    writeLedger(work);
    const repo = bareFrom(cleanups, work, 'ledger');
    const shop = path.join(base, 'shop');
    writeShop(shop, { members: { ledger: `${repo.url}#${repo.commit}` } });
    bind(shop);
    pinExternals();
    let { relations, model } = canvasAt(shop);
    expect(relations.map((r) => r.project)).toEqual(['', 'ledger']);
    expect(relations[0].comparedAt).toMatch(/^\d{4}-\d\d-\d\dT/);
    let { edge, relation } = checkoutRelation(model);
    expect(edge.to).toBe('ledger');
    expect(relation).toMatchObject({ id: '→ledger', consumer: '', producer: 'ledger', health: 'ok', pinnedCommit: repo.commit, unchanged: 1, uses: [] });
    expect(relation.pinnedDigest).toMatch(/^sha256:/);
    // The producer renames the used method; the member moves to it, the pin does not.
    renameLedgerMethod(work, 'record');
    pushChange(work, repo.bare, 'rename post to record');
    bind(shop);
    advanceMember('ledger');
    ({ model } = canvasAt(shop));
    ({ relation } = checkoutRelation(model));
    expect(relation.health).toBe('incompatible');
    expect(relation.uses).toEqual([expect.objectContaining({ name: 'ledger-portal.post', state: expect.stringMatching(/changed|removed/) })]);
  });

  it('a `../` sibling: ok at the pin, incompatible after the sibling renames a used method', () => {
    const base = tempDir(cleanups, 'wairon-rh-sib-');
    const ledger = path.join(base, 'ledger');
    writeLedger(ledger);
    const shop = path.join(base, 'shop');
    writeShop(shop, { members: { ledger: '../ledger' } });
    bind(shop);
    pinExternals();
    expect(checkoutRelation(canvasAt(shop).model).relation.health).toBe('ok');
    renameLedgerMethod(ledger, 'record');
    expect(checkoutRelation(canvasAt(shop).model).relation.health).toBe('incompatible');
  });
});

describe('family_validator.relations — a contained project member', () => {
  it('is no external, yet its relation is answered from the consumer\'s own gate: ok, then incompatible after an unexported use', () => {
    const base = tempDir(cleanups, 'wairon-rh-cont-');
    const shop = path.join(base, 'shop');
    writeShop(shop, { members: { ledger: 'ledger' } });
    const ledger = path.join(shop, 'ledger');
    writeLedger(ledger);
    let { relations, model } = canvasAt(shop);
    // The contained member is read at its own root too, and the root's status names it under its alias.
    expect(relations.map((r) => r.project)).toEqual(['', 'ledger']);
    expect(relations[0].externals).toEqual([expect.objectContaining({ alias: 'ledger', sourceKind: 'family', pinned: false, reachable: true })]);
    let { edge, relation } = checkoutRelation(model);
    expect(edge.to).toBe('ledger::ledger-portal');
    expect(relation).toMatchObject({ id: '→ledger', producer: 'ledger', health: 'ok', unchanged: 1 });
    expect(relation.pinnedDigest).toBeUndefined();
    // A use of something the member does not export: its own gate raises
    // EXTERNAL_NOT_EXPORTED there, and the relation reads incompatible.
    component(ledger, 'books', 'ledger-store', 'Store');
    component(shop, 'sales', 'checkout', 'Adapter', ['ledger::ledger-portal', 'ledger::ledger-store']);
    ({ model } = canvasAt(shop));
    ({ relation } = checkoutRelation(model));
    expect(relation.health).toBe('incompatible');
    expect(relation.uses).toEqual([expect.objectContaining({ name: 'ledger-store', state: 'removed' })]);
    expect(relation.uses[0].detail).toMatch(/exports no public name/);
    expect(relation.unchanged).toBe(1);
  });
});

describe('a declared external that is no project of the family', () => {
  it('is drawn as an external project node its consumption edge lands on, with the relation\'s health', () => {
    const base = tempDir(cleanups, 'wairon-rh-ext-');
    writeLedger(path.join(base, 'ledger'));
    const shop = path.join(base, 'shop');
    writeShop(shop, { externals: { ledger: { source: { path: '../ledger' } } } });
    bind(shop);
    pinExternals();
    const { model } = canvasAt(shop);
    const node = model.subsystems.find((s) => s.id === 'ledger');
    expect(node).toMatchObject({ project: true, external: true, storage: '../ledger' });
    const { edge, relation } = checkoutRelation(model);
    expect(edge.to).toBe('ledger');
    expect(relation.health, JSON.stringify(relation)).toBe('ok');
  });

  it('an unreachable producer is unavailable, never ok', () => {
    const base = tempDir(cleanups, 'wairon-rh-gone-');
    const shop = path.join(base, 'shop');
    writeShop(shop, { externals: { ledger: { source: { path: '../ledger' } } } });
    const { relations, model } = canvasAt(shop);
    expect(relations[0].externals[0]).toMatchObject({ alias: 'ledger', reachable: false });
    const { relation } = checkoutRelation(model);
    expect(relation.health).toBe('unavailable');
    expect(relation.detail ?? relation.uses.map((u) => u.detail).join(' ')).toBeTruthy();
  });

  it('a pair the relations do not answer is unavailable with the reason, never ok', () => {
    const base = tempDir(cleanups, 'wairon-rh-none-');
    writeLedger(path.join(base, 'ledger'));
    const shop = path.join(base, 'shop');
    writeShop(shop, { externals: { ledger: { source: { path: '../ledger' } } } });
    bind(shop);
    const model = buildCanvasModel([], [{ project: '', externals: [], comparedAt: '2026-10-03T00:00:00.000Z', detail: 'its root lies outside the request\'s reach' }]);
    expect(checkoutRelation(model).relation).toMatchObject({ health: 'unavailable', detail: 'its root lies outside the request\'s reach' });
  });
});

describe('wairon diagram', () => {
  /** The model a written canvas page embeds. */
  const embedded = (file: string): CanvasModel => JSON.parse(/var MODEL = (.*);\r?\n/.exec(fs.readFileSync(file, 'utf8'))![1]) as CanvasModel;

  it('computes health by default and freezes the relations with comparedAt; --no-health draws neutral edges and says not checked', async () => {
    const base = tempDir(cleanups, 'wairon-rh-cli-');
    writeLedger(path.join(base, 'ledger'));
    const shop = path.join(base, 'shop');
    writeShop(shop, { members: { ledger: '../ledger' } });
    bind(shop);
    pinExternals();
    bind(shop);
    const withHealth = path.join(base, 'with.html');
    await runDiagram({ canvas: true, out: withHealth });
    const frozen = embedded(withHealth);
    expect(frozen.relations).toEqual([expect.objectContaining({ id: '→ledger', health: 'ok', comparedAt: expect.stringMatching(/^\d{4}-/) })]);
    expect(frozen.edges.find((e) => e.consumption)?.relation).toBe('→ledger');

    bind(shop);
    const without = path.join(base, 'without.html');
    await runDiagram({ canvas: true, out: without, health: false });
    const neutral = embedded(without);
    expect(neutral.relations).toBeUndefined();
    const edge = neutral.edges.find((e) => e.consumption);
    expect(edge).toBeDefined();
    expect(edge!.relation).toBeUndefined();
    expect(fs.readFileSync(without, 'utf8')).toContain('health not checked');
  });
});
