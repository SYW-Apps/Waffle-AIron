import * as crypto from 'crypto';
import {
  loadSystemSpec,
  loadSubsystemSpecs,
  loadComponentSpecs,
  loadInterfaceSpecs,
  loadImplementationSpecs,
  loadTypeSpecs,
} from './specs.js';

// ---------------------------------------------------------------------------
// State Hash Specialist (sdd_host / sdd_core)
//
// Computes the deterministic content identity (StateId) of the current
// project's spec tree. Two trees with identical spec CONTENT produce the same
// StateId; any edit changes it. This backs the commit-scoped lock record and
// the promote-time re-check: a lock is scoped to the StateId it validated, and
// promotion recomputes it, so any change after locking auto-invalidates the
// lock. Volatile metadata (createdAt/updatedAt) is excluded so a no-op re-save
// that only bumps a timestamp does not shift the identity.
// ---------------------------------------------------------------------------

export interface StateId {
  algorithm: string;
  digest: string;
}

/** Deterministic StateId over the current (request-scoped) project's spec tree. */
export function computeStateId(): StateId {
  const tree = {
    system: loadSystemSpec(),
    subsystems: loadSubsystemSpecs(),
    components: loadComponentSpecs(),
    interfaces: loadInterfaceSpecs(),
    implementations: loadImplementationSpecs(),
    types: loadTypeSpecs(),
  };
  const digest = crypto.createHash('sha256').update(canonicalize(tree)).digest('hex');
  return { algorithm: 'sha256', digest };
}

/** True when two StateIds identify the same spec-tree content. */
export function stateIdEquals(a: StateId | null | undefined, b: StateId | null | undefined): boolean {
  return !!a && !!b && a.algorithm === b.algorithm && a.digest === b.digest;
}

/** Stable serialization: object keys sorted recursively (so key/formatting
 *  order never changes the digest), with volatile timestamps stripped. */
function canonicalize(value: unknown): string {
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
