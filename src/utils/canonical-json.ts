// ---------------------------------------------------------------------------
// Canonical JSON
//
// The one deterministic serialization every identity digest is taken over:
// object keys sorted recursively, so key or formatting order never moves a
// digest, and the volatile createdAt/updatedAt metadata stripped, so a re-save
// that only bumps a timestamp never shifts an identity. The content identity
// and the snapshot input keys (sdd_core) and the gate identity (sdd_validator)
// all digest this form; it lives here because the validator must not import
// core to reach it.
// ---------------------------------------------------------------------------

/** Stable serialization: object keys sorted recursively, volatile timestamps stripped. */
export function canonicalize(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') {
    const src = v as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(src).sort()) {
      if (k === 'createdAt' || k === 'updatedAt') continue; // volatile metadata
      out[k] = sortKeys(src[k]);
    }
    return out;
  }
  return v;
}
