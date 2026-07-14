import * as fs from 'fs';
import * as path from 'path';
import chalk from 'chalk';
import { logger } from '../utils/logger.js';
import { getProjectRoot } from '../utils/fs.js';
import { isProjectInitialized, loadProjectConfig, saveProjectConfig } from '../config/loader.js';
import {
  discoverPacks,
  globalPacksDir,
  loadExtensionPacks,
  packDirEntry,
  PackScope,
} from '../core/extensions.js';

// ---------------------------------------------------------------------------
// packs command — install/inspect/remove extension packs.
//
// A pack is a plain file (or directory with a pack entry file) providing
// profiles, language tables, and rules; wairon just reads and imports it.
// `packs add` VENDORS a pack: project scope copies it into .wai/packs/ and
// registers it in project.yaml (committed → CI and every clone enforce it);
// --global copies it into ~/.wairon/packs (WAIRON_PACKS_DIR), which is
// auto-loaded for every project on this machine. A wrapper product's
// installer is just an unzip + one `wairon packs add` — these commands are
// equally usable by hand.
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

export async function addPack(source: string, options: { global?: boolean } = {}): Promise<void> {
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
    logger.info('Note: repo-defining doctrine belongs in project packs (committed); use `wairon packs add <source>` inside the project for that.');
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
    config.extensions = { packs: [...packs, relRef], useGlobalPacks: config.extensions?.useGlobalPacks ?? true };
    saveProjectConfig(config);
    logger.success(`Vendored pack "${probe.name}" into ${relRef} and registered it in .wai/project.yaml.`);
  } else {
    fs.cpSync(abs, dest, { recursive: true, force: true });
    logger.success(`Pack "${probe.name}" already registered — refreshed ${relRef} from the source.`);
  }
  logger.info(`${describe(probe)} — commit .wai/ so CI and every clone enforce it.`);
}

export async function listPacks(): Promise<void> {
  const inProject = isProjectInitialized();
  const config = inProject ? loadProjectConfig() : undefined;
  const useGlobal = config?.extensions?.useGlobalPacks ?? true;
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
  const projectRefs = config?.extensions?.packs ?? [];
  if (projectRefs.length === 0) console.log(chalk.dim('  (none)'));
  for (const ref of projectRefs) {
    const probe = probePack(ref, root, 'project');
    if (probe.error) console.log(`  ${chalk.red('✖')} ${ref} — ${chalk.red(probe.error)}`);
    else console.log(`  ${chalk.green('●')} ${chalk.bold(probe.name ?? ref)}  ${chalk.dim(ref)}  ${chalk.dim(describe(probe))}`);
  }
  console.log('');
  logger.info('Rules from packs show up in `wairon rules list`; add packs with `wairon packs add <source> [--global]`.');
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
  for (const ref of packs) {
    const probe = probePack(ref, root, 'project');
    if (probe.name === name || ref === name || path.basename(ref) === name) {
      config.extensions = {
        packs: packs.filter(p => p !== ref),
        useGlobalPacks: config.extensions?.useGlobalPacks ?? true,
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
