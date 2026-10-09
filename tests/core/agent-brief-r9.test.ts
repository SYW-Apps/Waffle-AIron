import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { invalidateSpecCache, loadComponentSpecs } from '../../src/core/specs.js';
import { composeAgentBrief, resolveAgentTopology } from '../../src/core/agent_resolver.js';

// ---------------------------------------------------------------------------
// Round 9 (the briefs as a hand-off): one types file holding two Stores'
// entity types fenced to both; a first-wave module never allowed the line
// that declares it in its Portal's planned mod.rs; nothing in a Portal's
// brief about its handler shape or the injectedParams linkage; and a member's
// internal ids "as the pin has them" for a project that is never pinned.
// ---------------------------------------------------------------------------

const STAMP = "createdAt: '2026-10-09T10:00:00Z'\nupdatedAt: '2026-10-09T10:00:00Z'";

function project(root: string, name: string, extra: Record<string, unknown> = {}) {
  const waiDir = path.join(root, '.wai');
  const specsDir = path.join(waiDir, 'specs');
  for (const d of ['subsystems', 'components', 'interfaces', 'implementations', 'types']) {
    fs.mkdirSync(path.join(specsDir, d), { recursive: true });
  }
  fs.writeFileSync(path.join(waiDir, 'project.yaml'), JSON.stringify({
    schemaVersion: '1.0.0',
    name,
    projectType: 'backend',
    targets: [{ type: 'claude', outputDir: '.claude/agents', enabled: true }],
    rules: {},
    ...extra,
    createdAt: '2026-10-09T10:00:00Z',
    updatedAt: '2026-10-09T10:00:00Z',
  }));
  const writeSpec = (type: string, id: string, content: string): void => {
    const filePath = type === 'system' ? path.join(specsDir, '.index.yaml') : path.join(specsDir, `${type}s`, `${id}.yaml`);
    fs.writeFileSync(filePath, `${content}\n${STAMP}\n`);
  };
  const writeFile = (rel: string, content: string): void => {
    const p = path.join(root, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  };
  return { writeSpec, writeFile };
}

describe('live briefs, round 9', () => {
  let dirs: string[] = [];
  let isolatedGlobalDir: string;
  beforeEach(() => {
    invalidateSpecCache();
    isolatedGlobalDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-brief9-global-'));
    process.env.WAIRON_TEMPLATES_DIR = isolatedGlobalDir;
    process.env.WAIRON_VARIANTS_DIR = isolatedGlobalDir;
    dirs = [isolatedGlobalDir];
  });
  afterEach(() => {
    invalidateSpecCache();
    vi.restoreAllMocks();
    delete process.env.WAIRON_TEMPLATES_DIR;
    delete process.env.WAIRON_VARIANTS_DIR;
    for (const d of dirs) try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* win file locks */ }
  });
  const tempRoot = (prefix: string): string => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    dirs.push(d);
    return d;
  };

  /** The solo-app design: two Stores whose entity types share one planned src/types.ts, a Portal with guessed injections. */
  function habitly(): string {
    const root = tempRoot('wairon-brief9-');
    const p = project(root, 'habitly');
    p.writeSpec('system', 'system', 'schemaVersion: 1.0.0\nname: Habitly\nvision: habits');
    p.writeSpec('subsystem', 'habitly', 'schemaVersion: 1.0.0\nid: habitly\nname: Habitly\ndescription: d\nparentSystem: Habitly');
    const component = (id: string, type: string, deps: string[] = []): void => {
      p.writeSpec('component', id, `id: ${id}\nname: ${id}\ndescription: d\nsubsystem: habitly\ncomponentType: ${type}${deps.length ? `\ndependsOn: [${deps.join(', ')}]` : ''}`);
      p.writeSpec('interface', `i${id}`, `id: i${id}\nname: I${id}\ndescription: d\ncomponent: ${id}\nmethods: []`);
    };
    component('habit_store', 'Store');
    component('account_store', 'Store');
    component('habit_orchestrator', 'Orchestrator', ['habit_store', 'account_store']);
    component('habit_portal', 'Portal', ['habit_orchestrator']);
    p.writeSpec('implementation', 'habit_store_pg', 'id: habit_store_pg\nname: h\ndescription: d\ncontract: ihabit_store\nsourcePath: src/habit-store.ts\ninjectedParams: [db]\nmethods: []');
    p.writeSpec('implementation', 'account_store_pg', 'id: account_store_pg\nname: a\ndescription: d\ncontract: iaccount_store\nsourcePath: src/account-store.ts\nmethods: []');
    p.writeSpec('implementation', 'habit_orchestrator_impl', 'id: habit_orchestrator_impl\nname: o\ndescription: d\ncontract: ihabit_orchestrator\nsourcePath: src/habit-orchestrator.ts\nmethods: []');
    p.writeSpec('implementation', 'habit_portal_http', 'id: habit_portal_http\nname: p\ndescription: d\ncontract: ihabit_portal\nsourcePath: src/habit-portal.ts\ninjectedParams: [req, res]\nmethods: []');
    p.writeSpec('type', 'habit', 'kind: entity\nid: habit\nname: Habit\nsubsystem: habitly\ncomponentClass: habit_store\nsourcePath: src/types.ts\nfields: []\nmethods: []');
    p.writeSpec('type', 'user', 'kind: entity\nid: user\nname: User\nsubsystem: habitly\ncomponentClass: account_store\nsourcePath: src/types.ts\nfields: []\nmethods: []');
    p.writeFile('package.json', '{"name":"habitly"}');
    vi.spyOn(process, 'cwd').mockReturnValue(root);
    return root;
  }

  it('no two implementer briefs share a fenced file — one types file holding two Stores\' entity types is shared, never fenced', () => {
    habitly();
    const ids = loadComponentSpecs().map((c) => c.id);
    const fencedBy = new Map<string, string[]>();
    for (const id of ids) {
      for (const file of composeAgentBrief(id).codeFence ?? []) fencedBy.set(file, [...(fencedBy.get(file) ?? []), id]);
    }
    const twice = [...fencedBy].filter(([, owners]) => owners.length > 1);
    expect(twice).toEqual([]);
    const store = composeAgentBrief('habit_store');
    expect(store.codeFence).toEqual(['src/habit-store.ts']);
    expect(store.sharedPaths).toContain('src/types.ts');
    expect(composeAgentBrief('account_store').sharedPaths).toContain('src/types.ts');
    // The generated topology holds the same invariant across every implementer record.
    const records = resolveAgentTopology().filter((r) => r.template === 'implementer');
    const all = records.flatMap((r) => r.ownedPaths);
    expect(new Set(all).size).toBe(all.length);
  });

  it('a Portal\'s brief carries its handler shape; every brief says injectedParams are linkage the implementer sets, and lists guesses to remove', () => {
    habitly();
    const portal = composeAgentBrief('habit_portal');
    expect(portal.instructions).toContain('## Handler shape');
    expect(portal.instructions).toContain('takes the contract\'s OWN parameters, in order');
    expect(portal.instructions).toContain('`req.params.<name>`');
    expect(portal.instructions).toContain('`conformance: off` is only for generated or vendored code');
    expect(portal.instructions).toContain('`habit_portal_http`: [req, res]');
    expect(portal.instructions).toContain('UNUSED_INJECTED_PARAM');
    const store = composeAgentBrief('habit_store');
    expect(store.instructions).not.toContain('## Handler shape');
    expect(store.instructions).toContain('## Code linkage you own');
    expect(store.instructions).toContain('`habit_store_pg`: [db]');
    expect(store.instructions).toContain('may be guesses written before any code existed');
    const orchestrator = composeAgentBrief('habit_orchestrator');
    expect(orchestrator.instructions).toContain('declare them only when your code takes a parameter');
    expect(orchestrator.instructions).not.toContain('Declared now');
  });

  it('a first-wave module beside its Portal\'s PLANNED mod.rs may add the line declaring itself: the module root is shared', () => {
    const root = tempRoot('wairon-brief9-rs-');
    const p = project(root, 'geo-sdk');
    p.writeSpec('system', 'system', 'schemaVersion: 1.0.0\nname: Geo\nvision: maths');
    p.writeSpec('subsystem', 'distance', 'schemaVersion: 1.0.0\nid: distance\nname: Distance\ndescription: d\nparentSystem: Geo');
    p.writeSpec('component', 'distance_math', 'id: distance_math\nname: m\ndescription: d\nsubsystem: distance\ncomponentType: Orchestrator\ndependencyClass: pure');
    p.writeSpec('component', 'distance_portal', 'id: distance_portal\nname: p\ndescription: d\nsubsystem: distance\ncomponentType: Portal\ndependsOn: [distance_math]');
    p.writeSpec('interface', 'idistance_math', 'id: idistance_math\nname: I\ndescription: d\ncomponent: distance_math\nmethods: []');
    p.writeSpec('interface', 'idistance_portal', 'id: idistance_portal\nname: I\ndescription: d\ncomponent: distance_portal\nmethods: []');
    p.writeSpec('implementation', 'distance_math_impl', 'id: distance_math_impl\nname: m\ndescription: d\ncontract: idistance_math\nsourcePath: src/distance/math.rs\nmethods: []');
    p.writeSpec('implementation', 'distance_portal_impl', 'id: distance_portal_impl\nname: p\ndescription: d\ncontract: idistance_portal\nsourcePath: src/distance/mod.rs\nmethods: []');
    vi.spyOn(process, 'cwd').mockReturnValue(root);
    const maths = composeAgentBrief('distance_math');
    expect(maths.codeFence).toEqual(['src/distance/math.rs']);
    expect(maths.sharedPaths).toContain('src/distance/mod.rs');
    expect(maths.instructions).toContain('- `src/distance/mod.rs` (planned — create it)');
    expect(maths.instructions).toContain('add only the line that declares or re-exports your module');
    // Still the Portal's own fence, and only the Portal's.
    expect(composeAgentBrief('distance_portal').codeFence).toEqual(['src/distance/mod.rs']);
  });

  it('a member\'s section names its PUBLIC export names and its live export table, never "as the pin has them"', () => {
    const base = tempRoot('wairon-brief9-family-');
    const app = path.join(base, 'route-planner');
    const sdk = path.join(base, 'geo-sdk');
    const member = project(sdk, 'geo-sdk', { id: 'geo-sdk' });
    member.writeSpec('system', 'system', [
      'schemaVersion: 1.0.0', 'name: geo-sdk', 'vision: maths', 'publicInterfaces:',
      '  - component: geocoding_portal', '    interface: igeocoding_portal', '    from: geocoding', '    as: geocoding', '    audience: external',
    ].join('\n'));
    member.writeSpec('subsystem', 'geocoding', 'schemaVersion: 1.0.0\nid: geocoding\nname: Geocoding\ndescription: d\nparentSystem: geo-sdk\npublicInterfaces:\n  - component: geocoding_portal\n    interface: igeocoding_portal');
    member.writeSpec('component', 'geocoding_portal', 'id: geocoding_portal\nname: g\ndescription: d\nsubsystem: geocoding\ncomponentType: Portal\ntransport: InProcess');
    member.writeSpec('interface', 'igeocoding_portal', 'id: igeocoding_portal\nname: I\ndescription: d\ncomponent: geocoding_portal\nmethods: []');
    const consumer = project(app, 'route-planner', { id: 'route-planner', members: { geo: { source: '../geo-sdk' } } });
    consumer.writeSpec('system', 'system', 'schemaVersion: 1.0.0\nname: route-planner\nvision: routes');
    consumer.writeSpec('subsystem', 'routing', 'schemaVersion: 1.0.0\nid: routing\nname: Routing\ndescription: d\nparentSystem: route-planner');
    consumer.writeSpec('component', 'route_planning', 'id: route_planning\nname: r\ndescription: d\nsubsystem: routing\ncomponentType: Orchestrator\ndependsOn: [geo::geocoding]');
    consumer.writeSpec('interface', 'iroute_planning', 'id: iroute_planning\nname: I\ndescription: d\ncomponent: route_planning\nmethods: []');
    consumer.writeSpec('implementation', 'route_planning_impl', 'id: route_planning_impl\nname: r\ndescription: d\ncontract: iroute_planning\nsourcePath: src/route-planning.ts\nbindings: [src/geo-binding.ts]\nmethods: []');
    vi.spyOn(process, 'cwd').mockReturnValue(app);
    const brief = composeAgentBrief('route_planning');
    expect(brief.instructions).toContain('## Externals used');
    expect(brief.instructions).toContain('`geo::geocoding`');
    expect(brief.instructions).not.toContain('geo::geocoding_portal');
    expect(brief.instructions).toContain('read live and never pinned');
    expect(brief.instructions).toContain('keep them exactly as the member\'s live L0 export table names them now');
    expect(brief.instructions).not.toContain('as the pin has them');
  });
});
