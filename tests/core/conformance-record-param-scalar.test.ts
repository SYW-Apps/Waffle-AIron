/**
 * A contract parameter typed as a record the code annotates as a scalar —
 * under the contract's own name or another — is PARAM_TYPE_MISMATCH, in
 * TypeScript and in Python: a record is an object, and a string, a number or
 * a boolean cannot hold it. The honest annotation, an unknown name, a union
 * and any keep the verdicts they had.
 */
import { describe, expect, it } from 'vitest';
import { defineRuleFixture, runRuleFixture, type FixtureTree } from '../rules-matrix/harness.js';
import { dispatchTree, py, ts } from '../rules-matrix/families/conformance-surface-gaps.fixtures.js';

const RECORD = {
  id: 'parcel_key', name: 'ParcelKey', kind: 'value-object',
  fields: [{ name: 'parcelId', type: 'string' }, { name: 'ownerId', type: 'string' }],
};

function findings(tree: FixtureTree, code = 'PARAM_TYPE_MISMATCH'): string[] {
  const run = runRuleFixture(defineRuleFixture({ code, expectFire: false, reason: 'probe', scenario: 'A parcel dispatch system the gate reads whole.', tree }));
  return run.issues.filter(i => i.code === code).map(i => `${i.code}: ${i.message}`);
}

const TS_BODY = (param: string): string[] => [
  `async dispatchParcel(${param}): Promise<string> {`,
  '  const routeId = `route-${String(parcelId)}`;',
  '  this.store.record(String(parcelId), routeId);',
  '  return routeId;',
  '}',
];
const PY_BODY = (param: string): string[] => [
  `async def dispatch_parcel(self, ${param}) -> str:`,
  '    route_id = "route-" + str(parcel_id)',
  '    self._store.record(str(parcel_id), route_id)',
  '    return route_id',
];

function recordTyped(tree: FixtureTree, type = 'parcel_key'): FixtureTree {
  const contract = tree.interfaces!.find(i => i.id === 'idispatch_orchestrator')!;
  const method = (contract.methods as Array<Record<string, unknown>>)[0];
  const params = method.params as Array<{ name: string; type: string }>;
  params[0].type = type;
  method.signature = `${method.name as string}(${params[0].name}: ${type}): async string`;
  return { ...tree, types: [...(tree.types ?? []), RECORD] };
}

describe('a record parameter the code annotates as a scalar', () => {
  for (const scalar of ['string', 'number', 'boolean']) {
    it(`TypeScript: ${scalar} under the contract's own parameter name`, () => {
      const found = findings(recordTyped(dispatchTree(ts(TS_BODY(`parcelId: ${scalar}`)), false)));
      expect(found).toHaveLength(1);
      expect(found[0]).toMatch(new RegExp(`"parcelId" \\(the code takes "parcelId" annotated "${scalar}", where the contract declares "parcel_key"\\)`));
    });
  }

  it('TypeScript: string under another parameter name is still a finding, naming both types', () => {
    const body = TS_BODY('key: string').map(line => line.split('parcelId').join('key'));
    const found = findings(recordTyped(dispatchTree(ts(body), false)), 'UNREALIZED_PARAM');
    expect(found).toHaveLength(1);
    expect(found[0]).toMatch(/a string, where the contract declares the record "parcel_key"/);
  });

  it('Python: str under the contract\'s own parameter name', () => {
    const found = findings(recordTyped(dispatchTree(py(PY_BODY('parcel_id: str')), true)));
    expect(found).toHaveLength(1);
    expect(found[0]).toMatch(/annotated "str"/);
  });

  it('the honest annotation stays silent, in both languages', () => {
    expect(findings(recordTyped(dispatchTree(ts(TS_BODY('parcelId: ParcelKey')), false)))).toEqual([]);
    expect(findings(recordTyped(dispatchTree(py(PY_BODY('parcel_id: ParcelKey')), true)))).toEqual([]);
  });

  it('a name the design does not know, a union and any are not compared', () => {
    for (const written of ['Mystery', 'string | ParcelKey', 'any', 'unknown']) {
      expect(findings(recordTyped(dispatchTree(ts(TS_BODY(`parcelId: ${written}`)), false))).filter(f => /annotated "(Mystery|string \| ParcelKey)"/.test(f))).toEqual([]);
    }
  });
});

describe('a record return the code annotates as a scalar', () => {
  it('TypeScript: string where the contract returns a record is RETURN_TYPE_MISMATCH', () => {
    const tree = recordTyped(dispatchTree(ts(TS_BODY('parcelId: ParcelKey')), false));
    const method = (tree.interfaces!.find(i => i.id === 'idispatch_orchestrator')!.methods as Array<Record<string, unknown>>)[0];
    method.returns = 'async parcel_key';
    expect(findings(tree, 'RETURN_TYPE_MISMATCH')).toHaveLength(1);
  });
});
