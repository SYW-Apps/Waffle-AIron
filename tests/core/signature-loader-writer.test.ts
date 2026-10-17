import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { setProjectRoot } from '../../src/utils/fs.js';
import { writeSpecFile } from '../../src/core/spec-files.js';
import {
  dryRunSerializeSpecs,
  invalidateSpecCache,
  loadInterfaceSpec,
  loadSpec,
  rewriteSpecRefs,
  saveSpec,
  signatureFacts,
  specKind,
  updateSpec,
} from '../../src/core/specs.js';
import { renameComponent, renameMethod } from '../../src/core/provision.js';
import {
  ComponentSpecSchema,
  InterfaceSpecSchema,
  SubsystemSpecSchema,
  SystemSpecSchema,
  TypeSpecSchema,
  type InterfaceSpec,
} from '../../src/models/index.js';
import { buildReferenceFamily, type ReferenceFamily } from '../helpers/reference-family.js';

// ---------------------------------------------------------------------------
// Stage 1 signatures, wave 2: the scan resolves every signatureFrom and
// derives every text; the writer stores the stored form (never a source's
// params, always the derived text); the reference table carries signatureFrom
// through binding, relativization and renames. Real temp trees, the real scan
// and the real writer.
// ---------------------------------------------------------------------------

const STAMP = '2026-10-03T00:00:00.000Z';
const specs = (dir: string, ...parts: string[]): string => path.join(dir, '.wai', 'specs', ...parts);

let dirs: string[] = [];
let family: ReferenceFamily | null = null;

afterEach(() => {
  setProjectRoot(null);
  invalidateSpecCache();
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  dirs = [];
  family?.cleanup();
  family = null;
});

function bind(root: string): void {
  invalidateSpecCache();
  setProjectRoot(root);
}

const RUN_PARAMS = [{ name: 'values', type: 'list<string>' }, { name: 'mode', type: 'string', optional: true }];

/**
 * One project: `portal` depends on `engine`; engine's `run` carries params and
 * a drifted text; the portal's `execute` takes its signature from `engine.run`
 * and `onChange` from the signature type `change_listener`.
 */
function buildTree(portalMethods: Record<string, unknown>[] = [
  { name: 'execute', description: 'Execute through the engine', signatureFrom: 'engine.run' },
  { name: 'onChange', description: 'Hear a change', signatureFrom: 'change_listener' },
]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-sigsrc-'));
  dirs.push(dir);
  fs.mkdirSync(path.join(dir, '.wai'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.wai', 'project.yaml'), [
    'schemaVersion: 1.0.0', 'name: Sig', 'targets: []', `createdAt: '${STAMP}'`, `updatedAt: '${STAMP}'`, '',
  ].join('\n'));
  writeSpecFile(specs(dir, '.index.yaml'), SystemSpecSchema.parse({
    schemaVersion: '1.0.0', name: 'Sig', vision: 'signatures', boundaries: [], globalRequirements: [], createdAt: STAMP, updatedAt: STAMP,
  }));
  writeSpecFile(specs(dir, 'core', '.index.yaml'), SubsystemSpecSchema.parse({
    id: 'core', name: 'core', description: 'core', parentSystem: 'Sig', publicInterfaces: [], trustedLinks: [],
    status: 'complete', createdAt: STAMP, updatedAt: STAMP,
  }));
  for (const [id, dependsOn] of [['portal', ['engine']], ['engine', []]] as const) {
    writeSpecFile(specs(dir, 'core', id, '.index.yaml'), ComponentSpecSchema.parse({
      id, name: id, description: id, subsystem: 'core', componentType: 'Orchestrator', owns: [], dependsOn,
      status: 'complete', createdAt: STAMP, updatedAt: STAMP,
    }));
  }
  writeSpecFile(specs(dir, 'core', 'engine', '.interface.yaml'), InterfaceSpecSchema.parse({
    id: 'iengine', name: 'iengine', description: 'engine', component: 'engine', status: 'complete', createdAt: STAMP, updatedAt: STAMP,
    methods: [{ name: 'run', description: 'Run the engine', signature: 'run(mode, values): void', returns: 'void', params: RUN_PARAMS }],
  }));
  writeSpecFile(specs(dir, 'core', 'portal', '.interface.yaml'), InterfaceSpecSchema.parse({
    id: 'iportal', name: 'iportal', description: 'portal', component: 'portal', status: 'complete', createdAt: STAMP, updatedAt: STAMP,
    methods: portalMethods,
  }));
  writeSpecFile(specs(dir, 'types', 'change_listener.yaml'), TypeSpecSchema.parse({
    kind: 'signature', id: 'change_listener', name: 'ChangeListener', description: 'A change callback',
    params: [{ name: 'event', type: 'string' }], returns: 'void', createdAt: STAMP, updatedAt: STAMP,
  }));
  return dir;
}

const readYaml = (file: string): any => yaml.load(fs.readFileSync(file, 'utf8'));
const methodOf = (spec: InterfaceSpec | null, name: string) => spec?.methods.find((m) => m.name === name);

describe('the scan resolves sources and derives texts', () => {
  it('reads a sourced method with its source\'s params, returns and a derived text', () => {
    bind(buildTree());
    const execute = methodOf(loadInterfaceSpec('iportal'), 'execute')!;
    expect(execute.params).toEqual(RUN_PARAMS);
    expect(execute.returns).toBe('void');
    expect(execute.signature).toBe('execute(values: list<string>, mode?: string): void');
    expect(methodOf(loadInterfaceSpec('iportal'), 'onChange')!.signature).toBe('onChange(event: string): void');
  });

  it('shows the derived text, never the stale stored one, and keeps the stale one as a fact', () => {
    bind(buildTree());
    expect(methodOf(loadInterfaceSpec('iengine'), 'run')!.signature).toBe('run(values: list<string>, mode?: string): void');
    expect(signatureFacts().staleTexts).toEqual([expect.objectContaining({
      specId: 'iengine', method: 'run', stored: 'run(mode, values): void', derived: 'run(values: list<string>, mode?: string): void',
    })]);
    expect(signatureFacts().sources.map((f) => `${f.method}:${f.outcome}`)).toEqual(['execute:resolved', 'onChange:resolved']);
  });

  it('recognises a signature type file that leaves its fields list out', () => {
    expect(specKind({ kind: 'signature', id: 'x', params: [], returns: 'void' })).toBe('type');
  });
});

describe('the writer stores the stored form', () => {
  it('never writes a source\'s resolved params back on a re-save of the loaded contract', () => {
    const dir = buildTree();
    bind(dir);
    saveSpec('interface', loadInterfaceSpec('iportal')!);
    const stored = readYaml(specs(dir, 'core', 'portal', '.interface.yaml'));
    expect(stored.methods.find((m: any) => m.name === 'execute')).toEqual({
      name: 'execute', description: 'Execute through the engine', signatureFrom: 'engine.run',
    });
  });

  it('writes the derived text on any save, which repairs a stale one', () => {
    const dir = buildTree();
    bind(dir);
    saveSpec('interface', loadInterfaceSpec('iengine')!);
    expect(readYaml(specs(dir, 'core', 'engine', '.interface.yaml')).methods[0].signature).toBe('run(values: list<string>, mode?: string): void');
    invalidateSpecCache();
    expect(signatureFacts().staleTexts).toEqual([]);
  });

  it('merges a delta onto the stored form: editing a sourced method\'s description writes no params', () => {
    const dir = buildTree();
    bind(dir);
    const report = updateSpec('interface', 'iportal', { methods: [{ name: 'execute', description: 'Execute it, through the engine' }] });
    expect(report.written).toBe(true);
    expect(report.changes.map((c) => c.path)).toEqual(['methods.execute.description']);
    const stored = readYaml(specs(dir, 'core', 'portal', '.interface.yaml'));
    expect(stored.methods[0]).toEqual({ name: 'execute', description: 'Execute it, through the engine', signatureFrom: 'engine.run' });
  });

  it('derives a delta\'s method text from its params, never taking the text the delta states', () => {
    const dir = buildTree();
    bind(dir);
    // Params upsert by name: `extra` is appended after the stored two.
    const report = updateSpec('interface', 'iengine', { methods: [{ name: 'run', signature: 'run(whatever)', params: [{ name: 'extra', type: 'number' }] }] });
    expect(report.changes.map((c) => c.path)).toContain('methods.run.signature');
    expect(readYaml(specs(dir, 'core', 'engine', '.interface.yaml')).methods[0].signature)
      .toBe('run(values: list<string>, mode?: string, extra: number): void');
  });

  it('writes nothing for a delta whose only edit is a text its params already derive', () => {
    const dir = buildTree();
    bind(dir);
    const report = updateSpec('interface', 'iengine', { methods: [{ name: 'run', signature: 'run(whatever)' }] });
    expect(report.written).toBe(false);
  });

  it('adopts a source when the delta unsets the method\'s params and returns', () => {
    const dir = buildTree([{ name: 'execute', description: 'Execute', signature: 'execute(values: list<string>, mode?: string): void', returns: 'void', params: RUN_PARAMS }]);
    bind(dir);
    updateSpec('interface', 'iportal', { methods: [{ name: 'execute', signatureFrom: 'engine.run', unset: ['params', 'returns'] }] });
    const stored = readYaml(specs(dir, 'core', 'portal', '.interface.yaml')).methods[0];
    expect(stored).toEqual({ name: 'execute', description: 'Execute', signatureFrom: 'engine.run' });
    invalidateSpecCache();
    expect(methodOf(loadInterfaceSpec('iportal'), 'execute')!.params).toEqual(RUN_PARAMS);
  });

  it('round-trips the loaded tree through the writer schema (the dry run lock relies on)', () => {
    bind(buildTree());
    expect(dryRunSerializeSpecs()).toEqual([]);
  });

  it('stores a type method\'s derived text', () => {
    const dir = buildTree();
    bind(dir);
    const type = loadSpec('type', 'change_listener')!;
    saveSpec('type', { ...type, kind: 'value-object', params: undefined, returns: undefined, methods: [{ name: 'matches', signature: 'stale', params: [{ name: 'ref', type: 'string' }], returns: 'bool' }] } as never);
    const stored = readYaml(specs(dir, 'types', 'change_listener.yaml'));
    expect(stored.methods[0].signature).toBe('matches(ref: string): bool');
  });
});

describe('renames carry signatureFrom', () => {
  it('rewriteSpecRefs reads it as a component.method pair, each half against the other', () => {
    const doc: any = { id: 'iportal', component: 'portal', methods: [{ name: 'execute', signatureFrom: 'engine.run' }] };
    rewriteSpecRefs(doc, (ref, position, owner) => (position === 'method' && owner === 'engine' && ref === 'run' ? 'start' : ref));
    expect(doc.methods[0].signatureFrom).toBe('engine.start');
    rewriteSpecRefs(doc, (ref, position) => (position === 'component' && ref === 'engine' ? 'motor' : ref));
    expect(doc.methods[0].signatureFrom).toBe('motor.start');
  });

  it('rewriteSpecRefs reads a value with no method head as a type reference', () => {
    const doc: any = { id: 'iportal', component: 'portal', methods: [{ name: 'onChange', signatureFrom: 'change_listener' }] };
    rewriteSpecRefs(doc, (ref, position) => (position === 'type' && ref === 'change_listener' ? 'core::change_listener' : ref));
    expect(doc.methods[0].signatureFrom).toBe('core::change_listener');
  });

  it('renameMethod retargets every signatureFrom naming the method', () => {
    const dir = buildTree();
    bind(dir);
    renameMethod('engine', 'run', 'start');
    invalidateSpecCache();
    expect(readYaml(specs(dir, 'core', 'portal', '.interface.yaml')).methods[0].signatureFrom).toBe('engine.start');
    expect(methodOf(loadInterfaceSpec('iportal'), 'execute')!.params).toEqual(RUN_PARAMS);
  });

  it('renameComponent re-points the head of every signatureFrom naming the component', () => {
    const dir = buildTree();
    bind(dir);
    renameComponent('engine', 'motor');
    invalidateSpecCache();
    const portal = readYaml(fs.readdirSync(specs(dir, 'core')).includes('portal')
      ? specs(dir, 'core', 'portal', '.interface.yaml') : '');
    expect(portal.methods[0].signatureFrom).toBe('motor.run');
    expect(signatureFacts().sources.find((f) => f.method === 'execute')).toMatchObject({ outcome: 'resolved', target: 'motor.run' });
  });
});

describe('a cross-project method source `alias::component.method`', () => {
  function withSourcedShell(): ReferenceFamily {
    const fam = buildReferenceFamily();
    writeSpecFile(specs(fam.top, 'app', 'app-shell', '.interface.yaml'), InterfaceSpecSchema.parse({
      id: 'iapp-shell', name: 'iapp-shell', description: 'The shell', component: 'app-shell', status: 'complete',
      createdAt: STAMP, updatedAt: STAMP,
      methods: [{ name: 'run', description: 'Run through the engine', signatureFrom: 'core::engine-portal.run' }],
    }));
    return fam;
  }

  it('binds the head through the alias table and resolves the producer\'s params', () => {
    family = withSourcedShell();
    bind(family.top);
    const run = methodOf(loadInterfaceSpec('iapp-shell'), 'run')!;
    expect(run.signatureFrom).toBe('core::engine-portal.run');
    expect(run.params).toEqual([{ name: 'values', type: 'shared::host-var-values', description: 'The host variables' }]);
    expect(signatureFacts().sources.find((f) => f.interfaceId === 'iapp-shell')).toMatchObject({ form: 'method', target: 'core::engine-portal.run', outcome: 'resolved' });
  });

  it('writes the authored `alias::` text back on a re-save, and nothing the source supplies', () => {
    family = withSourcedShell();
    bind(family.top);
    saveSpec('interface', loadInterfaceSpec('iapp-shell')!);
    const stored = readYaml(specs(family.top, 'app', 'app-shell', '.interface.yaml'));
    expect(stored.methods[0]).toEqual({ name: 'run', description: 'Run through the engine', signatureFrom: 'core::engine-portal.run' });
  });

  it('re-saves a member\'s sourced contract from the top as the exact inverse of the scan', () => {
    family = buildReferenceFamily();
    writeSpecFile(specs(family.core, 'engine', 'engine-relay', '.index.yaml'), ComponentSpecSchema.parse({
      id: 'engine-relay', name: 'engine-relay', description: 'relay', subsystem: 'engine', componentType: 'Orchestrator',
      owns: [], dependsOn: ['engine-portal'], status: 'complete', createdAt: STAMP, updatedAt: STAMP,
    }));
    const relayFile = specs(family.core, 'engine', 'engine-relay', '.interface.yaml');
    writeSpecFile(relayFile, InterfaceSpecSchema.parse({
      id: 'iengine-relay', name: 'iengine-relay', description: 'relay', component: 'engine-relay', status: 'complete',
      createdAt: STAMP, updatedAt: STAMP, methods: [{ name: 'relay', description: 'Relay a run', signatureFrom: 'engine-portal.run' }],
    }));
    bind(family.top);
    const relay = loadInterfaceSpec('core::iengine-relay')!;
    expect(relay.methods[0].signatureFrom).toBe('core::engine-portal.run');
    expect(relay.methods[0].params).toHaveLength(1);
    const before = fs.readFileSync(relayFile, 'utf8');
    saveSpec('interface', relay);
    expect(readYaml(relayFile).methods[0]).toEqual({ name: 'relay', description: 'Relay a run', signatureFrom: 'engine-portal.run' });
    expect(readYaml(relayFile).methods).toEqual((yaml.load(before) as any).methods);
  });
});
