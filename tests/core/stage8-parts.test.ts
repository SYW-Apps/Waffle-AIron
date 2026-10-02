import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { setProjectRoot } from '../../src/utils/fs.js';
import { writeSpecFile } from '../../src/core/spec-files.js';
import { invalidateSpecCache, listProjectRoots, saveComponentSpec, loadComponentSpec, PartReadOnly } from '../../src/core/specs.js';
import { projectFamilyGraph } from '../../src/core/project-family.js';
import { validateProject, validateAsComplete, validateFamily, computeGateStateId, type ValidationIssue, type ValidationResult } from '../../src/core/validation.js';
import { computeOwnStateId } from '../../src/core/statehash.js';
import { captureApprovedSpecs } from '../../src/core/approval.js';
import { readLockRecord } from '../../src/core/lockfile.js';
import { pinExternals } from '../../src/core/surfaces.js';
import { runLock } from '../../src/commands/lock.js';
import { projectConfigRepositoryAt } from '../../src/config/project-config.js';
import { plan } from '../../src/migrations/chaining-migration.js';
import { apply } from '../helpers/chaining-transaction.js';
import { buildReferenceFamily, buildContractFamily } from '../helpers/reference-family.js';
import {
  ComponentSpecSchema,
  SubsystemSpecSchema,
  SystemSpecSchema,
} from '../../src/models/index.js';

// ---------------------------------------------------------------------------
// Stage 8, wave A — parts. A member whose content holds no id, no L0 and no
// lock is a PART: a piece of its declaring project stored elsewhere, whose
// subsystems are that project's own. Real temp directories throughout; a git
// part is served by a local bare repository, so nothing here needs a network,
// and WAIRON_CACHE_DIR points the fetch cache at a temp directory.
//
// The properties: part-is-the-parents-subsystem, storage-is-orthogonal,
// part-alone-judges-against-pin (with and without the pin), and
// existing-members-unchanged.
// ---------------------------------------------------------------------------

const STAMP = '2026-10-02T00:00:00.000Z';
const cleanups: (() => void)[] = [];
/** Every variable a run could write a global file through (F85): redirected to a temp home, restored after. */
const REDIRECTED = ['WAIRON_CACHE_DIR', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA'] as const;
let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = Object.fromEntries(REDIRECTED.map((k) => [k, process.env[k]]));
  const home = tempDir('wairon-home-');
  for (const k of REDIRECTED) process.env[k] = k === 'WAIRON_CACHE_DIR' ? tempDir('wairon-cache-') : home;
});

afterEach(() => {
  setProjectRoot(null);
  invalidateSpecCache();
  vi.restoreAllMocks();
  for (const k of REDIRECTED) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  for (const c of cleanups.splice(0)) {
    try { c(); } catch { /* windows file locks */ }
  }
});

function tempDir(prefix: string): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  return dir;
}

function bind(dir: string): void {
  setProjectRoot(dir);
  invalidateSpecCache();
}

const specs = (dir: string, ...parts: string[]): string => path.join(dir, '.wai', 'specs', ...parts);

function projectYaml(dir: string, extra: Record<string, unknown>): void {
  fs.mkdirSync(path.join(dir, '.wai'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.wai', 'project.yaml'), yaml.dump({
    schemaVersion: '1.0.0', id: 'clinic', name: 'Clinic', targets: [], createdAt: STAMP, updatedAt: STAMP, ...extra,
  }));
}

function partYaml(dir: string, partOf: Record<string, unknown>): void {
  fs.mkdirSync(path.join(dir, '.wai'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.wai', 'project.yaml'), yaml.dump({ schemaVersion: '1.0.0', partOf }));
}

/** The clinic's own front desk: its L0 and the frontdesk subsystem with the patient registry. */
function writeFrontDesk(root: string): void {
  writeSpecFile(specs(root, '.index.yaml'), SystemSpecSchema.parse({
    schemaVersion: '1.0.0', name: 'Clinic', vision: 'A clinic that books and checks in patients',
    boundaries: [], globalRequirements: [], createdAt: STAMP, updatedAt: STAMP,
  }));
  writeSpecFile(specs(root, 'frontdesk', '.index.yaml'), SubsystemSpecSchema.parse({
    id: 'frontdesk', name: 'frontdesk', description: 'Checks patients in', parentSystem: 'Clinic',
    publicInterfaces: [], trustedLinks: [], status: 'complete', createdAt: STAMP, updatedAt: STAMP,
  }));
  writeSpecFile(specs(root, 'frontdesk', 'patient-registry', '.index.yaml'), ComponentSpecSchema.parse({
    id: 'patient-registry', name: 'patient-registry', description: 'Keeps the registered patients', subsystem: 'frontdesk',
    componentType: 'Orchestrator', owns: [], dependsOn: [], status: 'complete', createdAt: STAMP, updatedAt: STAMP,
  }));
}

/**
 * The scheduling subsystem, written under `specsRoot` (the clinic's own specs
 * folder, or a part's): its appointment planner reaches the front desk's
 * patient registry by its LOCAL id — a sibling subsystem the ordinary
 * subsystem rules judge (it publishes no interface for it).
 */
function writeScheduling(partRoot: string): void {
  writeSpecFile(specs(partRoot, 'scheduling', '.index.yaml'), SubsystemSpecSchema.parse({
    id: 'scheduling', name: 'scheduling', description: 'Books appointments', parentSystem: 'Clinic',
    publicInterfaces: [], trustedLinks: [], status: 'complete', createdAt: STAMP, updatedAt: STAMP,
  }));
  writeSpecFile(specs(partRoot, 'scheduling', 'appointment-planner', '.index.yaml'), ComponentSpecSchema.parse({
    id: 'appointment-planner', name: 'appointment-planner', description: 'Plans appointments for registered patients', subsystem: 'scheduling',
    componentType: 'Orchestrator', owns: [], dependsOn: ['patient-registry'], status: 'complete', createdAt: STAMP, updatedAt: STAMP,
  }));
}

/** git, quietly, with an identity so a commit works on any machine. */
function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=Stage Eight', '-c', 'user.email=stage8@example.invalid', '-c', 'commit.gpgsign=false', ...args], {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

/** A local bare repository holding the scheduling part (with its partOf), and the commit it is at. */
function schedulingRepository(): { url: string; commit: string; bare: string } {
  const work = tempDir('wairon-part-work-');
  writeScheduling(work);
  partYaml(work, { project: 'clinic' });
  git(work, 'init', '-q');
  git(work, 'add', '-A');
  git(work, 'commit', '-q', '-m', 'the scheduling part');
  const commit = git(work, 'rev-parse', 'HEAD');
  const bare = path.join(tempDir('wairon-part-bare-'), 'scheduling.git');
  git(path.dirname(bare), 'clone', '-q', '--bare', work, bare);
  return { url: `file:///${bare.replace(/\\/g, '/').replace(/^\//, '')}`, commit, bare };
}

type Storage = 'inline' | 'contained' | 'sibling' | 'git';

/** The clinic with the scheduling subsystem stored as asked; answers the clinic's root. */
function clinic(storage: Storage): string {
  const base = tempDir('wairon-clinic-');
  const root = path.join(base, 'clinic');
  writeFrontDesk(root);
  if (storage === 'inline') {
    projectYaml(root, {});
    writeScheduling(root);
  } else if (storage === 'contained') {
    projectYaml(root, { members: { scheduling: 'services/scheduling' } });
    writeScheduling(path.join(root, 'services', 'scheduling'));
  } else if (storage === 'sibling') {
    projectYaml(root, { members: { scheduling: '../scheduling' } });
    writeScheduling(path.join(base, 'scheduling'));
    partYaml(path.join(base, 'scheduling'), { project: 'clinic', path: '../clinic' });
  } else {
    const repo = schedulingRepository();
    projectYaml(root, { members: { scheduling: `${repo.url}#${repo.commit}` } });
  }
  return root;
}

/** A verdict as a comparable multiset: severity, code and the spec each finding is about. */
function verdictOf(result: ValidationResult): { valid: boolean; findings: string[] } {
  return { valid: result.valid, findings: result.issues.map((i: ValidationIssue) => `${i.severity} ${i.code} @${i.specId ?? '-'}`).sort() };
}

function gateAt(root: string): ValidationResult {
  bind(root);
  return validateProject({});
}

describe('stage 8 — kind from content, and parts read into their parent', () => {
  it('reads a contained member with no id, L0 or lock as a part: its subsystems are the root\'s own, keyed locally', () => {
    const root = clinic('contained');
    bind(root);
    const [own] = listProjectRoots();
    expect(listProjectRoots()).toHaveLength(1);
    expect(own.parts).toHaveLength(1);
    const part = own.parts[0];
    expect(part).toMatchObject({ alias: 'scheduling', storage: 'contained', partOf: null, availability: 'live', subsystems: ['scheduling'] });
    expect(part.specIds.sort()).toEqual(['appointment-planner', 'scheduling']);
    expect(part.contentDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    // The part's specs are the root's: owned by '' and bound by local id.
    const family = projectFamilyGraph();
    expect(family.owners.get('appointment-planner')).toBe('');
    expect(family.nodes).toHaveLength(1);
    expect(family.nodes[0].parts.map((p) => p.alias)).toEqual(['scheduling']);
    expect(loadComponentSpec('appointment-planner')?.dependsOn).toEqual(['patient-registry']);
  });

  it('reads a member whose content declares an id, holds an L0 or carries a lock as a project, exactly as before', () => {
    const f = buildReferenceFamily();
    cleanups.push(() => f.cleanup());
    bind(f.top);
    const roots = listProjectRoots();
    expect(roots.map((r) => r.namespace)).toEqual(['', 'core', 'transpiler', 'shared']);
    expect(roots.every((r) => r.parts.length === 0)).toBe(true);
    expect(projectFamilyGraph().problems.filter((p) => p.kind === 'kind-mismatch' || p.kind === 'part-unavailable')).toEqual([]);
  });

  it('reports a key a part and its parent both declare as a duplicate-spec naming both files', () => {
    const root = clinic('contained');
    // The parent declares a scheduling subsystem of its own as well.
    writeScheduling(root);
    bind(root);
    const dup = projectFamilyGraph().problems.filter((p) => p.kind === 'duplicate-spec');
    expect(dup.map((p) => p.id).sort()).toEqual(['appointment-planner', 'scheduling']);
    expect(dup.every((p) => p.detail.includes(path.join('services', 'scheduling')))).toBe(true);
  });

  it('leaves `part::x` unresolved, with the hint to write the local id', () => {
    const root = clinic('contained');
    const file = specs(root, 'frontdesk', 'patient-registry', '.index.yaml');
    const doc = yaml.load(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    fs.writeFileSync(file, yaml.dump({ ...doc, dependsOn: ['scheduling::appointment-planner'] }));
    bind(root);
    const ref = listProjectRoots()[0].authoredReferences.find((r) => r.authored === 'scheduling::appointment-planner');
    expect(ref).toMatchObject({ binding: 'unresolved' });
    expect(ref?.hint).toContain('write the local id "appointment-planner"');
  });
});

describe('property: part-is-the-parents-subsystem', () => {
  it('a contained part and the same subsystems inline give identical verdicts, own identity and gate identity', () => {
    const inline = clinic('inline');
    const contained = clinic('contained');
    const a = gateAt(inline);
    const aOwn = computeOwnStateId();
    const aGate = computeGateStateId();
    const b = gateAt(contained);
    const bOwn = computeOwnStateId();
    const bGate = computeGateStateId();
    expect(verdictOf(b)).toEqual(verdictOf(a));
    // The ordinary subsystem rules judged the dependency across the part's folder.
    expect(a.issues.some((i) => i.specId === 'appointment-planner')).toBe(true);
    expect(bOwn).toEqual(aOwn);
    expect(bGate).toEqual(aGate);
  });

  it('locks to the same state, the part pinned by its content digest as a part, approved by the parent\'s lock', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const states: string[] = [];
    for (const storage of ['inline', 'contained'] as const) {
      const root = clinic(storage);
      bind(root);
      const captured = computeGateStateId();
      const record = await runLock({ yes: true }, validateAsComplete({}), captured);
      states.push(`${record!.stateId.algorithm}:${record!.stateId.digest}`);
      if (storage === 'contained') {
        expect(record!.members).toEqual({ scheduling: { as: 'part', contentDigest: expect.stringMatching(/^sha256:/), state: 'approved' } });
        expect(Object.keys(record!.specs!).filter((k) => k.startsWith('members/')).sort()).toEqual([
          'members/scheduling/.wai/specs/scheduling/.index.yaml',
          'members/scheduling/.wai/specs/scheduling/appointment-planner/.index.yaml',
        ]);
        // The approval reads as approved right after, the part's files included.
        bind(root);
        expect(validateFamily({}).issues.filter((i) => i.code === 'MEMBER_UNAPPROVED' || i.code === 'MEMBER_DRIFTED')).toEqual([]);
      }
    }
    expect(states[1]).toBe(states[0]);
  });
});

describe('property: storage-is-orthogonal', () => {
  it('moving a part between contained, sibling and git changes no verdict, no spec key and no identity', () => {
    const seen = (['contained', 'sibling', 'git'] as const).map((storage) => {
      const root = clinic(storage);
      const result = gateAt(root);
      return {
        storage,
        verdict: verdictOf(result),
        keys: Object.keys(captureApprovedSpecs(root)).sort(),
        own: computeOwnStateId(),
        gate: computeGateStateId(),
        digest: listProjectRoots()[0].parts[0].contentDigest,
      };
    });
    for (const s of seen.slice(1)) {
      expect({ storage: s.storage, verdict: s.verdict }).toEqual({ storage: s.storage, verdict: seen[0].verdict });
      expect(s.keys).toEqual(seen[0].keys);
      expect(s.own).toEqual(seen[0].own);
      expect(s.gate).toEqual(seen[0].gate);
      expect(s.digest).toEqual(seen[0].digest);
    }
  });

  it('a git part is read from the cache at its pinned commit, and the lock records that commit', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const root = clinic('git');
    bind(root);
    const part = listProjectRoots()[0].parts[0];
    expect(part).toMatchObject({ storage: 'git', availability: 'cache' });
    expect(part.directory!.startsWith(process.env.WAIRON_CACHE_DIR!)).toBe(true);
    const config = projectConfigRepositoryAt(root).load()!;
    const commit = String(config.members!.scheduling).split('#')[1];
    expect(part.commit).toBe(commit);
    const record = await runLock({ yes: true }, validateAsComplete({}), computeGateStateId());
    expect(record!.members!.scheduling).toEqual({ as: 'part', contentDigest: part.contentDigest, commit, state: 'approved' });
  });
});

describe('the git fetch cache: content-addressed, immutable, offline', () => {
  it('serves a cached commit with no network, and an uncached one offline is PART_UNAVAILABLE, never a pass', () => {
    const root = clinic('git');
    bind(root);
    const first = listProjectRoots()[0].parts[0];
    // The repository goes away: the cached commit still serves, byte for byte.
    const config = projectConfigRepositoryAt(root).load()!;
    const [url, commit] = String(config.members!.scheduling).split('#');
    fs.rmSync(path.join(url.replace(/^file:\/\/\/?/, process.platform === 'win32' ? '' : '/')), { recursive: true, force: true });
    bind(root);
    const again = listProjectRoots()[0].parts[0];
    expect(again).toMatchObject({ availability: 'cache', contentDigest: first.contentDigest, directory: first.directory });
    // A fresh cache: the commit is not cached and the remote cannot be reached.
    process.env.WAIRON_CACHE_DIR = tempDir('wairon-cache-empty-');
    bind(root);
    const result = validateProject({});
    const unavailable = result.issues.filter((i) => i.code === 'PART_UNAVAILABLE');
    expect(unavailable).toHaveLength(1);
    expect(unavailable[0].severity).toBe('error');
    expect(unavailable[0].message).toContain(commit);
    expect(result.valid).toBe(false);
    // The subsystems that live there are missing — not judged as present.
    expect(listProjectRoots()[0].parts[0].availability).toBe('unavailable');
  });

  it('refuses a write into a git part (PartReadOnly), writing nothing', () => {
    const root = clinic('git');
    bind(root);
    const part = listProjectRoots()[0].parts[0];
    const before = fs.readdirSync(part.directory!, { recursive: true }).sort();
    const planner = loadComponentSpec('appointment-planner')!;
    expect(() => saveComponentSpec({ ...planner, description: 'Edited where it cannot be' })).toThrow(PartReadOnly);
    expect(() => saveComponentSpec({ ...planner, description: 'Edited where it cannot be' })).toThrow(/member update scheduling/);
    expect(fs.readdirSync(part.directory!, { recursive: true }).sort()).toEqual(before);
    // A NEW component in the git part's subsystem goes where its subsystem lives: refused too.
    expect(() => saveComponentSpec({ ...planner, id: 'waitlist-keeper', name: 'waitlist-keeper' })).toThrow(PartReadOnly);
  });

  it('writes a contained or sibling part\'s spec back to its file in the part', () => {
    for (const storage of ['contained', 'sibling'] as const) {
      const root = clinic(storage);
      bind(root);
      const planner = loadComponentSpec('appointment-planner')!;
      saveComponentSpec({ ...planner, description: 'Plans and reschedules appointments' });
      const partDir = storage === 'contained' ? path.join(root, 'services', 'scheduling') : path.join(path.dirname(root), 'scheduling');
      const stored = yaml.load(fs.readFileSync(specs(partDir, 'scheduling', 'appointment-planner', '.index.yaml'), 'utf8')) as { description: string };
      expect(stored.description).toBe('Plans and reschedules appointments');
      expect(fs.existsSync(specs(root, 'scheduling'))).toBe(false);
    }
  });
});

describe('MEMBER_KIND_MISMATCH and PART_UNAVAILABLE at the parent', () => {
  it('a git part missing partOf says exactly which line to add, and in which repository', () => {
    const work = tempDir('wairon-part-nopartof-');
    writeScheduling(work);
    git(work, 'init', '-q');
    git(work, 'add', '-A');
    git(work, 'commit', '-q', '-m', 'no partOf');
    const commit = git(work, 'rev-parse', 'HEAD');
    const url = `file:///${work.replace(/\\/g, '/').replace(/^\//, '')}`;
    const root = path.join(tempDir('wairon-clinic-'), 'clinic');
    writeFrontDesk(root);
    projectYaml(root, { members: { scheduling: `${url}#${commit}` } });
    const result = gateAt(root);
    const mismatch = result.issues.filter((i) => i.code === 'MEMBER_KIND_MISMATCH');
    expect(mismatch).toHaveLength(1);
    expect(mismatch[0].message).toContain('add the line `partOf: { project: clinic }` in .wai/project.yaml of the repository');
    expect(mismatch[0].message).toContain(url);
    expect(mismatch[0].specId).toBeUndefined();
  });

  it('an asserted `as` the content contradicts is one finding; the content still decides', () => {
    const root = clinic('contained');
    projectYaml(root, { members: { scheduling: { source: 'services/scheduling', as: 'project' } } });
    const result = gateAt(root);
    expect(result.issues.filter((i) => i.code === 'MEMBER_KIND_MISMATCH').map((i) => i.message)).toEqual([
      expect.stringContaining('asserted `as: project`, but its content makes it a part'),
    ]);
    expect(listProjectRoots()[0].parts.map((p) => p.alias)).toEqual(['scheduling']);
  });

  it('a `use` on a part, a contained part declaring partOf and a part declaring project fields are each a mismatch', () => {
    const root = clinic('contained');
    projectYaml(root, { members: { scheduling: { source: 'services/scheduling', use: ['*'] } } });
    partYaml(path.join(root, 'services', 'scheduling'), { project: 'clinic' });
    const raw = path.join(root, 'services', 'scheduling', '.wai', 'project.yaml');
    fs.writeFileSync(raw, `${fs.readFileSync(raw, 'utf8')}externals:\n  billing: {}\n`);
    const messages = gateAt(root).issues.filter((i) => i.code === 'MEMBER_KIND_MISMATCH').map((i) => i.message).join('\n');
    expect(messages).toContain('its `use` imports nothing');
    expect(messages).toContain('declares `partOf`');
    expect(messages).toContain('declares `externals` without the id');
  });

  it('a part whose directory is absent is PART_UNAVAILABLE', () => {
    const root = clinic('sibling');
    fs.rmSync(path.join(path.dirname(root), 'scheduling'), { recursive: true, force: true });
    const result = gateAt(root);
    expect(result.issues.filter((i) => i.code === 'PART_UNAVAILABLE').map((i) => i.message)).toEqual([expect.stringContaining('has no directory there')]);
  });
});

describe('property: part-alone-judges-against-pin', () => {
  it('without a pin: PART_UNPINNED alone — part of the parent; validate from the parent', () => {
    const root = clinic('sibling');
    const part = path.join(path.dirname(root), 'scheduling');
    const result = gateAt(part);
    expect(result.issues.map((i) => `${i.severity} ${i.code}`)).toEqual(['warning PART_UNPINNED']);
    expect(result.issues[0].message).toContain('Part of "clinic"; validate from the parent');
    expect(result.valid).toBe(true);
  });

  it('with a pin: judged against the excerpt — the same verdict with or without the parent on disk', () => {
    const root = clinic('sibling');
    const part = path.join(path.dirname(root), 'scheduling');
    bind(part);
    const [pin] = pinExternals();
    expect(pin).toMatchObject({ alias: 'clinic', outcome: 'pinned', project: 'clinic' });
    expect(fs.existsSync(path.join(part, '.wai', 'externals', 'clinic.yaml'))).toBe(true);
    // A second pin with nothing moved changes nothing.
    bind(part);
    expect(pinExternals()[0].outcome).toBe('unchanged');
    const withParent = gateAt(part);
    expect(withParent.issues.some((i) => i.code === 'PART_JUDGED_ALONE')).toBe(true);
    expect(withParent.issues.some((i) => i.code === 'PART_UNPINNED')).toBe(false);
    const notice = withParent.issues.find((i) => i.code === 'PART_JUDGED_ALONE')!;
    expect(notice.message).toContain('unused-detection');
    // No finding is about the parent's specs: they are the parent's to judge.
    expect(withParent.issues.some((i) => i.specId === 'patient-registry' || i.specId === 'frontdesk')).toBe(false);
    // The parent leaves: the part's verdict does not move.
    fs.renameSync(root, `${root}-elsewhere`);
    cleanups.push(() => fs.rmSync(`${root}-elsewhere`, { recursive: true, force: true }));
    expect(verdictOf(gateAt(part))).toEqual(verdictOf(withParent));
  });

  it('judges the part\'s reference into the parent as the parent judges it', () => {
    const root = clinic('sibling');
    const part = path.join(path.dirname(root), 'scheduling');
    bind(part);
    pinExternals();
    const alone = gateAt(part).issues.filter((i) => i.specId === 'appointment-planner').map((i) => i.code).sort();
    const fromParent = gateAt(root).issues.filter((i) => i.specId === 'appointment-planner').map((i) => i.code).sort();
    // The subsystem rules judge the reference identically; unused detection
    // needs the whole tree, so the part alone skips it (and names it).
    expect(alone).toContain('CROSS_SUBSYSTEM_PRIVATE_ACCESS');
    expect(alone).toEqual(fromParent.filter((code) => code !== 'UNUSED_COMPONENT'));
  });
});

describe('property: existing-members-unchanged', () => {
  /** A family's verdict at its top, the deprecated-form notices of the one migration left out. */
  function familyVerdict(top: string): string[] {
    bind(top);
    return validateFamily({}).issues
      .filter((i) => !(i.code === 'DEPRECATED_MOUNT_FORM' && i.message.includes('long-form `path`')))
      .map((i) => `${i.severity} ${i.code} @${i.specId ?? '-'}`).sort();
  }

  it('the reference family and a stage-7-style family validate identically before and after the path → source rewrite', () => {
    for (const build of [buildReferenceFamily, buildContractFamily]) {
      const f = build();
      cleanups.push(() => f.cleanup());
      const configFile = path.join(f.top, '.wai', 'project.yaml');
      const original = familyVerdict(f.top);
      // Every member written in the pre-stage-8 long form.
      const config = yaml.load(fs.readFileSync(configFile, 'utf8')) as { members: Record<string, unknown> };
      const longForm = Object.fromEntries(Object.entries(config.members).map(([alias, value]) => [alias, { path: value, description: `The ${alias} member` }]));
      fs.writeFileSync(configFile, yaml.dump({ ...config, members: longForm }));
      bind(f.top);
      const before = validateFamily({});
      expect(before.issues.filter((i) => i.code === 'DEPRECATED_MOUNT_FORM' && i.message.includes('long-form `path`'))).toHaveLength(Object.keys(longForm).length);
      expect(familyVerdict(f.top)).toEqual(original);
      expect(projectFamilyGraph().problems.filter((p) => p.kind === 'kind-mismatch' || p.kind === 'part-unavailable')).toEqual([]);
      // doctor --fix: the one stage-8 step.
      bind(f.top);
      const planned = plan();
      expect(planned.projects.find((p) => p.project === '')?.locations.sort()).toEqual(Object.keys(longForm).sort());
      apply(planned);
      const after = yaml.load(fs.readFileSync(configFile, 'utf8')) as { members: Record<string, Record<string, unknown>> };
      for (const alias of Object.keys(longForm)) {
        expect(after.members[alias]).toEqual({ source: longForm[alias].path, description: `The ${alias} member` });
      }
      // The same family never written in the long form, migrated by the same
      // doctor run: the stage-8 step changed nothing a verdict reads.
      const twin = build();
      cleanups.push(() => twin.cleanup());
      bind(twin.top);
      apply(plan());
      expect(familyVerdict(f.top)).toEqual(familyVerdict(twin.top));
      bind(f.top);
      expect(validateFamily({}).issues.filter((i) => i.code === 'DEPRECATED_MOUNT_FORM' && i.message.includes('long-form `path`'))).toEqual([]);
    }
  });
});
