/**
 * The 6.3.0 QA panel's two conformance misses (seat 3):
 * - a verb the design removed, still exported, passed because a same-named
 *   member of ANOTHER class counted as its use, and a re-export counted as a
 *   use — a use is now a use of that very declaration, and a re-export is
 *   publication;
 * - a collaborator wired as an object literal of a module's functions
 *   (`{ pickRoute }` in a composition root) was CALL_ORIGIN_UNRESOLVED and
 *   UNREALIZED_DEPENDENCY — the type checker now reads the wiring.
 */
import { describe, expect, it } from 'vitest';
import { defineRuleFixture, runRuleFixture, type FixtureTree } from '../rules-matrix/harness.js';
import { dispatchTree, plannerTree, ts, TS_DISPATCH_BODY } from '../rules-matrix/families/conformance-surface-gaps.fixtures.js';

function issues(tree: FixtureTree, codes: string[]): string[] {
  const result = runRuleFixture(defineRuleFixture({ code: codes[0], expectFire: false, reason: 'probe', scenario: 'A parcel dispatch system the gate reads whole.', tree }));
  return result.issues.filter(i => codes.includes(i.code)).map(i => `${i.code}: ${i.message}`);
}

/** The orchestrator's file exporting a module function `lookup` beside the class, which calls the store's own `lookup`. */
function leftoverTree(extra: Record<string, string> = {}): FixtureTree {
  const tree = dispatchTree(ts([
    ...TS_DISPATCH_BODY.slice(0, 2),
    '  if (this.store.lookup(parcelId)) return this.store.lookup(parcelId);',
    ...TS_DISPATCH_BODY.slice(2),
  ], [
    '/** A verb the design no longer declares. */',
    'export function lookup(parcelId: string): string {',
    '  return `route-${parcelId}`;',
    '}',
  ]), false, { narratesLookup: true });
  Object.assign(tree.files!, extra);
  return tree;
}

describe('a use is a use of that declaration', () => {
  it('a same-named method of another class is no use of an exported function', () => {
    const found = issues(leftoverTree(), ['UNDECLARED_PUBLIC_MEMBER']);
    expect(found).toHaveLength(1);
    expect(found[0]).toContain('"lookup"');
  });

  it('a re-export is publication: a barrel republishing the name uses nothing', () => {
    const found = issues(leftoverTree({ 'src/dispatch/index.ts': 'export { lookup } from \'./dispatch_orchestrator.js\';\nexport * from \'./dispatch_orchestrator.js\';\n' }), ['UNDECLARED_PUBLIC_MEMBER']);
    expect(found).toHaveLength(1);
    expect(found[0]).toContain('"lookup"');
  });

  it('a file importing the name through the barrel and calling it is a use', () => {
    const found = issues(leftoverTree({
      'src/dispatch/index.ts': 'export { lookup as routeOf } from \'./dispatch_orchestrator.js\';\n',
      'src/app.ts': 'import { routeOf } from \'./dispatch/index.js\';\nexport const first = routeOf(\'p-1\');\n',
    }), ['UNDECLARED_PUBLIC_MEMBER']);
    expect(found).toEqual([]);
  });

  it('a file importing it from its own module and calling it is a use', () => {
    const found = issues(leftoverTree({
      'src/app.ts': 'import { lookup } from \'./dispatch/dispatch_orchestrator.js\';\nexport const first = lookup(\'p-1\');\n',
    }), ['UNDECLARED_PUBLIC_MEMBER']);
    expect(found).toEqual([]);
  });

  it('an analyzed file importing it unrenamed and wiring it without a call is a use', () => {
    const tree = leftoverTree({
      'src/app.ts': 'import { lookup } from \'./dispatch/dispatch_orchestrator.js\';\nexport const handlers = { lookup };\n',
    });
    // Analyzed, the importer is judged by what the checker lands and the names it imports.
    tree.rules = { conformance: { sourceRoots: ['src'] } };
    expect(issues(tree, ['UNDECLARED_PUBLIC_MEMBER'])).toEqual([]);
  });

  it('an exported class a star barrel only republishes is used by nothing', () => {
    const tree = dispatchTree(ts([...TS_DISPATCH_BODY], [
      '/** A class no contract declares. */',
      'export class RouteCache {',
      '  get(parcelId: string): string { return parcelId; }',
      '}',
    ]), false);
    tree.files!['src/dispatch/index.ts'] = 'export * from \'./dispatch_orchestrator.js\';\n';
    // Analyzed, the barrel's declared names carry what it republishes.
    tree.rules = { conformance: { sourceRoots: ['src'] } };
    const found = issues(tree, ['UNDECLARED_PUBLIC_MEMBER']);
    expect(found).toHaveLength(1);
    expect(found[0]).toContain('"RouteCache" (an exported class)');
    // A file importing it through the barrel and constructing it uses it.
    tree.files!['src/app.ts'] = 'import { RouteCache } from \'./dispatch/index.js\';\nexport const cache = new RouteCache();\n';
    expect(issues(tree, ['UNDECLARED_PUBLIC_MEMBER'])).toEqual([]);
  });
});

describe('a file the run does not analyze is judged by where its uses land', () => {
  const lookupFindings = (extra: Record<string, string>): string[] => issues(leftoverTree(extra), ['UNDECLARED_PUBLIC_MEMBER']);

  it('a test calling the same-named method of another class uses nothing', () => {
    const found = lookupFindings({
      'tests/store.test.ts': 'import { TrackingStore } from \'../src/dispatch/tracking-store.js\';\nnew TrackingStore().lookup(\'p-1\');\n',
    });
    expect(found).toHaveLength(1);
    expect(found[0]).toContain('"lookup"');
  });

  it('a script file reaching none of the run\'s files adds no name', () => {
    const found = lookupFindings({ 'scripts/tally.ts': 'const lookup = 1;\nconsole.log(lookup);\n' });
    expect(found).toHaveLength(1);
    expect(found[0]).toContain('"lookup"');
  });

  it('a test importing the function and calling it uses it', () => {
    expect(lookupFindings({
      'tests/dispatch.test.ts': 'import { lookup } from \'../src/dispatch/dispatch_orchestrator.js\';\nlookup(\'p-1\');\n',
    })).toEqual([]);
  });

  it('a test reaching it through an unanalyzed barrel under another name uses it', () => {
    expect(lookupFindings({
      'lib/index.ts': 'export { lookup as routeOf } from \'../src/dispatch/dispatch_orchestrator.js\';\n',
      'tests/dispatch.test.ts': 'import { routeOf } from \'../lib/index.js\';\nrouteOf(\'p-1\');\n',
    })).toEqual([]);
  });

  it('a test importing a name the realizing file republishes, and calling it, uses it', () => {
    // The call lands on the helper's own declaration; the import of the name from the realizing file is the use of its re-export.
    const tree = dispatchTree(ts([...TS_DISPATCH_BODY], ['export { formatRoute } from \'./route-format.js\';']), false);
    tree.files!['src/dispatch/route-format.ts'] = 'export function formatRoute(parcelId: string): string {\n  return `route-${parcelId}`;\n}\n';
    const formatFindings = (): string[] => issues(tree, ['UNDECLARED_PUBLIC_MEMBER']).filter(f => f.includes('formatRoute'));
    expect(formatFindings()).toHaveLength(1);
    tree.files!['tests/format.test.ts'] = 'import { formatRoute } from \'../src/dispatch/dispatch_orchestrator.js\';\nformatRoute(\'p-1\');\n';
    expect(formatFindings()).toEqual([]);
  });

  it('a file in a language no checker reads still exempts by name', () => {
    expect(lookupFindings({ 'tools/report.py': 'def report(lookup):\n    return lookup\n' })).toEqual([]);
  });

  it('an exported class is still exempted by its name in an unanalyzed file', () => {
    const tree = dispatchTree(ts([...TS_DISPATCH_BODY], [
      '/** A class no contract declares. */',
      'export class RouteCache {',
      '  get(parcelId: string): string { return parcelId; }',
      '}',
    ]), false);
    expect(issues(tree, ['UNDECLARED_PUBLIC_MEMBER'])).toHaveLength(1);
    tree.files!['scripts/notes.ts'] = 'const RouteCache = 1;\nconsole.log(RouteCache);\n';
    expect(issues(tree, ['UNDECLARED_PUBLIC_MEMBER'])).toEqual([]);
  });
});

/** The planner as a module function behind a port the orchestrator declares for itself, wired (or not) by a composition root. */
function wiredTree(root: string | undefined): FixtureTree {
  const tree = plannerTree({ stated: true, narrated: true });
  tree.files!['src/dispatch/route-planner.ts'] = [
    'export function pickRoute(parcelId: string): string {',
    '  return `route-${parcelId}`;',
    '}',
    '',
  ].join('\n');
  tree.files!['src/dispatch/dispatch_orchestrator.ts'] = [
    'import { TrackingStore } from \'./tracking-store.js\';',
    '',
    '/** What the orchestrator needs of the route planner. */',
    'export interface RoutePort {',
    '  pickRoute(parcelId: string): string;',
    '}',
    '',
    'export class DispatchOrchestrator {',
    '  constructor(private readonly store: TrackingStore, private readonly planner: RoutePort) {}',
    '',
    '  async dispatchParcel(parcelId: string): Promise<string> {',
    '    const routeId = this.planner.pickRoute(parcelId);',
    '    this.store.record(parcelId, routeId);',
    '    return routeId;',
    '  }',
    '}',
    '',
  ].join('\n');
  if (root !== undefined) tree.files!['src/main.ts'] = root;
  return tree;
}

const WIRED_CODES = ['CALL_ORIGIN_UNRESOLVED', 'UNREALIZED_DEPENDENCY', 'CALL_STEP_UNREALIZED'];

describe('a port wired with an object literal of module functions', () => {
  it('without the composition root the call cannot be followed', () => {
    expect(issues(wiredTree(undefined), WIRED_CODES).some(i => i.startsWith('CALL_ORIGIN_UNRESOLVED'))).toBe(true);
  });

  it('a composition root wiring { pickRoute } lands the call on the planner', () => {
    const root = [
      'import { DispatchOrchestrator } from \'./dispatch/dispatch_orchestrator.js\';',
      'import { TrackingStore } from \'./dispatch/tracking-store.js\';',
      'import { pickRoute } from \'./dispatch/route-planner.js\';',
      '',
      'export const orchestrator = new DispatchOrchestrator(new TrackingStore(), { pickRoute });',
      '',
    ].join('\n');
    expect(issues(wiredTree(root), WIRED_CODES)).toEqual([]);
  });

  it('a property naming the function through a namespace import lands it the same way', () => {
    const root = [
      'import { DispatchOrchestrator, type RoutePort } from \'./dispatch/dispatch_orchestrator.js\';',
      'import { TrackingStore } from \'./dispatch/tracking-store.js\';',
      'import * as planner from \'./dispatch/route-planner.js\';',
      '',
      'const port: RoutePort = { pickRoute: planner.pickRoute };',
      'export const orchestrator = new DispatchOrchestrator(new TrackingStore(), port);',
      '',
    ].join('\n');
    expect(issues(wiredTree(root), WIRED_CODES)).toEqual([]);
  });
});
