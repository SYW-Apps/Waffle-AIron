import * as crypto from 'crypto';
import {
  loadSystemSpec,
  loadSubsystemSpecs,
  loadComponentSpecs,
  loadInterfaceSpecs,
  loadImplementationSpecs,
  loadTypeSpecs,
  graph,
} from './specs.js';
import {
  componentDesignView, implementationDesignView, interfaceDesignView, subsystemDesignView, typeDesignView,
  type ImplementationSpec,
} from '../models/specs.js';
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
// Two readings: the whole scan (computeStateId — the snapshot and archive
// stamps) and the bound project's OWN design (computeOwnDesignStateId — the
// design half of the approval identity a lock records). The approval identity
// itself is the validator's to compute (src/core/rules/approval-identity.ts),
// since the policy it covers is the validator's to project.
// ---------------------------------------------------------------------------

export interface StateId {
  algorithm: string;
  digest: string;
  /**
   * On an approval identity only: the digest of each half it covers, taken on
   * its own (approval_identity.parts): design, rules, composition, network
   * (when declared) and selections. Never part of the digest; a lock records
   * them as `parts`, so a later check can say WHICH half moved.
   */
  parts?: Record<string, string>;
}

/** Algorithm marker for the CONTENT identity: the spec tree alone. */
export const CONTENT_ALGORITHM = 'sha256';

/**
 * Algorithm marker for the DESIGN identity: the own specs through their design
 * views, code linkage and readiness (status) out. Distinct from the content
 * marker and from the earlier design reading, so none of them can ever compare
 * equal.
 */
export const DESIGN_ALGORITHM = 'sha256-design-2';

/** How each kind of spec is read into a digest — as loaded, or through a projection. */
interface TreeReading {
  implementation?: (impl: ImplementationSpec) => ImplementationSpec;
  component?: <T extends object>(spec: T) => T;
  type?: <T extends object>(spec: T) => T;
  subsystem?: <T extends object>(spec: T) => T;
  interface?: <T extends object>(spec: T) => T;
  algorithm?: string;
}

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

/** The canonical digest of one tree reading, in identity order. */
function digestTree(keep: (id: string) => boolean, reading: TreeReading = {}): StateId {
  const kind = <T extends { id: string }>(specs: T[]): T[] => inIdentityOrder(specs.filter((s) => keep(s.id)));
  const same = <T>(spec: T): T => spec;
  const tree = {
    system: loadSystemSpec(),
    subsystems: kind(loadSubsystemSpecs().map(reading.subsystem ?? same)),
    components: kind(loadComponentSpecs().map(reading.component ?? same)),
    interfaces: kind(loadInterfaceSpecs().map(reading.interface ?? same)),
    implementations: kind(loadImplementationSpecs().map(reading.implementation ?? same)),
    types: kind(loadTypeSpecs().map(reading.type ?? same)),
  };
  const digest = crypto.createHash('sha256').update(canonicalize(tree)).digest('hex');
  return { algorithm: reading.algorithm ?? CONTENT_ALGORITHM, digest };
}

/** Whether a spec key belongs to the bound root (owner key empty): a member's specs are its own lock's. */
function ownedByRoot(): (id: string) => boolean {
  const owners = graph().owners;
  return (id) => (owners.get(id) ?? '') === '';
}

/**
 * Deterministic CONTENT StateId over the current (request-scoped) project's
 * spec tree, every member the scan follows included. The snapshot and archive
 * stamps; never the approval identity.
 */
export function computeStateId(): StateId {
  return digestTree(() => true);
}

/**
 * state_hash.ownDesign — the DESIGN identity of the bound project's own specs:
 * the specs the scan keys under the bound root (a part's included, a project
 * member's never), each digested in its design view — an implementation, a
 * type, a component, a subsystem and a contract through their type's
 * designView (code linkage, readiness and timestamps out), every other kind
 * with its timestamps out (canonicalize drops them) — in stable order and
 * canonical form. A part's implementation needs no re-expression from the
 * part's root: the paths are linkage, and the view leaves them out, so moving
 * a part leaves the identity unchanged. Algorithm marker `sha256-design-2`,
 * so it never compares equal to a content identity. The design half of the
 * approval identity.
 */
export function computeOwnDesignStateId(): StateId {
  return digestTree(ownedByRoot(), {
    implementation: implementationDesignView,
    component: componentDesignView,
    type: typeDesignView,
    subsystem: subsystemDesignView,
    interface: interfaceDesignView,
    algorithm: DESIGN_ALGORITHM,
  });
}

/** True when two StateIds are the same identity: same algorithm, same digest. */
export function stateIdEquals(a: StateId | null | undefined, b: StateId | null | undefined): boolean {
  return !!a && !!b && a.algorithm === b.algorithm && a.digest === b.digest;
}
