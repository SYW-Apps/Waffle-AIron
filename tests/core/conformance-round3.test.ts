import { describe, it, expect, vi, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as yaml from 'js-yaml';
import { validateProject } from '../../src/core/validation.js';
import { invalidateSpecCache } from '../../src/core/specs.js';
import { setProjectRoot } from '../../src/utils/fs.js';
import { pinExternals } from '../../src/core/surfaces.js';
import { renameMethod } from '../../src/core/provision.js';
import { technologyPackages } from '../../src/models/index.js';
import { BASE_FIXTURE_RULES, materializeFixtureProject, type FixtureTree } from '../rules-matrix/harness.js';

// ---------------------------------------------------------------------------
// The code<->spec gaps the third round of user trials found:
//
//   1. An Adapter's dependsOn to a remote Portal (a network transport) read as
//      UNREALIZED_DEPENDENCY until an import connected the two services — the
//      trial's assistant added a cross-service `import type` to silence it.
//   2. `this.x!.write()`, `const s = this.x; s.write()` and destructuring of a
//      field hid a Portal's write shortcut; a receiver nothing declares was
//      passed in silence.
//   3. TECH_LEAKAGE_IN_CODE was inert for `technologies: [postgres]` (it
//      compared `pg` with `postgres`), and mixing the two notations raised a
//      spurious spec-side TECH_LEAKAGE.
//   4. A type with no sourcePath was never shape-checked, and nothing said so.
//   5. Implementing another project's snake_case extension point from a
//      camelCase tree tripped the casing rule, and the rename tool refused the
//      producer's names.
//   6. Interfaces in a shared contracts.ts broke call tracing.
//   9. One SOURCE_FILE_PLANNED notice per planned FILE.
// ---------------------------------------------------------------------------

function createTempProject() {
  invalidateSpecCache();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-round3-'));
  const waiDir = path.join(tempDir, '.wai');
  fs.mkdirSync(waiDir);
  fs.writeFileSync(path.join(waiDir, 'project.yaml'), JSON.stringify({
    schemaVersion: '1.0.0',
    name: 'test-project',
    targets: [{ type: 'claude', outputDir: '.claude/agents', enabled: true }],
    rules: {},
  }));
  const specsDir = path.join(waiDir, 'specs');
  for (const d of ['subsystems', 'components', 'interfaces', 'implementations', 'types']) {
    fs.mkdirSync(path.join(specsDir, d), { recursive: true });
  }
  const stamp = "createdAt: '2026-10-05T10:00:00Z'\nupdatedAt: '2026-10-05T10:00:00Z'";
  const writeSpec = (type: string, name: string, content: string) => {
    const filePath = type === 'system'
      ? path.join(specsDir, '.index.yaml')
      : path.join(specsDir, `${type}s`, `${name}.yaml`);
    fs.writeFileSync(filePath, `${content}\n${stamp}\n`);
  };
  writeSpec('system', 'system', 'schemaVersion: 1.0.0\nname: TestSystem\nvision: testing');
  writeSpec('subsystem', 'sub-a', 'schemaVersion: 1.0.0\nid: sub-a\nname: SubA\ndescription: d\nparentSystem: TestSystem');
  return {
    tempDir,
    component: (id: string, type: string, extra = '') =>
      writeSpec('component', id, `schemaVersion: 1.0.0\nid: ${id}\nname: ${id}\ndescription: d\nsubsystem: sub-a\ncomponentType: ${type}\n${extra}`),
    contract: (compId: string, methods: Array<[string, string?]>) =>
      writeSpec('interface', `i${compId}`, [
        'schemaVersion: 1.0.0', `id: i${compId}`, `name: I${compId}`, 'description: contract', `component: ${compId}`, 'methods:',
        ...methods.map(([m, effect]) => [
          `  - name: ${m}`,
          `    description: ${m} does its one thing, carefully and observably`,
          `    signature: "${m}(id: string): string"`,
          '    params: [{ name: id, type: string }]',
          '    returns: string',
          ...(effect ? [`    effect: ${effect}`] : []),
        ].join('\n')),
      ].join('\n')),
    impl: (compId: string, body: string) =>
      writeSpec('implementation', `impl-${compId}`, `schemaVersion: 1.0.0\nid: impl-${compId}\nname: Impl${compId}\ndescription: impl\ncontract: i${compId}\n${body}`),
    type: (id: string, body: string) =>
      writeSpec('type', id, `schemaVersion: 1.0.0\nid: ${id}\nname: ${id}\nkind: value-object\ndescription: a record\n${body}`),
    source: (relPath: string, content: string) => {
      const abs = path.join(tempDir, relPath);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content);
    },
    activate: () => { vi.spyOn(process, 'cwd').mockReturnValue(tempDir); },
    cleanup: () => {
      invalidateSpecCache();
      vi.restoreAllMocks();
      try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* win file locks */ }
    },
  };
}

type Issue = { code: string; specId?: string; message: string; severity: string };
type Result = { issues: Issue[] };
const byCode = (res: Result, code: string) => res.issues.filter(i => i.code === code);
const intent = (m: string) => `  - name: ${m}\n    detail: intent\n    intent: Performs its one thing against held state; failures surface as thrown errors.`;

let proj: ReturnType<typeof createTempProject> | undefined;
afterEach(() => { proj?.cleanup(); proj = undefined; });

describe("1. an Adapter's edge to a remote Portal is the link, never an import", () => {
  function remoteShape(p: ReturnType<typeof createTempProject>, transport: string): void {
    p.component('ingest-api', 'Portal', `transport: ${transport}`);
    p.contract('ingest-api', [['recordHit']]);
    p.impl('ingest-api', `sourcePath: src/ingest.ts\nmethods:\n${intent('recordHit')}`);
    p.source('src/ingest.ts', 'export function recordHit(id: string): string { return id; }\n');
    p.component('ingest-client', 'Adapter', 'dependsOn: [ingest-api]');
    p.contract('ingest-client', [['send']]);
    p.impl('ingest-client', `sourcePath: src/client.ts\nmethods:\n${intent('send')}`);
    // The plain HTTP client: nothing imports the remote service's code.
    p.source('src/client.ts', "export async function send(id: string): Promise<string> { const r = await fetch('/hits', { method: 'POST', body: id }); return r.statusText; }\n");
  }

  it('an HTTP Portal: no UNREALIZED_DEPENDENCY, and nothing asks for a cross-service import', () => {
    proj = createTempProject();
    remoteShape(proj, 'HTTP');
    proj.activate();
    expect(byCode(validateProject(), 'UNREALIZED_DEPENDENCY')).toEqual([]);
  });

  it('control: the same edge to an in-process library is still owed an import', () => {
    proj = createTempProject();
    remoteShape(proj, 'InProcess');
    proj.activate();
    const unrealized = byCode(validateProject(), 'UNREALIZED_DEPENDENCY');
    expect(unrealized).toHaveLength(1);
    expect(unrealized[0].message).toContain('ingest-client');
  });
});

/** Portal -> Orchestrator -> Repository; the Portal's constructor injects the Repository as well. */
function habitShape(p: ReturnType<typeof createTempProject>, portalBody: string, fieldType = 'CheckinRepository'): void {
  p.component('repo-a', 'Repository');
  p.contract('repo-a', [['record', 'write'], ['find', 'read']]);
  p.impl('repo-a', `sourcePath: src/repo.ts\nmethods:\n${intent('record')}\n${intent('find')}`);
  p.source('src/repo.ts', 'export class CheckinRepository {\n  record(id: string): string { return id; }\n  find(id: string): string { return id; }\n}\n');
  p.component('tracker-a', 'Orchestrator', 'dependsOn: [repo-a]');
  p.contract('tracker-a', [['checkIn']]);
  p.impl('tracker-a', [
    'sourcePath: src/tracker.ts', 'methods:', '  - name: checkIn', '    narrative:',
    '      - { stepNumber: 1, description: Record the check-in, type: call, targetComponent: repo-a, targetMethod: record }',
    '      - { stepNumber: 2, description: Done, type: return, outcome: done }',
  ].join('\n'));
  p.source('src/tracker.ts', [
    "import type { CheckinRepository } from './repo.js';",
    'export class HabitTracker {',
    '  constructor(private readonly checkins: CheckinRepository) {}',
    '  checkIn(id: string): string { return this.checkins.record(id); }',
    '}', '',
  ].join('\n'));
  p.component('web-a', 'Portal', 'transport: InProcess\ndependsOn: [tracker-a]');
  p.contract('web-a', [['checkIn']]);
  p.impl('web-a', [
    'sourcePath: src/web.ts', 'methods:', '  - name: checkIn', '    narrative:',
    '      - { stepNumber: 1, description: Dispatch to the tracker, type: call, targetComponent: tracker-a, targetMethod: checkIn }',
    '      - { stepNumber: 2, description: Done, type: return, outcome: done }',
  ].join('\n'));
  p.source('src/web.ts', [
    "import type { HabitTracker } from './tracker.js';",
    "import type { CheckinRepository } from './repo.js';",
    'export class HabitsApi {',
    `  constructor(private readonly tracker: HabitTracker, private readonly checkins?: ${fieldType} | null) {}`,
    `  checkIn(id: string): string { ${portalBody} return this.tracker.checkIn(id); }`,
    '}', '',
  ].join('\n'));
}

describe('2. a write shortcut hidden behind `!`, a cast or a local alias', () => {
  const shapes: Array<[string, string]> = [
    ['a non-null assertion', 'this.checkins!.record(id);'],
    ['a cast', '(this.checkins as CheckinRepository).record(id);'],
    ['a local alias', 'const store = this.checkins!; store.record(id);'],
    ['a destructured field', 'const { checkins } = this; checkins!.record(id);'],
    ['a renamed destructured field', 'const { checkins: c } = this; c!.record(id);'],
  ];
  for (const [label, body] of shapes) {
    it(`${label} is followed like the plain form`, () => {
      proj = createTempProject();
      habitShape(proj, body);
      proj.activate();
      const res = validateProject();
      const shortcut = byCode(res, 'PORTAL_WRITE_SHORTCUT_IN_CODE');
      expect(shortcut).toHaveLength(1);
      expect(shortcut[0].message).toContain('repo-a.record');
      expect(byCode(res, 'UNDECLARED_DEPENDENCY').some(i => i.message.includes('repo-a.record'))).toBe(true);
    });
  }

  it('a receiver nothing declares is said so (PORTAL_CALL_UNRESOLVED), never passed in silence', () => {
    proj = createTempProject();
    habitShape(proj, 'const store = makeStore(); store.record(id);');
    proj.source('src/web.ts', fs.readFileSync(path.join(proj.tempDir, 'src/web.ts'), 'utf8')
      + 'declare function makeStore(): any;\n');
    proj.activate();
    const res = validateProject();
    expect(byCode(res, 'PORTAL_WRITE_SHORTCUT_IN_CODE')).toEqual([]);
    const unresolved = byCode(res, 'PORTAL_CALL_UNRESOLVED');
    expect(unresolved).toHaveLength(1);
    expect(unresolved[0].severity).toBe('warning');
    expect(unresolved[0].message).toContain('repo-a.record');
  });

  it('a read through an unfollowable receiver is not a write candidate', () => {
    proj = createTempProject();
    habitShape(proj, 'const store = makeStore(); store.find(id);');
    proj.source('src/web.ts', fs.readFileSync(path.join(proj.tempDir, 'src/web.ts'), 'utf8')
      + 'declare function makeStore(): any;\n');
    proj.activate();
    expect(byCode(validateProject(), 'PORTAL_CALL_UNRESOLVED')).toEqual([]);
  });
});

describe('3. technology packages known by default', () => {
  function storeShape(p: ReturnType<typeof createTempProject>, technology: string, portalImport: string, second?: string): void {
    p.component('db-store', 'Store', 'durability: read-through');
    p.contract('db-store', [['save', 'write']]);
    p.impl('db-store', `sourcePath: src/db.ts\ntechnologies: [${technology}]\nmethods:\n${intent('save')}`);
    p.source('src/db.ts', "import { Pool } from 'pg';\nexport function save(id: string): string { void Pool; return id; }\n");
    if (second !== undefined) {
      p.component('user-store', 'Store', 'durability: read-through\ndescription: Users kept in postgres');
      p.contract('user-store', [['add', 'write']]);
      p.impl('user-store', `sourcePath: src/users.ts\ntechnologies: [${second}]\nmethods:\n${intent('add')}`);
      p.source('src/users.ts', 'export function add(id: string): string { return id; }\n');
    }
    p.component('api-b', 'Portal', 'transport: InProcess');
    p.contract('api-b', [['hit']]);
    p.impl('api-b', `sourcePath: src/api.ts\nmethods:\n${intent('hit')}`);
    p.source('src/api.ts', `${portalImport}\nexport function hit(id: string): string { return id; }\n`);
  }

  it('`technologies: [postgres]` alone polices `pg`', () => {
    proj = createTempProject();
    storeShape(proj, 'postgres', "import pg from 'pg';\nvoid pg;");
    proj.activate();
    const leaks = byCode(validateProject(), 'TECH_LEAKAGE_IN_CODE');
    expect(leaks).toHaveLength(1);
    expect(leaks[0].message).toContain('src/api.ts');
    expect(leaks[0].message).toContain('"pg"');
  });

  it('an HTTP client is never a technology leak', () => {
    proj = createTempProject();
    storeShape(proj, 'postgres', "import axios from 'axios';\nvoid axios;");
    proj.activate();
    expect(byCode(validateProject(), 'TECH_LEAKAGE_IN_CODE')).toEqual([]);
  });

  it('a string and an object notation of one technology raise no spurious TECH_LEAKAGE', () => {
    proj = createTempProject();
    storeShape(proj, '{ name: postgres, matches: [pg] }', "export const x = 1;", 'postgres');
    proj.activate();
    expect(byCode(validateProject(), 'TECH_LEAKAGE')).toEqual([]);
  });

  it('the table is extended per technology by what packs contribute', () => {
    expect(technologyPackages('postgres')).toEqual(expect.arrayContaining(['postgres', 'pg', '@neondatabase/serverless']));
    expect(technologyPackages('PostgreSQL')).toContain('pg');
    expect(technologyPackages({ name: 'yaml', matches: ['yaml package'] })).toEqual(['yaml package']);
    expect(technologyPackages('cockroach', { cockroach: ['@cockroachdb/driver'] })).toEqual(['cockroach', '@cockroachdb/driver']);
  });
});

describe('4. a type with no sourcePath is said so', () => {
  it('a notice before its subsystem has code, a warning once it has', () => {
    proj = createTempProject();
    proj.type('habit', 'subsystem: sub-a\nfields:\n  - { name: id, type: string }');
    proj.component('store-a', 'Store', 'durability: read-through');
    proj.contract('store-a', [['save', 'write']]);
    proj.impl('store-a', `sourcePath: src/store.ts\nmethods:\n${intent('save')}`);
    proj.activate();
    let found = byCode(validateProject(), 'MISSING_TYPE_SOURCE_PATH');
    expect(found).toHaveLength(1);
    expect(found[0].severity).toBe('notice');
    expect(found[0].specId).toBe('habit');

    proj.source('src/store.ts', 'export function save(id: string): string { return id; }\n');
    invalidateSpecCache();
    found = byCode(validateProject(), 'MISSING_TYPE_SOURCE_PATH');
    expect(found).toHaveLength(1);
    expect(found[0].severity).toBe('warning');
  });

  it('a type that names its file is not reported', () => {
    proj = createTempProject();
    proj.type('habit', 'subsystem: sub-a\nsourcePath: src/habit.ts\nfields:\n  - { name: id, type: string }');
    proj.source('src/habit.ts', 'export interface habit { id: string }\n');
    proj.activate();
    expect(byCode(validateProject(), 'MISSING_TYPE_SOURCE_PATH')).toEqual([]);
  });
});

describe('6. interfaces in a shared contracts file', () => {
  it('a call through a collaborator typed by a shared interface is traced to the class implementing it', () => {
    proj = createTempProject();
    proj.component('repo-a', 'Repository');
    proj.contract('repo-a', [['record', 'write']]);
    proj.impl('repo-a', `sourcePath: src/repo.ts\nmethods:\n${intent('record')}`);
    proj.source('src/contracts.ts', [
      'export interface IRepo { record(id: string): string }',
      'export interface ITracker { checkIn(id: string): string }', '',
    ].join('\n'));
    proj.source('src/repo.ts', "import type { IRepo } from './contracts.js';\nexport class Repo implements IRepo {\n  record(id: string): string { return id; }\n}\n");
    proj.component('tracker-a', 'Orchestrator', 'dependsOn: [repo-a]');
    proj.contract('tracker-a', [['checkIn']]);
    proj.impl('tracker-a', [
      'sourcePath: src/tracker.ts', 'methods:', '  - name: checkIn', '    narrative:',
      '      - { stepNumber: 1, description: Record it, type: call, targetComponent: repo-a, targetMethod: record }',
      '      - { stepNumber: 2, description: Done, type: return, outcome: done }',
    ].join('\n'));
    proj.source('src/tracker.ts', [
      "import type { IRepo, ITracker } from './contracts.js';",
      'export class Tracker implements ITracker {',
      '  constructor(private readonly repo: IRepo) {}',
      '  checkIn(id: string): string { return this.repo.record(id); }',
      '}', '',
    ].join('\n'));
    proj.activate();
    const res = validateProject();
    const onTracker = (code: string) => byCode(res, code).filter(i => i.specId === 'impl-tracker-a');
    expect(onTracker('CALL_STEP_UNREALIZED')).toEqual([]);
    expect(onTracker('CALL_ORIGIN_UNRESOLVED')).toEqual([]);
  });
});

describe('9. planned files', () => {
  it('one SOURCE_FILE_PLANNED notice per implementation, naming every planned file', () => {
    proj = createTempProject();
    proj.component('store-a', 'Store', 'durability: read-through');
    proj.contract('store-a', [['save', 'write'], ['load', 'read']]);
    proj.impl('store-a', `sourcePath: src/store.ts\nmethods:\n${intent('save')}\n${intent('load')}\n    sourcePath: src/load.ts`);
    proj.activate();
    const planned = byCode(validateProject(), 'SOURCE_FILE_PLANNED').filter(i => i.specId === 'impl-store-a');
    expect(planned).toHaveLength(1);
    expect(planned[0].message).toContain('src/store.ts');
    expect(planned[0].message).toContain('src/load.ts');
  });
});

// ---- 5. implementing another project's extension point ----------------------

const TS = '2026-01-01T00:00:00.000Z';
const roots: string[] = [];
afterEach(() => {
  setProjectRoot(null);
  invalidateSpecCache();
  for (const dir of roots.splice(0)) {
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* windows locks */ }
  }
});

function configYaml(id: string, extra: Record<string, unknown> = {}): string {
  return yaml.dump({
    schemaVersion: '1.0.0', id, name: id, targets: [], rules: BASE_FIXTURE_RULES,
    extensions: { packs: [], useGlobalPacks: false }, ...extra, createdAt: TS, updatedAt: TS,
  }, { noRefs: true, lineWidth: 200 });
}

/** A Rust producer exporting a snake_case extension point, and a TypeScript consumer implementing it. */
function traitPair(): { geo: string; studio: string } {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-r3impl-')));
  roots.push(root);
  const geo: FixtureTree = {
    system: {
      name: 'GeoKit', vision: 'A geocoding library.', targetLanguage: 'Rust',
      publicInterfaces: [{ from: 'geo', component: 'provider-port', as: 'provider', role: 'implement' }],
    },
    subsystems: [{ id: 'geo', description: 'Geocoding.', publicInterfaces: [{ component: 'provider-port', details: 'Where answers come from.', role: 'implement' }] }],
    components: [{ id: 'provider-port', componentType: 'Adapter', description: 'The port GeoKit geocodes through.' }],
    interfaces: [{ id: 'iprovider_port', component: 'provider-port', methods: [{ name: 'forward_geocode', description: 'Geocode an address.', params: [{ name: 'address_line', type: 'string' }], returns: 'string' }] }],
  };
  const studio: FixtureTree = {
    system: { name: 'Planner', vision: 'Plans routes.', targetLanguage: 'TypeScript' },
    subsystems: [{ id: 'routing', description: 'Routing.' }],
    components: [{ id: 'nominatim', componentType: 'Adapter', description: 'Geocodes through Nominatim.' }],
    interfaces: [{
      id: 'inominatim', component: 'nominatim', implements: 'geo::provider',
      methods: [{ name: 'forward_geocode', description: 'Geocode an address through Nominatim.', params: [{ name: 'address_line', type: 'string' }], returns: 'string' }],
    }],
  };
  const geoDir = path.join(root, 'geo');
  const studioDir = path.join(root, 'studio');
  fs.mkdirSync(geoDir, { recursive: true });
  fs.mkdirSync(studioDir, { recursive: true });
  materializeFixtureProject(geoDir, geo);
  fs.writeFileSync(path.join(geoDir, '.wai', 'project.yaml'), configYaml('geo'));
  materializeFixtureProject(studioDir, studio);
  fs.writeFileSync(path.join(studioDir, '.wai', 'project.yaml'), configYaml('studio', { externals: { geo: { source: { path: '../geo' } } } }));
  return { geo: geoDir, studio: studioDir };
}

describe("5. an implemented extension point's names come from the producer", () => {
  it('its methods are exempt from the local casing rule, with no lint allow', () => {
    const p = traitPair();
    setProjectRoot(p.studio);
    invalidateSpecCache();
    pinExternals();
    invalidateSpecCache();
    const naming = validateProject({}).issues.filter((i) => i.code === 'NAMING_CONVENTION_VIOLATION');
    expect(naming.filter((i) => i.message.includes('forward_geocode'))).toEqual([]);
  });

  it('the rename tool accepts a producer-dictated name', () => {
    const p = traitPair();
    setProjectRoot(p.studio);
    invalidateSpecCache();
    const result = renameMethod('nominatim', 'forward_geocode', 'forward_lookup');
    expect(result.to).toBe('forward_lookup');
    // Still an identifier, though: a name no language spells is refused.
    expect(() => renameMethod('nominatim', 'forward_lookup', 'forward-lookup')).toThrow(/invalid-name/);
  });
});
