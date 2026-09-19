import * as crypto from 'crypto';
import {
  loadSystemSpec,
  loadSubsystemSpecs,
  loadComponentSpecs,
  loadInterfaceSpecs,
  loadImplementationSpecs,
  loadTypeSpecs,
} from './specs.js';
import { canonicalize, compareOrdinal } from '../utils/canonical-json.js';

// ---------------------------------------------------------------------------
// State Hash (sdd_core)
//
// Computes the deterministic content identity (StateId) of the current
// project's spec tree. Two trees with identical spec CONTENT produce the same
// StateId ON EVERY MACHINE; any edit changes it. Volatile metadata
// (createdAt/updatedAt) is excluded so a no-op re-save that only bumps a
// timestamp does not shift the identity, and the specs are put in id order
// before they are digested so the filesystem's directory order stays out of it.
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

/**
 * Put one kind of spec into the order the identity is taken in: by id, then by
 * canonical content, compared ordinally.
 *
 * The loaders hand back whatever order the filesystem walked the spec files in,
 * and `canonicalize` sorts object KEYS but never arrays — deliberately, because
 * a narrative's steps and a method's params are ordered by meaning and sorting
 * them would make a real design change invisible to the digest. Directory order
 * is not meaning: NTFS returns names sorted, ext4 returns them in hash order, so
 * the same tree digested on Windows and on Linux produced two different
 * identities and a lock taken on one machine read stale on the other. Ordering
 * here is what makes the identity a property of the SPECS rather than of the
 * filesystem that happened to hold them.
 *
 * The content tie-break matters only when two specs share an id — itself an
 * error the validator reports — and it costs a per-spec canonicalize (about 8ms
 * over 900 specs, against 130ms to load them). Without it, `sort` is stable and
 * duplicates would silently keep their directory order, putting the platform
 * back into the digest at exactly the moment the tree is malformed.
 */
function inIdentityOrder<T extends { id: string }>(specs: T[]): T[] {
  return specs
    .map((spec) => ({ spec, content: canonicalize(spec) }))
    .sort((a, b) => compareOrdinal(a.spec.id, b.spec.id) || compareOrdinal(a.content, b.content))
    .map((entry) => entry.spec);
}

/** Deterministic CONTENT StateId over the current (request-scoped) project's spec tree. */
export function computeStateId(): StateId {
  const tree = {
    system: loadSystemSpec(),
    subsystems: inIdentityOrder(loadSubsystemSpecs()),
    components: inIdentityOrder(loadComponentSpecs()),
    interfaces: inIdentityOrder(loadInterfaceSpecs()),
    implementations: inIdentityOrder(loadImplementationSpecs()),
    types: inIdentityOrder(loadTypeSpecs()),
  };
  const digest = crypto.createHash('sha256').update(canonicalize(tree)).digest('hex');
  return { algorithm: CONTENT_ALGORITHM, digest };
}

/** True when two StateIds are the same identity: same algorithm, same digest. */
export function stateIdEquals(a: StateId | null | undefined, b: StateId | null | undefined): boolean {
  return !!a && !!b && a.algorithm === b.algorithm && a.digest === b.digest;
}
