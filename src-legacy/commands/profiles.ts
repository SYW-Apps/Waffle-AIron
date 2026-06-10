import inquirer from 'inquirer';
import chalk from 'chalk';
import * as path from 'path';
import * as os from 'os';
import { logger } from '../utils/logger.js';
import {
  loadProfiles,
  addProfile,
  deleteProfile,
  getProfile,
  resolveActiveProfile,
  createWrapperScript,
  copyConfigDir,
  waironBinDir,
  TOOL_CONFIG_ENV_VARS,
  TOOL_DEFAULT_CONFIG_DIRS,
  type Profile,
  type ToolProfile,
} from '../config/profiles.js';
import { getActiveProfileId, setActiveProfileId } from '../config/userconfig.js';
import { loadProjectConfig, saveProjectConfig } from '../config/loader.js';
import { assertProjectInitialized } from '../config/loader.js';

// ---------------------------------------------------------------------------
// profiles list
// ---------------------------------------------------------------------------

export async function runProfilesList(): Promise<void> {
  const profiles = loadProfiles();
  const globalActive = getActiveProfileId();

  if (profiles.length === 0) {
    logger.info('No profiles configured.');
    logger.info(`Run ${chalk.bold('wairon profiles create')} to create one.`);
    return;
  }

  // Detect project-level profile if in a wairon project
  let projectProfileId: string | undefined;
  try {
    assertProjectInitialized();
    projectProfileId = loadProjectConfig().profile;
  } catch {
    // not in a project — that's fine
  }

  logger.blank();
  for (const p of profiles) {
    const isGlobalActive = p.id === globalActive;
    const isProjectActive = p.id === projectProfileId;
    const markers: string[] = [];
    if (isGlobalActive) markers.push(chalk.green('global'));
    if (isProjectActive) markers.push(chalk.cyan('this project'));

    const badge = markers.length > 0 ? ` ${chalk.gray('[')}${markers.join(', ')}${chalk.gray(']')}` : '';
    console.log(`  ${chalk.bold(p.id)}  ${chalk.gray(p.name)}${badge}`);

    for (const [tool, tp] of Object.entries(p.tools)) {
      if (!tp) continue;
      const dir = tp.configDir ? chalk.gray(` → ${tp.configDir}`) : '';
      console.log(`    ${chalk.cyan(tool)}: ${chalk.yellow(tp.command)}${dir}`);
    }
    logger.blank();
  }

  logger.info(`Bin directory: ${chalk.gray(waironBinDir())}`);
  logger.info(`Add it to your PATH to use profile wrapper scripts.`);
}

// ---------------------------------------------------------------------------
// profiles create
// ---------------------------------------------------------------------------

export async function runProfilesCreate(): Promise<void> {
  const existing = loadProfiles().map((p) => p.id);

  const { id } = await inquirer.prompt<{ id: string }>([
    {
      type: 'input',
      name: 'id',
      message: 'Profile id (e.g. "work", "personal"):',
      validate: (v: string) => {
        if (!v.trim()) return 'Required';
        if (existing.includes(v.trim())) return `Profile "${v.trim()}" already exists`;
        if (!/^[a-z0-9_-]+$/.test(v.trim())) return 'Use lowercase letters, numbers, hyphens or underscores only';
        return true;
      },
    },
  ]);

  const { name } = await inquirer.prompt<{ name: string }>([
    {
      type: 'input',
      name: 'name',
      message: 'Human-readable name:',
      default: id.charAt(0).toUpperCase() + id.slice(1),
    },
  ]);

  const profile: Profile = {
    id: id.trim(),
    name: name.trim(),
    tools: {},
    createdAt: new Date().toISOString(),
  };

  // Optionally configure tools
  const tools = ['claude', 'gemini'];
  for (const tool of tools) {
    const { configure } = await inquirer.prompt<{ configure: boolean }>([
      {
        type: 'confirm',
        name: 'configure',
        message: `Configure ${chalk.cyan(tool)} for this profile?`,
        default: false,
      },
    ]);

    if (!configure) continue;

    const { command } = await inquirer.prompt<{ command: string }>([
      {
        type: 'input',
        name: 'command',
        message: `  CLI command for ${tool} in this profile:`,
        default: `${tool}-${id.trim()}`,
        validate: (v: string) => v.trim() ? true : 'Required',
      },
    ]);

    const defaultDir = path.join(os.homedir(), `.${tool}-${id.trim()}`);
    const { configDir } = await inquirer.prompt<{ configDir: string }>([
      {
        type: 'input',
        name: 'configDir',
        message: `  Config directory for this profile (leave blank to share default):`,
        default: defaultDir,
      },
    ]);

    const toolProfile: ToolProfile = {
      command: command.trim(),
    };
    if (configDir.trim()) {
      toolProfile.configDir = configDir.trim();
      toolProfile.configEnvVar = TOOL_CONFIG_ENV_VARS[tool];
    }

    profile.tools[tool] = toolProfile;
  }

  addProfile(profile);
  logger.success(`Profile "${id}" created.`);

  // Offer to run setup
  const { runSetup } = await inquirer.prompt<{ runSetup: boolean }>([
    {
      type: 'confirm',
      name: 'runSetup',
      message: 'Run setup now (create wrapper scripts + copy config dirs)?',
      default: true,
    },
  ]);

  if (runSetup) {
    await _setupProfile(profile);
  } else {
    logger.info(`Run ${chalk.bold(`wairon profiles setup ${id}`)} later to finish setup.`);
  }
}

// ---------------------------------------------------------------------------
// profiles setup <id>
// ---------------------------------------------------------------------------

export async function runProfilesSetup(id: string): Promise<void> {
  const profile = getProfile(id);
  if (!profile) {
    logger.error(`Profile "${id}" not found. Run \`wairon profiles list\` to see available profiles.`);
    process.exit(1);
  }
  await _setupProfile(profile);
}

async function _setupProfile(profile: Profile): Promise<void> {
  let anyTool = false;

  for (const [tool, tp] of Object.entries(profile.tools)) {
    if (!tp) continue;
    anyTool = true;

    logger.blank();
    logger.info(`Setting up ${chalk.cyan(tool)} for profile "${chalk.bold(profile.id)}"...`);

    // 1. Copy config dir (if configured and source exists)
    if (tp.configDir) {
      const sourceDir = TOOL_DEFAULT_CONFIG_DIRS[tool];
      if (sourceDir) {
        const result = copyConfigDir(sourceDir, tp.configDir);
        if (result === 'copied') {
          logger.success(`  Copied ${sourceDir} → ${tp.configDir}`);
        } else if (result === 'skipped') {
          logger.info(`  Config dir already exists: ${tp.configDir} (skipped copy)`);
        } else {
          logger.warn(`  Source config dir not found: ${sourceDir} (skipped copy)`);
        }
      }
    }

    // 2. Create wrapper script
    const scriptPath = createWrapperScript(tool, tp);
    logger.success(`  Created wrapper script: ${scriptPath}`);
  }

  if (!anyTool) {
    logger.warn(`Profile "${profile.id}" has no tools configured. Use ${chalk.bold('wairon profiles edit ' + profile.id)} to add tools.`);
    return;
  }

  logger.blank();
  logger.info(`To use these commands, add ${chalk.bold(waironBinDir())} to your PATH:`);
  if (process.platform === 'win32') {
    logger.info(chalk.gray(`  [System Properties → Environment Variables → PATH]`));
  } else {
    logger.info(chalk.gray(`  export PATH="${waironBinDir()}:$PATH"  # add to ~/.bashrc or ~/.zshrc`));
  }
}

// ---------------------------------------------------------------------------
// profiles use <id>   — set active profile for current project
// ---------------------------------------------------------------------------

export async function runProfilesUse(id: string): Promise<void> {
  assertProjectInitialized();

  if (!getProfile(id)) {
    logger.error(`Profile "${id}" not found. Run \`wairon profiles list\` to see available profiles.`);
    process.exit(1);
  }

  const config = loadProjectConfig();
  config.profile = id;
  saveProjectConfig(config);
  logger.success(`Project profile set to "${id}".`);
  logger.info(`wairon delegate will now use this profile's commands for this project.`);
}

// ---------------------------------------------------------------------------
// profiles set-global <id>   — set the global default profile
// ---------------------------------------------------------------------------

export async function runProfilesSetGlobal(id: string): Promise<void> {
  if (!getProfile(id)) {
    logger.error(`Profile "${id}" not found. Run \`wairon profiles list\` to see available profiles.`);
    process.exit(1);
  }

  setActiveProfileId(id);
  logger.success(`Global active profile set to "${id}".`);
}

// ---------------------------------------------------------------------------
// profiles delete <id>
// ---------------------------------------------------------------------------

export async function runProfilesDelete(id: string): Promise<void> {
  if (!getProfile(id)) {
    logger.error(`Profile "${id}" not found.`);
    process.exit(1);
  }

  const { confirm } = await inquirer.prompt<{ confirm: boolean }>([
    {
      type: 'confirm',
      name: 'confirm',
      message: `Delete profile "${id}"? This will not remove any wrapper scripts or config dirs.`,
      default: false,
    },
  ]);

  if (!confirm) {
    logger.info('Cancelled.');
    return;
  }

  deleteProfile(id);

  // Clear from global active if it was set
  if (getActiveProfileId() === id) {
    setActiveProfileId(undefined);
    logger.info('Global active profile cleared.');
  }

  logger.success(`Profile "${id}" deleted.`);
}

// ---------------------------------------------------------------------------
// profiles show <id>
// ---------------------------------------------------------------------------

export async function runProfilesShow(id: string): Promise<void> {
  const profile = getProfile(id);
  if (!profile) {
    logger.error(`Profile "${id}" not found.`);
    process.exit(1);
  }

  const active = resolveActiveProfile();
  const isActive = active?.id === id;

  logger.blank();
  console.log(`${chalk.bold(profile.id)}  ${chalk.gray(profile.name)}${isActive ? chalk.green(' [active]') : ''}`);
  console.log(chalk.gray(`Created: ${profile.createdAt}`));
  logger.blank();

  if (Object.keys(profile.tools).length === 0) {
    logger.info('No tools configured for this profile.');
  } else {
    for (const [tool, tp] of Object.entries(profile.tools)) {
      if (!tp) continue;
      console.log(`  ${chalk.cyan(tool)}`);
      console.log(`    command:   ${chalk.yellow(tp.command)}`);
      if (tp.configDir) console.log(`    configDir: ${tp.configDir}`);
      if (tp.configEnvVar) console.log(`    envVar:    ${tp.configEnvVar}`);
    }
  }
  logger.blank();
}
