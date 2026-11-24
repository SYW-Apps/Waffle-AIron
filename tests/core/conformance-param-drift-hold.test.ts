/**
 * A callee whose code drifts from its contract on a PARAMETER holds the
 * caller's own findings about that callee (CALL_ORIGIN_UNRESOLVED,
 * UNREALIZED_DEPENDENCY) under the root cause, as a drifted return type does
 * (see conformance-qa-gate.test.ts): one finding, at the cause.
 */
import { describe, expect, it } from 'vitest';
import { defineRuleFixture, runRuleFixture, type FixtureTree } from '../rules-matrix/harness.js';
import { dispatchTree, ts, tsOrchestrator, TS_DISPATCH_BODY } from '../rules-matrix/families/conformance-surface-gaps.fixtures.js';

function run(tree: FixtureTree) {
  return runRuleFixture(defineRuleFixture({ code: 'PARAM_TYPE_MISMATCH', expectFire: false, reason: 'probe', scenario: 'A parcel dispatch system the gate reads whole.', tree }));
}

/** The dispatch system plus a desk whose port names the contract's own signature. */
function withDesk(body: string[]): FixtureTree {
  const tree = dispatchTree(ts(body), false);
  tree.components!.push({ id: 'dispatch-desk', componentType: 'Portal', transport: 'InProcess', description: 'The dispatch desk\'s in-process entry for booking parcels.', dependsOn: ['dispatch-orchestrator'], invokedBy: { kind: 'entry', caller: 'the dispatch desk application' } });
  tree.interfaces!.push({ id: 'idispatch_desk', component: 'dispatch-desk', methods: [{ name: 'bookParcel', description: 'Book a parcel from the desk.', signature: 'bookParcel(parcelId: string): async string', returns: 'async string', params: [{ name: 'parcelId', type: 'string' }] }] });
  tree.implementations!.push({ id: 'dispatch_desk_impl', contract: 'idispatch_desk', sourcePath: 'src/dispatch/desk.ts', methods: [{ name: 'bookParcel', narrative: [{ stepNumber: 1, type: 'call', targetComponent: 'dispatch-orchestrator', targetMethod: 'dispatchParcel', description: 'Hand the booking to the dispatch orchestrator.' }] }] });
  tree.files!['src/dispatch/desk.ts'] = [
    '/** The collaborator this desk calls, typed after its contract. */',
    'interface DispatchPort {',
    '  dispatchParcel(parcelId: string): Promise<string>;',
    '}',
    '',
    'export class DispatchDesk {',
    '  constructor(private readonly dispatch: DispatchPort) {}',
    '',
    '  async bookParcel(parcelId: string): Promise<string> {',
    '    return this.dispatch.dispatchParcel(parcelId);',
    '  }',
    '}',
    '',
  ].join('\n');
  return tree;
}

const callerFindings = (issues: Array<{ code: string; specId?: string }>) =>
  issues.filter(i => i.specId === 'dispatch_desk_impl' && (i.code === 'UNREALIZED_DEPENDENCY' || i.code === 'CALL_ORIGIN_UNRESOLVED'));

describe('a caller is held under a callee drifting on a parameter', () => {
  it('control: the honest callee leaves the caller and the callee silent', () => {
    const issues = run(withDesk(TS_DISPATCH_BODY)).issues;
    expect(callerFindings(issues)).toEqual([]);
    expect(issues.filter(i => i.code === 'PARAM_TYPE_MISMATCH' || i.code === 'UNDECLARED_PARAM')).toEqual([]);
    void tsOrchestrator;
  });

  it('a parameter annotated with another type: PARAM_TYPE_MISMATCH at the callee, nothing on the caller', () => {
    const issues = run(withDesk([
      'async dispatchParcel(parcelId: number): Promise<string> {',
      '  const routeId = `route-${parcelId}`;',
      '  this.store.record(String(parcelId), routeId);',
      '  return routeId;',
      '}',
    ])).issues;
    const root = issues.filter(i => i.code === 'PARAM_TYPE_MISMATCH' && i.specId === 'dispatch_orchestrator_impl');
    expect(root).toHaveLength(1);
    expect(callerFindings(issues)).toEqual([]);
  });

  it('an extra required parameter: UNDECLARED_PARAM at the callee, nothing on the caller', () => {
    const issues = run(withDesk([
      'async dispatchParcel(parcelId: string, priority: string): Promise<string> {',
      '  const routeId = `route-${parcelId}-${priority}`;',
      '  this.store.record(parcelId, routeId);',
      '  return routeId;',
      '}',
    ])).issues;
    const root = issues.filter(i => i.code === 'UNDECLARED_PARAM' && i.specId === 'dispatch_orchestrator_impl');
    expect(root).toHaveLength(1);
    expect(callerFindings(issues)).toEqual([]);
  });
});
