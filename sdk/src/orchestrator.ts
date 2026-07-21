import * as path from 'path';
import { load as yamlLoad } from 'js-yaml';
import * as codec from './codec.js';
import * as scaffold from './scaffold.js';
import * as archive from './archive.js';
import { SDK_VERSION } from './version.js';
import type {
  PackArchiveInfo,
  PackArchiveManifest,
  PackBuildResult,
  PackExtractionLimits,
  PackExtractionResult,
  PackFile,
  PackScaffoldRequest,
} from './types.js';

// ---------------------------------------------------------------------------
// SDK Orchestrator (sdk_orchestrator_impl) — the four pack workflows. Delegates
// format/safety decisions to the codec, template rendering to the scaffold
// specialist, and all zip+fs I/O to the archive adapter. Holds no state.
// ---------------------------------------------------------------------------

const decode = (b: Uint8Array): string => new TextDecoder().decode(b);
const encode = (s: string): Uint8Array => new TextEncoder().encode(s);

/** Render the scaffold file map and write it under the target directory. */
export function scaffoldPack(request: PackScaffoldRequest): string[] {
  // Step 1: render the scaffold file map for the requested pack.
  const files = scaffold.render(request);
  // Step 2: write the rendered files as a directory tree under targetDir.
  archive.writeTree(request.targetDir, files);
  // Step 3: return the created file paths (targetDir-joined).
  return files.map((file) => path.join(request.targetDir, file.path));
}

/** Build an installable .wpack archive from a pack directory. */
export function buildPack(sourceDir: string): PackBuildResult {
  // Step 1: read the source pack directory into a file map.
  const files = archive.readPackDir(sourceDir);
  // Step 2: require an envelope.
  const envelope = files.find((file) => file.path === codec.ENVELOPE_FILENAME);
  if (!envelope) {
    // Step 3: reject a pack directory with no envelope.
    throw new Error('pack build requires a wairon-pack.yaml envelope (run `wairon pack init` to scaffold one)');
  }
  // Step 4 (parse): parse + validate the envelope (also version-gates the format).
  const manifest = codec.parseManifest(decode(envelope.contents));
  // Step 5: read the inner pack identity (pack.yaml, or package.json for code).
  const identity = readInnerIdentity(files, manifest);
  // Step 6: assert the envelope's name/version match the inner pack manifest.
  codec.verifyIdentity(manifest, identity.name, identity.version);
  // Step 7: seal integrity (entryDigests + digest + generatedBy/generatedAt).
  const sealed = codec.sealIntegrity(manifest, files, `@wairon/sdk@${SDK_VERSION}`, new Date().toISOString());
  // Step 8: serialize the sealed manifest back to canonical envelope text.
  const sealedText = codec.serializeManifest(sealed);
  // Step 9: upsert wairon-pack.yaml (sealed envelope text) into the file map.
  const finalFiles = upsertEnvelope(files, sealedText);
  // Step 10: deflate the files + envelope into .wpack archive bytes.
  const archiveBytes = archive.assembleArchive(finalFiles);
  // Step 11: assemble PackArchiveInfo + suggestedFileName.
  const info = buildInfo(sealed, finalFiles);
  const suggestedFileName = `${sealed.name}-${sealed.version}.wpack`;
  // Step 12: return the build result.
  return { archive: archiveBytes, info, suggestedFileName };
}

/** Inspect + verify a .wpack archive without extracting it. */
export function inspectArchive(archiveBytes: Uint8Array): PackArchiveInfo {
  // Step 1: enumerate archive entries without inflating.
  const entries = archive.listEntries(archiveBytes);
  // Step 2: is there no wairon-pack.yaml entry?
  if (!entries.some((entry) => entry.path === codec.ENVELOPE_FILENAME)) {
    // Step 3: reject a non-.wpack archive.
    throw new Error('not a .wpack archive (missing wairon-pack.yaml envelope)');
  }
  // Step 4 (readEnv): inflate just the envelope entry.
  const envelopeBytes = archive.inflateEntry(archiveBytes, codec.ENVELOPE_FILENAME);
  // Step 5: parse + version-check the envelope text.
  const manifest = codec.parseManifest(decode(envelopeBytes));
  // Step 6: compute compatibility against the running wairon version.
  const compatible = codec.checkCompatibility(manifest, SDK_VERSION);
  // Step 7: assemble PackArchiveInfo from the manifest + archive stats.
  const fileEntries = entries.filter((entry) => entry.kind === 'file');
  const totalUncompressedBytes = entries.reduce((sum, entry) => sum + entry.uncompressedSize, 0);
  const info: PackArchiveInfo = {
    name: manifest.name,
    version: manifest.version,
    kind: manifest.kind,
    entry: manifest.entry,
    formatVersion: manifest.formatVersion,
    entryCount: fileEntries.length,
    totalUncompressedBytes,
    compatible,
  };
  if (manifest.minWaironVersion !== undefined) info.minWaironVersion = manifest.minWaironVersion;
  // Step 8: return the PackArchiveInfo (no extraction performed).
  return info;
}

/** Safely extract a .wpack archive into a destination directory under enforced limits. */
export function extractPack(
  archiveBytes: Uint8Array,
  destDir: string,
  limits?: PackExtractionLimits,
): PackExtractionResult {
  // Step 1: did the caller omit limits?
  const effectiveLimits = limits === undefined
    // Step 2: fall back to the codec's default limit profile.
    ? codec.defaultLimits()
    : limits;
  // Step 3 (list): enumerate archive entries without inflating (caps run pre-decompress).
  const entries = archive.listEntries(archiveBytes);
  // Step 4: compute the safe extraction plan (throws on any unsafe/oversized entry).
  const plan = codec.planExtraction(entries, effectiveLimits);
  // Step 5: initialize an empty file list.
  const files: PackFile[] = [];
  // Step 6: inflate each approved path from the plan.
  for (const approvedPath of plan.paths) {
    // Step 7: inflate one approved entry.
    const contents = archive.inflateEntry(archiveBytes, approvedPath);
    // Step 8 (inflateEnd): append { path, contents } to the file list.
    files.push({ path: approvedPath, contents });
  }
  // Step 9: read the wairon-pack.yaml text from the inflated files.
  const envelope = files.find((file) => file.path === codec.ENVELOPE_FILENAME);
  if (!envelope) {
    throw new Error('not a .wpack archive (missing wairon-pack.yaml envelope)');
  }
  // Step 10: parse the envelope into the result manifest.
  const manifest = codec.parseManifest(decode(envelope.contents));
  // Step 11: enforce integrity BEFORE writing (throws on mismatch; no-op when none carried).
  codec.verifyIntegrity(manifest, files);
  // Step 12: write the approved, integrity-checked files as a directory tree.
  const directory = path.resolve(destDir);
  archive.writeTree(directory, files);
  // Step 13: assemble PackExtractionResult.
  const result: PackExtractionResult = {
    directory,
    entryPath: manifest.entry,
    manifest,
    name: manifest.name,
    kind: manifest.kind,
    entryCount: files.length,
  };
  // Step 14: return where the pack landed + its parsed manifest.
  return result;
}

// --- helpers ---------------------------------------------------------------

function readInnerIdentity(files: PackFile[], manifest: PackArchiveManifest): { name: string; version: string } {
  const innerPath = manifest.kind === 'code' ? 'package.json' : manifest.entry;
  const inner = files.find((file) => file.path === innerPath);
  if (!inner) throw new Error(`pack build: inner pack manifest "${innerPath}" is missing`);
  const parsed = (manifest.kind === 'code'
    ? JSON.parse(decode(inner.contents))
    : yamlLoad(decode(inner.contents))) as Record<string, unknown> | null;
  const name = parsed?.name;
  const version = parsed?.version;
  if (typeof name !== 'string' || typeof version !== 'string') {
    throw new Error(`pack build: inner pack manifest "${innerPath}" lacks a name/version`);
  }
  return { name, version };
}

function upsertEnvelope(files: PackFile[], envelopeText: string): PackFile[] {
  const others = files.filter((file) => file.path !== codec.ENVELOPE_FILENAME);
  return [...others, { path: codec.ENVELOPE_FILENAME, contents: encode(envelopeText) }];
}

function buildInfo(manifest: PackArchiveManifest, files: PackFile[]): PackArchiveInfo {
  const totalUncompressedBytes = files.reduce((sum, file) => sum + file.contents.length, 0);
  const info: PackArchiveInfo = {
    name: manifest.name,
    version: manifest.version,
    kind: manifest.kind,
    entry: manifest.entry,
    formatVersion: manifest.formatVersion,
    entryCount: files.length,
    totalUncompressedBytes,
    compatible: true,
  };
  if (manifest.minWaironVersion !== undefined) info.minWaironVersion = manifest.minWaironVersion;
  return info;
}
