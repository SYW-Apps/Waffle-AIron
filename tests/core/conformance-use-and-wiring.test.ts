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
