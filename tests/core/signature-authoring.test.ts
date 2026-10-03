import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { setProjectRoot } from '../../src/utils/fs.js';
import { applyRestatement, updateSpecGated, writeSpec, type SpecRestatement } from '../../src/core/authoring.js';
import { invalidateSpecCache, loadInterfaceSpec, saveSpec, saveSystemSpec } from '../../src/core/specs.js';
import type { ComponentSpec, InterfaceSpec, SubsystemSpec } from '../../src/models/specs.js';

// ---------------------------------------------------------------------------
// Stage 1 signatures, wave 3: the authoring seam. A signatureFrom stated
// beside params or returns is refused (SIGNATURE_SOURCE_RESTATED) — by a
// create in spec_restatement.applyTo and by a delta in the updateSpecGated
// hook; a method stating nothing it takes is refused; a params-bearing
// method's text is derived, never taken; a re-authoring carries from the
// STORED form, so it never inherits a source's resolved params.
// ---------------------------------------------------------------------------

const STAMP = '2026-10-03T00:00:00.000Z';
const INTERFACE_FIELDS = ['id', 'name', 'description', 'component', 'methods', 'status'];
const METHOD_FIELDS = ['name', 'description', 'signature', 'returns', 'signatureFrom', 'params', 'guarantees', 'effect', 'invokedBy', 'findings', 'ext'];
let roots: string[] = [];

afterEach(() => {
  setProjectRoot(null);
  invalidateSpecCache();
  for (const r of roots) fs.rmSync(r, { recursive: true, force: true });
  roots = [];
});

const restatement = (methods: Record<string, unknown>[]): SpecRestatement => ({
  kind: 'interface',
  spec: { id: 'iportal', name: 'iportal', description: 'd', component: 'portal', methods } as unknown as InterfaceSpec,
  fields: INTERFACE_FIELDS,
  memberFields: METHOD_FIELDS,
});
const portal = { id: 'portal' } as ComponentSpec;

describe('spec_restatement.applyTo', () => {
  it('refuses a signatureFrom stated beside params or returns, naming both ways out', () => {
    const application = applyRestatement(restatement([
      { name: 'execute', description: 'd', signatureFrom: 'engine.run', params: [{ name: 'x', type: 'string' }] },
      { name: 'other', description: 'd', signatureFrom: 'engine.run', returns: 'void' },
    ]), null, portal);
    expect(application.refusal).toContain('SIGNATURE_SOURCE_RESTATED');
    expect(application.refusal).toContain('"execute", "other"');
    expect(application.refusal).toContain('unset its params and returns');
  });

  it('accepts a source stated alone', () => {
    const application = applyRestatement(restatement([{ name: 'execute', description: 'd', signatureFrom: 'engine.run' }]), null, portal);
    expect(application.refusal).toBeUndefined();
    expect((application.spec as InterfaceSpec).methods[0]).toMatchObject({ name: 'execute', signatureFrom: 'engine.run' });
  });

  it('refuses a method stating neither params, a source nor a prose signature', () => {
    const application = applyRestatement(restatement([{ name: 'execute', description: 'd', returns: 'void' }]), null, portal);
    expect(application.refusal).toContain('"execute" states neither params, a signatureFrom nor a prose signature');
  });

  it('derives a params-bearing method\'s text, naming a stated text that differed', () => {
    const application = applyRestatement(restatement([{
      name: 'execute', description: 'd', signature: 'execute(x)', returns: 'void', params: [{ name: 'x', type: 'string', optional: true }],
    }]), null, portal);
    expect((application.spec as InterfaceSpec).methods[0].signature).toBe('execute(x?: string): void');
    expect(application.notices.join('\n')).toContain('stated "execute(x)", written "execute(x?: string): void"');
  });

  it('carries from the stored form: re-stating a sourced method by its source alone is not a restatement', () => {
    // The loaded contract holds the source's resolved params; the stored one does not.
    const loaded = {
      id: 'iportal', name: 'iportal', description: 'd', component: 'portal', status: 'complete', createdAt: STAMP, updatedAt: STAMP,
      methods: [{ name: 'execute', description: 'd', signatureFrom: 'engine.run', signature: 'execute(x: string): void', returns: 'void', params: [{ name: 'x', type: 'string' }], ext: { k: 1 } }],
    } as InterfaceSpec;
    const application = applyRestatement(restatement([{ name: 'execute', description: 'd', signatureFrom: 'engine.run' }]), loaded, portal);
    expect(application.refusal).toBeUndefined();
    expect(application.changedMethods).toEqual([]);
    // What the source supplies is never carried into the restatement.
    const written = (application.spec as InterfaceSpec).methods[0];
    expect(written.params).toBeUndefined();
  });
});

describe('the updateSpecGated hook', () => {
  function tree(): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-sigauth-'));
    roots.push(root);
    fs.mkdirSync(path.join(root, '.wai', 'specs'), { recursive: true });
    setProjectRoot(root);
    saveSystemSpec({ schemaVersion: '1.0.0', name: 'Sig', vision: 'v', boundaries: [], globalRequirements: [], createdAt: STAMP, updatedAt: STAMP });
    saveSpec('subsystem', { id: 'core', name: 'core', description: 'd', parentSystem: 'Sig', publicInterfaces: [], trustedLinks: [], status: 'draft', createdAt: STAMP, updatedAt: STAMP } as SubsystemSpec);
    for (const [id, dependsOn] of [['engine', []], ['portal', ['engine']]] as const) {
      saveSpec('component', { id, name: id, description: 'd', subsystem: 'core', componentType: 'Orchestrator', owns: [], dependsOn: [...dependsOn], status: 'draft', createdAt: STAMP, updatedAt: STAMP } as ComponentSpec);
    }
    writeSpec({ ...restatement([]), spec: { id: 'iengine', name: 'iengine', description: 'd', component: 'engine', methods: [{ name: 'run', description: 'd', returns: 'void', params: [{ name: 'x', type: 'string' }] }] } as unknown as InterfaceSpec });
    writeSpec(restatement([
      { name: 'execute', description: 'd', returns: 'void', params: [{ name: 'x', type: 'string' }] },
      { name: 'relay', description: 'Relay', signatureFrom: 'engine.run' },
    ]));
    return root;
  }

  it('refuses a delta adopting a source while the method keeps its params, writing nothing', () => {
    tree();
    const before = JSON.stringify(loadInterfaceSpec('iportal'));
    expect(() => updateSpecGated('interface', 'iportal', { methods: [{ name: 'execute', signatureFrom: 'engine.run' }] }))
      .toThrow(/SIGNATURE_SOURCE_RESTATED/);
    invalidateSpecCache();
    expect(JSON.stringify(loadInterfaceSpec('iportal'))).toBe(before);
  });

  it('accepts the adoption when the delta unsets the params and returns', () => {
    const root = tree();
    const report = updateSpecGated('interface', 'iportal', { methods: [{ name: 'execute', signatureFrom: 'engine.run', unset: ['params', 'returns'] }] });
    expect(report.written).toBe(true);
    const file = fs.readdirSync(path.join(root, '.wai', 'specs'), { recursive: true }) as string[];
    const portalFile = file.find((f) => f.replace(/\\/g, '/').endsWith('portal/.interface.yaml'))!;
    const stored = yaml.load(fs.readFileSync(path.join(root, '.wai', 'specs', portalFile), 'utf8')) as { methods: Record<string, unknown>[] };
    expect(stored.methods[0]).toEqual({ name: 'execute', description: 'd', signatureFrom: 'engine.run' });
  });

  it('lets a delta edit a sourced method\'s description, the merge being over the stored form', () => {
    tree();
    const report = updateSpecGated('interface', 'iportal', { methods: [{ name: 'relay', description: 'Relay a run onward' }] });
    expect(report.changes.map((c) => c.path)).toEqual(['methods.relay.description']);
  });
});
