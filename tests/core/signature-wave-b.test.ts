import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { setProjectRoot } from '../../src/utils/fs.js';
import { writeSpecFile } from '../../src/core/spec-files.js';
import { invalidateSpecCache, loadInterfaceSpec, moveMethods, signatureFacts, type SpecWriteHooks } from '../../src/core/specs.js';
import { repairSignatures } from '../../src/core/signature-repair.js';
import { resolveSignatures } from '../../src/core/index.js';
import { pinExternals } from '../../src/core/surfaces.js';
import { validateProject } from '../../src/core/validation.js';
import {
  ComponentSpecSchema,
  InterfaceSpecSchema,
  SubsystemSpecSchema,
  SystemSpecSchema,
  TypeSpecSchema,
} from '../../src/models/index.js';

// ---------------------------------------------------------------------------
// Stage 1 signatures, wave B: what the rules and the doctor read of the
// loader's facts, end to end on real temp trees — the doctor's repair (plan,
// apply, idempotence, what it never touches), a method move re-pointing the
// sources that name a moved method, an `alias::` signature type whose alias is
// not the producer's id, and a part judged alone resolving against its pinned
// parent excerpt.
// ---------------------------------------------------------------------------

const STAMP = '2026-10-03T00:00:00.000Z';
const specs = (dir: string, ...parts: string[]): string => path.join(dir, '.wai', 'specs', ...parts);
const readYaml = (file: string): any => yaml.load(fs.readFileSync(file, 'utf8'));
const RUN_PARAMS = [{ name: 'values', type: 'string[]' }, { name: 'mode', type: 'string', optional: true }];

let dirs: string[] = [];
let saved: Record<string, string | undefined> = {};
const REDIRECTED = ['WAIRON_CACHE_DIR', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA'] as const;

beforeEach(() => {
  saved = Object.fromEntries(REDIRECTED.map((k) => [k, process.env[k]]));
  const home = tempDir('wairon-sigb-home-');
  for (const k of REDIRECTED) process.env[k] = home;
});

afterEach(() => {
  setProjectRoot(null);
  invalidateSpecCache();
  for (const k of REDIRECTED) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  for (const d of dirs) {
    try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* windows locks */ }
  }
  dirs = [];
});

function tempDir(prefix: string): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  dirs.push(dir);
  return dir;
}

function bind(root: string): void {
  invalidateSpecCache();
  setProjectRoot(root);
}

function projectYaml(dir: string, fields: Record<string, unknown>): void {
  fs.mkdirSync(path.join(dir, '.wai'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.wai', 'project.yaml'), yaml.dump({
    schemaVersion: '1.0.0', targets: [], createdAt: STAMP, updatedAt: STAMP, ...fields,
  }));
}

function system(dir: string, name: string, publicInterfaces: Record<string, unknown>[] = []): void {
  writeSpecFile(specs(dir, '.index.yaml'), SystemSpecSchema.parse({
    schemaVersion: '1.0.0', name, vision: `${name} for the signature tests`, boundaries: [], globalRequirements: [],
    ...(publicInterfaces.length ? { publicInterfaces } : {}), createdAt: STAMP, updatedAt: STAMP,
  }));
}

function subsystem(dir: string, parentSystem: string, id: string): void {
  writeSpecFile(specs(dir, id, '.index.yaml'), SubsystemSpecSchema.parse({
    id, name: id, description: `The ${id} subsystem`, parentSystem, publicInterfaces: [], trustedLinks: [],
    status: 'complete', createdAt: STAMP, updatedAt: STAMP,
  }));
}

function component(dir: string, sub: string, id: string, dependsOn: string[] = []): void {
  writeSpecFile(specs(dir, sub, id, '.index.yaml'), ComponentSpecSchema.parse({
    id, name: id, description: `The ${id} component`, subsystem: sub, componentType: 'Orchestrator', owns: [], dependsOn,
    status: 'complete', createdAt: STAMP, updatedAt: STAMP,
  }));
}

function contract(dir: string, sub: string, comp: string, methods: Record<string, unknown>[]): string {
  const file = specs(dir, sub, comp, '.interface.yaml');
  writeSpecFile(file, InterfaceSpecSchema.parse({
    id: `i${comp}`, name: `i${comp}`, description: `The ${comp} contract`, component: comp, methods,
    status: 'complete', createdAt: STAMP, updatedAt: STAMP,
  }));
  return file;
}

function signatureType(file: string, id: string): void {
  writeSpecFile(file, TypeSpecSchema.parse({
    kind: 'signature', id, name: id, description: `The ${id} callback`,
    params: [{ name: 'event', type: 'string' }], returns: 'void', createdAt: STAMP, updatedAt: STAMP,
  }));
}

/**
 * One project, the toll line: `gate` depends on `meter`; meter's `charge`
 * stores a drifted text; gate's `tap` restates its source exactly. With a
 * conflict, the till's `refund` restates the same source with a different
 * returns — a contract only its author can settle.
 */
function tollLine(conflict = false): { root: string; meterFile: string; gateFile: string; tillFile: string } {
  const root = tempDir('wairon-sigb-');
  projectYaml(root, { name: 'Toll' });
  system(root, 'Toll');
  subsystem(root, 'Toll', 'lane');
  component(root, 'lane', 'meter');
  component(root, 'lane', 'gate', ['meter']);
  component(root, 'lane', 'till', ['meter']);
  const meterFile = contract(root, 'lane', 'meter', [
    { name: 'charge', description: 'Charge a passage', signature: 'charge(mode, values): void', returns: 'void', params: RUN_PARAMS },
  ]);
  const gateFile = contract(root, 'lane', 'gate', [
    { name: 'tap', description: 'Tap through', signatureFrom: 'meter.charge', params: RUN_PARAMS, returns: 'void' },
  ]);
  const tillFile = contract(root, 'lane', 'till', [
    { name: 'pay', description: 'Pay at the till', signatureFrom: 'meter.charge', params: RUN_PARAMS, returns: 'void' },
    { name: 'stamp', description: 'Stamp a receipt', signature: 'stamp(receipt): void', returns: 'void', params: [{ name: 'receipt', type: 'string' }] },
    ...(conflict ? [{ name: 'refund', description: 'Refund a tap', signatureFrom: 'meter.charge', params: RUN_PARAMS, returns: 'string' }] : []),
  ]);
  return { root, meterFile, gateFile, tillFile };
}

describe('core_orchestrator.repairSignatures', () => {
  it('plans the stale texts and the equal restatements, and writes nothing without apply', () => {
    const { root, meterFile, gateFile } = tollLine();
    bind(root);
    const before = [fs.readFileSync(meterFile, 'utf8'), fs.readFileSync(gateFile, 'utf8')];
    const plan = repairSignatures(false);
    expect(plan).toEqual(expect.arrayContaining([
      expect.objectContaining({ specId: 'imeter', kind: 'interface', dropped: [], regenerated: [expect.objectContaining({ method: 'charge', derived: 'charge(values: string[], mode?: string): void' })] }),
      expect.objectContaining({ specId: 'igate', kind: 'interface', dropped: ['tap'] }),
      expect.objectContaining({ specId: 'itill', dropped: ['pay'], regenerated: [expect.objectContaining({ method: 'stamp' })] }),
    ]));
    expect([fs.readFileSync(meterFile, 'utf8'), fs.readFileSync(gateFile, 'utf8')]).toEqual(before);
  });

  it("applies through the writer's stored form, and an applied run leaves an empty plan", () => {
    const { root, meterFile, gateFile } = tollLine();
    bind(root);
    repairSignatures(true);
    expect(readYaml(meterFile).methods[0].signature).toBe('charge(values: string[], mode?: string): void');
    expect(readYaml(gateFile).methods[0]).toEqual({ name: 'tap', description: 'Tap through', signatureFrom: 'meter.charge' });
    bind(root);
    expect(repairSignatures(false)).toEqual([]);
    expect(validateProject({}).issues.filter((i) => i.code === 'SIGNATURE_TEXT_STALE')).toEqual([]);
  });

  it('never repairs a DIFFERING restatement, nor the interface holding it: only its author knows the contract', () => {
    const { root, tillFile } = tollLine(true);
    bind(root);
    const before = fs.readFileSync(tillFile, 'utf8');
    const plan = repairSignatures(true);
    expect(plan.map((r) => r.specId).sort()).toEqual(['igate', 'imeter']);
    expect(fs.readFileSync(tillFile, 'utf8')).toBe(before);
    bind(root);
    expect(signatureFacts().sources).toContainEqual(expect.objectContaining({ method: 'refund', outcome: 'restated', differs: true }));
    expect(validateProject({}).issues.filter((i) => i.code === 'SIGNATURE_SOURCE_RESTATED').map((i) => i.specId)).toEqual(['itill']);
  });

  it("touches the bound project only: a contained member's stale text is its own doctor's", () => {
    const top = tempDir('wairon-sigb-top-');
    const member = path.join(top, 'meters');
    projectYaml(top, { id: 'toll', name: 'Toll', members: { meters: 'meters' } });
    system(top, 'Toll');
    projectYaml(member, { id: 'meters', name: 'Meters' });
    system(member, 'Meters');
    subsystem(member, 'Meters', 'lane');
    component(member, 'lane', 'meter');
    const memberFile = contract(member, 'lane', 'meter', [
      { name: 'charge', description: 'Charge a passage', signature: 'charge(mode, values): void', returns: 'void', params: RUN_PARAMS },
    ]);
    bind(top);
    expect(signatureFacts().staleTexts.map((s) => s.specId)).toContain('meters::imeter');
    expect(repairSignatures(true)).toEqual([]);
    expect(readYaml(memberFile).methods[0].signature).toBe('charge(mode, values): void');
  });
});

describe('core_orchestrator.moveMethods carries signatureFrom', () => {
  const permissive: SpecWriteHooks = { gate: () => undefined, assess: () => [] };

  it('re-points a source naming a moved method to the method\'s new home', () => {
    const { root, gateFile, tillFile } = tollLine();
    component(root, 'lane', 'cashier');
    contract(root, 'lane', 'cashier', [{ name: 'open', description: 'Open the till', signature: 'open(): void', returns: 'void' }]);
    bind(root);
    const report = moveMethods('meter', 'cashier', ['charge'], permissive);
    expect(report.moved).toBe(true);
    expect(readYaml(gateFile).methods[0].signatureFrom).toBe('cashier.charge');
    expect(readYaml(tillFile).methods[0].signatureFrom).toBe('cashier.charge');
    bind(root);
    // The gate does not reach the new home: the source is off the design's edges now.
    expect(signatureFacts().sources).toContainEqual(expect.objectContaining({ method: 'tap', outcome: 'resolved', target: 'cashier.charge' }));
    expect(validateProject({}).issues.filter((i) => i.code === 'SIGNATURE_SOURCE_OFF_EDGE').map((i) => i.specId)).toContain('igate');
  });
});

describe('an `alias::` signature type binds as every alias:: type reference does', () => {
  /** The top project declares the member `engine` under the alias `eng`; the member exports a signature type. */
  function aliasedFamily(): string {
    const top = tempDir('wairon-sigb-alias-');
    const engine = path.join(top, 'engine');
    projectYaml(top, { id: 'tollway', name: 'Tollway', members: { eng: 'engine' } });
    system(top, 'Tollway');
    subsystem(top, 'Tollway', 'plaza');
    component(top, 'plaza', 'booth');
    contract(top, 'plaza', 'booth', [{ name: 'onPassage', description: 'Hear a passage', signatureFrom: 'eng::passage-listener' }]);
    projectYaml(engine, { id: 'engine', name: 'Engine' });
    system(engine, 'Engine', [{ typeDef: 'passage-listener', audience: 'project' }]);
    signatureType(specs(engine, 'types', 'passage-listener.yaml'), 'passage-listener');
    return top;
  }

  it('resolves through the alias, which differs from the producer\'s project id', () => {
    bind(aliasedFamily());
    const method = loadInterfaceSpec('ibooth')!.methods[0];
    expect(method.params).toEqual([{ name: 'event', type: 'string' }]);
    expect(method.returns).toBe('void');
    expect(method.signature).toBe('onPassage(event: string): void');
    expect(signatureFacts().sources).toContainEqual(expect.objectContaining({ method: 'onPassage', form: 'signature', outcome: 'resolved' }));
    expect(validateProject({}).issues.filter((i) => i.code.startsWith('SIGNATURE_SOURCE'))).toEqual([]);
  });
});

describe('a part judged alone resolves against its pinned parent excerpt', () => {
  /** The clinic's front desk (with a signature type) and a sibling part whose methods take their signatures from it. */
  function clinicWithPart(): { root: string; part: string } {
    const base = tempDir('wairon-sigb-clinic-');
    const root = path.join(base, 'clinic');
    const part = path.join(base, 'scheduling');
    projectYaml(root, { id: 'clinic', name: 'Clinic', members: { scheduling: '../scheduling' } });
    system(root, 'Clinic');
    subsystem(root, 'Clinic', 'frontdesk');
    component(root, 'frontdesk', 'patient-registry');
    contract(root, 'frontdesk', 'patient-registry', [
      { name: 'admit', description: 'Admit a patient', returns: 'string', params: [{ name: 'patientId', type: 'string' }] },
    ]);
    // A parent method that is itself sourced: the excerpt holds it in its stored form.
    component(root, 'frontdesk', 'admission-desk', ['patient-registry']);
    contract(root, 'frontdesk', 'admission-desk', [{ name: 'admit', description: 'Admit at the desk', signatureFrom: 'patient-registry.admit' }]);
    signatureType(specs(root, 'types', 'admission-listener.yaml'), 'admission-listener');
    fs.mkdirSync(path.join(part, '.wai'), { recursive: true });
    fs.writeFileSync(path.join(part, '.wai', 'project.yaml'), yaml.dump({ schemaVersion: '1.0.0', partOf: { project: 'clinic', path: '../clinic' } }));
    writeSpecFile(specs(part, 'scheduling', '.index.yaml'), SubsystemSpecSchema.parse({
      id: 'scheduling', name: 'scheduling', description: 'Books appointments', parentSystem: 'Clinic',
      publicInterfaces: [], trustedLinks: [], status: 'complete', createdAt: STAMP, updatedAt: STAMP,
    }));
    component(part, 'scheduling', 'appointment-planner', ['patient-registry']);
    contract(part, 'scheduling', 'appointment-planner', [
      { name: 'book', description: 'Book an admitted patient', signatureFrom: 'patient-registry.admit' },
      { name: 'onAdmit', description: 'Hear an admission', signatureFrom: 'admission-listener' },
    ]);
    return { root, part };
  }

  it('binds a part method to the parent\'s method and signature type, which the part\'s own scan cannot see', () => {
    const { root, part } = clinicWithPart();
    bind(part);
    pinExternals();
    bind(part);
    // The part's own scan alone cannot bind a parent source...
    expect(signatureFacts().sources.filter((f) => f.outcome === 'unresolved').map((f) => f.method).sort()).toEqual(['book', 'onAdmit']);
    // ...the gate resolves it against the pinned excerpt, as the parent's own gate does.
    const alone = validateProject({});
    expect(alone.issues.some((i) => i.code === 'PART_JUDGED_ALONE')).toBe(true);
    expect(alone.issues.filter((i) => i.code.startsWith('SIGNATURE_'))).toEqual([]);
    bind(root);
    expect(validateProject({}).issues.filter((i) => i.code.startsWith('SIGNATURE_') && i.specId === 'iappointment_planner')).toEqual([]);
  });

  it('resolves an excerpt\'s stored sourced method into a signature and returns', () => {
    const stored = InterfaceSpecSchema.parse({
      id: 'iadmission_desk', name: 'iadmission_desk', description: 'desk', component: 'admission-desk', status: 'complete',
      createdAt: STAMP, updatedAt: STAMP, methods: [{ name: 'admit', description: 'Admit at the desk', signatureFrom: 'patient-registry.admit' }],
    });
    const registry = InterfaceSpecSchema.parse({
      id: 'ipatient_registry', name: 'ipatient_registry', description: 'registry', component: 'patient-registry', status: 'complete',
      createdAt: STAMP, updatedAt: STAMP, methods: [{ name: 'admit', description: 'Admit', returns: 'string', params: [{ name: 'patientId', type: 'string' }] }],
    });
    const components = ['admission-desk', 'patient-registry'].map((id) => ComponentSpecSchema.parse({
      id, name: id, description: id, subsystem: 'frontdesk', componentType: 'Orchestrator', owns: [], dependsOn: [],
      status: 'complete', createdAt: STAMP, updatedAt: STAMP,
    }));
    const resolved = resolveSignatures([stored, registry], components, []);
    expect(resolved.interfaces[0].methods[0]).toMatchObject({ signature: 'admit(patientId: string): string', returns: 'string' });
  });
});
