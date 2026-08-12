import * as path from 'path';
import { load as yamlLoad } from 'js-yaml';
import * as codec from './codec.js';
import * as treecodec from './treecodec.js';
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
  TreeArchiveInfo,
  TreeArchiveManifest,
  TreeBuildResult,
  TreeExtractionResult,
  TreeRootSource,
} from './types.js';

// ---------------------------------------------------------------------------
// SDK Orchestrator (sdk_orchestrator_impl) — the four pack workflows and the
// three spec-tree archive workflows. Delegates format/safety decisions to the
// codecs, template rendering to the scaffold specialist, and all zip+fs I/O to
// the archive adapter. Holds no state.
//
// Root DISCOVERY stays with the caller: the SDK never walks a spec tree, it
// only archives the roots it is handed.
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

// ── Spec-tree archive workflows (.waitree) ──────────────────────────────────

/** Pack a project's spec tree — the supplied roots' .wai directories — into a .waitree. */
export function buildTreeArchive(
  roots: TreeRootSource[],
  projectName: string,
  stateId?: string,
  includeDerived?: boolean,
): TreeBuildResult {
  // Step 1: initialize an empty archive file map and an empty packed-roots list.
  const files: PackFile[] = [];
  const packedRoots: string[] = [];
  // Step 2: pack each supplied root.
  for (const root of roots) {
    // Step 3: read this root's .wai directory recursively into a file map.
    const rootFiles = archive.readPackDir(root.waiDir);
    // Step 4: keep only portable design state.
    const portable = treecodec.selectTreeFiles(rootFiles, includeDerived === true);
    // Step 5 (packEnd): prefix with this root's project-relative path + '.wai/'.
    const prefix = treeRootPrefix(root.relativePath);
    for (const file of portable) files.push({ path: `${prefix}${file.path}`, contents: file.contents });
    packedRoots.push(normalizeRootPath(root.relativePath));
  }
  // Step 6: did the roots yield no files at all?
  if (files.length === 0) {
    // Step 7: an export that silently carries nothing is worse than a failure.
    throw new Error('tree export found no spec-tree files under the supplied roots');
  }
  // Step 8: build the unsealed envelope.
  const manifest: TreeArchiveManifest = {
    formatVersion: 1,
    projectName,
    roots: packedRoots,
    waironVersion: SDK_VERSION,
    includesDerived: includeDerived === true,
  };
  if (stateId !== undefined) manifest.stateId = stateId;
  // Step 9: seal integrity (entryDigests + digest + generatedBy/generatedAt).
  const sealed = treecodec.sealTreeIntegrity(
    manifest,
    files,
    `@wairon/sdk@${SDK_VERSION}`,
    new Date().toISOString(),
  );
  // Step 10: serialize the sealed manifest to canonical envelope text.
  const sealedText = treecodec.serializeTreeManifest(sealed);
  // Step 11: upsert wairon-tree.yaml (sealed envelope text) into the file map.
  const finalFiles: PackFile[] = [
    ...files.filter((file) => file.path !== treecodec.TREE_ENVELOPE_FILENAME),
    { path: treecodec.TREE_ENVELOPE_FILENAME, contents: encode(sealedText) },
  ];
  // Step 12: deflate the files + envelope into .waitree archive bytes.
  const archiveBytes = archive.assembleArchive(finalFiles);
  // Step 13: derive the suggested file name from the project name.
  const suggestedFileName = `${slugify(projectName)}.waitree`;
  // Step 14: return the build result.
  return { archive: archiveBytes, manifest: sealed, suggestedFileName, fileCount: files.length };
}

/** Inspect a .waitree archive without extracting it. */
export function inspectTreeArchive(archiveBytes: Uint8Array): TreeArchiveInfo {
  // Step 1: enumerate archive entries without inflating.
  const entries = archive.listEntries(archiveBytes);
  // Step 2: is there no wairon-tree.yaml entry?
  if (!entries.some((entry) => entry.path === treecodec.TREE_ENVELOPE_FILENAME)) {
    // Step 3: reject a non-.waitree archive.
    throw new Error('not a .waitree archive (missing wairon-tree.yaml envelope)');
  }
  // Step 4 (readEnv): inflate just the envelope entry.
  const envelopeBytes = archive.inflateEntry(archiveBytes, treecodec.TREE_ENVELOPE_FILENAME);
  // Step 5: parse + version-check the envelope text.
  const manifest = treecodec.parseTreeManifest(decode(envelopeBytes));
  // Step 6: compute compatibility against the running wairon version.
  const compatible = treecodec.checkTreeCompatibility(manifest, SDK_VERSION);
  // Step 7: assemble TreeArchiveInfo from the manifest + archive stats.
  const fileEntries = entries.filter((entry) => entry.kind === 'file');
  const totalUncompressedBytes = entries.reduce((sum, entry) => sum + entry.uncompressedSize, 0);
  // Step 8: return the TreeArchiveInfo (no extraction performed).
  return { manifest, entryCount: fileEntries.length, totalUncompressedBytes, compatible };
}

/** Safely extract a .waitree archive into a destination project root under enforced limits. */
export function extractTreeArchive(
  archiveBytes: Uint8Array,
  destDir: string,
  limits?: PackExtractionLimits,
  refuseExecutableEntries?: boolean,
): TreeExtractionResult {
  // Step 1: did the caller omit limits?
  const effectiveLimits = limits === undefined
    // Step 2: fall back to the codec's tree limit profile.
    ? treecodec.defaultTreeLimits()
    : limits;
  // Step 3 (list): enumerate archive entries without inflating (caps run pre-decompress).
  const entries = archive.listEntries(archiveBytes);
  // Step 4: compute the safe extraction plan (throws on any unsafe/oversized entry).
  const plan = treecodec.planTreeExtraction(entries, effectiveLimits);
  // Step 5: did the caller ask for the over-the-wire portability guard?
  if (refuseExecutableEntries === true) {
    // Step 6: refuse executable or non-spec-tree entries before anything is inflated.
    treecodec.assertPortableTreePaths(plan.paths);
  }
  // Step 7 (inflate): initialize an empty file list.
  const files: PackFile[] = [];
  // Step 8: inflate each approved path from the plan.
  for (const approvedPath of plan.paths) {
    // Step 9: inflate one approved entry.
    const contents = archive.inflateEntry(archiveBytes, approvedPath);
    // Step 10 (inflateEnd): append { path, contents } to the file list.
    files.push({ path: approvedPath, contents });
  }
  // Step 11: is the wairon-tree.yaml envelope missing from the inflated files?
  const envelope = files.find((file) => file.path === treecodec.TREE_ENVELOPE_FILENAME);
  if (!envelope) {
    // Step 12: reject a non-.waitree archive.
    throw new Error('not a .waitree archive (missing wairon-tree.yaml envelope)');
  }
  // Step 13 (parse): parse the envelope into the result manifest.
  const manifest = treecodec.parseTreeManifest(decode(envelope.contents));
  // Step 14: enforce integrity BEFORE writing (throws on mismatch; no-op when none carried).
  treecodec.verifyTreeIntegrity(manifest, files);
  // Step 15: write the approved, integrity-checked files as a directory tree.
  const directory = path.resolve(destDir);
  archive.writeTree(directory, files);
  // Step 16: assemble TreeExtractionResult.
  const result: TreeExtractionResult = {
    destDir: directory,
    manifest,
    roots: manifest.roots,
    writtenPaths: files.map((file) => file.path),
  };
  // Step 17: return where the tree landed + its parsed manifest.
  return result;
}

// --- helpers ---------------------------------------------------------------

/** The archive-path prefix for one packed root: '.wai/' at the top, else '<dir>/.wai/'. */
function treeRootPrefix(relativePath: string): string {
  const normalized = normalizeRootPath(relativePath);
  return normalized === '.' ? '.wai/' : `${normalized}/.wai/`;
}

/** A packed root's canonical project-relative form: POSIX separators, '.' for the top root. */
function normalizeRootPath(relativePath: string): string {
  const posix = relativePath.split(path.sep).join('/').replace(/^\.\//, '').replace(/\/+$/, '');
  return posix === '' || posix === '.' ? '.' : posix;
}

/** A file-name-safe stem for a project name. */
function slugify(projectName: string): string {
  const slug = projectName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'spec-tree';
}

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
