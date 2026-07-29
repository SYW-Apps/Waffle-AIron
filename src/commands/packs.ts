import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import chalk from 'chalk';
import { scaffoldPack, buildPack as sdkBuildPack, extractPack } from '@wairon/sdk';
import type { PackScaffoldRequest, PackBuildResult, PackExtractionResult } from '@wairon/sdk';
import { logger } from '../utils/logger.js';
import { getProjectRoot } from '../utils/fs.js';
import { isProjectInitialized, loadProjectConfig, saveProjectConfig } from '../config/loader.js';
import type { PackSelection } from '../models/project.js';
import {
  discoverPacks,
  globalPacksDir,
  loadExtensionPacks,
  packDirEntry,
  packEntryLabel,
  packEntryRef,
  globalPacksEnabled,
  PackScope,
} from '../core/extensions.js';
// The pack store reached through sdd_core's PUBLISHED surface (the core barrel is
// core_portal's realization) rather than by importing the store adapter module —
// same shape as every other cli_* adapter's hop into core.
import {
  packStoreDir,
  listInstalledPacks,
  resolveInstalledPack,
  installPackFromDirectory,
  uninstallPack,
  type InstalledPack,
} from '../core/index.js';

// ---------------------------------------------------------------------------
// pack command family — author, install, inspect, and remove extension packs.
//
// A pack is a plain file (or directory with a pack entry file) providing
// profiles, language tables, and rules; wairon just reads and imports it.
// Authoring goes through the @wairon/sdk portal: `pack init` scaffolds a pack
// project, `pack build` emits an installable `.wpack` archive.
//
// `pack add` INSTALLS a pack. A .wpack/.zip source is safely extracted (via the
// SDK) into .wai/packs/<name>/ and the directory registered; a plain file/dir
// source is VENDORED as before: project scope copies it into .wai/packs/ and
// registers it in project.yaml (committed → CI and every clone enforce it);
// --global copies it into ~/.wairon/packs (WAIRON_PACKS_DIR), which is
// auto-loaded for every project on this machine. A wrapper product's installer
// is just one `wairon pack add <file.wpack>` — these commands are equally
// usable by hand. `wairon packs` remains as a deprecated alias.
// ---------------------------------------------------------------------------

interface PackProbe {
  name?: string;
  profiles: number;
  languages: number;
  rules: number;
  skills: number;
  patterns: number;
  error?: string;
}

/** Load a single pack ref in isolation to learn its name/contents. */
function probePack(ref: string, baseRoot: string, scope: PackScope): PackProbe {
  const loaded = loadExtensionPacks([{ ref, scope }], baseRoot);
  if (loaded.errors.length) return { profiles: 0, languages: 0, rules: 0, skills: 0, patterns: 0, error: loaded.errors[0] };
  return {
    name: loaded.packNames[0],
    profiles: Object.keys(loaded.profiles).length,
    languages: Object.keys(loaded.languages).length,
    rules: loaded.rules.length,
    skills: loaded.skills.length,
    patterns: loaded.patterns.length,
  };
}

function describe(probe: PackProbe): string {
  const parts = [`${probe.profiles} profile(s)`, `${probe.languages} language(s)`, `${probe.rules} rule(s)`];
  if (probe.skills) parts.push(`${probe.skills} skill(s)`);
  if (probe.patterns) parts.push(`${probe.patterns} pattern(s)`);
  return parts.join(', ');
}

/** The unit to vendor: the file itself, or the whole directory of a directory pack. */
function resolveSourceUnit(source: string): { abs: string; isDir: boolean } {
  const abs = path.resolve(source);
  if (!fs.existsSync(abs)) {
    throw new Error(`Pack source "${source}" does not exist.`);
  }
  const isDir = fs.statSync(abs).isDirectory();
  if (isDir && !packDirEntry(abs)) {
    throw new Error(`"${source}" is a directory without a pack entry file (pack.yaml | pack.cjs | index.cjs | ...).`);
  }
  return { abs, isDir };
}

/** A .wpack / .zip archive source is installed via the SDK, not vendored verbatim. */
function isArchiveRef(source: string): boolean {
  return /\.(wpack|zip)$/i.test(source);
}

export async function addPack(source: string, options: { global?: boolean } = {}): Promise<void> {
  // ZIP-aware: a .wpack/.zip source is inspected + safely extracted via the SDK
  // and its DIRECTORY registered; a plain file/dir source falls through to the
  // unchanged vendoring path below.
  if (isArchiveRef(source)) {
    await addPackFromArchive(source, options);
    return;
  }

  const { abs } = resolveSourceUnit(source);

  // Verify the pack loads BEFORE vendoring it anywhere.
  const scope: PackScope = options.global ? 'global' : 'project';
  const probe = probePack(abs, path.dirname(abs), scope);
  if (probe.error) {
    logger.error(probe.error);
    process.exitCode = 1;
    return;
  }

  if (options.global) {
    const destDir = globalPacksDir();
    const dest = path.join(destDir, path.basename(abs));
    if (path.resolve(dest) !== abs) {
      fs.mkdirSync(destDir, { recursive: true });
      fs.cpSync(abs, dest, { recursive: true, force: true });
    }
    logger.success(`Installed pack "${probe.name}" globally: ${dest}`);
    logger.info(`${describe(probe)} — auto-loaded for every project on this machine (WAIRON_PACKS_DIR / ~/.wairon/packs).`);
    logger.info('Note: repo-defining doctrine belongs in project packs (committed); use `wairon pack add <source>` inside the project for that.');
    return;
  }

  if (!isProjectInitialized()) {
    logger.error('Not inside a wairon project — run `wairon init` first, or use --global for a machine-wide install.');
    process.exitCode = 1;
    return;
  }

  const root = getProjectRoot();
  const relRef = `.wai/packs/${path.basename(abs)}`;
  const dest = path.join(root, '.wai', 'packs', path.basename(abs));
  if (path.resolve(dest) !== abs) {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.cpSync(abs, dest, { recursive: true, force: true });
  }

  const config = loadProjectConfig();
  const packs = config.extensions?.packs ?? [];
  if (!packs.includes(relRef)) {
    config.extensions = { packs: [...packs, relRef], useGlobalPacks: globalPacksEnabled(config) };
    saveProjectConfig(config);
    logger.success(`Vendored pack "${probe.name}" into ${relRef} and registered it in .wai/project.yaml.`);
  } else {
    fs.cpSync(abs, dest, { recursive: true, force: true });
    logger.success(`Pack "${probe.name}" already registered — refreshed ${relRef} from the source.`);
  }
  logger.info(`${describe(probe)} — commit .wai/ so CI and every clone enforce it.`);
}

/**
 * Install a `.wpack`/`.zip` archive: read its bytes, safely extract it via the
 * SDK into .wai/packs/<name>/ (project) or <globalPacksDir>/<name>/ (--global)
 * — the pack name comes from the extraction result's manifest — then register
 * the resulting DIRECTORY ref exactly like vendoring does. The pack is probe-
 * loaded before anything is registered, so a malformed/unsafe archive fails
 * cleanly and leaves no partial registration.
 */
async function addPackFromArchive(source: string, options: { global?: boolean }): Promise<void> {
  const abs = path.resolve(source);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
    logger.error(`Pack archive "${source}" does not exist.`);
    process.exitCode = 1;
    return;
  }

  const scope: PackScope = options.global ? 'global' : 'project';

  // Resolve the base packs directory (project scope requires a project).
  let baseDir: string;
  if (options.global) {
    baseDir = globalPacksDir();
  } else {
    if (!isProjectInitialized()) {
      logger.error('Not inside a wairon project — run `wairon init` first, or use --global for a machine-wide install.');
      process.exitCode = 1;
      return;
    }
    baseDir = path.join(getProjectRoot(), '.wai', 'packs');
  }

  // Extract into a staging directory first; the pack's own name (and thus its
  // final directory) is only known from the extraction result's manifest.
  const bytes = fs.readFileSync(abs);
  fs.mkdirSync(baseDir, { recursive: true });
  const staging = fs.mkdtempSync(path.join(baseDir, '.wpack-staging-'));
  let result: PackExtractionResult;
  try {
    result = extractPack(bytes, staging);
  } catch (err) {
    fs.rmSync(staging, { recursive: true, force: true });
    logger.error(`Failed to extract pack archive "${path.basename(abs)}": ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
    return;
  }

  // Relocate the extracted tree to <name>/ (replacing any prior copy).
  const name = result.name;
  const destDir = path.join(baseDir, name);
  if (fs.existsSync(destDir)) fs.rmSync(destDir, { recursive: true, force: true });
  fs.renameSync(staging, destDir);

  // Probe-verify the extracted pack loads BEFORE registering anything.
  const probe = probePack(destDir, path.dirname(destDir), scope);
  if (probe.error) {
    fs.rmSync(destDir, { recursive: true, force: true });
    logger.error(probe.error);
    process.exitCode = 1;
    return;
  }

  if (options.global) {
    logger.success(`Installed pack "${probe.name ?? name}" globally: ${destDir}`);
    logger.info(`${describe(probe)} — auto-loaded for every project on this machine (WAIRON_PACKS_DIR / ~/.wairon/packs).`);
    return;
  }

  // Register the DIRECTORY ref, exactly like vendoring registers a ref.
  const relRef = `.wai/packs/${name}`;
  const config = loadProjectConfig();
  const packs = config.extensions?.packs ?? [];
  if (!packs.includes(relRef)) {
    config.extensions = { packs: [...packs, relRef], useGlobalPacks: globalPacksEnabled(config) };
    saveProjectConfig(config);
    logger.success(`Installed pack "${probe.name ?? name}" into ${relRef} and registered it in .wai/project.yaml.`);
  } else {
    logger.success(`Pack "${probe.name ?? name}" already registered — refreshed ${relRef} from ${path.basename(abs)}.`);
  }
  logger.info(`${describe(probe)} — commit .wai/ so CI and every clone enforce it.`);
}

/**
 * `wairon pack init <name>` — scaffold a new pack project (declarative or code
 * variant, optional skill stub) via the SDK portal, then print the created
 * files and next steps. A code pack's package.json pins @wairon/sdk to the
 * running SDK version so it builds against a matching contract.
 */
export async function initPack(
  name: string,
  options: { kind?: 'declarative' | 'code'; dir?: string; skill?: boolean } = {},
): Promise<void> {
  const kind = options.kind === 'code' ? 'code' : 'declarative';
  const targetDir = options.dir ?? `./${name}`;
  const request: PackScaffoldRequest = { name, kind, targetDir };
  if (options.skill) request.withSkill = true;

  // Step 1: scaffold the pack project via the SDK portal.
  const created = scaffoldPack(request);

  // Step 2: print the created file paths and next-step guidance.
  logger.success(`Scaffolded ${kind} pack "${name}" into ${targetDir}`);
  for (const file of created) {
    console.log(`  ${chalk.green('+')} ${chalk.dim(file)}`);
  }
  logger.blank();
  logger.info(`Next: cd ${targetDir} && wairon pack build`);
}

/**
 * `wairon pack build [source]` — build an installable `.wpack` archive from a
 * pack directory via the SDK portal, write it to <name>-<version>.wpack (or
 * --out), and report the path + size. The SDK seals integrity and validates the
 * envelope against the inner pack manifest before emitting the archive.
 */
export async function buildPack(source: string, options: { out?: string } = {}): Promise<void> {
  const sourceDir = source && source.length > 0 ? source : '.';

  // Step 1: build the archive via the SDK portal.
  const result: PackBuildResult = sdkBuildPack(sourceDir);

  // Step 2: write the archive bytes to --out (or the suggested file name) and report.
  const outPath = options.out ?? result.suggestedFileName;
  fs.writeFileSync(outPath, result.archive);
  logger.success(`Built pack "${result.info.name}" v${result.info.version} → ${outPath} (${result.archive.byteLength} bytes)`);
  logger.info(`Install it with \`wairon pack add ${outPath}\`, or upload it to a hosted instance.`);
}

// ---------------------------------------------------------------------------
// The pack STORE — install / uninstall / which.
//
// `pack install` puts a pack into this wairon install's store and applies it to
// NOTHING: a project opts in by selecting it. That is the split `pack add
// --global` never made — installing there also granted the pack authority over
// every project on the machine, so the gate differed per developer and CI
// disagreed with every local run. See docs/design/pack-scoping.md.
// ---------------------------------------------------------------------------

/** `wairon pack install <source>` — install into the store; applies to nothing until selected. */
export async function installPack(source: string): Promise<void> {
  let sourceDir: string;
  let origin: string;
  let cleanup: string | null = null;

  if (isArchiveRef(source)) {
    // Archives go through the SDK's hardened path (envelope inspection, code-pack
    // refusal, extraction limits) exactly as `pack add` does — the store adapter
    // never parses untrusted bytes.
    const extracted = extractArchiveToTemp(source);
    if (!extracted) return;
    sourceDir = extracted.dir;
    cleanup = extracted.dir;
    origin = path.resolve(source);
  } else {
    let unit;
    try {
      unit = resolveSourceUnit(source);
    } catch (e) {
      logger.error(e instanceof Error ? e.message : String(e));
      process.exitCode = 1;
      return;
    }
    if (!unit.isDir) {
      logger.error(`"${source}" is a single pack file. Install a pack DIRECTORY or a .wpack archive, so the store can version it.`);
      process.exitCode = 1;
      return;
    }
    sourceDir = unit.abs;
    origin = unit.abs;
  }

  try {
    const installed = installPackFromDirectory(sourceDir, origin);
    logger.success(`Installed ${installed.name} v${installed.version} into the pack store.`);
    console.log(`  ${chalk.dim(installed.path)}`);
    console.log(`  ${chalk.dim(installed.digest)}`);
    logger.blank();
    logger.info(`This applies to NOTHING yet — a project opts in with: ${chalk.cyan(`wairon pack use ${installed.name}`)}`);
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(origin)) {
      logger.warn('Installed from a local path, so no fetchable source was recorded — CI and a fresh clone cannot obtain it. Bundle it into the project, or record a URL when selecting it.');
    }
  } catch (e) {
    logger.error(e instanceof Error ? e.message : String(e));
    process.exitCode = 1;
  } finally {
    if (cleanup) { try { fs.rmSync(cleanup, { recursive: true, force: true }); } catch { /* temp dir */ } }
  }
}

/** Extract a .wpack/.zip into a temp directory via the SDK, or null on failure. */
function extractArchiveToTemp(source: string): { dir: string } | null {
  const abs = path.resolve(source);
  if (!fs.existsSync(abs)) {
    logger.error(`Pack archive "${source}" does not exist.`);
    process.exitCode = 1;
    return null;
  }
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-packinstall-'));
  try {
    const result: PackExtractionResult = extractPack(new Uint8Array(fs.readFileSync(abs)), tempDir);
    void result;
    return { dir: tempDir };
  } catch (e) {
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* temp dir */ }
    logger.error(`Could not extract "${source}": ${e instanceof Error ? e.message : String(e)}`);
    process.exitCode = 1;
    return null;
  }
}

/** `wairon pack uninstall <name>[@version]` — remove from the store. */
export async function uninstallStorePack(spec: string): Promise<void> {
  const { name, version } = parseNameAtVersion(spec);
  if (!uninstallPack(name, version)) {
    logger.error(`No pack "${spec}" is installed in the store (${packStoreDir()}).`);
    process.exitCode = 1;
    return;
  }
  logger.success(`Uninstalled ${version ? `${name} v${version}` : `every version of ${name}`} from the pack store.`);
  logger.info('A project that still SELECTS it will now fail its gate with PACK_NOT_INSTALLED — reinstall it or drop the selection.');
}

/** `wairon pack which <name>[@version]` — identify exactly which pack resolves. */
export async function whichPack(spec: string): Promise<void> {
  const { name, version } = parseNameAtVersion(spec);
  const resolved = resolveInstalledPack(name, version);
  if (!resolved) {
    logger.error(`No pack "${spec}" is installed in the store (${packStoreDir()}).`);
    const names = [...new Set(listInstalledPacks().map((p) => p.name))];
    if (names.length) logger.info(`Installed: ${names.join(', ')}`);
    process.exitCode = 1;
    return;
  }
  printInstalled(resolved, version === undefined);
}

function printInstalled(pack: InstalledPack, latestByDefault: boolean): void {
  console.log(`${chalk.bold(pack.name)} ${chalk.cyan(`v${pack.version}`)}${latestByDefault ? chalk.dim('  (latest installed)') : ''}`);
  console.log(`  path     ${chalk.dim(pack.path)}`);
  console.log(`  digest   ${chalk.dim(pack.digest)}`);
  console.log(`  origin   ${pack.origin ? chalk.dim(pack.origin) : chalk.yellow('(not recorded)')}`);
  if (pack.installedAt) console.log(`  installed ${chalk.dim(pack.installedAt)}`);
  if (pack.waironVersion) console.log(`  by wairon ${chalk.dim(pack.waironVersion)}`);
}

/**
 * `wairon pack use <name>[@version]` — SELECT an installed pack for this project.
 *
 * The selection is recorded by name in project.yaml, and the `source` is copied
 * from the store's install record so the project self-describes how a fresh
 * machine or CI runner obtains the same doctrine. Omitting a version means
 * "latest installed"; `--pin` freezes the resolved version and its digest.
 */
export async function usePack(
  spec: string,
  options: { source?: string; bundle?: boolean; pin?: boolean } = {},
): Promise<void> {
  if (!isProjectInitialized()) {
    logger.error('Not inside a wairon project — run `wairon init` first.');
    process.exitCode = 1;
    return;
  }
  const { name, version } = parseNameAtVersion(spec);
  const resolved = resolveInstalledPack(name, version);
  if (!resolved) {
    logger.error(`No pack "${spec}" is installed in the store (${packStoreDir()}). Install it first: wairon pack install <source>`);
    const names = [...new Set(listInstalledPacks().map((p) => p.name))];
    if (names.length) logger.info(`Installed: ${names.join(', ')}`);
    process.exitCode = 1;
    return;
  }

  const recorded = options.source ?? resolved.origin;
  const selection = buildSelection(resolved, { ...options, pinVersion: version !== undefined });
  const reselected = writeSelection(selection);

  logger.success(`${reselected ? 'Re-selected' : 'Selected'} pack "${resolved.name}"${selection.version ? ` v${selection.version}` : ' (latest installed)'} for this project.`);
  if (options.bundle) {
    logger.info('Marked for bundling — run `wairon pack bundle` to commit a copy under .wai/packs/ so the repo needs no machine setup.');
  }
  warnIfUnobtainable(selection, recorded, options.bundle === true);
  logger.info('Commit .wai/project.yaml so every clone applies the same doctrine.');
}

/** True for a source a fresh machine or CI runner could actually fetch. */
function isFetchableSource(source: string | undefined): source is string {
  return source !== undefined && /^[a-z][a-z0-9+.-]*:\/\//i.test(source);
}

/**
 * Compose the selection to record. The version is written only when the user
 * asked for one (explicit `@version` or `--pin`); otherwise the selection tracks
 * latest-installed. The source is carried over from the store's install record —
 * so the user never types a URL — but only when it is actually fetchable.
 */
function buildSelection(
  resolved: InstalledPack,
  options: { source?: string; bundle?: boolean; pin?: boolean; pinVersion: boolean },
): PackSelection {
  const source = options.source ?? resolved.origin;
  const selection: PackSelection = { name: resolved.name };
  if (options.pinVersion || options.pin) selection.version = resolved.version;
  if (options.pin) selection.integrity = resolved.digest;
  if (isFetchableSource(source)) selection.source = source;
  if (options.bundle) selection.bundle = true;
  return selection;
}

/** Record the selection, replacing any existing one for the same pack. Returns whether it replaced. */
function writeSelection(selection: PackSelection): boolean {
  const config = loadProjectConfig();
  const existing = config.extensions?.packs ?? [];
  const without = existing.filter((e) => typeof e === 'string' || e.name !== selection.name);
  config.extensions = {
    packs: [...without, selection],
    useGlobalPacks: globalPacksEnabled(config),
  };
  saveProjectConfig(config);
  return without.length !== existing.length;
}

/** A selection with neither a fetchable source nor a bundle cannot be resolved by CI or a clone. */
function warnIfUnobtainable(selection: PackSelection, recorded: string | undefined, bundled: boolean): void {
  if (selection.source !== undefined || bundled) return;
  logger.warn(
    recorded
      ? `The recorded origin (${recorded}) is not a fetchable URL, so no source was written. CI and a fresh clone cannot obtain this pack — re-run with --source <url>, or --bundle to commit a copy.`
      : 'No source is recorded for this pack, so CI and a fresh clone cannot obtain it — re-run with --source <url>, or --bundle to commit a copy.',
  );
}

/**
 * `wairon pack bundle [name] [--all]` — commit a copy of a selected pack under
 * `.wai/packs/<name>/<version>/`.
 *
 * This is what makes a repository self-sufficient: a bundled pack resolves BEFORE
 * the store, so a clone and CI apply the doctrine with an empty store and no
 * network. The version is pinned in the selection at the same time, because a
 * bundle is a copy of one specific version — leaving the selection floating would
 * let the committed bytes and the declared intent drift apart.
 */
/** Which selections to bundle: the named one, all of them, or those already marked. */
function bundleTargets(selections: PackSelection[], name: string | undefined, all: boolean): PackSelection[] {
  if (all) return selections;
  if (name) return selections.filter((s) => s.name === name);
  return selections.filter((s) => s.bundle === true);
}

/** Replace the committed copy of one pack, returning where it was written. */
function writeBundle(root: string, resolved: InstalledPack): string {
  const dest = path.join(root, '.wai', 'packs', resolved.name, resolved.version);
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.cpSync(resolved.path, dest, { recursive: true });
  return dest;
}

export async function bundlePack(name?: string, options: { all?: boolean } = {}): Promise<void> {
  if (!isProjectInitialized()) {
    logger.error('Not inside a wairon project — run `wairon init` first.');
    process.exitCode = 1;
    return;
  }
  const root = getProjectRoot();
  const config = loadProjectConfig();
  const entries = config.extensions?.packs ?? [];
  const selections = entries.filter((e): e is PackSelection => typeof e !== 'string');

  const targets = bundleTargets(selections, name, options.all === true);
  if (targets.length === 0) {
    logger.error(name
      ? `This project does not select a pack named "${name}".`
      : 'No pack selections are marked for bundling. Pass a name, use --all, or select with `wairon pack use <name> --bundle`.');
    process.exitCode = 1;
    return;
  }

  const bundled: string[] = [];
  for (const selection of targets) {
    const resolved = resolveInstalledPack(selection.name, selection.version);
    if (!resolved) {
      logger.error(`Cannot bundle "${packEntryLabel(selection)}": it is not installed in the store (${packStoreDir()}). Install it first.`);
      process.exitCode = 1;
      continue;
    }
    const dest = writeBundle(root, resolved);

    // Pin what was actually committed, and record the bundle so resolution and
    // a later `pack bundle` (no args) both know this pack travels with the repo.
    selection.version = resolved.version;
    selection.bundle = true;
    bundled.push(`${resolved.name}@${resolved.version}`);
    console.log(`  ${chalk.green('+')} ${chalk.dim(path.relative(root, dest).replace(/\\/g, '/'))}`);
  }

  if (bundled.length === 0) return;
  config.extensions = { packs: entries, useGlobalPacks: globalPacksEnabled(config) };
  saveProjectConfig(config);
  logger.success(`Bundled ${bundled.length} pack(s) into .wai/packs/: ${bundled.join(', ')}.`);
  logger.info('Commit .wai/ — a clone and CI now apply this doctrine with no pack store and no network.');
}

/** `wairon pack unuse <name>` — deselect a pack for this project (it stays installed). */
export async function unusePack(name: string): Promise<void> {
  if (!isProjectInitialized()) {
    logger.error('Not inside a wairon project — run `wairon init` first.');
    process.exitCode = 1;
    return;
  }
  const config = loadProjectConfig();
  const existing = config.extensions?.packs ?? [];
  const remaining = existing.filter((e) => typeof e === 'string' || e.name !== name);
  if (remaining.length === existing.length) {
    logger.error(`This project does not select a pack named "${name}".`);
    process.exitCode = 1;
    return;
  }
  config.extensions = { packs: remaining, useGlobalPacks: globalPacksEnabled(config) };
  saveProjectConfig(config);
  logger.success(`Deselected pack "${name}" — it remains installed in the store.`);
  logger.info('Its profiles, rules, and assertions no longer apply to this project; re-validate to see the change.');
}

/** Split `name` or `name@version`. */
function parseNameAtVersion(spec: string): { name: string; version?: string } {
  const at = spec.lastIndexOf('@');
  if (at <= 0) return { name: spec };
  return { name: spec.slice(0, at), version: spec.slice(at + 1) };
}

export async function listPacks(): Promise<void> {
  const inProject = isProjectInitialized();
  const config = inProject ? loadProjectConfig() : undefined;
  const useGlobal = globalPacksEnabled(config ?? {});
  const root = inProject ? getProjectRoot() : process.cwd();

  console.log(chalk.bold('\nExtension packs\n'));

  const globalRefs = discoverPacks(globalPacksDir());
  console.log(chalk.bold.cyan(`■ Global (${globalPacksDir()})${useGlobal ? '' : chalk.yellow('  [disabled: extensions.useGlobalPacks: false]')}`));
  if (globalRefs.length === 0) console.log(chalk.dim('  (none)'));
  for (const ref of globalRefs) {
    const probe = probePack(ref, path.dirname(ref), 'global');
    if (probe.error) console.log(`  ${chalk.red('✖')} ${path.basename(ref)} — ${chalk.red(probe.error)}`);
    else console.log(`  ${chalk.green('●')} ${chalk.bold(probe.name ?? path.basename(ref))}  ${chalk.dim(describe(probe))}`);
  }

  console.log('');
  if (!inProject) {
    console.log(chalk.dim('Not inside a wairon project — project packs not shown.'));
    return;
  }
  console.log(chalk.bold.cyan('■ Project (.wai/project.yaml → extensions.packs)'));
  const projectEntries = config?.extensions?.packs ?? [];
  if (projectEntries.length === 0) console.log(chalk.dim('  (none)'));
  for (const entry of projectEntries) {
    // A by-name SELECTION is listed under its declared label and probed at
    // wherever it resolves (bundle, then store); an unresolvable one is shown as
    // the error it is, because the project declared doctrine it is not getting.
    const label = packEntryLabel(entry);
    const ref = packEntryRef(entry, root);
    if (!ref) {
      console.log(`  ${chalk.red('✖')} ${label} — ${chalk.red('declared but not installed or bundled')}`);
      continue;
    }
    const probe = probePack(ref, root, 'project');
    const origin = typeof entry === 'string' ? ref : `selected → ${ref}`;
    if (probe.error) console.log(`  ${chalk.red('✖')} ${label} — ${chalk.red(probe.error)}`);
    else console.log(`  ${chalk.green('●')} ${chalk.bold(probe.name ?? label)}  ${chalk.dim(origin)}  ${chalk.dim(describe(probe))}`);
  }
  console.log('');
  logger.info('Rules from packs show up in `wairon rules list`; add packs with `wairon pack add <source> [--global]`.');
}

export async function removePack(name: string, options: { global?: boolean } = {}): Promise<void> {
  if (options.global) {
    for (const ref of discoverPacks(globalPacksDir())) {
      const probe = probePack(ref, path.dirname(ref), 'global');
      if (probe.name === name || path.basename(ref) === name) {
        fs.rmSync(ref, { recursive: true, force: true });
        logger.success(`Removed global pack "${probe.name ?? name}" (${ref}).`);
        return;
      }
    }
    logger.error(`No global pack named "${name}" found in ${globalPacksDir()}.`);
    process.exitCode = 1;
    return;
  }

  if (!isProjectInitialized()) {
    logger.error('Not inside a wairon project — use --global to remove a machine-wide pack.');
    process.exitCode = 1;
    return;
  }
  const root = getProjectRoot();
  const config = loadProjectConfig();
  const packs = config.extensions?.packs ?? [];
  for (const entry of packs) {
    // `pack remove` is the LEGACY vendored-pack command; a by-name selection is
    // dropped with `pack unuse` (which leaves the pack installed), so skip those.
    if (typeof entry !== 'string') continue;
    const ref = entry;
    const probe = probePack(ref, root, 'project');
    if (probe.name === name || ref === name || path.basename(ref) === name) {
      config.extensions = {
        packs: packs.filter(p => p !== ref),
        useGlobalPacks: globalPacksEnabled(config),
      };
      saveProjectConfig(config);
      // Delete vendored files, but never paths outside .wai/packs (the ref
      // may point at a location the user owns).
      const resolved = path.resolve(root, ref);
      const vendorDir = path.resolve(root, '.wai', 'packs');
      if (resolved.startsWith(vendorDir + path.sep)) {
        fs.rmSync(resolved, { recursive: true, force: true });
        logger.success(`Deregistered pack "${probe.name ?? name}" and deleted ${ref}.`);
      } else {
        logger.success(`Deregistered pack "${probe.name ?? name}" (files at ${ref} left in place).`);
      }
      return;
    }
  }
  logger.error(`No project pack named "${name}" registered. See \`wairon packs list\`.`);
  process.exitCode = 1;
}
