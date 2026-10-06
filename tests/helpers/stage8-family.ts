import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { writeSpecFile } from '../../src/core/spec-files.js';
import {
  ComponentSpecSchema,
  ImplementationSpecSchema,
  InterfaceSpecSchema,
  SubsystemSpecSchema,
  SystemSpecSchema,
  TypeSpecSchema,
} from '../../src/models/index.js';

// ---------------------------------------------------------------------------
// Stage 8, wave B fixtures: a producer project (ledger) and a consumer (shop)
// that uses one of its methods, stored however a test asks — a git
// repository served by a LOCAL bare repository, a `../` sibling checkout, a
// path external — and a clinic with a part to promote and demote. Every
// document is written through the writer's own schema, on real temp
// directories; nothing on the path under test is mocked.
// ---------------------------------------------------------------------------

const STAMP = '2026-10-03T00:00:00.000Z';

/** Every variable a run could write a global file through: redirected to a temp home by `isolateGlobals`. */
export const REDIRECTED = ['WAIRON_CACHE_DIR', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA'] as const;

/** A fresh temp directory, real path, removed by the returned cleanup list's owner. */
export function tempDir(cleanups: (() => void)[], prefix: string): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  return dir;
}

/** Point HOME, USERPROFILE, APPDATA, LOCALAPPDATA and WAIRON_CACHE_DIR at temp directories; answers the restore. */
export function isolateGlobals(cleanups: (() => void)[]): () => void {
  const saved = Object.fromEntries(REDIRECTED.map((k) => [k, process.env[k]]));
  const home = tempDir(cleanups, 'wairon-home-');
  for (const k of REDIRECTED) process.env[k] = k === 'WAIRON_CACHE_DIR' ? tempDir(cleanups, 'wairon-cache-') : home;
  return () => {
    for (const k of REDIRECTED) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  };
}

/** git, quietly, with an identity so a commit works on any machine. */
export function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=Stage Eight', '-c', 'user.email=stage8@example.invalid', '-c', 'commit.gpgsign=false', ...args], {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

/** A local bare repository cloned from a work tree; answers its file URL and the work tree's head. */
export function bareFrom(cleanups: (() => void)[], work: string, name: string): { url: string; bare: string; commit: string } {
  git(work, 'init', '-q');
  git(work, 'add', '-A');
  git(work, 'commit', '-q', '-m', `the ${name}`);
  const bare = path.join(tempDir(cleanups, 'wairon-bare-'), `${name}.git`);
  git(path.dirname(bare), 'clone', '-q', '--bare', work, bare);
  return { url: `file:///${bare.replace(/\\/g, '/').replace(/^\//, '')}`, bare, commit: git(work, 'rev-parse', 'HEAD') };
}

/** Commit the work tree's changes and push them to its bare repository; answers the new commit. */
export function pushChange(work: string, bare: string, message: string): string {
  git(work, 'add', '-A');
  git(work, 'commit', '-q', '-m', message);
  const branch = git(work, 'rev-parse', '--abbrev-ref', 'HEAD');
  git(work, 'push', '-q', bare, `HEAD:${branch}`);
  return git(work, 'rev-parse', 'HEAD');
}

export const specs = (dir: string, ...parts: string[]): string => path.join(dir, '.wai', 'specs', ...parts);

/** A project configuration written as YAML. */
export function projectYaml(dir: string, fields: Record<string, unknown>): void {
  fs.mkdirSync(path.join(dir, '.wai'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.wai', 'project.yaml'), yaml.dump({ schemaVersion: '1.0.0', targets: [], createdAt: STAMP, updatedAt: STAMP, ...fields }));
}

export function system(dir: string, name: string, publicInterfaces: Record<string, unknown>[] = []): void {
  writeSpecFile(specs(dir, '.index.yaml'), SystemSpecSchema.parse({
    schemaVersion: '1.0.0', name, vision: `${name}, in miniature`, boundaries: [], globalRequirements: [],
    ...(publicInterfaces.length ? { publicInterfaces } : {}), createdAt: STAMP, updatedAt: STAMP,
  }));
}

export function subsystem(dir: string, parentSystem: string, id: string, extra: Record<string, unknown> = {}): void {
  writeSpecFile(specs(dir, id, '.index.yaml'), SubsystemSpecSchema.parse({
    id, name: id, description: `The ${id} subsystem`, parentSystem, publicInterfaces: [], trustedLinks: [],
    status: 'complete', createdAt: STAMP, updatedAt: STAMP, ...extra,
  }));
}

export function component(dir: string, sub: string, id: string, componentType: string, dependsOn: string[] = [], extra: Record<string, unknown> = {}): void {
  writeSpecFile(specs(dir, sub, id, '.index.yaml'), ComponentSpecSchema.parse({
    id, name: id, description: `The ${id} component`, subsystem: sub, componentType,
    ...(componentType === 'Portal' ? { transport: 'Custom' } : {}),
    owns: [], dependsOn, status: 'complete', createdAt: STAMP, updatedAt: STAMP, ...extra,
  }));
}

export function contract(dir: string, sub: string, comp: string, methods: Record<string, unknown>[]): void {
  writeSpecFile(specs(dir, sub, comp, '.interface.yaml'), InterfaceSpecSchema.parse({
    id: `i${comp}`, name: `i${comp}`, description: `The ${comp} contract`, component: comp, methods,
    status: 'complete', createdAt: STAMP, updatedAt: STAMP,
  }));
}

export function implementation(dir: string, sub: string, comp: string, contractId: string, methods: Record<string, unknown>[]): void {
  writeSpecFile(specs(dir, sub, comp, '.implementation.yaml'), ImplementationSpecSchema.parse({
    id: `${comp}_impl`, name: `${comp}_impl`, description: `The ${comp} implementation`, contract: contractId, methods,
    status: 'complete', createdAt: STAMP, updatedAt: STAMP,
  }));
}

export function type(file: string, id: string, fields: { name: string; type: string }[], extra: Record<string, unknown> = {}): void {
  writeSpecFile(file, TypeSpecSchema.parse({
    kind: 'value-object', id, name: id, description: `The ${id} type`,
    fields: fields.map((f) => ({ ...f, description: `The ${f.name}`, optional: false })),
    methods: [], createdAt: STAMP, updatedAt: STAMP, ...extra,
  }));
}

/**
 * The producer: project `ledger`, whose books subsystem publishes the
 * ledger-portal and whose L0 exports it at audience instance, so a consumer
 * outside the family sees it. Its one method is named `method` — a test
 * renames it to break a consumer.
 */
export function writeLedger(dir: string, method = 'post'): void {
  projectYaml(dir, { id: 'ledger', name: 'Ledger' });
  system(dir, 'Ledger', [{ from: 'books', component: 'ledger-portal', audience: 'instance' }]);
  subsystem(dir, 'Ledger', 'books', { publicInterfaces: [{ type: 'Custom', details: 'The ledger surface', component: 'ledger-portal' }] });
  component(dir, 'books', 'ledger-portal', 'Portal');
  contract(dir, 'books', 'ledger-portal', [{
    name: method, description: 'Post an amount', signature: `${method}(amount: number): void`, returns: 'void',
    params: [{ name: 'amount', type: 'number', description: 'The amount' }],
  }]);
}

/** Rename the ledger's one method — a break for every consumer that calls it. */
export function renameLedgerMethod(dir: string, to: string): void {
  contract(dir, 'books', 'ledger-portal', [{
    name: to, description: 'Post an amount', signature: `${to}(amount: number): void`, returns: 'void',
    params: [{ name: 'amount', type: 'number', description: 'The amount' }],
  }]);
}

/**
 * The consumer: project `shop`, whose checkout calls `ledger::ledger-portal.post`.
 * `declare` is written into its configuration as is (members or externals).
 */
export function writeShop(dir: string, declare: Record<string, unknown>): void {
  projectYaml(dir, { id: 'shop', name: 'Shop', ...declare });
  system(dir, 'Shop');
  subsystem(dir, 'Shop', 'sales');
  component(dir, 'sales', 'checkout', 'Adapter', ['ledger::ledger-portal']);
  contract(dir, 'sales', 'checkout', [{
    name: 'pay', description: 'Pay for the basket', signature: 'pay(amount: number): void', returns: 'void',
    params: [{ name: 'amount', type: 'number', description: 'The amount' }],
  }]);
  implementation(dir, 'sales', 'checkout', 'icheckout', [{
    name: 'pay',
    narrative: [
      { stepNumber: 1, description: 'Post the amount to the ledger', type: 'call', targetComponent: 'ledger::ledger-portal', targetMethod: 'post' },
    ],
  }]);
}

/**
 * The clinic: project `clinic` with its own frontdesk subsystem (the published
 * patient-portal, the patient type, and a checkin client that uses the part's
 * schedule-portal) and a contained PART `scheduling` at services/scheduling,
 * whose booking client uses the frontdesk's patient-portal and patient type.
 * References cross both ways, so a promote has something to respell and a
 * demote something to take back.
 */
export function writeClinic(root: string): { root: string; part: string } {
  projectYaml(root, { id: 'clinic', name: 'Clinic', members: { scheduling: 'services/scheduling' } });
  system(root, 'Clinic');
  subsystem(root, 'Clinic', 'frontdesk', { publicInterfaces: [{ type: 'Custom', details: 'Patients', component: 'patient-portal' }] });
  component(root, 'frontdesk', 'patient-portal', 'Portal');
  component(root, 'frontdesk', 'checkin-client', 'Adapter', ['schedule-portal']);
  type(specs(root, 'types', 'patient.yaml'), 'patient', [{ name: 'name', type: 'string' }], { subsystem: 'frontdesk' });
  const part = path.join(root, 'services', 'scheduling');
  subsystem(part, 'Clinic', 'scheduling', { publicInterfaces: [{ type: 'Custom', details: 'Schedules', component: 'schedule-portal' }] });
  component(part, 'scheduling', 'schedule-portal', 'Portal');
  component(part, 'scheduling', 'booking-client', 'Adapter', ['patient-portal']);
  contract(part, 'scheduling', 'booking-client', [{
    name: 'book', description: 'Book a patient in', signature: 'book(p: patient): void', returns: 'void',
    params: [{ name: 'p', type: 'patient', description: 'The patient' }],
  }]);
  return { root, part };
}
