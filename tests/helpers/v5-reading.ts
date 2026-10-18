import { it } from 'vitest';
import { runInV5Reading } from '../../src/utils/fs.js';

// ---------------------------------------------------------------------------
// The v5 reading, for the tests that exercise what `wairon upgrade` does with
// the forms wairon 5 wrote.
//
// The core reads only the running major's forms; the v5 forms are read under
// one binding, runInV5Reading, which the upgrade orchestrator binds around its
// rehearsal. A test of the upgrade's machinery (the Specialist retirement, the
// reachability migration, the chaining migration, the reference rewrite, the
// lock re-expression, ...) runs its body inside that binding exactly as the
// orchestrator would; a test that a v6 tree behaves, or that a v5 form is
// refused, stays outside it.
// ---------------------------------------------------------------------------

/** Run a body in the v5 reading (a synchronous body stays synchronous, an async one is awaited inside it). */
export const inV5Reading = <T>(fn: () => T): T => runInV5Reading(fn);

type Body = (...args: any[]) => unknown;

/** Wrap a test body so it runs in the v5 reading. */
const wrapped = (fn: Body): Body => function (this: unknown, ...args: any[]) { return runInV5Reading(() => fn.apply(this, args)); };

/** `it`, with the test body run in the v5 reading: `(name, fn, timeout?)` or `(name, options, fn)`. */
export function v5it(name: string, fn: Body | object, timeoutOrBody?: number | Body): void {
  if (typeof fn === 'function') it(name, wrapped(fn as Body) as never, timeoutOrBody as number | undefined);
  else it(name, fn as never, wrapped(timeoutOrBody as Body) as never);
}

/** `it.skip`, in the v5 reading. */
v5it.skip = (name: string, fn: Body | object, timeoutOrBody?: number | Body): void => {
  if (typeof fn === 'function') it.skip(name, wrapped(fn as Body) as never, timeoutOrBody as number | undefined);
  else it.skip(name, fn as never, wrapped(timeoutOrBody as Body) as never);
};

/** `it.each` over a table, each body run in the v5 reading. */
v5it.each = <T>(table: readonly T[]) => (name: string, fn: (row: T) => unknown, timeout?: number): void => {
  it.each(table as T[])(name, wrapped(fn as Body) as never, timeout);
};
