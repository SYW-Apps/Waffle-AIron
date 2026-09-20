import * as fs from 'fs';
import * as path from 'path';
import { listFilesRecursive } from '../utils/fs.js';
import { readYamlFile, writeYamlFile } from '../utils/yaml.js';

// ---------------------------------------------------------------------------
// The spec tree's file face (spec_file_store).
//
// This module exists because the spec tree's STORAGE FORMAT is a decision the
// design owns, and a decision needs one place to live. Underneath it today are
// the project's general-purpose YAML and directory helpers — but those are
// infrastructure the whole codebase shares (project.yaml, pack manifests,
// templates, variants, surface snapshots and the registry all read YAML), and
// nothing about them is spec-aware. Pointing the store at them claimed two
// utility modules whole and made nineteen unrelated importers read as
// consumers of a Repository-private Store.
//
// So the store is these four functions and nothing else: every read, write,
// walk and DELETE of a spec document goes through here, and the format — YAML,
// with `.yaml` on disk — is chosen here once. Callers above this line address
// spec documents by path; callers below it know nothing about specs.
//
// Path resolution is deliberately NOT here. A spec path is resolved by the
// caller (AI_PATHS / aiPathsAt), because the store reads spec documents out of
// other project roots too — a chaining parent's tree, a mounted child's — and
// a store bound to one specs directory could not do that.
// ---------------------------------------------------------------------------

/** The extension a spec document carries on disk — the format decision, once. */
const SPEC_FILE_EXTENSION = '.yaml';

/**
 * Read and parse the spec document at `filePath`.
 * Returns null when the file is absent; throws on malformed content.
 */
export function readSpecFile(filePath: string): unknown {
  return readYamlFile(filePath);
}

/**
 * Serialize `document` in the spec storage format and write it to `filePath`,
 * creating parent directories as needed.
 */
export function writeSpecFile(filePath: string, document: unknown): void {
  writeYamlFile(filePath, document);
}

/**
 * Every spec document under `specsDir`, recursively.
 * An absent directory yields an empty list rather than an error.
 */
export function listSpecFiles(specsDir: string): string[] {
  return listFilesRecursive(specsDir, SPEC_FILE_EXTENSION);
}

/**
 * Delete the spec document at `filePath` and prune the parent directories the
 * deletion emptied, stopping at `specsRoot` so the root itself survives an
 * emptied tree. Answers false when there was no document there, so a caller can
 * tell "deleted" from "was never there" without a second existence check.
 *
 * `specsRoot` is a parameter for the same reason a path is: the store is
 * PATH-ADDRESSED, not root-bound, and the specs directory is configurable
 * (`paths.specsDir`), so the boundary cannot be derived from the path and the
 * store is the one component that must never read project.yaml to find it.
 */
export function remove(filePath: string, specsRoot: string): boolean {
  if (!fs.existsSync(filePath)) return false;
  fs.unlinkSync(filePath);
  pruneEmptyDirs(path.dirname(filePath), path.resolve(specsRoot));
  return true;
}

/** Remove each empty directory from `dir` upward, stopping before `specsRoot`. */
function pruneEmptyDirs(dir: string, specsRoot: string): void {
  let at = dir;
  while (at !== specsRoot && at.startsWith(specsRoot)) {
    if (!fs.existsSync(at) || fs.readdirSync(at).length > 0) return;
    fs.rmdirSync(at);
    at = path.dirname(at);
  }
}
