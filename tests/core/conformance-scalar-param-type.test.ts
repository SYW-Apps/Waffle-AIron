/**
 * A scalar parameter the code annotates as another scalar takes a different
 * value than the contract declares: PARAM_TYPE_MISMATCH, in TypeScript and in
 * Python, whatever either side calls it — while the spellings a scalar is
 * written as (TypeScript's number for an int, an enum as a string, a date as
 * a string, optionality) and the types no side reads as one scalar stay
 * silent.
 */
import { describe, expect, it } from 'vitest';
import { defineRuleFixture, runRuleFixture, type FixtureTree } from '../rules-matrix/harness.js';
import { dispatchTree, py, ts } from '../rules-matrix/families/conformance-surface-gaps.fixtures.js';

function paramFindings(tree: FixtureTree): string[] {
  const run = runRuleFixture(defineRuleFixture({ code: 'PARAM_TYPE_MISMATCH', expectFire: false, reason: 'probe', scenario: 'A parcel dispatch system the gate reads whole.', tree }));
  return run.issues
    .filter(i => ['PARAM_TYPE_MISMATCH', 'PARAM_NAME_MISMATCH', 'UNREALIZED_PARAM', 'UNDECLARED_PARAM'].includes(i.code))
    .map(i => `${i.code}: ${i.message}`);
}

const TS_BODY = (param: string): string[] => [
  `async dispatchParcel(${param}): Promise<string> {`,
  '  const routeId = `route-${parcelId}`;',
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

/** The dispatch tree with the contract's parcel id typed as given. */
function typedAs(tree: FixtureTree, type: string, extraTypes: FixtureTree['types'] = []): FixtureTree {
  const contract = tree.interfaces!.find(i => i.id === 'idispatch_orchestrator')!;
  const method = (contract.methods as Array<Record<string, unknown>>)[0];
  const params = method.params as Array<{ name: string; type: string }>;
  params[0].type = type;
  method.signature = `${method.name as string}(${params[0].name}: ${type}): async string`;
  return { ...tree, types: [...(tree.types ?? []), ...extraTypes] };
}

describe('a scalar parameter annotated as another scalar', () => {
  it('TypeScript: number where the contract declares a string', () => {
    const found = paramFindings(dispatchTree(ts(TS_BODY('parcelId: number')), false));
    expect(found).toHaveLength(1);
    expect(found[0]).toMatch(/^PARAM_TYPE_MISMATCH: .*"parcelId" \(the code takes "parcelId" annotated "number", where the contract declares "string"\)/);
  });

  it('Python: int where the contract declares a string', () => {
    const found = paramFindings(dispatchTree(py(PY_BODY('parcel_id: int')), true));
    expect(found).toHaveLength(1);
    expect(found[0]).toMatch(/^PARAM_TYPE_MISMATCH: .*annotated "int", where the contract declares "string"/);
  });

  it('Python: a renamed parameter of another scalar is the type finding, naming both', () => {
    const body = PY_BODY('parcel_ref: bool').map(line => line.split('parcel_id').join('parcel_ref'));
    const found = paramFindings(dispatchTree(py(body), true));
    expect(found).toHaveLength(1);
    expect(found[0]).toMatch(/^PARAM_TYPE_MISMATCH: .*the code takes "parcel_ref" annotated "bool"/);
  });

  it('the same scalar stays silent in both languages', () => {
    expect(paramFindings(dispatchTree(ts(TS_BODY('parcelId: string')), false))).toEqual([]);
    expect(paramFindings(dispatchTree(py(PY_BODY('parcel_id: str')), true))).toEqual([]);
  });
});

describe('the spellings a scalar is written as stay silent', () => {
  it('TypeScript number for an int, and Python int for an int', () => {
    expect(paramFindings(typedAs(dispatchTree(ts(TS_BODY('parcelId: number')), false), 'int'))).toEqual([]);
    expect(paramFindings(typedAs(dispatchTree(py(PY_BODY('parcel_id: int')), true), 'int'))).toEqual([]);
  });

  it('an optional string, written with a default or as Optional', () => {
    const tsTree = typedAs(dispatchTree(ts(TS_BODY('parcelId: string | undefined')), false), 'string');
    expect(paramFindings(tsTree).filter(f => f.startsWith('PARAM_TYPE_MISMATCH'))).toEqual([]);
    const pyTree = dispatchTree(py(PY_BODY('parcel_id: Optional[str] = None'), [], ['from typing import Optional']), true);
    expect(paramFindings(pyTree).filter(f => f.startsWith('PARAM_TYPE_MISMATCH'))).toEqual([]);
  });

  it('a date written as a string, an enum as a string, a named scalar as what it holds', () => {
    expect(paramFindings(typedAs(dispatchTree(ts(TS_BODY('parcelId: string')), false), 'date'))).toEqual([]);
    // A Date object is the other way a date, or a datetime, is written.
    expect(paramFindings(typedAs(dispatchTree(ts(TS_BODY('parcelId: Date')), false), 'date'))).toEqual([]);
    expect(paramFindings(typedAs(dispatchTree(ts(TS_BODY('parcelId: Date')), false), 'datetime'))).toEqual([]);
    expect(paramFindings(typedAs(dispatchTree(py(PY_BODY('parcel_id: datetime'), [], ['from datetime import datetime']), true), 'datetime'))).toEqual([]);
    expect(paramFindings(typedAs(dispatchTree(py(PY_BODY('parcel_id: date'), [], ['from datetime import date']), true), 'date'))).toEqual([]);
    // An epoch number is a datetime too, and bytes travel as a buffer or an encoded string.
    expect(paramFindings(typedAs(dispatchTree(ts(TS_BODY('parcelId: number')), false), 'datetime'))).toEqual([]);
    for (const written of ['string', 'Uint8Array', 'Buffer']) {
      expect(paramFindings(typedAs(dispatchTree(ts(TS_BODY(`parcelId: ${written}`)), false), 'bytes')).filter(f => f.startsWith('PARAM_TYPE_MISMATCH'))).toEqual([]);
    }
    expect(paramFindings(typedAs(dispatchTree(py(PY_BODY('parcel_id: bytes')), true), 'bytes'))).toEqual([]);
    const status = { id: 'parcel_status', name: 'ParcelStatus', kind: 'enum', values: [{ name: 'booked' }, { name: 'sent' }] };
    expect(paramFindings(typedAs(dispatchTree(ts(TS_BODY('parcelId: string')), false), 'parcel_status', [status]))).toEqual([]);
    const ref = { id: 'parcel_ref', name: 'ParcelRef', kind: 'value-object', holds: 'string' };
    expect(paramFindings(typedAs(dispatchTree(ts(TS_BODY('parcelId: string')), false), 'parcel_ref', [ref]))).toEqual([]);
  });

  it('a side no reading settles to one scalar is not compared', () => {
    expect(paramFindings(dispatchTree(ts(TS_BODY('parcelId: string | number')), false)).filter(f => f.startsWith('PARAM_TYPE_MISMATCH'))).toEqual([]);
    expect(paramFindings(dispatchTree(py(PY_BODY('parcel_id: "ParcelKey"')), true)).filter(f => f.startsWith('PARAM_TYPE_MISMATCH'))).toEqual([]);
  });

  it('a named scalar holding another primitive is the mismatch', () => {
    const ref = { id: 'parcel_ref', name: 'ParcelRef', kind: 'value-object', holds: 'int' };
    const found = paramFindings(typedAs(dispatchTree(ts(TS_BODY('parcelId: string')), false), 'parcel_ref', [ref]));
    expect(found.map(f => f.split(':')[0])).toEqual(['PARAM_TYPE_MISMATCH']);
  });

  it('a Python date never stands for a datetime, as a parameter or a return', () => {
    const param = paramFindings(typedAs(dispatchTree(py(PY_BODY('parcel_id: date'), [], ['from datetime import date']), true), 'datetime'));
    expect(param.map(f => f.split(':')[0])).toEqual(['PARAM_TYPE_MISMATCH']);
    const tree = dispatchTree(py([
      'async def dispatch_parcel(self, parcel_id: str) -> date:',
      '    self._store.record(parcel_id, "route-" + parcel_id)',
      '    return date.today()',
    ], [], ['from datetime import date']), true);
    const method = (tree.interfaces!.find(i => i.id === 'idispatch_orchestrator')!.methods as Array<Record<string, unknown>>)[0];
    method.returns = 'async datetime';
    method.signature = 'dispatch_parcel(parcel_id: string): async datetime';
    const run = runRuleFixture(defineRuleFixture({ code: 'RETURN_TYPE_MISMATCH', expectFire: true, reason: 'a date has no time of day', scenario: 'A parcel dispatch system whose booking answers when it was booked.', tree }));
    expect(run.matching).toHaveLength(1);
  });
});

