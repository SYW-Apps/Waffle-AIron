import * as crypto from 'crypto';
import {
  loadSystemSpec,
  loadSubsystemSpecs,
  loadComponentSpecs,
  loadInterfaceSpecs,
  loadImplementationSpecs,
  loadTypeSpecs,
} from './specs.js';
import { canonicalize } from '../utils/canonical-json.js';

// ---------------------------------------------------------------------------
// State Hash (sdd_core)
//
// Computes the deterministic content identity (StateId) of the current
// project's spec tree. Two trees with identical spec CONTENT produce the same
// StateId; any edit changes it. Volatile metadata (createdAt/updatedAt) is
// excluded so a no-op re-save that only bumps a timestamp does not shift the
// identity.
//
// The gate identity a lock records digests this content identity together with
// the governing doctrine; it is the validator's to compute
// (src/core/rules/gate-identity.ts), since the doctrine it covers is the
// validator's rule set.
// ---------------------------------------------------------------------------

export interface StateId {
  algorithm: string;
  digest: string;
}

/** Algorithm marker for the CONTENT identity: the spec tree alone. */
const CONTENT_ALGORITHM = 'sha256';

/** Deterministic CONTENT StateId over the current (request-scoped) project's spec tree. */
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
  return { algorithm: CONTENT_ALGORITHM, digest };
}

/** True when two StateIds are the same identity: same algorithm, same digest. */
export function stateIdEquals(a: StateId | null | undefined, b: StateId | null | undefined): boolean {
  return !!a && !!b && a.algorithm === b.algorithm && a.digest === b.digest;
}
