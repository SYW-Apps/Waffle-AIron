import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { setProjectRoot, runWithProjectBinding, runWithProjectRoot } from '../../src/utils/fs.js';
import {
  invalidateSpecCache,
  loadComponentSpecs,
  saveSpec,
  saveComponentSpec,
  saveSystemSpec,
} from '../../src/core/specs.js';
import { projectFamilyGraph } from '../../src/core/project-family.js';
import { externalizeSubsystem, internalizeMember, moveMember } from '../../src/core/provision.js';
import { projectConfigRepository, projectConfigRepositoryAt } from '../../src/config/project-config.js';
import { validateSddTree, type ValidationResult } from '../../src/core/validation.js';
import { writeYamlFile } from '../../src/utils/yaml.js';
import { plan, apply, isEmpty, blocked } from '../../src/commands/chaining-migration.js';
import { runDoctor } from '../../src/commands/doctor.js';
import { buildReferenceFamily, type ReferenceFamily } from '../helpers/reference-family.js';

// ---------------------------------------------------------------------------
// Stage 3, wave C — the migration that retires position, over the reference
// family (tests/helpers/reference-family.ts: Waffler's shape in miniature) and
// real temp directories; nothing on the path under test is mocked.
//
// The `property:` cases are stage-3.md §8's migration properties; the three
// `follow-up` cases are the wave-B follow-ups decided on 2026-09-27.
// ---------------------------------------------------------------------------

const execFileP = promisify(execFile);
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const TSX_CLI = path.join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const WAIRON_CLI = path.join(REPO_ROOT, 'src', 'cli', 'index.ts');

/** `wairon doctor …` in a real process with no terminal; resolves whatever its exit code. */
const doctorCli = (cwd: string, ...args: string[]): Promise<{ stdout: string; code: number }> =>
  execFileP(process.execPath, [TSX_CLI, WAIRON_CLI, 'doctor', ...args], { cwd, timeout: 180_000 })
    .then((r) => ({ stdout: r.stdout, code: 0 }))
    .catch((e: Error & { stdout?: string; code?: number }) => ({ stdout: e.stdout ?? '', code: e.code ?? 1 }));

/** Bind a root and read it as it is now. */
function at<T>(dir: string, fn: () => T): T {
  invalidateSpecCache();
  setProjectRoot(dir);
  return fn();
}

/** Every file under the family, hashed — the whole directory, so a write anywhere shows. */
function dirHash(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else out[path.relative(root, full)] = crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex');
    }
  };
  walk(root);
  return out;
}

const codes = (res: ValidationResult, ...wanted: string[]): string[] =>
  res.issues.filter((i) => wanted.includes(i.code)).map((i) => `${i.code} @${i.specId ?? '-'}`).sort();

const rel = (root: string, items: string[]): string[] => items.map((w) => path.relative(root, w).split(path.sep).join('/'));

describe('stage 3 — the position migration over the reference family', () => {
  let family: ReferenceFamily | null = null;
  const fresh = (): ReferenceFamily => {
    family = buildReferenceFamily();
    return family;
  };

  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    setProjectRoot(null);
    invalidateSpecCache();
    family?.cleanup();
    family = null;
  });

  it('plans the mount move, the carried fields and every rewrite, raw and bound alike', () => {
    const f = fresh();
    const planned = at(f.transpiler, () => plan());
    expect(planned.familyRoot).toBe(path.resolve(f.top));
    expect(blocked(planned)).toBe(false);
    const top = planned.projects.find((p) => p.project === '')!;
    // The mount moves, its description into the member entry; its entry names no component, so it exports nothing and retires, listed.
    expect(top.members).toEqual([{
      parent: '', alias: 'shared', path: 'shared', description: 'The vocabulary every project speaks', member: 'shared', carried: [],
      retired: ['publicInterfaces: Custom "The shared vocabulary" (names no component — nothing to export)', 'trustedLinks: []'],
    }]);
    // Every deprecated form, each once: bare where it lands at home, `alias::name` elsewhere.
    expect(planned.rewrites.map((r) => [r.project, r.specId, r.form, r.from, r.to])).toEqual([
      ['', 'app-worker', 'leading', '::core::engine-portal', 'core::engine-portal'],
      ['transpiler', 'transpiler::lowering-core', 'super', 'super::engine-portal', 'core::engine-portal'],
      ['transpiler', 'transpiler::lowering-core', 'path', 'core::transpiler::lowering-portal', 'lowering-portal'],
      ['transpiler', 'transpiler::lowering-core', 'leading', '::core::engine-portal', 'core::engine-portal'],
    ]);
    // The rewrite into core needs transpiler's external for it — and nothing else: core exports engine-portal already.
    expect(planned.projects.find((p) => p.project === 'transpiler')?.externals.map((e) => e.alias)).toEqual(['core']);
    expect(planned.findings).toEqual([]);
  });

  it('property: migration-is-plan-first — plan, --report and an unconfirmed --fix write nothing', async () => {
    const f = fresh();
    const before = dirHash(f.top);
    at(f.top, () => plan());
    expect(dirHash(f.top)).toEqual(before);
    at(f.core, () => undefined);
    await runDoctor({ report: 'chaining' });
    const printed = vi.mocked(console.log).mock.calls.map((c) => String(c[0])).join('\n');
    expect(printed).toContain('member: shared: shared — moved from its legacy L1 mount, its description carried');
    expect(printed).toMatch(/Rewrites.* \(4\)/);
    expect(printed).toContain('transpiler (3):');
    expect(printed).toContain('Nothing was written.');
    expect(dirHash(f.top)).toEqual(before);
    const unconfirmed = await doctorCli(f.top, '--fix');
    expect(unconfirmed.stdout).toContain('Chaining migration skipped: no terminal to confirm it');
    // Every file of the family — specs, configurations, pins — as it was.
    const after = dirHash(f.top);
    const touched = Object.keys(after).filter((k) => after[k] !== before[k] && /[\\/]\.wai[\\/](specs|project\.yaml|externals|surfaces)/.test(k));
    expect(touched).toEqual([]);
  }, 240_000);

  it('after apply: no deprecated form, no mount form, and the migrated references are declared and exported', () => {
    const f = fresh();
    const before = at(f.top, () => validateSddTree());
    expect(codes(before, 'DEPRECATED_REFERENCE_FORM')).toHaveLength(4);
    expect(codes(before, 'DEPRECATED_MOUNT_FORM')).toEqual(['DEPRECATED_MOUNT_FORM @shared']);
    expect(codes(before, 'EXTERNAL_UNDECLARED', 'EXTERNAL_NOT_EXPORTED')).toHaveLength(2);
    const report = at(f.top, () => apply(plan()));
    expect(rel(f.top, report.written)).toEqual([
      'core/transpiler/.wai/project.yaml',
      'core/transpiler/.wai/externals/core.yaml',
      'core/transpiler/.wai/externals.lock.yaml',
      '.wai/project.yaml',
      '.wai/specs: subsystem shared',
      '.wai/specs: component app-worker',
      'core/transpiler/.wai/specs: component lowering-core',
    ]);
    for (const root of [f.top, f.core, f.transpiler, f.shared]) {
      const after = at(root, () => validateSddTree());
      expect(codes(after, 'DEPRECATED_REFERENCE_FORM', 'DEPRECATED_MOUNT_FORM', 'EXTERNAL_UNDECLARED', 'EXTERNAL_NOT_EXPORTED', 'EXTERNAL_UNRESOLVED')).toEqual([]);
    }
    // The member entry carries the mount's description; no L1 document is left.
    const members = (yaml.load(fs.readFileSync(path.join(f.top, '.wai', 'project.yaml'), 'utf8')) as { members: unknown }).members;
    expect(members).toEqual({ core: 'core', shared: { path: 'shared', description: 'The vocabulary every project speaks' } });
    expect(fs.existsSync(path.join(f.top, '.wai', 'specs', 'shared', '.index.yaml'))).toBe(false);
    // The rewritten text, on disk.
    const lowering = yaml.load(fs.readFileSync(path.join(f.transpiler, '.wai', 'specs', 'lowering', 'lowering-core', '.index.yaml'), 'utf8')) as { dependsOn: string[] };
    expect(lowering.dependsOn).toEqual(['core::engine-portal', 'lowering-portal', 'core::engine-portal']);
  });

  it('property: idempotence — the second plan is empty and a second apply writes nothing', () => {
    const f = fresh();
    const first = at(f.top, () => plan());
    at(f.top, () => apply(first));
    const settled = dirHash(f.top);
    for (const root of [f.top, f.core, f.transpiler, f.shared]) {
      const again = at(root, () => plan());
      expect(isEmpty(again)).toBe(true);
      expect(again.rewrites).toEqual([]);
      expect(again.projects).toEqual([]);
    }
    const second = at(f.top, () => plan());
    expect(at(f.top, () => apply(second))).toEqual({ plan: second, applied: false, written: [], relock: [] });
    // Applying the first plan again changes nothing either: each write is idempotent.
    const replay = at(f.top, () => apply(first));
    expect(replay.written).toEqual([]);
    expect(dirHash(f.top)).toEqual(settled);
  });

  it('property: root-invariance still holds after the migration — one target per reference from every root', () => {
    const f = fresh();
    at(f.top, () => apply(plan()));
    /** Each bound dependsOn of lowering-core, as (the directory of the project it lands in, its local id). */
    const landings = (root: string, key: string): string[] => at(root, () => {
      const graph = projectFamilyGraph();
      return (loadComponentSpecs().find((c) => c.id === key)?.dependsOn ?? []).map((target) => {
        const owner = graph.owners.get(target) ?? '';
        const node = graph.nodes.find((n) => n.namespace === owner)!;
        const local = owner && target.startsWith(`${owner}::`) ? target.slice(owner.length + 2) : target;
        return `${path.relative(f.top, node.directory).split(path.sep).join('/') || '.'}:${local}`;
      });
    });
    const expected = ['core:engine-portal', 'core/transpiler:lowering-portal', 'core:engine-portal'];
    expect(landings(f.top, 'transpiler::lowering-core')).toEqual(expected);
    expect(landings(f.core, 'transpiler::lowering-core')).toEqual(expected);
    // From transpiler's own root the scan holds no core, so the text binds nothing
    // there — and it is the same `alias::name` text, judged through the parent.
    const own = at(f.transpiler, () => projectFamilyGraph().authoredReferences.filter((r) => r.specId === 'lowering-core'));
    expect(own.map((r) => [r.authored, r.form])).toEqual([['core::engine-portal', 'alias'], ['core::engine-portal', 'alias']]);
  });

  it('property: alias-rename-touches-no-sibling — renaming a member alias leaves every sibling byte for byte and verdict for verdict', () => {
    const f = fresh();
    at(f.top, () => apply(plan()));
    const siblings = [f.shared, f.core];
    const hashes = siblings.map(dirHash);
    const verdicts = siblings.map((root) => at(root, () => validateSddTree().issues.map((i) => `${i.code}|${i.specId}|${i.message}`).sort()));
    // The parent renames its alias for core — one key in its own project.yaml, in place, nothing else.
    const config = path.join(f.top, '.wai', 'project.yaml');
    const text = fs.readFileSync(config, 'utf8');
    expect(text).toMatch(/^ {2}core: core$/m);
    fs.writeFileSync(config, text.replace(/^ {2}core: core$/m, '  engine-core: core'));
    expect(siblings.map(dirHash)).toEqual(hashes);
    // shared reaches core by its own external (the producer's project id), never the parent's alias.
    expect(siblings.map((root) => at(root, () => validateSddTree().issues.map((i) => `${i.code}|${i.specId}|${i.message}`).sort()))).toEqual(verdicts);
    const fromTop = at(f.top, () => validateSddTree());
    expect(codes(fromTop, 'EXTERNAL_UNDECLARED', 'EXTERNAL_UNRESOLVED').filter((c) => !/@(app-shell|app-worker)$/.test(c))).toEqual([]);
  });
});

describe('stage 3 — the wave-B follow-ups', () => {
  let family: ReferenceFamily | null = null;
  const made: string[] = [];

  afterEach(() => {
    setProjectRoot(null);
    invalidateSpecCache();
    family?.cleanup();
    family = null;
    for (const dir of made.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('follow-up (a): member move refuses a legacy mount carrying fields beyond its path and description, pointing at doctor --fix', () => {
    family = buildReferenceFamily();
    const f = family;
    const before = dirHash(f.top);
    // shared's mount carries a publicInterfaces entry: a move would drop it.
    expect(() => at(f.top, () => moveMember('shared', 'vocabulary'))).toThrow(/carries publicInterfaces.*`wairon doctor --fix`/s);
    expect(dirHash(f.top)).toEqual(before);
    // Once the migration carried it, the member moves.
    at(f.top, () => apply(plan()));
    at(f.top, () => moveMember('shared', 'vocabulary'));
    expect(fs.existsSync(path.join(f.top, 'vocabulary', '.wai', 'project.yaml'))).toBe(true);
  });

  it('follow-up (b): internalizeMember refuses while another project of the family references the member, listing each reference', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-internalize-'));
    made.push(root);
    const now = new Date().toISOString();
    fs.mkdirSync(path.join(root, '.wai', 'specs'), { recursive: true });
    writeYamlFile(path.join(root, '.wai', 'project.yaml'), {
      schemaVersion: '1.0.0', id: 'fleet', name: 'fleet', targets: [], rules: {}, extensions: { packs: [], useGlobalPacks: false }, createdAt: now, updatedAt: now,
    });
    at(root, () => {
      saveSystemSpec({ schemaVersion: '1.0.0', name: 'fleet', vision: 'v', boundaries: [], globalRequirements: [], createdAt: now, updatedAt: now } as never);
      saveSpec('subsystem', { id: 'core', name: 'core', description: 'the core', parentSystem: 'fleet', publicInterfaces: [{ type: 'Custom', details: 'core api', component: 'core_portal' }], trustedLinks: [], status: 'draft', createdAt: now, updatedAt: now } as never);
      saveComponentSpec({ id: 'core_portal', name: 'Core Portal', description: 'front door', subsystem: 'core', componentType: 'Portal', portalType: 'Custom', owns: [], dependsOn: [], createdAt: now, updatedAt: now } as never);
      invalidateSpecCache();
      externalizeSubsystem('core', 'packages/core');
    });
    // A second member, ops, reaches core through an external of its own.
    const ops = path.join(root, 'packages', 'ops');
    fs.mkdirSync(path.join(ops, '.wai', 'specs'), { recursive: true });
    writeYamlFile(path.join(ops, '.wai', 'project.yaml'), {
      schemaVersion: '1.0.0', id: 'ops', name: 'ops', targets: [], externals: { core: {} }, createdAt: now, updatedAt: now,
    });
    runWithProjectRoot(ops, () => {
      saveSystemSpec({ schemaVersion: '1.0.0', name: 'ops', vision: 'v', boundaries: [], globalRequirements: [], createdAt: now, updatedAt: now } as never);
      saveSpec('subsystem', { id: 'dispatch', name: 'dispatch', description: 'd', parentSystem: 'ops', publicInterfaces: [], trustedLinks: [], status: 'draft', createdAt: now, updatedAt: now } as never);
      saveComponentSpec({ id: 'dispatch_adapter', name: 'Dispatch Adapter', description: 'hop into core', subsystem: 'dispatch', componentType: 'Adapter', owns: [], dependsOn: ['core::core_portal'], createdAt: now, updatedAt: now } as never);
    });
    at(root, () => projectConfigRepository.declareMember('ops', { path: 'packages/ops' }));
    const before = dirHash(root);
    expect(() => at(root, () => internalizeMember('core'))).toThrow(/other projects of the family reference the member "core" — ops: ops::dispatch_adapter \(dependsOn\) "core::core_portal"/);
    expect(dirHash(root)).toEqual(before);
    // With the reference gone, the same member is taken in.
    runWithProjectRoot(ops, () => {
      invalidateSpecCache();
      saveComponentSpec({ id: 'dispatch_adapter', name: 'Dispatch Adapter', description: 'no longer crosses', subsystem: 'dispatch', componentType: 'Adapter', owns: [], dependsOn: [], createdAt: now, updatedAt: now } as never);
    });
    at(root, () => internalizeMember('core'));
    expect(projectConfigRepositoryAt(root).load()?.members).toEqual({ ops: 'packages/ops' });
  });

  it('follow-up (c): a member declaring its parent or a sibling is clean from its own root; only what neither the scan nor the climb finds is EXTERNAL_UNRESOLVED', () => {
    family = buildReferenceFamily();
    const f = family;
    at(f.top, () => apply(plan()));
    // transpiler declares its parent core, shared declares its sibling core: each producer lies above its root.
    for (const root of [f.transpiler, f.shared]) expect(codes(at(root, () => validateSddTree()), 'EXTERNAL_UNRESOLVED')).toEqual([]);
    // A misspelled declaration is still reported from the member's own root …
    runWithProjectRoot(f.shared, () => projectConfigRepository.declareExternal('nowhere', {}));
    expect(codes(at(f.shared, () => validateSddTree()), 'EXTERNAL_UNRESOLVED')).toEqual(['EXTERNAL_UNRESOLVED @-']);
    // … and a request that may not read above its root cannot climb: its own scan's verdict stands.
    const narrowed = runWithProjectBinding(f.transpiler, { topRoot: f.transpiler, parentReach: false }, () => {
      invalidateSpecCache();
      return validateSddTree();
    });
    expect(codes(narrowed, 'EXTERNAL_UNRESOLVED')).toEqual(['EXTERNAL_UNRESOLVED @-']);
  });
});

// ---------------------------------------------------------------------------
// The chaining migration's own stage-3 steps: project-level types exported as
// the project's own, a minimal L0 for a project that exports and has none,
// the keys a first gated L0 write drops, and a mount entry carried into its
// member (published at L1 first where its subsystem does not publish it yet).
// ---------------------------------------------------------------------------

const TS = '2026-01-01T00:00:00.000Z';
const dump = (spec: Record<string, unknown>): string =>
  yaml.dump({ schemaVersion: '1.0.0', createdAt: TS, updatedAt: TS, ...spec }, { noRefs: true, lineWidth: 200 });

function write(root: string, relPath: string, text: string): void {
  const file = path.join(root, ...relPath.split('/'));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

const config = (id: string, extra: Record<string, unknown> = {}): string =>
  dump({ id, name: id, targets: [], rules: {}, extensions: { packs: [], useGlobalPacks: false }, ...extra });

/** hub mounts lib the legacy way and declares app and words as members; app reaches words' project-level type. */
function hub(o: { trustedLink?: boolean } = {}): { root: string; lib: string; app: string; words: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-hub-'));
  write(root, '.wai/project.yaml', config('hub', { members: { app: 'packages/app', words: 'packages/words' } }));
  write(root, '.wai/specs/.index.yaml', dump({ name: 'hub', vision: 'The hub.' }));
  write(root, '.wai/specs/lib/.index.yaml', dump({
    id: 'lib', name: 'lib', description: 'The shared library', parentSystem: 'hub', projectPath: 'packages/lib',
    publicInterfaces: [{ component: 'lib-portal', type: 'RPC', details: 'The library surface' }],
    trustedLinks: o.trustedLink ? [{ subsystem: 'lib', reason: 'a fast lane' }] : [],
  }));
  // lib: an L0 carrying a key its schema does not know, and a portal its subsystem does not publish.
  write(root, 'packages/lib/.wai/project.yaml', config('lib'));
  write(root, 'packages/lib/.wai/specs/.index.yaml', dump({ name: 'lib', vision: 'The library.', status: 'draft' }));
  write(root, 'packages/lib/.wai/specs/core/.index.yaml', dump({ id: 'core', name: 'core', description: 'Core.', parentSystem: 'lib' }));
  write(root, 'packages/lib/.wai/specs/core/lib-portal/.index.yaml', dump({
    id: 'lib-portal', name: 'lib-portal', description: 'The library portal', subsystem: 'core', componentType: 'Portal', portalType: 'Custom', owns: [], dependsOn: [],
  }));
  // words: project-level types only, and no L0 of its own.
  write(root, 'packages/words/.wai/project.yaml', config('words'));
  write(root, 'packages/words/.wai/specs/types/term.yaml', dump({ id: 'term', name: 'term', kind: 'value-object', description: 'A term.', fields: [{ name: 'text', type: 'string' }] }));
  // app: reaches words' type through its external.
  write(root, 'packages/app/.wai/project.yaml', config('app', { externals: { words: {} } }));
  write(root, 'packages/app/.wai/specs/.index.yaml', dump({ name: 'app', vision: 'The app.' }));
  write(root, 'packages/app/.wai/specs/types/entry.yaml', dump({ id: 'entry', name: 'entry', kind: 'value-object', description: 'An entry.', fields: [{ name: 'term', type: 'words::term' }] }));
  invalidateSpecCache();
  return { root, lib: path.join(root, 'packages', 'lib'), app: path.join(root, 'packages', 'app'), words: path.join(root, 'packages', 'words') };
}

describe('stage 3 — the chaining migration steps it gained', () => {
  const made: string[] = [];
  const family = (o?: Parameters<typeof hub>[0]): ReturnType<typeof hub> => {
    const f = hub(o);
    made.push(f.root);
    return f;
  };

  afterEach(() => {
    setProjectRoot(null);
    invalidateSpecCache();
    for (const dir of made.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('plans an own typeDef entry, a minimal L0, the dropped keys and the carried mount entry', () => {
    const f = family();
    const planned = at(f.root, () => plan());
    expect(planned.findings).toEqual([]);
    const words = planned.projects.find((p) => p.project === 'words')!;
    expect(words.createsSystem).toBe(true);
    expect(words.exports).toEqual([{ typeDef: 'term', publicName: 'term', audience: 'project', consumers: ['app'], members: ['type'], reason: 'reference' }]);
    const lib = planned.projects.find((p) => p.project === 'lib')!;
    expect(lib.exports).toEqual([{
      from: 'core', component: 'lib-portal', publicName: 'lib-portal', audience: 'project', consumers: [], members: [],
      type: 'RPC', details: 'The library surface', reason: 'mount', publishAtL1: true,
    }]);
    expect(lib.droppedKeys).toEqual(['status: draft']);
    expect(lib.createsSystem).toBe(false);
  });

  it('applies them, and the family validates with every migrated reference exported and nothing dropped silently', () => {
    const f = family();
    const planned = at(f.root, () => plan());
    at(f.root, () => apply(planned));
    // The minimal L0: the project's name, a one-line vision, the own type.
    const wordsL0 = yaml.load(fs.readFileSync(path.join(f.words, '.wai', 'specs', '.index.yaml'), 'utf8')) as Record<string, unknown>;
    expect(wordsL0).toMatchObject({ name: 'words', publicInterfaces: [{ typeDef: 'term', audience: 'project' }] });
    expect(String(wordsL0.vision)).toContain('words');
    // The carried entry: published at L1 first, then re-exported at L0 — and the unknown key the plan named is gone.
    const libL1 = yaml.load(fs.readFileSync(path.join(f.lib, '.wai', 'specs', 'core', '.index.yaml'), 'utf8')) as { publicInterfaces: unknown[] };
    expect(libL1.publicInterfaces).toEqual([{ type: 'RPC', details: 'The library surface', component: 'lib-portal' }]);
    const libL0 = yaml.load(fs.readFileSync(path.join(f.lib, '.wai', 'specs', '.index.yaml'), 'utf8')) as Record<string, unknown>;
    expect(libL0.status).toBeUndefined();
    expect(libL0.publicInterfaces).toEqual([{ from: 'core', component: 'lib-portal', type: 'RPC', details: 'The library surface', audience: 'project' }]);
    const after = at(f.root, () => validateSddTree());
    expect(codes(after, 'EXTERNAL_NOT_EXPORTED', 'EXTERNAL_UNDECLARED', 'EXPORT_INVALID', 'DEPRECATED_MOUNT_FORM')).toEqual([]);
    expect(isEmpty(at(f.app, () => plan()))).toBe(true);
  });

  it('a mount field with no home blocks apply before its first write', () => {
    const f = family({ trustedLink: true });
    const before = dirHash(f.root);
    const planned = at(f.root, () => plan());
    expect(planned.findings).toEqual([expect.objectContaining({ kind: 'mount-field-unhomed', project: 'lib', blocking: true })]);
    expect(planned.findings[0].detail).toMatch(/carries trustedLinks \(lib\): a fast lane cannot cross a project/);
    expect(blocked(planned)).toBe(true);
    expect(() => at(f.root, () => apply(planned))).toThrow(/mount-field-unhomed/);
    expect(dirHash(f.root)).toEqual(before);
  });
});
