import * as crypto from 'crypto';
import {
  loadSystemSpec,
  loadSubsystemSpecs,
  loadComponentSpecs,
  loadInterfaceSpecs,
  loadImplementationSpecs,
  loadTypeSpecs,
  graph,
  scanAllSpecs,
} from './specs.js';
import * as path from 'path';
import { getProjectRoot } from '../utils/fs.js';
import {
  componentDesignView, implementationDesignView, interfaceDesignView, subsystemDesignView, typeDesignView,
  type ImplementationSpec, type SpecStatus,
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
// stamps) and the bound project's OWN specs alone (computeOwnStateId — the
// content half of the gate identity a lock records). The gate identity itself
// is the validator's to compute (src/core/rules/gate-identity.ts), since the
// doctrine it covers is the validator's rule set.
// ---------------------------------------------------------------------------

export interface StateId {
  algorithm: string;
  digest: string;
  /**
   * On a gate identity only: the same gate identity computed under the
   * algorithm the bound project's lock record was taken with, when that is an
   * earlier algorithm this release can still recompute (the full-content
   * format-2 one, or the earlier design reading that still carried status). Present only while the record on disk carries it, so such a
   * lock is judged exactly as it was taken. Never recorded: a lock writes
   * algorithm and digest alone.
   */
  asRecorded?: StateId;
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

/**
 * The marker of the EARLIER design reading, whose view still carried each
 * spec's status: what every format-3 lock written before readiness left the
 * approval was taken under. Recomputed, never written (ownDesignAsRecorded).
 */
export const EARLIER_DESIGN_ALGORITHM = 'sha256-design';

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
 * stamps; never the gate identity since stage 5.
 */
export function computeStateId(): StateId {
  return digestTree(() => true);
}

/**
 * state_hash.ownTree — the content identity of the bound project's OWN specs:
 * the specs the scan keys under the bound root (owner key empty), never a
 * member's. A member's specs reach the gate identity only as the member's
 * composition subject; hashing them here too would re-couple a parent's
 * approval to every member edit. Same ordering, canonical form and algorithm
 * marker as computeStateId, so for a project with no members the two agree.
 */
export function computeOwnStateId(): StateId {
  const family = graph();
  const owners = family.owners;
  // Stage 8: a part's specs are the project's own, digested as stored in the
  // part — its implementations' file paths from the part's root — so moving
  // the part's storage leaves the identity unchanged (storage-is-orthogonal).
  const parts = family.nodes.find((n) => n.namespace === '')?.parts ?? [];
  const files = scanAllSpecs().paths.implementation;
  const root = getProjectRoot();
  const asStored = (impl: ImplementationSpec): ImplementationSpec => {
    const file = files[impl.id];
    const part = file === undefined ? undefined : parts.find((p) => p.directory !== undefined && isInside(p.directory, file));
    return part?.directory !== undefined ? fromPartRoot(impl, root, part.directory) : impl;
  };
  return digestTree((id) => (owners.get(id) ?? '') === '', { implementation: asStored });
}

/**
 * state_hash.ownDesign — the DESIGN identity of the bound project's own specs:
 * exactly ownTree's selection, storage-independence and ordering, but each
 * spec digested in its design view — an implementation, a type, a component,
 * a subsystem and a contract through their type's designView (code linkage,
 * readiness and timestamps out), every other kind with its timestamps out
 * (canonicalize drops them). A part's implementation needs no re-expression
 * from the part's root: the paths are linkage, and the view leaves them out.
 * Algorithm marker `sha256-design-2`, so it never compares equal to a content
 * identity or to the earlier design reading. The content half of the gate
 * identity from lock format 3 on.
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

/** The key a spec's approved status is recorded under: `<kind>:<id>`. */
function approvedStatusKey(kind: string, id: string): string {
  return `${kind}:${id}`;
}

/**
 * state_hash.ownDesignAsRecorded — the own design identity in the EARLIER
 * reading (`sha256-design`), whose view still carried each spec's status: the
 * design view as ownDesign takes it with the status put back — the one
 * approvedStatus names for `<kind>:<id>` (the status the approval recorded),
 * else the status the spec has now. So a lock taken in that reading is
 * recomputed exactly as it was taken, and a tree in which nothing but a status
 * moved still matches it.
 */
export function computeOwnDesignStateIdAsRecorded(approvedStatus: ReadonlyMap<string, SpecStatus>): StateId {
  const withStatus = (kind: string, view: <T extends object>(spec: T) => T) => <T extends object>(spec: T): T => {
    const status = (spec as { status?: unknown }).status;
    if (status === undefined) return view(spec);
    const id = (spec as { id?: unknown }).id;
    const approved = typeof id === 'string' ? approvedStatus.get(approvedStatusKey(kind, id)) : undefined;
    return { ...view(spec), status: approved ?? status } as T;
  };
  return digestTree(ownedByRoot(), {
    implementation: withStatus('implementation', implementationDesignView) as (impl: ImplementationSpec) => ImplementationSpec,
    component: withStatus('component', componentDesignView),
    type: withStatus('type', typeDesignView),
    subsystem: withStatus('subsystem', subsystemDesignView),
    interface: withStatus('interface', interfaceDesignView),
    algorithm: EARLIER_DESIGN_ALGORITHM,
  });
}

/** Whether a file lies inside a directory. */
function isInside(dir: string, file: string): boolean {
  const rel = path.relative(dir, file);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** An implementation's file paths re-expressed from the project root to its part's root, as the part's file stores them. */
function fromPartRoot(impl: ImplementationSpec, root: string, partDir: string): ImplementationSpec {
  const from = (p: string): string => (path.isAbsolute(p) ? p : path.relative(partDir, path.resolve(root, p)).split(path.sep).join('/'));
  return {
    ...impl,
    ...(impl.sourcePath ? { sourcePath: from(impl.sourcePath) } : {}),
    ...(impl.simPath ? { simPath: from(impl.simPath) } : {}),
    methods: impl.methods.map((m) => (m.sourcePath ? { ...m, sourcePath: from(m.sourcePath) } : m)),
  };
}

/** True when two StateIds are the same identity: same algorithm, same digest. */
export function stateIdEquals(a: StateId | null | undefined, b: StateId | null | undefined): boolean {
  return !!a && !!b && a.algorithm === b.algorithm && a.digest === b.digest;
}
