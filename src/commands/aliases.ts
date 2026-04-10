import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import chalk from 'chalk';
import { logger } from '../utils/logger.js';
import { SUPPORTED_ALIASES, SupportedAlias } from '../config/defaults.js';
import {
  getDisabledAliases,
  setDisabledAliases,
  getInstallDir,
} from '../config/userconfig.js';

// ---------------------------------------------------------------------------
// aliases command
//
// Manages the short command names that point to waffagent.
//
// For npm installs: the bin entries in package.json already register all
// aliases — this command reports their status but cannot change npm's setup.
//
// For binary installs (pkg builds): this command creates/removes symlinks
// (Unix) or .cmd wrapper files (Windows) in the install directory.
//
// Usage:
//   waffagent aliases list
//   waffagent aliases enable wagent
//   waffagent aliases disable wagent
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

export async function runAliasesList(): Promise<void> {
  const disabled = new Set(getDisabledAliases());
  const installDir = resolveInstallDir();
  const isNpm = !isPkgBinary();

  logger.header('Command aliases');
  logger.blank();

  if (isNpm) {
    logger.info('Installed via npm — aliases are managed by package.json bin entries.');
    logger.blank();
  }

  for (const alias of SUPPORTED_ALIASES) {
    const isDisabled = disabled.has(alias);
    const conflict = detectConflict(alias, installDir);

    let statusLabel: string;
    let note = '';

    if (isNpm) {
      statusLabel = chalk.green('active (npm)');
    } else if (isDisabled) {
      statusLabel = chalk.gray('disabled');
    } else if (conflict) {
      statusLabel = chalk.yellow('conflict');
      note = `  ← ${chalk.yellow(conflict)}`;
    } else {
      const filePath = aliasFilePath(alias, installDir);
      const exists = filePath ? fs.existsSync(filePath) : false;
      statusLabel = exists ? chalk.green('active') : chalk.red('missing');
      if (!exists && !isDisabled) {
        note = '  ← run `waffagent aliases enable ' + alias + '` to create';
      }
    }

    console.log(`  ${chalk.bold(alias.padEnd(16))} ${statusLabel}${note}`);
  }

  logger.blank();

  if (!isNpm && installDir) {
    logger.info(`Install directory: ${installDir}`);
  } else if (!isNpm && !installDir) {
    logger.warn('Install directory unknown. Run the install script to set it, or set it manually:');
    logger.info('  waffagent aliases enable <name>  (will attempt to derive from current binary)');
  }
}

// ---------------------------------------------------------------------------
// enable
// ---------------------------------------------------------------------------

export async function runAliasesEnable(alias: string): Promise<void> {
  if (!isSupportedAlias(alias)) {
    logger.error(`"${alias}" is not a supported alias. Supported: ${SUPPORTED_ALIASES.join(', ')}`);
    process.exit(1);
  }

  if (isPkgBinary()) {
    await enableBinaryAlias(alias as SupportedAlias);
  } else {
    logger.info(`Running as a Node.js script (npm install). Aliases are controlled by package.json.`);
    logger.info(`"${alias}" is already registered via npm's bin entries.`);
  }

  // Remove from disabled list regardless
  const disabled = getDisabledAliases().filter((a) => a !== alias);
  setDisabledAliases(disabled);
  logger.success(`Alias "${alias}" enabled.`);
}

// ---------------------------------------------------------------------------
// disable
// ---------------------------------------------------------------------------

export async function runAliasesDisable(alias: string): Promise<void> {
  if (!isSupportedAlias(alias)) {
    logger.error(`"${alias}" is not a supported alias. Supported: ${SUPPORTED_ALIASES.join(', ')}`);
    process.exit(1);
  }

  if (isPkgBinary()) {
    await disableBinaryAlias(alias as SupportedAlias);
  } else {
    logger.info(`Running as a Node.js script (npm install).`);
    logger.info(`To remove the "${alias}" bin entry, uninstall and reinstall the package without it,`);
    logger.info(`or manage it via your shell's PATH.`);
  }

  // Add to disabled list
  const disabled = getDisabledAliases();
  if (!disabled.includes(alias)) disabled.push(alias);
  setDisabledAliases(disabled);
  logger.success(`Alias "${alias}" disabled. It will not be re-created on future updates.`);
}

// ---------------------------------------------------------------------------
// Helpers: binary alias management
// ---------------------------------------------------------------------------

async function enableBinaryAlias(alias: SupportedAlias): Promise<void> {
  const installDir = resolveInstallDir(true);
  if (!installDir) {
    logger.error('Cannot determine install directory. Is waffagent installed as a binary?');
    process.exit(1);
  }

  const conflict = detectConflict(alias, installDir);
  if (conflict) {
    logger.warn(`"${alias}" already exists at: ${conflict}`);
    logger.warn(`It does not appear to point to waffagent. Refusing to overwrite.`);
    logger.info(`Disable or remove the conflicting command first, then re-run this command.`);
    process.exit(1);
  }

  const filePath = aliasFilePath(alias, installDir)!;

  if (process.platform === 'win32') {
    writeWindowsWrapper(alias, installDir, filePath);
  } else {
    writeUnixSymlink(alias, installDir, filePath);
  }

  logger.success(`Created alias: ${filePath}`);
}

async function disableBinaryAlias(alias: SupportedAlias): Promise<void> {
  const installDir = resolveInstallDir(false);
  if (!installDir) return; // nothing to remove

  const filePath = aliasFilePath(alias, installDir);
  if (!filePath || !fs.existsSync(filePath)) {
    logger.info(`Alias file not found — nothing to remove.`);
    return;
  }

  // Safety check: only remove if it points to waffagent
  if (!isOurAlias(filePath, installDir)) {
    logger.warn(`"${filePath}" does not appear to be a waffagent alias — not removing.`);
    return;
  }

  fs.unlinkSync(filePath);
  logger.success(`Removed alias file: ${filePath}`);
}

function writeWindowsWrapper(_alias: string, _installDir: string, filePath: string): void {
  // Standard Windows .cmd wrapper: passes all args through to the main binary
  const wrapper = `@echo off\r\n"%~dp0waffagent.exe" %*\r\n`;
  fs.writeFileSync(filePath, wrapper, 'utf-8');
}

function writeUnixSymlink(_alias: string, installDir: string, filePath: string): void {
  const target = path.join(installDir, 'waffagent');
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  fs.symlinkSync(target, filePath);
  fs.chmodSync(filePath, 0o755);
}

function isOurAlias(filePath: string, installDir: string): boolean {
  try {
    if (process.platform === 'win32') {
      // Check if the .cmd file calls waffagent.exe from the same directory
      const content = fs.readFileSync(filePath, 'utf-8');
      return content.includes('waffagent.exe');
    } else {
      // Check if it's a symlink pointing to our waffagent binary
      const stat = fs.lstatSync(filePath);
      if (stat.isSymbolicLink()) {
        const target = fs.readlinkSync(filePath);
        const resolvedTarget = path.resolve(path.dirname(filePath), target);
        return resolvedTarget === path.join(installDir, 'waffagent');
      }
    }
  } catch { /* ignore */ }
  return false;
}

// ---------------------------------------------------------------------------
// Helpers: path resolution
// ---------------------------------------------------------------------------

/**
 * Return the path where an alias file should live in the install dir.
 * Returns undefined if installDir is unknown.
 */
function aliasFilePath(alias: string, installDir: string | undefined): string | undefined {
  if (!installDir) return undefined;
  const ext = process.platform === 'win32' ? '.cmd' : '';
  return path.join(installDir, alias + ext);
}

/**
 * Resolve the install directory.
 * For pkg binaries: dirname(process.execPath) — the binary lives there.
 * Falls back to stored installDir from user config.
 */
function resolveInstallDir(warnIfMissing = false): string | undefined {
  if (isPkgBinary()) {
    return path.dirname(process.execPath);
  }
  const stored = getInstallDir();
  if (!stored && warnIfMissing) {
    logger.warn('Install directory not recorded in ~/.waffagent/config.json');
  }
  return stored;
}

/**
 * Detect whether `alias` already exists on PATH and points to something
 * OTHER than our install dir. Returns the conflicting path or null.
 */
function detectConflict(alias: string, installDir: string | undefined): string | null {
  try {
    const cmd = process.platform === 'win32' ? `where ${alias}` : `which ${alias}`;
    const result = execSync(cmd, { stdio: 'pipe' }).toString().trim().split('\n')[0].trim();
    if (!result) return null;

    // If it's inside our install dir it's our own file — not a conflict
    if (installDir && result.startsWith(installDir)) return null;

    return result;
  } catch {
    // Command not found — no conflict
    return null;
  }
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function isPkgBinary(): boolean {
  return !!(process as NodeJS.Process & { pkg?: unknown }).pkg;
}

function isSupportedAlias(name: string): name is SupportedAlias {
  return (SUPPORTED_ALIASES as readonly string[]).includes(name);
}
