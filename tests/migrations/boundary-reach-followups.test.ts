import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { setProjectRoot } from '../../src/utils/fs.js';
import { invalidateSpecCache, updateSpec } from '../../src/core/specs.js';
import { validateFamily, validateProject } from '../../src/core/validation.js';
import { at, migrate, plan } from '../helpers/family-verbs.js';
import { tempDir, isolateGlobals, writeClinic, specs, component, contract, implementation, subsystem, type, projectYaml, system } from '../helpers/stage8-family.js';

// ---------------------------------------------------------------------------
// The follow-up work a boundary migration used to leave silent (round-2
// platform trial): a promote declares the entries its new boundary made
// necessary (the parent's modelled calls into the new project's Portal), the
// plan names the topics now crossing it, the family run pairs those topics
// across projects, and an externalize re-roots the types' sourcePaths with
// the implementations'. And a member's spec is never written from the root.
// ---------------------------------------------------------------------------

describe('promote: the entries and topics a new boundary makes', () => {
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
      try { c(); } catch { /* windows locks */ }
    }
  });

  /** The clinic, with the frontdesk calling the part's schedule-portal and the part emitting a topic the frontdesk consumes. */
  function clinic(): { root: string; part: string } {
    const made = writeClinic(path.join(tempDir(cleanups, 'wairon-reach-followups-'), 'clinic'));
    const { root, part } = made;
    contract(part, 'scheduling', 'schedule-portal', [{ name: 'open', description: 'Open a slot', signature: 'open(): void', returns: 'void' }]);
    contract(root, 'frontdesk', 'checkin-client', [{ name: 'checkIn', description: 'Check a patient in', signature: 'checkIn(): void', returns: 'void', invokedBy: { kind: 'runtime', caller: 'The front desk worker, once per arriving patient.' } }]);
    implementation(root, 'frontdesk', 'checkin-client', 'icheckin-client', [{
      name: 'checkIn', narrative: [{ stepNumber: 1, description: 'Open a slot', type: 'call', targetComponent: 'schedule-portal', targetMethod: 'open' }],
    }]);
    component(part, 'scheduling', 'booking-publisher', 'Adapter', [], { emits: [{ topic: 'booking.made' }] });
    component(root, 'frontdesk', 'booking-observer', 'Observer', [], { subscribesTo: [{ topic: 'booking.made' }] });
    return made;
  }

  it('declares a network entry on each verb the parent calls, and lists it in the plan', () => {
    const { root, part } = clinic();
    const planned = plan(root, { verb: 'promote', alias: 'scheduling' });
    expect(planned.refusals).toEqual([]);
    // The plan is rehearsed: it names the entry before anything is applied.
    expect(planned.edits.map((e) => e.detail).filter((d) => d.startsWith('entry declared'))).toEqual([
      expect.stringContaining('schedule-portal.open: entry (network) — called by checkin-client of clinic'),
    ]);
    migrate(root, { verb: 'promote', alias: 'scheduling' });
    const stored = yaml.load(fs.readFileSync(specs(part, 'scheduling', 'schedule-portal', '.interface.yaml'), 'utf-8')) as { methods: { name: string; invokedBy?: Record<string, string> }[] };
    expect(stored.methods[0].invokedBy).toMatchObject({ kind: 'entry', scope: 'network' });
    expect(stored.methods[0].invokedBy!.caller).toMatch(/checkin-client of clinic/);
  });

  it('names the topics now crossing the boundary, and the family run pairs them while the member alone reports them', () => {
    const { root, part } = clinic();
    const planned = plan(root, { verb: 'promote', alias: 'scheduling' });
    expect(planned.notes.join('\n')).toMatch(/booking\.made: emitted by booking-publisher \(the new project\), consumed in clinic by booking-observer/);
    migrate(root, { verb: 'promote', alias: 'scheduling' });
    const family = at(root, () => validateFamily({ family: true }));
    expect(family.issues.filter((i) => i.code === 'UNCONSUMED_TOPIC')).toEqual([]);
    const alone = at(part, () => validateProject());
    expect(alone.issues.filter((i) => i.code === 'UNCONSUMED_TOPIC').map((i) => i.specId)).toEqual(['booking-publisher']);
  });

  it('refuses sdd_update_spec on a member project\'s spec from the root, naming the member folder, writing nothing', () => {
    const { root, part } = clinic();
    migrate(root, { verb: 'promote', alias: 'scheduling' });
    const file = specs(part, 'scheduling', 'schedule-portal', '.index.yaml');
    const before = fs.readFileSync(file, 'utf-8');
    expect(() => at(root, () => updateSpec('component', 'scheduling::schedule-portal', { description: 'Changed from the root' })))
      .toThrow(/chained-spec: "scheduling::schedule-portal" lives in another project.*services\/scheduling.*sdd_update_spec component schedule-portal/s);
    expect(fs.readFileSync(file, 'utf-8')).toBe(before);
  });
});

describe('externalize: types are re-rooted with the implementations', () => {
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
      try { c(); } catch { /* windows locks */ }
    }
  });

  it('re-expresses a moved type\'s sourcePath (and its methods\') relative to the member root', () => {
    const root = path.join(tempDir(cleanups, 'wairon-type-reroot-'), 'shop');
    projectYaml(root, { id: 'shop', name: 'Shop' });
    system(root, 'Shop');
    subsystem(root, 'Shop', 'payments');
    component(root, 'payments', 'payment-store', 'Store', [], { durability: 'cache' });
    type(specs(root, 'payments', 'types', 'payment.yaml'), 'payment', [{ name: 'amount', type: 'int' }], {
      subsystem: 'payments', sourcePath: 'services/payments/src/domain/payment.ts',
    });
    migrate(root, { verb: 'externalize', subsystem: 'payments', path: 'services/payments' });
    const moved = fs.readdirSync(path.join(root, 'services', 'payments', '.wai', 'specs'), { recursive: true }) as string[];
    const typeFile = moved.find((f) => f.replace(/\\/g, '/').endsWith('payment.yaml'))!;
    const stored = yaml.load(fs.readFileSync(path.join(root, 'services', 'payments', '.wai', 'specs', typeFile), 'utf-8')) as { sourcePath: string };
    expect(stored.sourcePath).toBe('src/domain/payment.ts');
  });
});
