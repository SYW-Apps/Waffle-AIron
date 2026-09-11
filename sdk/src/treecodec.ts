import { load as yamlLoad, dump as yamlDump } from 'js-yaml';
import { createHash } from 'crypto';
import type {
  ArchiveEntryMeta,
  PackExtractionLimits,
  PackExtractionPlan,
  PackFile,
  TreeArchiveManifest,
} from './types.js';

// ---------------------------------------------------------------------------
// Tree Codec (tree_codec_impl) — PURE format + safety logic for the `.waitree`
// spec-tree archive, no I/O and no clock.
//
// selectTreeFiles is the single portability decision (what belongs in a tree
// archive at all); planTreeExtraction is the single pre-decompress safety
// chokepoint; assertPortableTreePaths is the over-the-wire executable guard;
// sealTreeIntegrity/verifyTreeIntegrity are the produce/verify pair.
//
// The small pure path/digest helpers below deliberately mirror the pack codec's
// rather than importing them: tree_codec declares NO dependencies, and reaching
// into pack_codec for them would make one codec depend on the other for a
// handful of one-line functions.
// ---------------------------------------------------------------------------

/** The tree-archive envelope filename. */
export const TREE_ENVELOPE_FILENAME = 'wairon-tree.yaml';

/** The highest tree-archive format major this SDK understands. */
const SUPPORTED_FORMAT_VERSION = 1;

/**
 * The tree caps profile: looser than the pack profile on entry count and total
 * size (a real spec tree is thousands of small YAML files across several
 * chained roots) and stricter on nothing.
 */
const TREE_DEFAULTS = {
  maxEntries: 20000,
  maxTotalUncompressedBytes: 64 * 1024 * 1024,
  maxEntryBytes: 8 * 1024 * 1024,
  maxCompressionRatio: 100,
  maxDepth: 24,
} as const;

/** Root-relative directories holding REGENERABLE artifacts — never portable design state. */
const DERIVED_ROOTS = ['generated', 'docs'];

/** Executable extensions: a bundled code pack's entry can ride inside a tree. */
const EXECUTABLE_EXT_RE = /\.(c|m)?js$/i;

/** The directory every packed root's content lives under, inside the archive. */
const WAI_SEGMENT = '.wai';

/** Parse + validate the envelope text into a TreeArchiveManifest; throws on malformed/newer-major. */
export function parseTreeManifest(text: string): TreeArchiveManifest {
  // Step 1: parse the envelope YAML text (throws on malformed YAML).
  const raw = yamlLoad(text);
  // Step 2: validate the required fields are present and well-typed.
  const manifest = validateEnvelope(raw);
  // Step 3: is the format major newer than this wairon supports?
  if (Math.trunc(manifest.formatVersion) > SUPPORTED_FORMAT_VERSION) {
    // Step 4: fail loudly rather than silently mis-read a newer format.
    throw new Error('unsupported tree-archive formatVersion (newer than this wairon understands)');
  }
  // Step 5: return the parsed manifest.
  return manifest;
}

/** Serialize a manifest to canonical wairon-tree.yaml text (export path). */
export function serializeTreeManifest(manifest: TreeArchiveManifest): string {
  // Step 1: drop undefined optional fields for a clean, canonical envelope.
  const clean: Record<string, unknown> = {
    formatVersion: manifest.formatVersion,
    projectName: manifest.projectName,
    roots: manifest.roots,
  };
  if (manifest.stateId !== undefined) clean.stateId = manifest.stateId;
  if (manifest.waironVersion !== undefined) clean.waironVersion = manifest.waironVersion;
  if (manifest.minWaironVersion !== undefined) clean.minWaironVersion = manifest.minWaironVersion;
  if (manifest.includesDerived !== undefined) clean.includesDerived = manifest.includesDerived;
  if (manifest.digest !== undefined) clean.digest = manifest.digest;
  if (manifest.entryDigests !== undefined) clean.entryDigests = manifest.entryDigests;
  if (manifest.generatedBy !== undefined) clean.generatedBy = manifest.generatedBy;
  if (manifest.generatedAt !== undefined) clean.generatedAt = manifest.generatedAt;
  // Step 2: return the wairon-tree.yaml text.
  return yamlDump(clean, { sortKeys: false });
}

/** The tree extraction-safety profile; callers override individual caps. */
export function defaultTreeLimits(): PackExtractionLimits {
  // Step 1: return the tree caps profile.
  return { ...TREE_DEFAULTS };
}

/**
 * Decide which of a root's files are portable design state: keep authored spec
 * state, drop regenerable artifacts unless the caller asked for them. Paths are
 * relative to the root's `.wai/` directory.
 */
export function selectTreeFiles(files: PackFile[], includeDerived: boolean): PackFile[] {
  // Step 1: did the caller ask for regenerable artifacts too?
  if (includeDerived) {
    // Step 2: return the file map unchanged — an explicit full-fidelity archive.
    return files;
  }
  // Step 3: drop every file under a regenerable root — a moved tree carries the
  // design, not its rendered output, which the destination regenerates.
  const kept = files.filter((file) => !isDerivedPath(file.path));
  // Step 4: return the portable design state.
  return kept;
}

/** Compute the safe extraction plan from enumerated entries under `limits`, or throw. */
export function planTreeExtraction(entries: ArchiveEntryMeta[], limits: PackExtractionLimits): PackExtractionPlan {
  // Step 1: resolve effective caps — each field of `limits` over the tree defaults.
  const caps = {
    maxEntries: limits.maxEntries ?? TREE_DEFAULTS.maxEntries,
    maxTotalUncompressedBytes: limits.maxTotalUncompressedBytes ?? TREE_DEFAULTS.maxTotalUncompressedBytes,
    maxEntryBytes: limits.maxEntryBytes ?? TREE_DEFAULTS.maxEntryBytes,
    maxCompressionRatio: limits.maxCompressionRatio ?? TREE_DEFAULTS.maxCompressionRatio,
    maxDepth: limits.maxDepth ?? TREE_DEFAULTS.maxDepth,
  };
  // Step 2: initialize an empty approved-path list and a running total of 0.
  const approved: string[] = [];
  let total = 0;
  // Step 3: vet each enumerated entry.
  for (const entry of entries) {
    // Step 4: reject symlinks/non-regular entries and structurally unsafe paths.
    if (isSymlinkOrNonRegular(entry.kind) || isStructurallyUnsafePath(entry.path)) {
      rejectUnsafe();
    }
    // Directory entries are structural (writeTree recreates them from file
    // paths) — skip without approving, never inflate a 0-byte dir marker.
    if (entry.kind === 'dir') continue;
    // Step 5: normalize the entry path to a destination-relative POSIX path.
    const normalized = normalizeRelPath(entry.path);
    // Step 6: reject zip-slip and over-deep paths.
    if (escapesDestination(normalized) || pathDepth(normalized) > caps.maxDepth) {
      rejectUnsafe();
    }
    // Step 7: reject oversized entries and zip bombs.
    if (entry.uncompressedSize > caps.maxEntryBytes || compressionRatio(entry) > caps.maxCompressionRatio) {
      rejectUnsafe();
    }
    // Step 8 (vetEnd): accept — append the path and add its inflated size.
    approved.push(normalized);
    total += entry.uncompressedSize;
  }
  // Step 9: reject archives exceeding the aggregate caps.
  if (approved.length > caps.maxEntries || total > caps.maxTotalUncompressedBytes) {
    rejectUnsafe();
  }
  // Step 11: return the approved plan.
  return { paths: approved, totalUncompressedBytes: total };
}

/**
 * Assert the planned paths carry no executable content and nothing outside a
 * spec-tree root. Called by any surface accepting an archive over the wire; a
 * local extraction on the developer's own machine may skip it.
 */
export function assertPortableTreePaths(paths: string[]): void {
  // Step 1: check each planned path.
  for (const entryPath of paths) {
    // Step 2: is this an executable file (a bundled code pack's entry)?
    if (EXECUTABLE_EXT_RE.test(entryPath)) {
      // Step 6 (rejectExecutable): same guidance the pack surface gives.
      throw new Error(
        'refused: the archive carries executable content. Only declarative spec state transfers over this ' +
          'surface; rule/code packs are executable and install via the trusted filesystem (mount into ' +
          'WAIRON_PACKS_DIR, or run `wairon packs add`).',
      );
    }
    // Step 3: does the path sit outside any recognized spec-tree root?
    if (entryPath !== TREE_ENVELOPE_FILENAME && !isUnderWaiRoot(entryPath)) {
      // Step 7 (rejectForeign): a tree archive carries .wai trees, never arbitrary project files.
      throw new Error(`refused: the archive carries an entry outside any spec-tree root ("${entryPath}")`);
    }
    // Step 4 (checkEnd): this path is portable spec-tree content.
  }
  // Step 5: every path is portable.
}

/** Verify every entry's sha256 against entryDigests; false when none carried, throws on mismatch. */
export function verifyTreeIntegrity(manifest: TreeArchiveManifest, files: PackFile[]): boolean {
  // Step 1: did the envelope carry no integrity data?
  if (!manifest.entryDigests) {
    // Step 2: no integrity data present — return false.
    return false;
  }
  const digests = manifest.entryDigests;
  // Step 3: check each file's digest.
  for (const file of files) {
    // The envelope carries these digests and cannot digest itself — skip it.
    if (file.path === TREE_ENVELOPE_FILENAME) continue;
    // Step 4: does the recomputed sha256 differ from the recorded digest?
    if (sha256(file.contents) !== digests[file.path]) {
      // Step 7: a digest mismatch means tampering.
      throw new Error('tree integrity digest mismatch');
    }
    // Step 5 (checkEnd): this file's digest matches.
  }
  // Step 6: all digests matched — return true.
  return true;
}

/** Produce-side partner of verifyTreeIntegrity: fill entryDigests + digest + stamps. */
export function sealTreeIntegrity(
  manifest: TreeArchiveManifest,
  files: PackFile[],
  generatedBy: string,
  generatedAt: string,
): TreeArchiveManifest {
  // Step 1: initialize an empty entryDigests map.
  const entryDigests: Record<string, string> = {};
  // Step 2: hash each file.
  for (const file of files) {
    // The envelope is the carrier of these digests — never hash it into itself.
    if (file.path === TREE_ENVELOPE_FILENAME) continue;
    // Step 3 (hashEnd): compute sha256(file.contents) and record it under file.path.
    entryDigests[file.path] = sha256(file.contents);
  }
  // Step 4: compute an overall manifest digest over the sorted entryDigests.
  const digest = sha256(canonicalDigestBytes(entryDigests));
  // Step 5: set entryDigests, digest, generatedBy, generatedAt.
  // Step 6: return the sealed manifest.
  return { ...manifest, entryDigests, digest, generatedBy, generatedAt };
}

/** Whether the archive's formatVersion + minWaironVersion are compatible with `waironVersion`. */
export function checkTreeCompatibility(manifest: TreeArchiveManifest, waironVersion: string): boolean {
  // Step 1: is the archive format unsupported?
  if (Math.trunc(manifest.formatVersion) > SUPPORTED_FORMAT_VERSION) {
    // Step 4: incompatible.
    return false;
  }
  // Step 2: is the running wairon below the archive's minimum?
  if (manifest.minWaironVersion && isBelow(waironVersion, manifest.minWaironVersion)) {
    // Step 4: incompatible.
    return false;
  }
  // Step 3: compatible.
  return true;
}

// --- helpers ---------------------------------------------------------------

function rejectUnsafe(): never {
  throw new Error('reject: unsafe or oversized tree-archive entry (zip-slip / size / ratio / depth guard)');
}

function validateEnvelope(raw: unknown): TreeArchiveManifest {
  if (!raw || typeof raw !== 'object') {
    throw new Error('malformed tree envelope (not a YAML mapping)');
  }
  const o = raw as Record<string, unknown>;
  if (typeof o.formatVersion !== 'number') throw new Error('tree envelope: formatVersion must be a number');
  if (typeof o.projectName !== 'string' || !o.projectName) throw new Error('tree envelope: projectName is required');
  if (!Array.isArray(o.roots) || o.roots.length === 0 || o.roots.some((r) => typeof r !== 'string' || !r)) {
    throw new Error('tree envelope: roots must be a non-empty list of project-relative directories');
  }
  const manifest: TreeArchiveManifest = {
    formatVersion: o.formatVersion,
    projectName: o.projectName,
    roots: o.roots as string[],
  };
  if (typeof o.stateId === 'string') manifest.stateId = o.stateId;
  if (typeof o.waironVersion === 'string') manifest.waironVersion = o.waironVersion;
  if (typeof o.minWaironVersion === 'string') manifest.minWaironVersion = o.minWaironVersion;
  if (typeof o.includesDerived === 'boolean') manifest.includesDerived = o.includesDerived;
  if (typeof o.digest === 'string') manifest.digest = o.digest;
  if (o.entryDigests && typeof o.entryDigests === 'object') {
    manifest.entryDigests = o.entryDigests as Record<string, string>;
  }
  if (typeof o.generatedBy === 'string') manifest.generatedBy = o.generatedBy;
  if (typeof o.generatedAt === 'string') manifest.generatedAt = o.generatedAt;
  return manifest;
}

/** True for a path under a regenerable root, relative to a root's .wai/ directory. */
function isDerivedPath(relPath: string): boolean {
  const first = relPath.split('/')[0];
  return DERIVED_ROOTS.includes(first);
}

/** True when an archive path lives under some root's .wai/ directory. */
function isUnderWaiRoot(archivePath: string): boolean {
  const segments = archivePath.split('/');
  // The .wai segment must exist AND carry content beneath it — a bare '.wai'
  // entry names a directory, not spec-tree state.
  const at = segments.indexOf(WAI_SEGMENT);
  return at >= 0 && at < segments.length - 1;
}

function isSymlinkOrNonRegular(kind: string): boolean {
  return kind !== 'file' && kind !== 'dir';
}

function isStructurallyUnsafePath(p: string): boolean {
  if (p.includes('\\')) return true; // backslash
  if (/^[A-Za-z]:/.test(p)) return true; // drive letter
  if (p.startsWith('/')) return true; // absolute POSIX
  return p.split('/').some((seg) => seg === '..'); // parent traversal
}

function normalizeRelPath(p: string): string {
  return p
    .split('/')
    .filter((seg) => seg !== '' && seg !== '.')
    .join('/');
}

function escapesDestination(normalized: string): boolean {
  return normalized.startsWith('/') || normalized.split('/').some((seg) => seg === '..');
}

function pathDepth(normalized: string): number {
  return normalized.split('/').filter((seg) => seg !== '').length;
}

function compressionRatio(entry: ArchiveEntryMeta): number {
  if (entry.compressedSize > 0) return entry.uncompressedSize / entry.compressedSize;
  return entry.uncompressedSize > 0 ? Infinity : 0;
}

function canonicalDigestBytes(entryDigests: Record<string, string>): Uint8Array {
  const lines = Object.keys(entryDigests)
    .sort()
    .map((key) => `${key}:${entryDigests[key]}`)
    .join('\n');
  return new TextEncoder().encode(lines);
}

function sha256(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

function isBelow(running: string, minimum: string): boolean {
  const [rMaj, rMin, rPat] = parseSemverCore(running);
  const [mMaj, mMin, mPat] = parseSemverCore(minimum);
  if (rMaj !== mMaj) return rMaj < mMaj;
  if (rMin !== mMin) return rMin < mMin;
  return rPat < mPat;
}

function parseSemverCore(v: string): [number, number, number] {
  const cleaned = v.trim().replace(/^[^0-9]*/, ''); // strip leading ^, ~, >=, v, etc.
  const core = cleaned.split(/[-+]/)[0]; // drop prerelease/build metadata
  const parts = core.split('.').map((n) => parseInt(n, 10));
  return [parts[0] || 0, parts[1] || 0, parts[2] || 0];
}
