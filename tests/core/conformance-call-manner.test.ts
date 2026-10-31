/**
 * call-manner-conformance: how a realized call runs (waited for, detached,
 * caught) against what the narrative says, for TypeScript and Python code —
 * each code and the controls that keep it quiet.
 */
import { describe, expect, it } from 'vitest';
import { defineRuleFixture, runRuleFixture, type FixtureTree } from '../rules-matrix/harness.js';
import {
  localStep, mannerTree, pyBody, recordStep, returnStep, tsBody, TRY_STEPS, TS_PERSIST_HELPER,
  type MannerStep, type MannerTreeOptions,
} from '../rules-matrix/families/conformance-call-manner.fixtures.js';

const MANNER = ['DETACHED_CALL_AWAITED', 'CALL_NOT_CAUGHT', 'CALL_NOT_AWAITED', 'OPEN_CALL_NOT_AWAITED', 'CALL_MANNER_UNJUDGED'];

function found(tree: FixtureTree): string[] {
  const run = runRuleFixture(defineRuleFixture({ code: 'CALL_NOT_AWAITED', expectFire: false, reason: 'probe', scenario: 'A service whose calls the gate reads.', tree }));
  return run.issues.filter(i => MANNER.includes(i.code)).map(i => i.code);
}

const DETACH: MannerStep[] = [recordStep(1, { detach: true }), returnStep(2)];
const PLAIN: MannerStep[] = [recordStep(1), returnStep(2)];

const ts = (opts: Omit<MannerTreeOptions, 'members'> & { body: string[] }) => found(mannerTree(false, { ...opts, members: opts.body }));
const py = (opts: Omit<MannerTreeOptions, 'members'> & { body: string[] }) => found(mannerTree(true, { ...opts, members: opts.body }));

describe('TypeScript: a detach step', () => {
  it('fires when the call is awaited', () => {
    expect(ts({ body: tsBody('await this.store.record(parcelId, routeId);'), steps: DETACH, stated: true })).toEqual(['DETACHED_CALL_AWAITED']);
  });
  it('is quiet for `void p`', () => {
    expect(ts({ body: tsBody('void this.store.record(parcelId, routeId);'), steps: DETACH, stated: true })).toEqual([]);
  });
  it('is quiet when the call is handed a .catch and not awaited', () => {
    expect(ts({ body: tsBody('this.store.record(parcelId, routeId).catch(() => undefined);'), steps: DETACH, stated: true })).toEqual([]);
  });
  it('fires when the call is the element of an awaited Promise.all', () => {
    expect(ts({ body: tsBody('await Promise.all([this.store.record(parcelId, routeId)]);'), steps: DETACH, stated: true })).toEqual(['DETACHED_CALL_AWAITED']);
  });
  it('fires when the call is returned directly', () => {
    const body = [
      'async dispatchParcel(parcelId: string): Promise<string> {',
      '  return this.store.record(parcelId, `route-${parcelId}`).then(() => parcelId);',
      '}',
    ];
    // Returned through a .then chain: waited for, since the function finishes only with it.
    expect(ts({ body, steps: [recordStep(1, { detach: true }), returnStep(2)], stated: true })).toEqual(['DETACHED_CALL_AWAITED']);
  });
  it('is quiet when one writing is awaited and another is not (only what every writing agrees on)', () => {
    expect(ts({
      body: tsBody('await this.store.record(parcelId, routeId);', 'void this.store.record(parcelId, routeId);'),
      steps: DETACH, stated: true,
    })).toEqual([]);
  });
  it('says CALL_MANNER_UNJUDGED, not a pass, when the call is made in a helper the method calls', () => {
    const body = tsBody('await this.persist(parcelId, routeId);');
    const after = [''];
    const tree = mannerTree(false, { members: [...body, '', 'async persist(parcelId: string, routeId: string): Promise<void> {', '  await this.store.record(parcelId, routeId);', '}'], steps: DETACH, stated: true, after });
    expect(found(tree)).toEqual(['CALL_MANNER_UNJUDGED']);
  });
  it('names the step, the target, the manner and the helper in the notice', () => {
    const tree = mannerTree(false, { members: [...tsBody('await this.persist(parcelId, routeId);'), '', ...TS_PERSIST_HELPER], steps: DETACH, stated: true });
    const run = runRuleFixture(defineRuleFixture({ code: 'CALL_NOT_AWAITED', expectFire: false, reason: 'probe', scenario: 'A service whose calls the gate reads.', tree }));
    const notice = run.issues.find(i => i.code === 'CALL_MANNER_UNJUDGED');
    expect(notice?.severity).toBe('notice');
    expect(notice?.message).toMatch(/step 1 → tracking-store\.record/);
    expect(notice?.message).toMatch(/detach/);
    expect(notice?.message).toMatch(/helper/);
  });
  it('says CALL_MANNER_UNJUDGED for a catching try step whose call is made in a helper', () => {
    const tree = mannerTree(false, { members: [...tsBody('await this.persist(parcelId, routeId);'), '', ...TS_PERSIST_HELPER], steps: TRY_STEPS, stated: true });
    expect(found(tree)).toEqual(['CALL_MANNER_UNJUDGED']);
  });
  it('says nothing for a helper call under a step that states no manner', () => {
    const tree = mannerTree(false, { members: [...tsBody('await this.persist(parcelId, routeId);'), '', ...TS_PERSIST_HELPER], steps: PLAIN, stated: true });
    expect(found(tree)).toEqual([]);
  });
  it('says nothing for a detach step whose code makes no call at all (call-conformance reports that)', () => {
    expect(ts({ body: tsBody('routeId.trim();'), steps: DETACH, stated: true })).toEqual([]);
  });
  it('says CALL_MANNER_UNJUDGED for a detach step whose target plans no code yet', () => {
    const tree = mannerTree(false, { members: tsBody('void this.store.record(parcelId, routeId);'), steps: DETACH, stated: true });
    delete tree.files!['src/dispatch/tracking-store.ts'];
    expect(found(tree)).toEqual(['CALL_MANNER_UNJUDGED']);
  });
  it('says nothing for a step that states no manner whose target plans no code yet', () => {
    const tree = mannerTree(false, { members: tsBody('void this.store.record(parcelId, routeId);'), steps: PLAIN, stated: true });
    delete tree.files!['src/dispatch/tracking-store.ts'];
    expect(found(tree)).toEqual([]);
  });
});

describe('TypeScript: a step in a catching try', () => {
  it('fires when nothing catches the call', () => {
    expect(ts({ body: tsBody('await this.store.record(parcelId, routeId);'), steps: TRY_STEPS, stated: true })).toEqual(['CALL_NOT_CAUGHT']);
  });
  it('is quiet when a try/catch encloses it', () => {
    expect(ts({ body: tsBody('try {', '  await this.store.record(parcelId, routeId);', '} catch {', '  // go on', '}'), steps: TRY_STEPS, stated: true })).toEqual([]);
  });
  it('is quiet when a .catch is chained on', () => {
    expect(ts({ body: tsBody('await this.store.record(parcelId, routeId).catch(() => undefined);'), steps: TRY_STEPS, stated: true })).toEqual([]);
  });
  it('fires for a try with only a finally', () => {
    expect(ts({ body: tsBody('try {', '  await this.store.record(parcelId, routeId);', '} finally {', '  routeId.trim();', '}'), steps: TRY_STEPS, stated: true })).toEqual(['CALL_NOT_CAUGHT']);
  });
  it('fires for a call written in the catch block', () => {
    expect(ts({
      body: tsBody('try {', '  routeId.trim();', '} catch {', '  await this.store.record(parcelId, routeId);', '}'),
      steps: TRY_STEPS, stated: true,
    })).toEqual(['CALL_NOT_CAUGHT']);
  });
  it('is quiet for a step in a try that names no catch', () => {
    const finallyOnly: MannerStep[] = [
      { stepNumber: 1, type: 'try', description: 'Record, always releasing.', endStep: 3, finallyStep: 3 },
      recordStep(2),
      localStep(3, 'Release the lock.'),
      returnStep(4),
    ];
    expect(ts({ body: tsBody('await this.store.record(parcelId, routeId);'), steps: finallyOnly, stated: true })).toEqual([]);
  });
});

describe('TypeScript: a step not marked detach', () => {
  it('fires CALL_NOT_AWAITED where the target is async, the call is never waited for and the detail is stated', () => {
    expect(ts({ body: tsBody('this.store.record(parcelId, routeId);'), steps: PLAIN, stated: true })).toEqual(['CALL_NOT_AWAITED']);
  });
  it('says the notice OPEN_CALL_NOT_AWAITED where the detail is open', () => {
    expect(ts({ body: tsBody('this.store.record(parcelId, routeId);'), steps: PLAIN })).toEqual(['OPEN_CALL_NOT_AWAITED']);
  });
  it('is quiet when the target completes now', () => {
    expect(ts({ body: tsBody('this.store.record(parcelId, routeId);'), steps: PLAIN, stated: true, asyncStore: false })).toEqual([]);
  });
  it('is quiet when the call is awaited through a cast and a non-null assertion', () => {
    expect(ts({ body: tsBody('await (this.store!.record(parcelId, routeId) as Promise<void>);'), steps: PLAIN, stated: true })).toEqual([]);
  });
  it('is quiet when the call is an element of an awaited Promise.allSettled', () => {
    expect(ts({ body: tsBody('await Promise.allSettled([this.store.record(parcelId, routeId)]);'), steps: PLAIN, stated: true })).toEqual([]);
  });
  it('is quiet when the call is returned directly', () => {
    const body = [
      'dispatchParcel(parcelId: string): Promise<void> {',
      '  return this.store.record(parcelId, `route-${parcelId}`);',
      '}',
    ];
    expect(ts({ body, steps: [recordStep(1), returnStep(2)], stated: true })).toEqual([]);
  });
  it('is quiet when a writing of the shape is awaited', () => {
    expect(ts({
      body: tsBody('this.store.record(parcelId, routeId);', 'await this.store.record(parcelId, routeId);'),
      steps: PLAIN, stated: true,
    })).toEqual([]);
  });
});

describe('Python', () => {
  it('says CALL_MANNER_UNJUDGED when the detach call is made in a helper the method calls', () => {
    const body = [
      ...pyBody('await self._persist(parcel_id, route_id)'),
      '',
      'async def _persist(self, parcel_id: str, route_id: str) -> None:',
      '    await self._store.record(parcel_id, route_id)',
    ];
    expect(py({ body, steps: DETACH, stated: true })).toEqual(['CALL_MANNER_UNJUDGED']);
  });
  it('fires DETACHED_CALL_AWAITED for an awaited detach step', () => {
    expect(py({ body: pyBody('await self._store.record(parcel_id, route_id)'), steps: DETACH, stated: true })).toEqual(['DETACHED_CALL_AWAITED']);
  });
  it('is quiet for asyncio.create_task on a detach step, and a create_task call is not an await', () => {
    expect(py({ body: pyBody('asyncio.create_task(self._store.record(parcel_id, route_id))'), steps: DETACH, stated: true })).toEqual([]);
  });
  it('fires DETACHED_CALL_AWAITED when the call is an element of an awaited asyncio.gather', () => {
    expect(py({ body: pyBody('await asyncio.gather(self._store.record(parcel_id, route_id))'), steps: DETACH, stated: true })).toEqual(['DETACHED_CALL_AWAITED']);
  });
  it('fires CALL_NOT_AWAITED for a coroutine returned without await', () => {
    const body = [
      'def dispatch_parcel(self, parcel_id: str):',
      '    return self._store.record(parcel_id, "route-" + parcel_id)',
    ];
    expect(py({ body, steps: [recordStep(1), returnStep(2)], stated: true })).toEqual(['CALL_NOT_AWAITED']);
  });
  it('is quiet for an awaited call', () => {
    expect(py({ body: pyBody('await self._store.record(parcel_id, route_id)'), steps: PLAIN, stated: true })).toEqual([]);
  });
  it('fires CALL_NOT_CAUGHT when no try/except encloses the call', () => {
    expect(py({ body: pyBody('await self._store.record(parcel_id, route_id)'), steps: TRY_STEPS, stated: true })).toEqual(['CALL_NOT_CAUGHT']);
  });
  it('is quiet when a try with an except encloses the call', () => {
    expect(py({
      body: pyBody('try:', '    await self._store.record(parcel_id, route_id)', 'except Exception:', '    pass'),
      steps: TRY_STEPS, stated: true,
    })).toEqual([]);
  });
  it('fires CALL_NOT_CAUGHT for a try with only a finally', () => {
    expect(py({
      body: pyBody('try:', '    await self._store.record(parcel_id, route_id)', 'finally:', '    route_id.strip()'),
      steps: TRY_STEPS, stated: true,
    })).toEqual(['CALL_NOT_CAUGHT']);
  });
  it('fires CALL_NOT_CAUGHT for a call written in the except block', () => {
    expect(py({
      body: pyBody('try:', '    route_id.strip()', 'except Exception:', '    await self._store.record(parcel_id, route_id)'),
      steps: TRY_STEPS, stated: true,
    })).toEqual(['CALL_NOT_CAUGHT']);
  });
  it('says OPEN_CALL_NOT_AWAITED for an unawaited async target at open detail', () => {
    expect(py({ body: pyBody('self._store.record(parcel_id, route_id)'), steps: PLAIN })).toEqual(['OPEN_CALL_NOT_AWAITED']);
  });
});
