import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { setProjectRoot } from '../../src/utils/fs.js';
import { writeSpecFile } from '../../src/core/spec-files.js';
import { invalidateSpecCache, saveInterfaceSpec, saveImplementationSpec } from '../../src/core/specs.js';
import { validateProject } from '../../src/core/validation.js';
import { buildRuleContext } from '../../src/core/rules/index.js';
import {
  ComponentSpecSchema,
  ImplementationSpecSchema,
  InterfaceSpecSchema,
  SubsystemSpecSchema,
  SystemSpecSchema,
} from '../../src/models/index.js';

// ---------------------------------------------------------------------------
// SOURCE_FILE_PLANNED names the likely slip: a planned path written as if
// relative to the part holding the spec, when it is on disk under the part's
// folder (ctx.partFolderOf). A spec of the root's own folder never draws it.
// ---------------------------------------------------------------------------

const STAMP = '2026-11-23T00:00:00.000Z';
const cleanups: string[] = [];

afterEach(() => {
  setProjectRoot(null);
  invalidateSpecCache();
  for (const dir of cleanups.splice(0)) {
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* windows file locks */ }
  }
});

const specs = (dir: string, ...parts: string[]): string => path.join(dir, '.wai', 'specs', ...parts);

function writeSubsystem(base: string, id: string, component: string): void {
  writeSpecFile(specs(base, id, '.index.yaml'), SubsystemSpecSchema.parse({
    id, name: id, description: `The ${id} subsystem`, parentSystem: 'Clinic',
    publicInterfaces: [], trustedLinks: [], status: 'complete', createdAt: STAMP, updatedAt: STAMP,
  }));
  writeSpecFile(specs(base, id, component, '.index.yaml'), ComponentSpecSchema.parse({
    id: component, name: component, description: `The ${component} of the clinic`, subsystem: id,
    componentType: 'Orchestrator', owns: [], dependsOn: [], status: 'complete', createdAt: STAMP, updatedAt: STAMP,
  }));
}

/** A clinic with one subsystem in its own folder and one in a contained part, each realized by a planned file. */
function clinic(): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-part-hint-')));
  cleanups.push(root);
  writeSpecFile(specs(root, '.index.yaml'), SystemSpecSchema.parse({
    schemaVersion: '1.0.0', name: 'Clinic', vision: 'A clinic that books and checks in patients',
    boundaries: [], globalRequirements: [], createdAt: STAMP, updatedAt: STAMP,
  }));
  fs.mkdirSync(path.join(root, '.wai'), { recursive: true });
  fs.writeFileSync(path.join(root, '.wai', 'project.yaml'), yaml.dump({
    schemaVersion: '1.0.0', id: 'clinic', name: 'Clinic', targets: [], createdAt: STAMP, updatedAt: STAMP,
    members: { scheduling: 'services/scheduling' },
  }));
  writeSubsystem(root, 'frontdesk', 'patient-registry');
  writeSubsystem(path.join(root, 'services', 'scheduling'), 'scheduling', 'appointment-planner');
  setProjectRoot(root);
  invalidateSpecCache();
  for (const [component, file] of [['patient-registry', 'src/registry.ts'], ['appointment-planner', 'src/planner.ts']] as const) {
    saveInterfaceSpec(InterfaceSpecSchema.parse({
      id: `i${component}`, name: `i${component}`, description: 'Contract.', component, createdAt: STAMP, updatedAt: STAMP,
      methods: [{ name: 'run', description: 'Run it.', returns: 'void', params: [], invokedBy: { kind: 'runtime', caller: 'the clinic runtime at start' } }],
    }));
    saveImplementationSpec(ImplementationSpecSchema.parse({
      id: `${component}_impl`, name: `${component}_impl`, description: 'Impl.', contract: `i${component}`, sourcePath: file, createdAt: STAMP, updatedAt: STAMP,
      methods: [{ name: 'run', narrative: [{ stepNumber: 1, type: 'local', description: 'Do the work.' }] }],
    }));
  }
  return root;
}

const plannedOf = (id: string) => validateProject({}).issues.filter((i) => i.code === 'SOURCE_FILE_PLANNED' && i.specId === id);

describe('SOURCE_FILE_PLANNED: a path written relative to the part', () => {
  it('names the spelling from the bound root when the file exists under the part folder', () => {
    const root = clinic();
    fs.mkdirSync(path.join(root, 'services', 'scheduling', 'src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'services', 'scheduling', 'src', 'planner.ts'), 'export function run(): void {}\n');
    invalidateSpecCache();
    const [issue] = plannedOf('appointment-planner_impl');
    expect(issue).toBeDefined();
    expect(issue.message).toContain('"src/planner.ts"');
    expect(issue.message).toContain('services/scheduling/src/planner.ts');
    expect(issue.message).toContain('plans a source file not written yet');
  });

  it('adds no hint when the file is under the part folder nowhere', () => {
    clinic();
    const [issue] = plannedOf('appointment-planner_impl');
    expect(issue).toBeDefined();
    expect(issue.message).not.toContain('services/scheduling');
  });

  it('adds no hint for a spec of the root folder, even when the same path exists under a part', () => {
    const root = clinic();
    fs.mkdirSync(path.join(root, 'services', 'scheduling', 'src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'services', 'scheduling', 'src', 'registry.ts'), 'export function run(): void {}\n');
    invalidateSpecCache();
    const [issue] = plannedOf('patient-registry_impl');
    expect(issue).toBeDefined();
    expect(issue.message).not.toContain('services/scheduling');
  });
});

describe('rule_context.partFolderOf', () => {
  it('is the part folder from the bound root for a part spec, and absent otherwise', () => {
    clinic();
    // The run's own context is exercised through the finding above; here the builder's answer for an absent family.
    const ctx = buildRuleContext({ system: undefined as never, subsystems: [], components: [], interfaces: [], implementations: [], types: [], projectType: 'backend' } as never);
    expect(ctx.partFolderOf('anything')).toBeUndefined();
  });
});
