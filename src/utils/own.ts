// ---------------------------------------------------------------------------
// Own-key lookups for records keyed by user ids.
//
// A spec id, an alias or a method name may be a name every plain object
// inherits (`constructor`, `toString`, `valueOf`, `hasOwnProperty`): a bare
// `record[id]` then answers the inherited function instead of "absent", and a
// write of `__proto__` replaces the prototype instead of adding a key. Every
// registry keyed by such a name reads through ownGet/ownHas and is built with
// dict(), whose objects have no prototype at all.
// ---------------------------------------------------------------------------

/** Whether `key` is an own property of `record` (never an inherited one). */
export function ownHas(record: object | null | undefined, key: string): boolean {
  return record != null && Object.hasOwn(record, key);
}

/** `record[key]` when it is an own property, else undefined. */
export function ownGet<T>(record: Readonly<Record<string, T>> | null | undefined, key: string): T | undefined {
  return record != null && Object.hasOwn(record, key) ? record[key] : undefined;
}

/** An empty record with no prototype, optionally filled from entries: no key is ever inherited. */
export function dict<T>(entries?: Iterable<readonly [string, T]>): Record<string, T> {
  const out = Object.create(null) as Record<string, T>;
  if (entries) for (const [k, v] of entries) out[k] = v;
  return out;
}
