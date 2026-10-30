/**
 * How a realized call runs, beside the narrative that says it —
 * src/core/rules/conformance/call-manner-conformance.ts.
 *
 * Documented intent pinned here (rule description):
 *  - DETACHED_CALL_AWAITED (warning): a call step marked detach (fire-and-forget)
 *    whose call every writing in the method's own function waits for.
 *  - CALL_NOT_CAUGHT (warning): a call step inside the body of a try step that
 *    catches, whose call no writing catches (no try/catch around it, no
 *    rejection handler chained on it).
 *  - CALL_NOT_AWAITED (warning): a call step not marked detach, in a method that
 *    states its detail, whose target completes later and whose call no writing
 *    waits for.
 *  - OPEN_CALL_NOT_AWAITED (notice): the same where the method leaves its detail
 *    open, so the design does not say whether it waits.
 *
 * Each control is the same tree with the defect corrected.
 */
import { defineRuleFixture, type FixtureTree } from '../harness.js';
import { dispatchTree, ts, py } from './conformance-surface-gaps.fixtures.js';

const TS_ASYNC_STORE = [
  'export class TrackingStore {',
  '  private readonly entries = new Map<string, string>();',
  '',
  '  async record(parcelId: string, routeId: string): Promise<void> {',
  '    this.entries.set(parcelId, routeId);',
  '  }',
  '',
  '  lookup(parcelId: string): string {',
  '    return this.entries.get(parcelId) ?? \'\';',
  '  }',
  '}',
  '',
].join('\n');

const PY_ASYNC_STORE = [
  'class TrackingStore:',
  '    def __init__(self) -> None:',
  '        self._entries: dict[str, str] = {}',
  '',
  '    async def record(self, parcel_id: str, route_id: str) -> None:',
  '        self._entries[parcel_id] = route_id',
  '',
  '    def lookup(self, parcel_id: str) -> str:',
  '        return self._entries.get(parcel_id, "")',
  '',
].join('\n');

/** A narrative step of the dispatch verb, as the spec writes it. */
export type MannerStep = Record<string, unknown>;

export const recordStep = (stepNumber: number, extra: Record<string, unknown> = {}): MannerStep => ({
  stepNumber, type: 'call', targetComponent: 'tracking-store', targetMethod: 'record',
  description: 'Record the booking in the tracking store.', ...extra,
});

export const localStep = (stepNumber: number, description: string): MannerStep => ({ stepNumber, type: 'local', description });

export const returnStep = (stepNumber: number): MannerStep => ({ stepNumber, type: 'return', outcome: 'success', description: 'Answer the route id.' });

/** The same call, narrated in a try step that catches (the call is step 2, the handler step 3). */
export const TRY_STEPS: MannerStep[] = [
  { stepNumber: 1, type: 'try', description: 'Try to record the booking.', endStep: 3, catches: [{ error: 'any', step: 3 }] },
  recordStep(2),
  localStep(3, 'Log the failed booking and go on.'),
  returnStep(4),
];

export interface MannerTreeOptions {
  /** The method lines inside the orchestrator class (TypeScript) or its body lines (Python). */
  members: string[];
  /** The narrative of the dispatch verb. */
  steps: MannerStep[];
  /** Whether the implementation states its detail (full). */
  stated?: boolean;
  /** Whether the tracking store's record completes later (async). Default true. */
  asyncStore?: boolean;
  /** Lines after the class. */
  after?: string[];
}

/** The dispatch tree with the orchestrator's code and narrative set for a manner scenario. */
export function mannerTree(python: boolean, opts: MannerTreeOptions): FixtureTree {
  const tree = dispatchTree(python ? py(opts.members, opts.after) : ts(opts.members, opts.after), python);
  const impl = tree.implementations!.find(i => i.id === 'dispatch_orchestrator_impl')!;
  (impl.methods as { narrative: MannerStep[] }[])[0].narrative = opts.steps;
  if (opts.stated) impl.detail = 'full';
  if (opts.asyncStore !== false) {
    const storeFile = python ? 'src/dispatch/tracking_store.py' : 'src/dispatch/tracking-store.ts';
    tree.files![storeFile] = python ? PY_ASYNC_STORE : TS_ASYNC_STORE;
  }
  return tree;
}

/** A TypeScript dispatch method whose recording line is the given one(s). */
export const tsBody = (...recording: string[]): string[] => [
  'async dispatchParcel(parcelId: string): Promise<string> {',
  '  const routeId = `route-${parcelId}`;',
  ...recording.map(l => `  ${l}`),
  '  return routeId;',
  '}',
];

/** A Python dispatch method whose recording line(s) are the given ones. */
export const pyBody = (...recording: string[]): string[] => [
  'async def dispatch_parcel(self, parcel_id: str) -> str:',
  '    route_id = "route-" + parcel_id',
  ...recording.map(l => `    ${l}`),
  '    return route_id',
];

const DETACH_STEPS = [recordStep(1, { detach: true }), returnStep(2)];
const PLAIN_STEPS = [recordStep(1), returnStep(2)];

export default [
  // -------------------------------------------------------------------------
  // DETACHED_CALL_AWAITED
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'DETACHED_CALL_AWAITED',
    severity: 'warning',
    anchoredTo: 'dispatch_orchestrator_impl',
    expectFire: true,
    scenario:
      'The dispatch narrative says the booking is recorded fire-and-forget (the step is marked detach), but the orchestrator awaits the tracking store before it answers the route.',
    tree: mannerTree(false, { members: tsBody('await this.store.record(parcelId, routeId);'), steps: DETACH_STEPS, stated: true }),
  }),
  defineRuleFixture({
    code: 'DETACHED_CALL_AWAITED',
    expectFire: false,
    reason: 'The orchestrator issues the record call without waiting for it, as the detach step says.',
    scenario:
      'The dispatch narrative says the booking is recorded fire-and-forget, and the orchestrator starts the recording and answers the route at once.',
    tree: mannerTree(false, { members: tsBody('void this.store.record(parcelId, routeId);'), steps: DETACH_STEPS, stated: true }),
  }),

  // -------------------------------------------------------------------------
  // CALL_NOT_CAUGHT
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'CALL_NOT_CAUGHT',
    severity: 'warning',
    anchoredTo: 'dispatch_orchestrator_impl',
    expectFire: true,
    scenario:
      'The dispatch narrative records the booking inside a try step that catches a failed booking and goes on, but the orchestrator awaits the store with nothing around it, so a failed booking escapes.',
    tree: mannerTree(false, { members: tsBody('await this.store.record(parcelId, routeId);'), steps: TRY_STEPS, stated: true }),
  }),
  defineRuleFixture({
    code: 'CALL_NOT_CAUGHT',
    expectFire: false,
    reason: 'The orchestrator wraps the awaited record call in a try/catch, as the narrative says.',
    scenario:
      'The dispatch narrative records the booking inside a try step that catches a failed booking, and the orchestrator awaits the store inside a try/catch that logs and goes on.',
    tree: mannerTree(false, {
      members: tsBody('try {', '  await this.store.record(parcelId, routeId);', '} catch {', '  // the booking failed: go on without it', '}'),
      steps: TRY_STEPS,
      stated: true,
    }),
  }),

  // -------------------------------------------------------------------------
  // CALL_NOT_AWAITED
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'CALL_NOT_AWAITED',
    severity: 'warning',
    anchoredTo: 'dispatch_orchestrator_impl',
    expectFire: true,
    scenario:
      'The dispatch narrative (stated in full) records the booking and then answers the route, and the tracking store records asynchronously, but the orchestrator never waits for the recording.',
    tree: mannerTree(false, { members: tsBody('this.store.record(parcelId, routeId);'), steps: PLAIN_STEPS, stated: true }),
  }),
  defineRuleFixture({
    code: 'CALL_NOT_AWAITED',
    expectFire: false,
    reason: 'The orchestrator awaits the asynchronous record call before it answers the route.',
    scenario:
      'The dispatch narrative (stated in full) records the booking and then answers the route, and the orchestrator awaits the asynchronous recording first.',
    tree: mannerTree(false, { members: tsBody('await this.store.record(parcelId, routeId);'), steps: PLAIN_STEPS, stated: true }),
  }),

  // -------------------------------------------------------------------------
  // OPEN_CALL_NOT_AWAITED
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'OPEN_CALL_NOT_AWAITED',
    severity: 'notice',
    anchoredTo: 'dispatch_orchestrator_impl',
    expectFire: true,
    scenario:
      'The dispatch narrative leaves its detail open, the tracking store records asynchronously, and the orchestrator never waits for the recording: the design does not say whether it waits, and the notice says the code does not.',
    tree: mannerTree(false, { members: tsBody('this.store.record(parcelId, routeId);'), steps: PLAIN_STEPS }),
  }),
  defineRuleFixture({
    code: 'OPEN_CALL_NOT_AWAITED',
    expectFire: false,
    reason: 'The orchestrator awaits the asynchronous record call, so there is nothing left open.',
    scenario:
      'The dispatch narrative leaves its detail open, and the orchestrator awaits the asynchronous recording before it answers the route.',
    tree: mannerTree(false, { members: tsBody('await this.store.record(parcelId, routeId);'), steps: PLAIN_STEPS }),
  }),
];
