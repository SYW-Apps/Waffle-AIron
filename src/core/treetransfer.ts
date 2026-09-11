import * as fs from 'fs';
import * as path from 'path';
import * as sdkPortal from '@wairon/sdk';
import type {
  PackExtractionLimits,
  TreeArchiveInfo,
  TreeBuildResult,
  TreeExtractionResult,
  TreeRootSource,
} from '@wairon/sdk';
import { aiPathsAt } from '../config/loader.js';
import { getProjectRoot, pathExists, listFilesRecursive } from '../utils/fs.js';
import { loadSystemSpec, listChainedRoots, invalidateSpecCache } from './specs.js';
import { computeStateId } from './statehash.js';

// ---------------------------------------------------------------------------
// Tree Archive Adapter (tree_archive_adapter_impl) + Tree Transfer Orchestrator
// (tree_transfer_orchestrator_impl) — src/core/treetransfer.ts
//
// The adapter is the archive + filesystem boundary: three forwards onto the
// @wairon/sdk .waitree capabilities, plus the staging/probe/swap/discard
// directory operations that keep an import recoverable. The orchestrator owns
// the two transfer workflows.
//
// Import never writes into a live tree: extraction lands in a staging directory
// INSIDE the destination root (same filesystem, and never outside the project's
// isolated root — which the hosted tenant model requires), and only a successful
// extraction is swapped into place with the previous tree moved aside.
// ---------------------------------------------------------------------------

/** Import policy, chosen by the calling surface — nothing here defaults permissively. */
export interface TreeImportOptions {
  /** Replace a spec tree already present at the destination (backed up first). Absent = REFUSE. */
  replaceExisting?: boolean;
  /** Apply the portable-path guard — set by every surface accepting an archive over the wire. */
  refuseExecutableEntries?: boolean;
  /** Project root to import into; defaults to the currently bound project root. */
  destDir?: string;
}

/** One project's spec tree packed for transfer, with the provenance to place it. */
export interface TreeExportResult {
  archive: Uint8Array;
  suggestedFileName: string;
  projectName: string;
  /** Project-relative roots packed — '.' plus every chained subproject. */
  roots: string[];
  fileCount: number;
  stateId?: string;
}

/** What an import actually did, including where a replaced tree was backed up. */
export interface TreeImportResult {
  destDir: string;
  projectName: string;
  roots: string[];
  fileCount: number;
  replaced: boolean;
  backupPath?: string;
  stateId?: string;
}

/** Directory names the transfer machinery owns inside a project root. */
const STAGING_PREFIX = '.wai-staging-';
const BACKUP_DIR = '.wai-backups';

// ── tree_archive_adapter: the @wairon/sdk + filesystem boundary ─────────────

/** Pack the supplied tree roots' .wai directories into .waitree archive bytes. */
export function buildTreeArchive(
  roots: TreeRootSource[],
  projectName: string,
  stateId?: string,
  includeDerived?: boolean,
): TreeBuildResult {
  // Step 1: forward to the SDK portal.
  return sdkPortal.buildTreeArchive(roots, projectName, stateId, includeDerived);
}

/** Read what a .waitree archive declares, without extracting anything. */
export function inspectTreeArchive(archive: Uint8Array): TreeArchiveInfo {
  // Step 1: forward to the SDK portal.
  return sdkPortal.inspectTreeArchive(archive);
}

/** Extract a .waitree archive into a destination directory under the SDK's tree limits. */
export function extractTreeArchive(
  archive: Uint8Array,
  destDir: string,
  refuseExecutableEntries?: boolean,
): TreeExtractionResult {
  // Step 1: forward to the SDK portal — omitted limits fall back to its tree
  // caps profile, and the caller's executable-entry policy passes through.
  const limits: PackExtractionLimits | undefined = undefined;
  return sdkPortal.extractTreeArchive(archive, destDir, limits, refuseExecutableEntries);
}

/** Whether a project root already holds a spec tree (a .wai carrying a project config). */
export function hasSpecTree(root: string): boolean {
  // Step 1: does the root hold a .wai directory carrying a project config?
  if (pathExists(aiPathsAt(root).projectConfig())) {
    // Step 2: a spec tree is present.
    return true;
  }
  // Step 3: no spec tree here.
  return false;
}

/**
 * Whether a project root holds AUTHORED design — any spec beyond the L0 system
 * index a bootstrap writes. This is the honest refusal test, and it is NOT the
 * same question as hasSpecTree: every hosted project is provisioned with a
 * project config and an empty L0 spec the moment it is created, so treating
 * "has a tree" as "has a design" would make importing into a fresh project
 * impossible without an override — turning the guard into noise everyone
 * routinely overrides. A bootstrap tree is not a design; losing it costs
 * nothing. Anything authored on top of it is refused unless the caller
 * explicitly asked to replace.
 */
export function hasAuthoredSpecs(root: string): boolean {
  // Step 1: locate the root's specs directory.
  const paths = aiPathsAt(root);
  const specsDir = paths.specsDir();
  if (!pathExists(specsDir)) {
    // Step 2: no specs directory at all — nothing authored.
    return false;
  }
  // Step 3: is any spec present other than the L0 system index?
  const systemIndex = path.resolve(paths.specsSystem());
  for (const file of listFilesRecursive(specsDir, '.yaml')) {
    if (path.resolve(file) !== systemIndex) {
      // Step 4: authored design is present.
      return true;
    }
  }
  // Step 5: only the bootstrap L0 index — nothing authored.
  return false;
}

/** Allocate an empty staging directory inside the destination root. */
export function createStagingDir(destDir: string): string {
  // Step 1: create a uniquely named staging directory INSIDE the destination
  // root — same filesystem (so the swap is a rename, not a cross-device copy)
  // and never outside the project's isolated root.
  const root = path.resolve(destDir);
  fs.mkdirSync(root, { recursive: true });
  const stagingDir = fs.mkdtempSync(path.join(root, STAGING_PREFIX));
  // Step 2: return the staging directory path.
  return stagingDir;
}

/**
 * Swap a fully extracted staging tree into place: move any existing spec dir
 * aside into one timestamped backup (when asked), then move the staged one into
 * position. Returns the backup directory path, or '' when nothing was replaced.
 */
export function commitStagedTree(
  stagingDir: string,
  destDir: string,
  roots: string[],
  backupExisting: boolean,
): string {
  // Step 1: derive the timestamped backup directory path; nothing has moved yet.
  const root = path.resolve(destDir);
  const backupDir = path.join(root, BACKUP_DIR, timestampSlug());
  let backedUp = false;

  // Step 2: swap each root into place.
  for (const rootRel of roots) {
    const relative = rootRel === '.' ? '' : rootRel;
    const stagedSpecDir = path.join(stagingDir, relative, '.wai');
    if (!fs.existsSync(stagedSpecDir)) continue; // nothing staged for this root
    const liveSpecDir = liveSpecDirFor(path.join(root, relative));

    // Step 3: does this root hold an existing spec dir the caller asked to preserve?
    if (backupExisting && liveSpecDir && fs.existsSync(liveSpecDir)) {
      // Step 4: move it into the backup directory under this root's relative
      // path, so one backup holds the whole previous tree in its original shape.
      const backupTarget = path.join(backupDir, relative, path.basename(liveSpecDir));
      fs.mkdirSync(path.dirname(backupTarget), { recursive: true });
      fs.renameSync(liveSpecDir, backupTarget);
      backedUp = true;
    } else if (liveSpecDir && fs.existsSync(liveSpecDir)) {
      fs.rmSync(liveSpecDir, { recursive: true, force: true });
    }

    // Step 5 (swapEnd): move the staged root's .wai into position.
    const target = path.join(root, relative, '.wai');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true });
    fs.renameSync(stagedSpecDir, target);
  }

  // Step 6: was anything moved aside?
  if (backedUp) {
    // Step 7: return the backup directory path.
    return backupDir;
  }
  // Step 8: return an empty string — the destination held no previous tree.
  return '';
}

/** Remove a staging directory and everything under it (best effort). */
export function discardStagingDir(stagingDir: string): void {
  // Step 1: remove it, swallowing any failure — tidying must never fail an
  // import that already succeeded.
  try {
    fs.rmSync(stagingDir, { recursive: true, force: true });
  } catch {
    /* best-effort cleanup */
  }
}

// ── tree_transfer_orchestrator: the two transfer workflows ──────────────────

/**
 * Pack the bound project's spec tree — its own .wai plus the .wai of every
 * chained subproject — into a .waitree archive stamped with its content state.
 */
export function exportSpecTree(includeDerived?: boolean): TreeExportResult {
  // Step 1: load the bound project's L0 system spec — its name is the identity.
  const system = loadSystemSpec();
  // Step 2: is there no system spec at the bound root?
  if (!system) {
    // Step 3: refuse rather than produce an archive of nothing.
    throw new Error('no spec tree to export at this project root');
  }
  // Step 4: list every chained subproject root beneath this project.
  const chained = listChainedRoots();
  // Step 5: assemble the root set — the top project first, each entry paired
  // with the absolute .wai directory it names (skipping any that is absent).
  const root = getProjectRoot();
  const candidates: TreeRootSource[] = [
    { relativePath: '.', waiDir: aiPathsAt(root).root() },
    ...chained.map((rel) => ({ relativePath: rel, waiDir: aiPathsAt(path.resolve(root, rel)).root() })),
  ];
  const roots = candidates.filter((source) => pathExists(source.waiDir));
  // Step 6: digest the tree's content as provenance for the far end.
  const stateId = computeStateId();
  // Step 7: pack the roots into .waitree archive bytes.
  const built = buildTreeArchive(roots, system.name, stateId.digest, includeDerived);
  // Step 8: assemble the export result.
  const result: TreeExportResult = {
    archive: built.archive,
    suggestedFileName: built.suggestedFileName,
    projectName: built.manifest.projectName,
    roots: built.manifest.roots,
    fileCount: built.fileCount,
    stateId: stateId.digest,
  };
  // Step 9: return the archive and its provenance.
  return result;
}

/**
 * Import a .waitree archive into a project root: inspect before touching disk,
 * refuse an incompatible archive or an occupied destination the caller did not
 * ask to replace, extract into staging, then swap into place with a backup.
 */
export function importSpecTree(archive: Uint8Array, options: TreeImportOptions): TreeImportResult {
  // Step 1: read what the archive declares BEFORE anything touches disk.
  const info = inspectTreeArchive(archive);
  // Step 2: is the archive incompatible with this wairon?
  if (!info.compatible) {
    // Step 3: refuse an archive this wairon cannot faithfully read.
    throw new Error('incompatible .waitree archive (format or minimum wairon version)');
  }
  // Step 4: resolve the destination project root.
  const destDir = path.resolve(options.destDir ?? getProjectRoot());
  // Step 5: does the destination already hold a spec tree? (Drives the BACKUP:
  // whatever is there is preserved, bootstrap or not.)
  const occupied = hasSpecTree(destDir);
  // Step 6: does it hold authored design? (Drives the REFUSAL: a freshly
  // provisioned project carries only an empty L0 spec, which is not a design.)
  const authored = hasAuthoredSpecs(destDir);
  // Step 7: is authored design present that the caller did not ask to replace?
  if (authored && options.replaceExisting !== true) {
    // Step 8: refuse to overwrite an existing design silently.
    throw new Error(
      'the destination already holds an authored spec tree; pass replaceExisting to move it aside and import over it',
    );
  }
  // Step 8 (stage): allocate a staging directory beside the destination.
  const stagingDir = createStagingDir(destDir);
  let extraction: TreeExtractionResult;
  // Step 9: extract into staging. A rejected, corrupt, or oversized archive
  // fails HERE, leaving the destination untouched.
  try {
    // Step 10: extract the archive into the staging directory.
    extraction = extractTreeArchive(archive, stagingDir, options.refuseExecutableEntries);
  } catch (err) {
    // Step 16 (cleanupAndRethrow): discard staging, then re-raise — a failed
    // import leaves neither a half-written tree nor litter.
    discardStagingDir(stagingDir);
    // Step 17: re-raise the extraction failure to the caller.
    throw err;
  }
  // Step 11: swap the staged tree into place, moving any previous tree aside.
  const backupPath = commitStagedTree(stagingDir, destDir, extraction.roots, occupied);
  // Step 12: remove the now-empty staging directory (best effort).
  discardStagingDir(stagingDir);
  // Step 13: drop the spec repository's cached index — this tree arrived as a
  // directory swap, bypassing every save path the cache observes.
  invalidateSpecCache();
  // Step 14: assemble the import result.
  const result: TreeImportResult = {
    destDir,
    projectName: extraction.manifest.projectName,
    roots: extraction.roots,
    fileCount: extraction.writtenPaths.length,
    replaced: occupied,
  };
  if (backupPath) result.backupPath = backupPath;
  if (extraction.manifest.stateId) result.stateId = extraction.manifest.stateId;
  // Step 15: return what was written and where the backup went.
  return result;
}

// --- helpers ---------------------------------------------------------------

/**
 * The spec directory a root actually carries today: `.wai`, or the legacy
 * `.wairon` when that is what exists. An import always WRITES `.wai`, so a
 * legacy directory must be moved aside by its own name rather than left behind
 * shadowing the tree that replaced it.
 */
function liveSpecDirFor(rootDir: string): string | null {
  const modern = path.join(rootDir, '.wai');
  if (fs.existsSync(modern)) return modern;
  const legacy = path.join(rootDir, '.wairon');
  if (fs.existsSync(legacy)) return legacy;
  return null;
}

/** A filesystem-safe timestamp for one backup directory. */
function timestampSlug(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}
