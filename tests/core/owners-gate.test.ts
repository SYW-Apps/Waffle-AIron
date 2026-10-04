import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { setProjectRoot, runWithProjectBinding } from '../../src/utils/fs.js';
import { invalidateSpecCache } from '../../src/core/specs.js';
import { validateProject, validateAsComplete, type ValidationResult } from '../../src/core/validation.js';
import { pinExternals } from '../../src/core/surfaces.js';
import { externalsRepository } from '../../src/core/externals.js';
import { projectConfigRepositoryAt } from '../../src/config/project-config.js';
import { canonicalTypeRef, contentDigest, memberDigest, nameKey, SurfaceSnapshotSchema } from '../../src/models/index.js';
import { buildReferenceFamily, buildImportFamily, type ImportFamily, type ReferenceFamily } from '../helpers/reference-family.js';

// ---------------------------------------------------------------------------
// Stage 4, wave A — the owner's gate (validateProject). A project is judged
// from its own files alone: its specs, its configuration, its pins and its
// contained members' export tables. Every property runs over real temp
// directories with nothing mocked on the path under test.
// ---------------------------------------------------------------------------

const cleanups: (() => void)[] = [];
afterEach(() => {
  setProjectRoot(null);
  invalidateSpecCache();
  for (const c of cleanups.splice(0)) {
    try { c(); } catch { /* windows file locks */ }
  }
});

function bind(dir: string): void {
  setProjectRoot(dir);
  invalidateSpecCache();
}

/** A verdict as a sorted list of `severity CODE @spec`, independent of where the project lies on disk. */
function verdict(res: ValidationResult): string[] {
  return res.issues.map((i) => `${i.severity} ${i.code} @${i.specId ?? '-'}`).sort();
}

function validateAt(dir: string): ValidationResult {
  bind(dir);
  return validateProject();
}

/** A copy of one project directory alone, with no family around it. */
function alone(dir: string): string {
  const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-alone-'));
  fs.cpSync(dir, copy, { recursive: true });
  cleanups.push(() => fs.rmSync(copy, { recursive: true, force: true }));
  return copy;
}

function referenceFamily(): ReferenceFamily {
  const f = buildReferenceFamily();
  cleanups.push(() => f.cleanup());
  return f;
}

function importFamily(): ImportFamily {
  const f = buildImportFamily();
  cleanups.push(() => f.cleanup());
  return f;
}

const codes = (res: ValidationResult, ...wanted: string[]): string[] =>
  verdict(res).filter((line) => wanted.some((c) => line.includes(` ${c} `)));

describe('the owner\'s gate — location', () => {
  it('location-independent: a member gets the same verdict alone and with its family on disk', () => {
    const f = referenceFamily();
    for (const member of [f.transpiler, f.shared, f.core]) {
      const inFamily = verdict(validateAt(member));
      const standalone = verdict(validateAt(alone(member)));
      expect(standalone).toEqual(inFamily);
      expect(inFamily.length).toBeGreaterThan(0);
    }
  });

  it('location-independent as-complete: the lock gate holds a member to one verdict wherever it is locked', () => {
    const f = referenceFamily();
    bind(f.transpiler);
    const inFamily = verdict(validateAsComplete());
    bind(alone(f.transpiler));
    expect(verdict(validateAsComplete())).toEqual(inFamily);
  });

  it('no-softening-by-location: a parent that turns rules off softens nothing its member reports', () => {
    const f = referenceFamily();
    const before = verdict(validateAt(f.transpiler));
    // The parent's doctrine switches off exactly the codes the member reports.
    const lenient = ['id: waffly', 'name: Waffly', 'members:', '  core: core', 'rules:', '  sddRuleSeverity:',
      '    EXTERNAL_CHECK_UNAVAILABLE: "off"', '    DEPRECATED_REFERENCE_FORM: "off"', '    INVALID_DEPENDENCY_REFERENCE: "off"',
      'targets: []', "createdAt: '2026-09-27T00:00:00.000Z'", "updatedAt: '2026-09-27T00:00:00.000Z'", ''];
    fs.writeFileSync(path.join(f.top, '.wai', 'project.yaml'), lenient.join('\n'));
    expect(verdict(validateAt(f.transpiler))).toEqual(before);
    // And the parent's own run never re-judges the member's specs at all.
    const fromTop = validateAt(f.top);
    expect(fromTop.issues.filter((i) => (i.specId ?? '').startsWith('transpiler::'))).toEqual([]);
  });

  it('same-config-both-roots: the member\'s own configuration governs it however the request binds it', () => {
    const f = referenceFamily();
    // The member raises a notice to an error in its own project.yaml.
    const config = projectConfigRepositoryAt(f.transpiler).load()!;
    fs.writeFileSync(path.join(f.transpiler, '.wai', 'project.yaml'), [
      'schemaVersion: 1.0.0', 'id: transpiler', `name: ${config.name}`, 'rules:', '  sddRuleSeverity:', '    DEPRECATED_REFERENCE_FORM: error',
      'targets: []', "createdAt: '2026-09-27T00:00:00.000Z'", "updatedAt: '2026-09-27T00:00:00.000Z'", ''].join('\n'));
    // The caller supplies the bound project's own rules (as the CLI and MCP do).
    const rules = projectConfigRepositoryAt(f.transpiler).load()!.rules;
    bind(f.transpiler);
    const own = validateProject({ rules });
    expect(codes(own, 'DEPRECATED_REFERENCE_FORM').length).toBeGreaterThan(0);
    expect(codes(own, 'DEPRECATED_REFERENCE_FORM').every((l) => l.startsWith('error '))).toBe(true);
    // A request bound to the member through a credential for the whole family: the same verdict.
    invalidateSpecCache();
    let viaFamily: ValidationResult | undefined;
    runWithProjectBinding(f.transpiler, { topRoot: f.top, parentReach: true }, () => { viaFamily = validateProject({ rules }); });
    expect(verdict(viaFamily!)).toEqual(verdict(own));
  });
});

describe('the owner\'s gate — references into other projects', () => {
  it('a reference into a declared external is judged against the pin alone: unavailable, then resolved', () => {
    const f = importFamily();
    f.setAppExternals({ shared: {} });
    // Unpinned: the `shared::host-record` field has nothing to be judged against.
    const unpinned = validateAt(f.app);
    const unavailable = unpinned.issues.filter((i) => i.code === 'EXTERNAL_CHECK_UNAVAILABLE');
    expect(unavailable.map((i) => i.specId)).toContain('screen-state');
    expect(unavailable[0].resolution).toMatchObject({ outcome: 'unavailable', owner: 'app' });
    bind(f.app);
    pinExternals();
    const pinned = validateAt(f.app);
    expect(codes(pinned, 'EXTERNAL_CHECK_UNAVAILABLE', 'EXTERNAL_NOT_EXPORTED')).toEqual([]);
    expect(pinned.hint).toMatch(/1 external was judged against its pin alone; `wairon validate --family`/);
  });
});

describe('the owner\'s gate — `use` imports', () => {
  it('without an import a bare name another project exports is unresolved, and the finding names the `use` line', () => {
    const f = importFamily();
    const res = validateAt(f.top);
    const undefinedRef = res.issues.filter((i) => i.code === 'UNDEFINED_TYPE_REFERENCE' && i.specId === 'report');
    expect(undefinedRef).toHaveLength(1);
    expect(undefinedRef[0].message).toContain('members.shared.use: [waffler-error]');
  });

  it('nameKey: `WafflerError` imports as `waffler-error` — one key for every spelling', () => {
    expect(nameKey('WafflerError')).toBe(nameKey('waffler-error'));
    expect(nameKey('waffler_error')).toBe('wafflererror');
    const f = importFamily();
    f.setTopMembers({ shared: { path: 'shared', use: ['waffler-error'] } });
    expect(codes(validateAt(f.top), 'UNDEFINED_TYPE_REFERENCE', 'IMPORT_AMBIGUOUS', 'IMPORT_UNRESOLVED')).toEqual([]);
  });

  it('two `*` imports supplying one name are ambiguous; an explicit name beats a `*`', () => {
    const f = importFamily();
    f.setTopMembers({ shared: { path: 'shared', use: ['*'] }, ui: { path: 'ui', use: ['*'] } });
    const ambiguous = validateAt(f.top);
    expect(codes(ambiguous, 'IMPORT_AMBIGUOUS')).toEqual(['error IMPORT_AMBIGUOUS @report']);
    expect(ambiguous.issues.find((i) => i.code === 'IMPORT_AMBIGUOUS')!.resolution?.outcome).toBe('ambiguous');
    f.setTopMembers({ shared: { path: 'shared', use: ['waffler-error'] }, ui: { path: 'ui', use: ['*'] } });
    expect(codes(validateAt(f.top), 'IMPORT_AMBIGUOUS', 'UNDEFINED_TYPE_REFERENCE')).toEqual([]);
    // Two explicit names are ambiguous too.
    f.setTopMembers({ shared: { path: 'shared', use: ['waffler-error'] }, ui: { path: 'ui', use: ['waffler_error'] } });
    expect(codes(validateAt(f.top), 'IMPORT_AMBIGUOUS')).toEqual(['error IMPORT_AMBIGUOUS @report']);
  });

  it('local first: a named import a local spec hides is IMPORT_SHADOWED_BY_LOCAL; a hidden `*` is silent', () => {
    const f = importFamily();
    f.addTopType('waffler-error', [{ name: 'code', type: 'number' }]);
    f.setTopMembers({ shared: { path: 'shared', use: ['waffler-error'] } });
    expect(codes(validateAt(f.top), 'IMPORT_SHADOWED_BY_LOCAL')).toEqual(['error IMPORT_SHADOWED_BY_LOCAL @-']);
    f.setTopMembers({ shared: { path: 'shared', use: ['*'] } });
    const star = validateAt(f.top);
    expect(codes(star, 'IMPORT_SHADOWED_BY_LOCAL', 'IMPORT_AMBIGUOUS', 'UNDEFINED_TYPE_REFERENCE')).toEqual([]);
  });

  it('a `use` name the producer does not export is IMPORT_UNRESOLVED, naming what it does export', () => {
    const f = importFamily();
    f.setTopMembers({ shared: { path: 'shared', use: ['waffler-eror'] } });
    const res = validateAt(f.top);
    const unresolved = res.issues.filter((i) => i.code === 'IMPORT_UNRESOLVED');
    expect(unresolved).toHaveLength(1);
    expect(unresolved[0].message).toContain('"waffler-error"');
  });

  it('an import from a declared external resolves against its pin, and the lock pins the name used bare', () => {
    const f = importFamily();
    f.setAppExternals({ shared: { use: ['waffler-error', 'host-record'] } });
    bind(f.app);
    pinExternals();
    const res = validateAt(f.app);
    expect(codes(res, 'UNDEFINED_TYPE_REFERENCE', 'EXTERNAL_CHECK_UNAVAILABLE', 'IMPORT_UNRESOLVED')).toEqual([]);
    bind(f.app);
    const lock = externalsRepository.readLock()!;
    // `WafflerError`, written bare, is a use the lock pins.
    expect(Object.keys(lock.externals.shared.used)).toContain('waffler-error');
  });
});

describe('canonical digests', () => {
  it('re-spelling a reference in a producer changes no byte of its pinned snapshot and no digest', () => {
    const f = importFamily();
    f.setAppExternals({ shared: {} });
    bind(f.app);
    pinExternals();
    const file = path.join(f.app, '.wai', 'externals', 'shared.yaml');
    const lockFile = path.join(f.app, '.wai', 'externals.lock.yaml');
    const snapshotBytes = fs.readFileSync(file);
    const lockBytes = fs.readFileSync(lockFile);
    // The producer names its own type through its own id instead of bare.
    f.setSharedRecordField('shared::index-value');
    bind(f.app);
    expect(pinExternals()[0].outcome).toBe('unchanged');
    expect(fs.readFileSync(file).equals(snapshotBytes)).toBe(true);
    expect(fs.readFileSync(lockFile).equals(lockBytes)).toBe(true);
  });

  it('canonicalTypeRef reads builtins, own-id prefixes and closure types into one spelling; prose never moves a digest', () => {
    const snapshot = SurfaceSnapshotSchema.parse({
      projectName: 'Shared', projectId: 'shared', origin: 'generated', generatedAt: '2026-09-28T00:00:00.000Z',
      interfaces: [],
      types: [
        { id: 'index-value', name: 'IndexValue', fields: [{ name: 'value', type: 'number', description: 'the value' }] },
        { id: 'host-record', name: 'HostRecord', fields: [{ name: 'index', type: 'shared::index-value' }] },
      ],
      exportedTypes: [{ id: 'host-record', type: 'host-record', audience: 'project' }],
    });
    // Stage 2: the canonical expression, so an alias and its canonical spelling digest alike.
    expect(canonicalTypeRef(snapshot, 'Promise<IndexValue | null>')).toBe('async index-value?');
    expect(canonicalTypeRef(snapshot, 'async IndexValue?')).toBe('async index-value?');
    expect(canonicalTypeRef(snapshot, 'shared.index-value[]')).toBe('list<index-value>');
    expect(canonicalTypeRef(snapshot, 'other::thing')).toBe('other::thing');
    const respelled = { ...snapshot, types: snapshot.types.map((t) => (t.id === 'host-record' ? { ...t, fields: [{ name: 'index', type: 'IndexValue' }] } : t)) };
    const reworded = { ...snapshot, types: snapshot.types.map((t) => ({ ...t, name: `${t.name} (renamed)`, fields: t.fields.map((fl) => ({ ...fl, description: 'reworded' })) })) };
    expect(contentDigest(respelled)).toBe(contentDigest(snapshot));
    expect(contentDigest(reworded)).toBe(contentDigest(snapshot));
    expect(memberDigest(respelled, 'host-record', 'type')).toBe(memberDigest(snapshot, 'host-record', 'type'));
    // A contract change still moves it.
    const changed = { ...snapshot, types: snapshot.types.map((t) => (t.id === 'index-value' ? { ...t, fields: [{ name: 'value', type: 'string' }] } : t)) };
    expect(contentDigest(changed)).not.toBe(contentDigest(snapshot));
  });
});
