import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { readYamlFile, writeYamlFile } from '../utils/yaml.js';
import { WAIRON_VERSION } from '../config/defaults.js';
import { isNewerVersion } from '../utils/version.js';
import { globalPacksDir, packDirEntry, readManifest } from './extensions.js';

// ---------------------------------------------------------------------------
// Pack Store Adapter (sdd_core)
//
// The machine-wide pool of INSTALLED extension packs. Installed is not applied:
// nothing here governs a project until that project selects it by name in
// .wai/project.yaml. That separation is the whole point — a pack installed on a
// developer's machine must not silently inject profiles, rules, and skills into
// every project on disk, because then the gate, the skills list, and the MCP
// instructions differ per developer and CI disagrees with every local run.
//
// Layout: <store>/<name>/<version>/ — versioned, so several versions coexist and
// two projects on one machine can select different ones. Each installed pack
// carries a sibling install record (.install.yaml) holding its origin, content
// digest, and provenance; the origin is what lets a project selection record a
// `source`, so a fresh machine or CI runner can obtain the same doctrine.
//
// The pre-versioned FLAT layout (a bare pack file, or a pack directory holding
// its entry file directly) still resolves, reported at version
// "0.0.0-unversioned" — an existing install keeps working while projects migrate
// to explicit selection.
//
// See docs/design/pack-scoping.md.
// ---------------------------------------------------------------------------

/** Version recorded for a pack that declares none, and for legacy flat entries. */
export const UNVERSIONED = '0.0.0-unversioned';

/** Per-pack install record, written beside the installed pack. */
const INSTALL_RECORD = '.install.yaml';

/** Never part of a pack's content digest. */
const DIGEST_EXCLUDED = new Set([INSTALL_RECORD, '.git', 'node_modules', '.DS_Store']);

/** One pack present in the store — see the `installed_pack` type spec. */
export interface InstalledPack {
  name: string;
  version: string;
  digest: string;
  origin?: string;
  installedAt?: string;
  waironVersion?: string;
  path: string;
}

interface InstallRecord {
  origin?: string;
  digest?: string;
  waironVersion?: string;
  installedAt?: string;
}

/**
 * This wairon install's pack store directory. Delegates to the pack source
 * adapter's resolver so the store and the loader can never disagree about where
 * packs live.
 */
export function packStoreDir(): string {
  return globalPacksDir();
}

// ---------------------------------------------------------------------------
// Content digest
// ---------------------------------------------------------------------------

/** Regular files under `dir`, as sorted forward-slash relative paths. */
function packFiles(dir: string, prefix = ''): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const e of entries) {
    if (DIGEST_EXCLUDED.has(e.name)) continue;
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...packFiles(path.join(dir, e.name), rel));
    else if (e.isFile()) out.push(rel);
  }
  return out.sort();
}

/**
 * Canonical sha256 over a pack's content: each file's normalized relative path
 * and bytes, folded in sorted order. Sorting and forward-slash normalization are
 * what make the digest reproducible across platforms and independent of HOW the
 * pack arrived — so an archive install, a directory install, and a committed
 * project bundle of the same pack all compare equal.
 *
 * A single-file pack (the legacy flat form) is digested as one entry keyed by its
 * basename, so it gets a stable identity too.
 */
export function computePackDigest(packDir: string): string {
  const hash = crypto.createHash('sha256');
  const abs = path.resolve(packDir);

  let isFile = false;
  try { isFile = fs.statSync(abs).isFile(); } catch { /* missing → empty digest below */ }

  const entries: [string, string][] = isFile
    ? [[path.basename(abs), abs]]
    : packFiles(abs).map((rel) => [rel, path.join(abs, rel)]);

  for (const [rel, full] of entries) {
    hash.update(rel);
    hash.update('\0');
    try { hash.update(fs.readFileSync(full)); } catch { /* unreadable file contributes its path only */ }
    hash.update('\0');
  }
  return `sha256-${hash.digest('hex')}`;
}

// ---------------------------------------------------------------------------
// Enumeration
// ---------------------------------------------------------------------------

function readInstallRecord(packPath: string): InstallRecord {
  try {
    const raw = readYamlFile(path.join(packPath, INSTALL_RECORD));
    return (raw && typeof raw === 'object' ? raw : {}) as InstallRecord;
  } catch {
    return {};
  }
}

/** The pack name a manifest declares, or null when it cannot be read cheaply. */
function declaredName(entryFile: string): string | null {
  if (!/\.ya?ml$/i.test(entryFile)) return null; // requiring a JS pack to read a name is not worth the side effects
  try {
    const raw = readYamlFile(entryFile) as { name?: unknown } | null;
    return typeof raw?.name === 'string' && raw.name.length > 0 ? raw.name : null;
  } catch {
    return null;
  }
}

const PACK_FILE_RE = /\.(ya?ml|cjs|js)$/i;

/** Assemble an InstalledPack from an installed location, falling back to a recomputed digest. */
function installedFrom(location: string, name: string, version: string): InstalledPack {
  const record = readInstallRecord(location);
  return {
    name,
    version,
    digest: record.digest ?? computePackDigest(location),
    origin: record.origin,
    installedAt: record.installedAt,
    waironVersion: record.waironVersion,
    path: location,
  };
}

/** The `<name>/<version>/` packs under a versioned store entry. */
function versionedEntries(nameDir: string, fallbackName: string): InstalledPack[] {
  let versions: fs.Dirent[];
  try {
    versions = fs.readdirSync(nameDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: InstalledPack[] = [];
  for (const v of versions) {
    if (!v.isDirectory()) continue;
    const versionDir = path.join(nameDir, v.name);
    const entryFile = packDirEntry(versionDir);
    if (!entryFile) continue;
    out.push(installedFrom(versionDir, declaredName(entryFile) ?? fallbackName, v.name));
  }
  return out;
}

/**
 * Classify one store entry into the packs it holds. Three shapes coexist so an
 * install predating the versioned layout keeps resolving: a bare pack FILE, a
 * pack DIRECTORY holding its entry file directly (both legacy, reported
 * unversioned), and the current `<name>/<version>/` layout.
 */
function storeEntryPacks(store: string, entry: fs.Dirent): InstalledPack[] {
  const full = path.join(store, entry.name);

  if (entry.isFile()) {
    if (!PACK_FILE_RE.test(entry.name)) return [];
    const name = declaredName(full) ?? entry.name.replace(PACK_FILE_RE, '');
    // A single-file pack has no directory to hold an install record.
    return [{ name, version: UNVERSIONED, digest: computePackDigest(full), path: full }];
  }
  if (!entry.isDirectory()) return [];

  const directEntry = packDirEntry(full);
  if (directEntry) return [installedFrom(full, declaredName(directEntry) ?? entry.name, UNVERSIONED)];

  return versionedEntries(full, entry.name);
}

/**
 * Every pack installed in the store, ordered by name then NEWEST VERSION FIRST
 * (so resolution takes [0]). A missing or unreadable store is an empty list, never
 * an error: having nothing installed is a normal state.
 */
export function listInstalledPacks(): InstalledPack[] {
  const store = packStoreDir();
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(store, { withFileTypes: true });
  } catch {
    return [];
  }

  return entries
    .flatMap((entry) => storeEntryPacks(store, entry))
    .sort((a, b) => {
      if (a.name !== b.name) return a.name.localeCompare(b.name);
      if (a.version === b.version) return 0;
      return isNewerVersion(b.version, a.version) ? -1 : 1;
    });
}

/**
 * Resolve a project selection against the store: the exact version when pinned,
 * otherwise the HIGHEST installed version (latest-by-default).
 *
 * Null is a normal answer meaning "declared but not installed" — the caller turns
 * it into a loud PACK_NOT_INSTALLED finding rather than quietly proceeding with
 * less doctrine than the project declared.
 */
export function resolveInstalledPack(name: string, version?: string): InstalledPack | null {
  const candidates = listInstalledPacks().filter((p) => p.name === name);
  if (candidates.length === 0) return null;
  if (version) return candidates.find((p) => p.version === version) ?? null;
  return candidates[0]; // newest first, per listInstalledPacks' ordering
}

// ---------------------------------------------------------------------------
// Mutation
// ---------------------------------------------------------------------------

/**
 * Install an already-materialized pack directory into the store at
 * <name>/<version>/, digest it, and write its install record.
 *
 * The manifest is read (and schema-validated) BEFORE anything is written, so a
 * malformed pack fails cleanly and never leaves a partial install in the store.
 * Archive handling stays with the caller — a .wpack is extracted through the SDK
 * first, so this adapter never parses untrusted bytes.
 */
export function installPackFromDirectory(sourceDir: string, origin?: string): InstalledPack {
  const abs = path.resolve(sourceDir);
  const entryFile = packDirEntry(abs);
  if (!entryFile) {
    throw new Error(`"${sourceDir}" is not a pack directory (no pack.yaml | pack.cjs | index.cjs | …).`);
  }

  const manifest = readManifest(entryFile, path.dirname(entryFile));
  const version = manifest.version && manifest.version.length > 0 ? manifest.version : UNVERSIONED;
  const dest = path.join(packStoreDir(), manifest.name, version);

  // Reinstalling the same name@version replaces it, so an install is idempotent.
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.cpSync(abs, dest, { recursive: true });

  const digest = computePackDigest(dest);
  const record: InstallRecord = {
    origin,
    digest,
    waironVersion: WAIRON_VERSION,
    installedAt: new Date().toISOString(),
  };
  writeYamlFile(path.join(dest, INSTALL_RECORD), record);

  return {
    name: manifest.name,
    version,
    digest,
    origin,
    installedAt: record.installedAt,
    waironVersion: record.waironVersion,
    path: dest,
  };
}

/**
 * Remove a pack from the store: the named version, or every version when none is
 * given. Returns whether anything existed to remove.
 *
 * Refusing an uninstall that a project still selects belongs to the calling
 * workflow — this adapter reports what it removed.
 */
export function uninstallPack(name: string, version?: string): boolean {
  const targets = listInstalledPacks().filter((p) => p.name === name && (!version || p.version === version));
  if (targets.length === 0) return false;

  for (const target of targets) {
    fs.rmSync(target.path, { recursive: true, force: true });
    // Prune the now-empty <store>/<name>/ level left behind by a versioned pack.
    const parent = path.dirname(target.path);
    if (path.resolve(parent) === path.resolve(packStoreDir())) continue;
    try {
      if (fs.readdirSync(parent).length === 0) fs.rmdirSync(parent);
    } catch { /* not empty, or already gone */ }
  }
  return true;
}
