import { load as yamlLoad, dump as yamlDump } from 'js-yaml';
import { createHash } from 'crypto';
import type {
  ArchiveEntryMeta,
  PackArchiveManifest,
  PackExtractionLimits,
  PackExtractionPlan,
  PackFile,
} from './types.js';

// ---------------------------------------------------------------------------
// Pack Codec (pack_codec_impl) — PURE format + safety logic, no I/O.
//
// planExtraction is the single safety chokepoint (zip-slip / size / ratio /
// depth / symlink guards, all pre-decompress). sealIntegrity/verifyIntegrity
// are the produce/verify integrity pair. The codec stays pure: build time is
// passed in, never read here.
// ---------------------------------------------------------------------------

/** The archive-root envelope filename. */
export const ENVELOPE_FILENAME = 'wairon-pack.yaml';

/** The highest pack-archive format major this SDK understands. */
const SUPPORTED_FORMAT_VERSION = 1;

/** The default extraction-safety profile: 4096 / 32 MiB / 8 MiB / 100:1 / depth 16. */
const DEFAULTS = {
  maxEntries: 4096,
  maxTotalUncompressedBytes: 32 * 1024 * 1024,
  maxEntryBytes: 8 * 1024 * 1024,
  maxCompressionRatio: 100,
  maxDepth: 16,
} as const;

/** Parse + validate the envelope text into a PackArchiveManifest; throws on malformed/newer-major. */
export function parseManifest(text: string): PackArchiveManifest {
  // Step 1: parse the envelope YAML text (throws on malformed YAML).
  const raw = yamlLoad(text);
  // Step 2: validate the required fields are present and well-typed.
  const manifest = validateEnvelope(raw);
  // Step 3: is the format major newer than this wairon supports?
  if (Math.trunc(manifest.formatVersion) > SUPPORTED_FORMAT_VERSION) {
    // Step 4: fail loudly rather than silently mis-read a newer format.
    throw new Error('unsupported pack-archive formatVersion (newer than this wairon understands)');
  }
  // Step 5: return the parsed manifest.
  return manifest;
}

/** Serialize a manifest to canonical wairon-pack.yaml text (build path). */
export function serializeManifest(manifest: PackArchiveManifest): string {
  // Step 1: drop undefined optional fields for a clean, canonical envelope.
  const clean: Record<string, unknown> = {
    formatVersion: manifest.formatVersion,
    name: manifest.name,
    version: manifest.version,
    kind: manifest.kind,
    entry: manifest.entry,
  };
  if (manifest.minWaironVersion !== undefined) clean.minWaironVersion = manifest.minWaironVersion;
  if (manifest.digest !== undefined) clean.digest = manifest.digest;
  if (manifest.entryDigests !== undefined) clean.entryDigests = manifest.entryDigests;
  if (manifest.generatedBy !== undefined) clean.generatedBy = manifest.generatedBy;
  if (manifest.generatedAt !== undefined) clean.generatedAt = manifest.generatedAt;
  // Step 2: return the wairon-pack.yaml text.
  return yamlDump(clean, { sortKeys: false });
}

/** The default extraction-safety profile; callers override individual caps. */
export function defaultLimits(): PackExtractionLimits {
  // Step 1: return the default caps profile.
  return { ...DEFAULTS };
}

/** Compute the safe extraction plan from enumerated entries under `limits`, or throw. */
export function planExtraction(entries: ArchiveEntryMeta[], limits: PackExtractionLimits): PackExtractionPlan {
  // Step 1: resolve effective caps — each field of `limits` over the defaults.
  const caps = {
    maxEntries: limits.maxEntries ?? DEFAULTS.maxEntries,
    maxTotalUncompressedBytes: limits.maxTotalUncompressedBytes ?? DEFAULTS.maxTotalUncompressedBytes,
    maxEntryBytes: limits.maxEntryBytes ?? DEFAULTS.maxEntryBytes,
    maxCompressionRatio: limits.maxCompressionRatio ?? DEFAULTS.maxCompressionRatio,
    maxDepth: limits.maxDepth ?? DEFAULTS.maxDepth,
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

/** Assert the envelope's name/version match the inner pack manifest; throw on mismatch. */
export function verifyIdentity(manifest: PackArchiveManifest, packName: string, packVersion: string): void {
  // Step 1: do envelope name/version differ from the inner pack manifest?
  if (manifest.name !== packName || manifest.version !== packVersion) {
    // Step 2: reject a tampered/mis-assembled archive.
    throw new Error('envelope identity mismatch (envelope name/version differ from the inner pack manifest)');
  }
  // Step 3: identity verified.
}

/** Verify every entry's sha256 against entryDigests; false when none carried, throws on mismatch. */
export function verifyIntegrity(manifest: PackArchiveManifest, files: PackFile[]): boolean {
  // Step 1: did the envelope carry no integrity data?
  if (!manifest.entryDigests) {
    // Step 2: no integrity data present — return false.
    return false;
  }
  const digests = manifest.entryDigests;
  // Step 3: check each file's digest.
  for (const file of files) {
    // The envelope carries these digests and cannot digest itself — skip it.
    if (file.path === ENVELOPE_FILENAME) continue;
    // Step 4: does the recomputed sha256 differ from the recorded digest?
    if (sha256(file.contents) !== digests[file.path]) {
      // Step 7: a digest mismatch means tampering.
      throw new Error('integrity digest mismatch');
    }
    // Step 5 (checkEnd): this file's digest matches.
  }
  // Step 6: all digests matched — return true.
  return true;
}

/** Produce-side partner of verifyIntegrity: fill entryDigests + digest + stamps. */
export function sealIntegrity(
  manifest: PackArchiveManifest,
  files: PackFile[],
  generatedBy: string,
  generatedAt: string,
): PackArchiveManifest {
  // Step 1: initialize an empty entryDigests map.
  const entryDigests: Record<string, string> = {};
  // Step 2: hash each file.
  for (const file of files) {
    // The envelope is the carrier of these digests — never hash it into itself.
    if (file.path === ENVELOPE_FILENAME) continue;
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
export function checkCompatibility(manifest: PackArchiveManifest, waironVersion: string): boolean {
  // Step 1: is the archive format unsupported?
  if (Math.trunc(manifest.formatVersion) > SUPPORTED_FORMAT_VERSION) {
    // Step 4: incompatible.
    return false;
  }
  // Step 2: is the running wairon below the pack's minimum?
  if (manifest.minWaironVersion && isBelow(waironVersion, manifest.minWaironVersion)) {
    // Step 4: incompatible.
    return false;
  }
  // Step 3: compatible.
  return true;
}

// --- helpers ---------------------------------------------------------------

function rejectUnsafe(): never {
  throw new Error('reject: unsafe or oversized archive entry (zip-slip / size / ratio / depth guard)');
}

function validateEnvelope(raw: unknown): PackArchiveManifest {
  if (!raw || typeof raw !== 'object') {
    throw new Error('malformed pack envelope (not a YAML mapping)');
  }
  const o = raw as Record<string, unknown>;
  if (typeof o.formatVersion !== 'number') throw new Error('pack envelope: formatVersion must be a number');
  if (typeof o.name !== 'string' || !o.name) throw new Error('pack envelope: name is required');
  if (typeof o.version !== 'string' || !o.version) throw new Error('pack envelope: version is required');
  if (typeof o.kind !== 'string' || (o.kind !== 'declarative' && o.kind !== 'code')) {
    throw new Error('pack envelope: kind must be "declarative" or "code"');
  }
  if (typeof o.entry !== 'string' || !o.entry) throw new Error('pack envelope: entry is required');
  const manifest: PackArchiveManifest = {
    formatVersion: o.formatVersion,
    name: o.name,
    version: o.version,
    kind: o.kind,
    entry: o.entry,
  };
  if (typeof o.minWaironVersion === 'string') manifest.minWaironVersion = o.minWaironVersion;
  if (typeof o.digest === 'string') manifest.digest = o.digest;
  if (o.entryDigests && typeof o.entryDigests === 'object') {
    manifest.entryDigests = o.entryDigests as Record<string, string>;
  }
  if (typeof o.generatedBy === 'string') manifest.generatedBy = o.generatedBy;
  if (typeof o.generatedAt === 'string') manifest.generatedAt = o.generatedAt;
  return manifest;
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
