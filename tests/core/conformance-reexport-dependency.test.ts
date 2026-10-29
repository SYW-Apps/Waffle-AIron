/**
 * The 6.4.0 QA panel's way around UNDECLARED_DEPENDENCY (seat 3): a file that
 * re-exports another component's code reaches it as surely as one importing
 * it, and so does a file importing that code's name through a barrel no
 * component realizes. Both are judged as imports now; a type-only re-export
 * republishes no code and stays out of it.
 */
import { describe, expect, it } from 'vitest';
import { defineRuleFixture, runRuleFixture, type FixtureTree } from '../rules-matrix/harness.js';
import { dispatchTree, ts, TS_DISPATCH_BODY } from '../rules-matrix/families/conformance-surface-gaps.fixtures.js';

const STORE = 'src/dispatch/tracking-store.ts';
const ORCHESTRATOR = 'src/dispatch/dispatch_orchestrator.ts';

function undeclared(tree: FixtureTree): string[] {
  const result = runRuleFixture(defineRuleFixture({ code: 'UNDECLARED_DEPENDENCY', expectFire: false, reason: 'probe', scenario: 'A parcel dispatch system the gate reads whole.', tree }));
  return result.issues.filter(i => i.code === 'UNDECLARED_DEPENDENCY').map(i => i.message);
}

/** The dispatch tree (the orchestrator depends on the store, never the reverse) with lines added to the store's file, and other files beside. */
function storeWriting(lines: string[], files: Record<string, string> = {}): FixtureTree {
  const tree = dispatchTree(ts([...TS_DISPATCH_BODY]), false);
  tree.files![STORE] = `${tree.files![STORE]}\n${lines.join('\n')}\n`;
  Object.assign(tree.files!, files);
  return tree;
}

describe('a runtime re-export is a dependency edge', () => {
  it('the tree as written declares every edge', () => {
    expect(undeclared(storeWriting([]))).toEqual([]);
  });

  it('a named re-export from a component the file declares no relation to is reported', () => {
    const found = undeclared(storeWriting(['export { DispatchOrchestrator } from \'./dispatch_orchestrator.js\';']));
    expect(found).toHaveLength(1);
    expect(found[0]).toContain(`"${STORE}"`);
    expect(found[0]).toContain(`re-exports from "${ORCHESTRATOR}"`);
  });

  it('a star and a namespace re-export are edges too', () => {
    expect(undeclared(storeWriting(['export * from \'./dispatch_orchestrator.js\';']))).toHaveLength(1);
    expect(undeclared(storeWriting(['export * as dispatch from \'./dispatch_orchestrator.js\';']))).toHaveLength(1);
  });

  it('a type-only re-export republishes no code', () => {
    expect(undeclared(storeWriting(['export type { DispatchOrchestrator } from \'./dispatch_orchestrator.js\';']))).toEqual([]);
    expect(undeclared(storeWriting(['export type * from \'./dispatch_orchestrator.js\';']))).toEqual([]);
  });

  it('a re-export along a declared edge is justified', () => {
    const tree = dispatchTree(ts([...TS_DISPATCH_BODY], ['export { TrackingStore } from \'./tracking-store.js\';']), false);
    expect(undeclared(tree)).toEqual([]);
  });
});

describe('a name imported through a barrel no component realizes is charged to where it comes from', () => {
  it('a renamed name followed through the barrel is reported against the file publishing it', () => {
    const found = undeclared(storeWriting(
      ['import { Dispatcher } from \'./lib/index.js\';', 'export const dispatcherKind = Dispatcher.name;'],
      { 'src/dispatch/lib/index.ts': 'export { DispatchOrchestrator as Dispatcher } from \'../dispatch_orchestrator.js\';\n' },
    ));
    expect(found).toHaveLength(1);
    expect(found[0]).toContain('through "src/dispatch/lib/index.ts" (which no component realizes)');
    expect(found[0]).toContain(`a name from "${ORCHESTRATOR}"`);
  });

  it('a star barrel charges only the module that exports the name', () => {
    const barrel = {
      'src/dispatch/lib/index.ts': 'export * from \'../dispatch_orchestrator.js\';\nexport * from \'./labels.js\';\n',
      'src/dispatch/lib/labels.ts': 'export function routeLabel(routeId: string): string {\n  return `route ${routeId}`;\n}\n',
    };
    expect(undeclared(storeWriting(['import { routeLabel } from \'./lib/index.js\';', 'export const firstLabel = routeLabel(\'r-1\');'], barrel))).toEqual([]);
    expect(undeclared(storeWriting(['import { DispatchOrchestrator } from \'./lib/index.js\';', 'export const dispatcherKind = DispatchOrchestrator.name;'], barrel))).toHaveLength(1);
  });

  it('a namespace import of the barrel reaches every file it republishes', () => {
    const found = undeclared(storeWriting(
      ['import * as lib from \'./lib/index.js\';', 'export const exported = Object.keys(lib);'],
      { 'src/dispatch/lib/index.ts': 'export { DispatchOrchestrator } from \'../dispatch_orchestrator.js\';\n' },
    ));
    expect(found).toHaveLength(1);
    expect(found[0]).toContain(`a name from "${ORCHESTRATOR}"`);
  });
});
