import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { setProjectRoot } from '../../src/utils/fs.js';
import { invalidateSpecCache } from '../../src/core/specs.js';
import { ensureProjectInitialized } from '../../src/core/provision.js';
import { installPackFromDirectory, type InstalledPack } from '../../src/core/packstore.js';

// ---------------------------------------------------------------------------
// The governance-stage fixture: a machine with a redirected home and pack
// store, one extension pack (acme-base) installed at several versions, and
// real project directories on disk. Nothing machine-global is touched: HOME,
// USERPROFILE, APPDATA and WAIRON_PACKS_DIR all point into one temp directory
// for the duration of a test.
//
// acme-base's profiles: `lenient` LOOSENS wairon's defaults (a warning code to
// notice, another turned off, a shallower design depth, naming, complexity and
// documentation overlays, a forbidden stereotype); `strict` RAISES one; and
// `backend` redefines the builtin profile of the same id. It also adds one
// declarative assertion.
// ---------------------------------------------------------------------------

export const NL = String.fromCharCode(10);
const TS = '2026-09-27T00:00:00.000Z';

/** The pack's manifest at a version. */
export function acmeBaseYaml(version: string): string {
  return [
    'name: acme-base',
    `version: ${version}`,
    'profiles:',
    '  lenient:',
    '    family: neutral',
    '    forbiddenStereotypes:',
    '      - types: [Supervisor]',
    '        reason: the platform runs no long-lived actors',
    '    rules:',
    '      designDepth: components',
    '      sddRuleSeverity:',
    '        UNUSED_COMPONENT: notice',
    "        GENERIC_COMPONENT_NAME: 'off'",
    '      naming:',
    "        components: '^[a-z-]+$'",
    '        stereotypes:',
    '          Orchestrator:',
    '            suffix: flow',
    '      complexity:',
    '        maxMethodParams: 5',
    '      documentation:',
    '        minDescriptionLength: 10',
    '  strict:',
    '    family: neutral',
    '    rules:',
    '      sddRuleSeverity:',
    '        UNUSED_COMPONENT: error',
    '  backend:',
    '    family: backend-like',
    '    rules:',
    '      sddRuleSeverity:',
    '        GENERIC_COMPONENT_NAME: notice',
    'assertions:',
    '  - kind: require-field',
    '    code: needs-dependency-class',
    '    severity: warning',
    '    reason: every orchestrator states its dependency class',
    '    on:',
    '      componentType: [Orchestrator]',
    '    field: dependencyClass',
    '',
  ].join(NL);
}

export interface GovernanceMachine {
  home: string;
  store: string;
  /** Install acme-base at a version, recording a fetchable origin. */
  install(version: string): InstalledPack;
  /** A fresh, initialized project directory (bound as the project root). */
  project(name: string, parent?: string): string;
  cleanup(): void;
}

const ENV_KEYS = ['HOME', 'USERPROFILE', 'APPDATA', 'WAIRON_PACKS_DIR'] as const;

/** Redirect every machine-global location into one temp home, with an empty pack store. */
export function governanceMachine(): GovernanceMachine {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-gov-home-'));
  const store = path.join(home, 'store');
  fs.mkdirSync(store, { recursive: true });
  const saved = ENV_KEYS.map((k) => [k, process.env[k]] as const);
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.APPDATA = home;
  process.env.WAIRON_PACKS_DIR = store;
  const made: string[] = [];
  return {
    home,
    store,
    install(version) {
      const src = fs.mkdtempSync(path.join(home, 'src-'));
      fs.writeFileSync(path.join(src, 'pack.yaml'), acmeBaseYaml(version));
      return installPackFromDirectory(src, `https://packs.example.test/acme-base-${version}.wpack`);
    },
    project(name, parent) {
      const dir = parent ? path.join(parent, name) : fs.mkdtempSync(path.join(os.tmpdir(), `wairon-gov-${name}-`));
      fs.mkdirSync(dir, { recursive: true });
      if (!parent) made.push(dir);
      bindRoot(dir);
      ensureProjectInitialized(name, name, `The ${name} project`);
      invalidateSpecCache();
      return dir;
    },
    cleanup() {
      setProjectRoot(null);
      invalidateSpecCache();
      for (const [k, v] of saved) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      for (const dir of [...made, home]) {
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* windows file locks */ }
      }
    },
  };
}

/** Bind a project root for the next calls. */
export function bindRoot(dir: string): void {
  setProjectRoot(dir);
  invalidateSpecCache();
}

/** Read, change and write a project's .wai/project.yaml as a plain document. */
export function editConfig(dir: string, change: (doc: Record<string, unknown>) => void): void {
  const file = path.join(dir, '.wai', 'project.yaml');
  const doc = (yaml.load(fs.readFileSync(file, 'utf8')) ?? {}) as Record<string, unknown>;
  change(doc);
  fs.writeFileSync(file, yaml.dump(doc, { noRefs: true, lineWidth: 200 }));
  invalidateSpecCache();
}

/** The project's .wai/project.yaml as a plain document. */
export function readConfig(dir: string): Record<string, unknown> {
  return (yaml.load(fs.readFileSync(path.join(dir, '.wai', 'project.yaml'), 'utf8')) ?? {}) as Record<string, unknown>;
}

/** Write a subsystem spec, with any extra top-level lines (designDepth, profile, lint). */
export function writeSubsystem(dir: string, id: string, extra: string[] = []): void {
  const sub = path.join(dir, '.wai', 'specs', id);
  fs.mkdirSync(sub, { recursive: true });
  const system = (yaml.load(fs.readFileSync(path.join(dir, '.wai', 'specs', '.index.yaml'), 'utf8')) as { name: string }).name;
  fs.writeFileSync(path.join(sub, '.index.yaml'), [
    `id: ${id}`, `name: ${id}`, `description: The ${id} subsystem of this project`, `parentSystem: ${system}`,
    'publicInterfaces: []', 'trustedLinks: []', 'status: complete', `createdAt: '${TS}'`, `updatedAt: '${TS}'`, ...extra, '',
  ].join(NL));
  invalidateSpecCache();
}

/** Write a draft Orchestrator component under a subsystem, with any extra top-level lines. */
export function writeComponent(dir: string, subsystem: string, id: string, extra: string[] = []): void {
  const comp = path.join(dir, '.wai', 'specs', subsystem, id);
  fs.mkdirSync(comp, { recursive: true });
  fs.writeFileSync(path.join(comp, '.index.yaml'), [
    `id: ${id}`, `name: ${id}`, `description: The ${id} that runs this project`, `subsystem: ${subsystem}`,
    'componentType: Orchestrator', 'owns: []', 'dependsOn: []', 'status: draft', `createdAt: '${TS}'`, `updatedAt: '${TS}'`, ...extra, '',
  ].join(NL));
  invalidateSpecCache();
}
