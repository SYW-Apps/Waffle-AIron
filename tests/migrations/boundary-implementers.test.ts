import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import * as path from 'path';
import { invalidateSpecCache } from '../../src/core/specs.js';
import { readYamlFile, writeYamlFile } from '../../src/utils/yaml.js';
import { validateFamily, type ValidationIssue } from '../../src/core/validation.js';
import { at, migrate, newFindings, plan } from '../helpers/family-verbs.js';
import { component, contract, implementation, isolateGlobals, projectYaml, specs, subsystem, system, tempDir } from '../helpers/stage8-family.js';
import * as migrations from '../../src/migrations/index.js';

// ---------------------------------------------------------------------------
// An abstraction published with role implement and restricted by a consumers
// list: the subsystems that IMPLEMENT it are its consumers as much as the ones
// that depend on it. Demote and internalize restore them across the old
// boundary exactly as they restore dependents (core_orchestrator_impl
// demoteMember step 18, internalizeMember step 23).
// ---------------------------------------------------------------------------

const cleanups: (() => void)[] = [];
let restore: () => void;
beforeEach(() => {
  restore = isolateGlobals(cleanups);
});
afterEach(() => {
  restore();
  for (const c of cleanups.splice(0).reverse()) c();
  invalidateSpecCache();
});

const method = { name: 'carry', description: 'Carry one load.', params: [{ name: 'weight', type: 'int' }], returns: 'void', effect: 'write' };

/** One live implementer of the abstraction, in a subsystem of `dir`. */
function implementer(dir: string, sub: string, id: string): void {
  component(dir, sub, id, 'Adapter', [], { invokedBy: { kind: 'runtime', caller: 'The composition root hands each load to a carrier.' } });
  contract(dir, sub, id, [method]);
  const file = specs(dir, sub, id, '.interface.yaml');
  writeYamlFile(file, { ...(readYamlFile(file) as object), implements: ['carrier'] });
  implementation(dir, sub, id, `i${id}`, [{ name: 'carry', narrative: [{ stepNumber: 1, type: 'local', description: 'Carry the load and keep its receipt.' }] }]);
}

/** The fleet: the abstraction in `api`, an implementer in `carriers`, another in `vehicles` — a PART at services/vehicles. */
function writeFleet(root: string): { root: string; part: string } {
  projectYaml(root, { id: 'fleet', name: 'Fleet', members: { vehicles: 'services/vehicles' } });
  system(root, 'Fleet');
  subsystem(root, 'Fleet', 'api', { publicInterfaces: [{ details: 'The contract each carrier implements.', component: 'carrier', role: 'implement', consumers: ['carriers', 'vehicles'] }] });
  component(root, 'api', 'carrier', 'Adapter', [], { abstract: true, invokedBy: { kind: 'runtime', caller: 'The composition root hands each load to a carrier.' } });
  contract(root, 'api', 'carrier', [method]);
  implementation(root, 'api', 'carrier', 'icarrier', [{ name: 'carry' }]);
  subsystem(root, 'Fleet', 'carriers');
  implementer(root, 'carriers', 'courier');
  const part = path.join(root, 'services', 'vehicles');
  subsystem(part, 'Fleet', 'vehicles');
  implementer(part, 'vehicles', 'truck');
  return { root, part };
}

const errorsOf = (root: string): string[] =>
  at(root, () => validateFamily({ family: true })).issues.filter((i: ValidationIssue) => i.severity === 'error').map((i) => `${i.code} @${i.specId ?? '-'}`).sort();

const consumersOf = (dir: string): string[] | undefined =>
  (readYamlFile(specs(dir, 'api', '.index.yaml')) as { publicInterfaces: { consumers?: string[] }[] }).publicInterfaces[0].consumers;

describe('consumers restored for the implementers of an abstraction', () => {
  it('demote: the implementing subsystem across the old boundary is a consumer again; plan = apply; no ABSTRACTION_UNPUBLISHED', () => {
    const { root } = writeFleet(path.join(tempDir(cleanups, 'wairon-implementers-'), 'fleet'));
    const before = errorsOf(root);
    migrate(root, { verb: 'promote', alias: 'vehicles' });
    invalidateSpecCache();
    expect(consumersOf(root)).toEqual(['carriers']);

    const planned = plan(root, { verb: 'demote', alias: 'vehicles' });
    expect(planned.refusals).toEqual([]);
    expect(planned.edits.map((e) => e.detail).join('\n')).toMatch(/consumers across the old boundary restored: api carrier: vehicles/);
    const report = at(root, () => migrations.apply(planned));
    expect(report.applied).toBe(true);
    invalidateSpecCache();

    expect(consumersOf(root)).toEqual(['carriers', 'vehicles']);
    const after = errorsOf(root);
    expect(after.filter((e) => e.startsWith('ABSTRACTION_UNPUBLISHED'))).toEqual([]);
    expect(newFindings(before, after)).toEqual([]);
  });

  it('internalize: the same restoration, named in the plan', () => {
    const { root } = writeFleet(path.join(tempDir(cleanups, 'wairon-implementers-'), 'fleet'));
    const before = errorsOf(root);
    migrate(root, { verb: 'promote', alias: 'vehicles' });
    invalidateSpecCache();
    expect(consumersOf(root)).toEqual(['carriers']);

    const planned = plan(root, { verb: 'internalize', alias: 'vehicles' });
    expect(planned.refusals).toEqual([]);
    expect(planned.edits.map((e) => e.detail).join('\n')).toMatch(/consumers across the old boundary restored: api carrier: vehicles/);
    const report = at(root, () => migrations.apply(planned));
    expect(report.applied).toBe(true);
    invalidateSpecCache();

    expect(consumersOf(root)).toEqual(['carriers', 'vehicles']);
    const after = errorsOf(root);
    expect(after.filter((e) => e.startsWith('ABSTRACTION_UNPUBLISHED'))).toEqual([]);
    expect(newFindings(before, after)).toEqual([]);
  });
});
