// ---------------------------------------------------------------------------
// Shared pack-archive value objects (@wairon/sdk public types).
//
// The `.wpack` format: a ZIP whose root carries a `wairon-pack.yaml` envelope
// wrapping an ordinary directory pack. These are the locked L2 value objects
// the SDK components exchange; the package index re-exports them verbatim.
//
// The spec `bytes` token is `Uint8Array` at the public surface. Node's Buffer
// is a Uint8Array subclass, so callers may pass a Buffer transparently; the SDK
// always RETURNS a Uint8Array. Whole in-memory buffers only — never streams —
// because the safety model enumerates entry sizes BEFORE inflating.
// ---------------------------------------------------------------------------

/**
 * The `.wpack` envelope, serialized as `wairon-pack.yaml` at the archive root —
 * the portable, versioned identity + integrity header wrapping a directory pack.
 * `kind` is "declarative" (data only) or "code" (executable entry / rules).
 */
export interface PackArchiveManifest {
  /** Pack-archive format version (currently 1); a newer major is rejected, not silently mis-read. */
  formatVersion: number;
  /** Pack identity; must equal the inner pack manifest's name. */
  name: string;
  /** Pack version (semver); must equal the inner pack manifest's version. */
  version: string;
  /** "declarative" (data only) | "code" (executable entry / programmatic rules). */
  kind: string;
  /** Archive-relative path to the pack entry file (e.g. "pack.yaml", "pack.cjs"). */
  entry: string;
  /** Minimum compatible wairon version (semver range). */
  minWaironVersion?: string;
  /** Optional integrity digest over the manifest. */
  digest?: string;
  /** Optional per-entry integrity map: archive path -> sha256. */
  entryDigests?: Record<string, string>;
  /** Producer stamp, e.g. "@wairon/sdk@X.Y.Z". */
  generatedBy?: string;
  /** ISO-8601 build timestamp. */
  generatedAt?: string;
}

/**
 * The result of inspecting a `.wpack` without extracting it: its envelope
 * identity plus computed archive stats and a compatibility verdict.
 */
export interface PackArchiveInfo {
  name: string;
  version: string;
  /** "declarative" | "code". */
  kind: string;
  entry: string;
  formatVersion: number;
  minWaironVersion?: string;
  /** Number of regular file entries in the archive. */
  entryCount: number;
  totalUncompressedBytes: number;
  /** Whether formatVersion + minWaironVersion are compatible with the running wairon. */
  compatible: boolean;
  /** Present when integrity data was carried: true if every entry digest matched. */
  integrityVerified?: boolean;
}

/**
 * The outcome of safely extracting a `.wpack` into a destination directory:
 * where it landed, its parsed envelope, and the archive-relative entry path.
 */
export interface PackExtractionResult {
  /** Absolute path the pack was extracted into (e.g. .wai/packs/<name>). */
  directory: string;
  /** Path to the pack entry file within `directory`. */
  entryPath: string;
  /** The parsed envelope. */
  manifest: PackArchiveManifest;
  /** Pack name (convenience mirror of manifest.name). */
  name: string;
  /** "declarative" | "code". */
  kind: string;
  /** Number of files written. */
  entryCount: number;
}

/**
 * The configurable safety caps the codec enforces when planning an extraction —
 * the zip-bomb / oversized-archive guardrails. Every field is optional; unset
 * fields fall back to the codec's default profile.
 */
export interface PackExtractionLimits {
  /** Max entry count (default 4096). */
  maxEntries?: number;
  /** Max total inflated size (default 32 MiB; hosted 8 MiB). */
  maxTotalUncompressedBytes?: number;
  /** Max single-entry inflated size (default 8 MiB). */
  maxEntryBytes?: number;
  /** Max inflated:compressed ratio, zip-bomb guard (default 100). */
  maxCompressionRatio?: number;
  /** Max path nesting depth (default 16). */
  maxDepth?: number;
}

/**
 * Inputs to `wairon pack init`: the identity and variant of the pack project to
 * scaffold, and where to write it.
 */
export interface PackScaffoldRequest {
  /** Pack name (also the default directory + archive stem). */
  name: string;
  /** Initial version (default 0.1.0). */
  version?: string;
  /** "declarative" | "code". */
  kind: string;
  /** Directory to scaffold the pack project into. */
  targetDir: string;
  /** Include a skills/<id>/SKILL.md stub. */
  withSkill?: boolean;
}

/**
 * The output of `wairon pack build`: the assembled `.wpack` archive bytes, a
 * descriptor of what was built, and a suggested file name.
 */
export interface PackBuildResult {
  /** The assembled .wpack (ZIP) bytes. */
  archive: Uint8Array;
  /** Descriptor of the built archive. */
  info: PackArchiveInfo;
  /** e.g. "my-pack-1.0.0.wpack". */
  suggestedFileName: string;
}

/**
 * One file within a pack: an archive-relative POSIX path and its raw bytes. The
 * common currency between the scaffold specialist, the archive adapter, and the
 * codec (integrity verification over file bytes).
 */
export interface PackFile {
  /** Archive-relative POSIX path (forward slashes). */
  path: string;
  /** Raw file bytes. */
  contents: Uint8Array;
}

/**
 * Metadata for one archive entry, enumerated by the archive adapter WITHOUT
 * inflating it — so the codec can enforce zip-bomb and size caps before any
 * bytes are decompressed.
 */
export interface ArchiveEntryMeta {
  /** Raw archive entry path (as stored, pre-normalization). */
  path: string;
  uncompressedSize: number;
  compressedSize: number;
  /** "file" | "dir" | "symlink". */
  kind: string;
}

/**
 * The codec's approved, safe extraction plan: the normalized archive-relative
 * paths that passed every safety check, plus the total inflated size. The
 * archive adapter inflates and writes only these paths.
 */
export interface PackExtractionPlan {
  /** Approved, normalized relative paths to inflate + write under the destination. */
  paths: string[];
  /** Sum of approved entries' inflated sizes. */
  totalUncompressedBytes: number;
}
