import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { setProjectRoot, listFilesRecursive } from '../../src/utils/fs.js';
import { writeSpecFile } from '../../src/core/spec-files.js';
import {
  invalidateSpecCache, loadImplementationSpec, saveImplementationSpec, saveTypeSpec, loadTypeSpec,
} from '../../src/core/specs.js';
import { renameComponent, renameType, renameField } from '../../src/core/provision.js';
import {
  ComponentSpecSchema, SubsystemSpecSchema, TypeSpecSchema, SystemSpecSchema, InterfaceSpecSchema, ImplementationSpecSchema,
} from '../../src/models/index.js';

const STAMP = '2026-10-02T00:00:00.000Z';
const cleanups: string[] = [];
afterEach(() => {
  setProjectRoot(null);
  invalidateSpecCache();
  for (const c of cleanups.splice(0)) { try { fs.rmSync(c, { recursive: true, force: true }); } catch { /* */ } }
});

function build(inPart: boolean, implId: string): { root: string; specs: string } {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rn-part-')));
  cleanups.push(root);
  fs.mkdirSync(path.join(root, '.wai'), { recursive: true });
  fs.writeFileSync(path.join(root, '.wai', 'project.yaml'), yaml.dump({
    schemaVersion: '1.0.0', id: 'clinic', name: 'Clinic', targets: [], createdAt: STAMP, updatedAt: STAMP,
    ...(inPart ? { members: { analytics: 'services/analytics' } } : {}),
  }));
  writeSpecFile(path.join(root, '.wai', 'specs', '.index.yaml'), SystemSpecSchema.parse({
    schemaVersion: '1.0.0', name: 'Clinic', vision: 'v', boundaries: [], globalRequirements: [], createdAt: STAMP, updatedAt: STAMP,
  }));
  const holder = inPart ? path.join(root, 'services', 'analytics') : root;
  const specs = path.join(holder, '.wai', 'specs');
  writeSpecFile(path.join(specs, 'analytics', '.index.yaml'), SubsystemSpecSchema.parse({
    id: 'analytics', name: 'analytics', description: 'd', parentSystem: 'Clinic',
    publicInterfaces: [], trustedLinks: [], status: 'draft', createdAt: STAMP, updatedAt: STAMP,
  }));
  writeSpecFile(path.join(specs, 'analytics', 'summary_portal', '.index.yaml'), ComponentSpecSchema.parse({
    id: 'summary_portal', name: 'summary_portal', description: 'd', subsystem: 'analytics',
    componentType: 'Portal', owns: [], dependsOn: [], createdAt: STAMP, updatedAt: STAMP,
  }));
  writeSpecFile(path.join(specs, 'analytics', 'summary_portal', '.interface.yaml'), InterfaceSpecSchema.parse({
    id: 'isummary_portal', name: 'i', description: 'd', component: 'summary_portal', createdAt: STAMP, updatedAt: STAMP,
    methods: [{ name: 'get_summary', description: 'd', signature: 'get_summary(): void', returns: 'void' }],
  }));
  writeSpecFile(path.join(specs, 'analytics', 'summary_portal', '.implementation.yaml'), ImplementationSpecSchema.parse({
    id: implId, name: 'impl', description: 'd', contract: 'isummary_portal', createdAt: STAMP, updatedAt: STAMP,
    methods: [{ name: 'get_summary', narrative: [{ stepNumber: 1, description: 'r', type: 'return', outcome: 'success' }] }],
  }));
  setProjectRoot(root);
  invalidateSpecCache();
  return { root, specs };
}

const tree = (dir: string): string[] => listFilesRecursive(dir, '.yaml').map((f) => path.relative(dir, f).replace(/\\/g, '/')).sort();

// renameComponent walks the bound project's own spec folders: a part's too.
describe.each([[false, 'root'], [true, 'part']])('renameComponent in the %s', (inPart, label) => {
  for (const implId of ['summary_portal_impl', 'summary_impl']) {
    it(`${label}: leaves no folder behind and keeps the implementation beside its contract (impl ${implId})`, () => {
      const { specs } = build(inPart as boolean, implId);
      renameComponent('summary_portal', 'analytics_portal');
      const expected = [
        'analytics/.index.yaml',
        'analytics/analytics_portal/.implementation.yaml',
        'analytics/analytics_portal/.index.yaml',
        'analytics/analytics_portal/.interface.yaml',
        ...(inPart ? [] : ['.index.yaml']),
      ].sort();
      expect(tree(specs)).toEqual(expected);
      expect(fs.existsSync(path.join(specs, 'analytics', 'summary_portal'))).toBe(false);

      // A later write of the implementation stays where it is.
      const id = implId === 'summary_portal_impl' ? 'analytics_portal_impl' : implId;
      const impl = loadImplementationSpec(id)!;
      expect(impl.contract).toBe('ianalytics_portal');
      saveImplementationSpec({ ...impl, description: 'changed' });
      invalidateSpecCache();
      expect(tree(specs)).toEqual(expected);
    });
  }
});

// renameType and renameField walk the part's folders too.
describe('type and field renames in a part', () => {
  function seed(): { root: string; partSpecs: string } {
    const { root, specs } = build(true, 'summary_portal_impl');
    writeSpecFile(path.join(root, '.wai', 'specs', 'core', '.index.yaml'), SubsystemSpecSchema.parse({
      id: 'core', name: 'core', description: 'd', parentSystem: 'Clinic',
      publicInterfaces: [], trustedLinks: [], status: 'draft', createdAt: STAMP, updatedAt: STAMP,
    }));
    const t = (id: string, subsystem: string, fields: { name: string; type: string }[]) => TypeSpecSchema.parse({
      id, name: id, description: 'd', kind: 'value-object', subsystem, fields, createdAt: STAMP, updatedAt: STAMP,
    });
    saveTypeSpec(t('cadence', 'analytics', [{ name: 'every', type: 'int' }]));
    saveTypeSpec(t('habit', 'analytics', [{ name: 'rhythm', type: 'cadence' }]));
    saveTypeSpec(t('plan', 'core', [{ name: 'when', type: 'cadence' }]));
    invalidateSpecCache();
    return { root, partSpecs: specs };
  }
  const fieldTypes = (id: string): string[] => loadTypeSpec(id)!.fields!.map((f) => f.type);

  it('renameType respells the references in the part and in the root', () => {
    seed();
    renameType('cadence', 'rhythm_spec');
    invalidateSpecCache();
    expect(loadTypeSpec('rhythm_spec')).not.toBeNull();
    expect(loadTypeSpec('cadence')).toBeNull();
    expect(fieldTypes('habit')).toEqual(['rhythm_spec']);
    expect(fieldTypes('plan')).toEqual(['rhythm_spec']);
  });

  it('renameField keeps working on a type in a part', () => {
    seed();
    renameField('cadence', 'every', 'each');
    invalidateSpecCache();
    expect(loadTypeSpec('cadence')!.fields!.map((f) => f.name)).toEqual(['each']);
  });
});
