import * as path from 'path';
import chalk from 'chalk';
import inquirer from 'inquirer';
import { logger } from '../utils/logger.js';
import { WaironError } from '../utils/errors.js';
import {
  ensureDir,
  writeFile,
  fromProjectRoot,
  findSystemRoot,
  getProjectRootOverride,
  setProjectRoot,
} from '../utils/fs.js';
import type { SubsystemSpec } from '../models/index.js';
import type { SpecRestatement } from '../core/authoring.js';
import { writeYamlFile } from '../utils/yaml.js';
import { AI_PATHS } from '../config/paths.js';
import {
  createProjectConfig,
  projectConfigExists,
  loadSystemSpec,
  loadSubsystemSpec,
  // cli_authoring_adapter: authoring the subsystem goes through the gated seam.
  writeSpec,
  defaultPackSelections,
  ensureProjectInitialized,
  // Through the core adapter, never ../utils/ai-guide.js: writing a tool's
  // configuration file is sdd_core work, and init is an sdd_cli command.
  globalGuideFilePath,
  localGuideFilePath,
  injectGuide,
  writeRootGuideDelegator,
  syncContextFiles,
} from './subsystem.js';
import { exportSddSkills } from './skills.js';
import { defaultTargetConfig } from '../config/defaults.js';
import { ProjectConfig, TargetConfig, activeTargetTypes } from '../models/project.js';

// ---------------------------------------------------------------------------
// init command
// ---------------------------------------------------------------------------

interface InitOptions {
  yes?: boolean;
}

interface AiGuidePlan {
  claudeGlobal: boolean;
  claudeLocal: boolean;
  geminiGlobal: boolean;
  geminiLocal: boolean;
}

export async function runInit(options: InitOptions = {}): Promise<void> {
  logger.header('wairon init');

  const cwd = process.cwd();
  const ancestorRoot = findSystemRoot(cwd);

  // Case (b): this very directory is already an initialized wairon project.
  if (ancestorRoot && path.resolve(ancestorRoot) === path.resolve(cwd)) {
    logger.info('Project already initialized.');
    logger.info('Design your spec tree with the SDD architect skill, then run `wairon generate`.');
    return;
  }

  // Case (c): cwd sits inside a parent wairon project → offer to make this
  // directory an external subsystem of that parent instead of dead-ending.
  if (ancestorRoot) {
    await runInitAsExternalSubsystem(ancestorRoot, cwd, options);
    return;
  }

  // Case (a): no ancestor project → bootstrap a fresh standalone project.
  if (options.yes) {
    await runInitNonInteractive();
    return;
  }

  await runInitInteractive();
}

// ---------------------------------------------------------------------------
// External-subsystem branch: cwd is a subdirectory of an existing project
// ---------------------------------------------------------------------------

async function runInitAsExternalSubsystem(
  parentRoot: string,
  cwd: string,
  options: InitOptions,
): Promise<void> {
  const relPath = path.relative(parentRoot, cwd) || '.';
  const defaultId = path.basename(cwd);

  logger.info(`Detected a parent wairon project at ${parentRoot}`);
  logger.info(`This directory ("${relPath}") is not yet a wairon project.`);

  if (!options.yes) {
    const { proceed } = await inquirer.prompt<{ proceed: boolean }>([
      {
        type: 'confirm',
        name: 'proceed',
        message: `Create "${relPath}" as an external subsystem of the parent project?`,
        default: true,
      },
    ]);
    if (!proceed) {
      logger.info('Cancelled — no changes made.');
      logger.info('To design this subproject, add it from the parent with `wairon subsystem add` or the SDD tools.');
      return;
    }
  }

  let subsystemId = defaultId;
  if (!options.yes) {
    const { id } = await inquirer.prompt<{ id: string }>([
      {
        type: 'input',
        name: 'id',
        message: 'Subsystem id:',
        default: defaultId,
      },
    ]);
    subsystemId = id?.trim() || defaultId;
  }

  // Author the subsystem against the PARENT root, through the authoring seam,
  // which wires it there and provisions this directory as the child.
  const prevOverride = getProjectRootOverride();
  setProjectRoot(parentRoot);
  try {
    const system = loadSystemSpec();
    if (!system) {
      throw new WaironError(`Parent project at ${parentRoot} has no system spec.`);
    }
    // Step 9: the subsystem the parent already stores under that id, if any.
    const stored = loadSubsystemSpec(subsystemId);
    // Step 10: the restatement, with only what this command owns — the id and
    // the projectPath — plus, for a subsystem the parent does not store yet,
    // the name and the placeholder description a new subsystem requires. The
    // seam derives parentSystem from the L0, fills a new spec's lists from the
    // schema defaults, and carries whatever an existing one already holds.
    const spec: Record<string, unknown> = { id: subsystemId, projectPath: relPath };
    const fields = ['id', 'projectPath'];
    if (!stored) {
      Object.assign(spec, { name: subsystemId, description: `External subsystem ${subsystemId}` });
      fields.push('name', 'description');
    }
    const restatement: SpecRestatement = { kind: 'subsystem', spec: spec as unknown as SubsystemSpec, fields };
    // Step 11: into the parent project through the authoring client adapter.
    const receipt = writeSpec(restatement);
    for (const notice of receipt.notices) logger.info(notice);
  } finally {
    setProjectRoot(prevOverride);
  }

  logger.success(`Created "${subsystemId}" as an external subsystem of the parent project.`);
  logger.info(`Wired the parent (projectPath: ${relPath}) and scaffolded this directory as a child wairon project.`);
  logger.info(`Design its spec tree from the parent using namespaced ids (e.g. ${subsystemId}::<component>).`);
}

// ---------------------------------------------------------------------------
// Non-interactive (--yes) path: sensible defaults, no prompts
// ---------------------------------------------------------------------------

async function runInitNonInteractive(): Promise<void> {
  const cwd = process.cwd();
  const projectName = path.basename(cwd);
  const now = new Date().toISOString();

  // Claude and Antigravity are active by default
  const targets: TargetConfig[] = [defaultTargetConfig('claude'), defaultTargetConfig('agy')];
  const projectConfig = buildProjectConfig(projectName, targets, now, 'backend');

  const guidePlan: AiGuidePlan = {
    claudeGlobal: false,
    claudeLocal: true,
    geminiGlobal: false,
    geminiLocal: true,
  };

  await executeInit(
    projectName,
    projectConfig,
    guidePlan,
  );

  logger.success(`Project "${projectName}" initialized (non-interactive).`);
  logger.info('Run `wairon status` to view your spec dashboard, or edit `.wai/phased_design.md` to begin designing.');
}

// ---------------------------------------------------------------------------
// Interactive path
// ---------------------------------------------------------------------------

async function runInitInteractive(): Promise<void> {
  const cwd = process.cwd();
  const defaultProjectName = path.basename(cwd);

  // ------------------------------------------------------------------
  // Phase 1 — Project name
  // ------------------------------------------------------------------

  const { projectName } = await inquirer.prompt<{ projectName: string }>([
    {
      type: 'input',
      name: 'projectName',
      message: 'Project name:',
      default: defaultProjectName,
    },
  ]);

  // ------------------------------------------------------------------
  // Phase 1b — Project Type
  // ------------------------------------------------------------------

  const { projectType } = await inquirer.prompt<{ projectType: 'backend' | 'frontend-reactive' | 'frontend-controller' | 'lowlevel-os' | 'game-ecs' | 'realtime-embedded' | 'plc-cyclic' | 'fullstack' }>([
    {
      type: 'list',
      name: 'projectType',
      message: 'Project type / architecture profile:',
      choices: [
        { name: 'Backend-only (standard DDD backend/services)', value: 'backend' },
        { name: 'Frontend Reactive (React, Vue 3, Svelte, SolidJS)', value: 'frontend-reactive' },
        { name: 'Frontend Controller (Angular, Flutter, Mobile/Native)', value: 'frontend-controller' },
        { name: 'Low-Level OS (processes, devices, schedulers — no profile-specific rules yet)', value: 'lowlevel-os' },
        { name: 'Game ECS (Entity-Component-System simulation — no profile-specific rules yet)', value: 'game-ecs' },
        { name: 'Real-Time Embedded (control loops, sensors, actuators — no profile-specific rules yet)', value: 'realtime-embedded' },
        { name: 'PLC Cyclic (IEC 61131-3 Structured Text, scan loops)', value: 'plc-cyclic' },
        { name: 'Fullstack / Monorepo (supports custom profile per subsystem)', value: 'fullstack' },
      ],
      default: 'backend',
    },
  ]);

  // ------------------------------------------------------------------
  // Phase 2 — Targets selection
  // ------------------------------------------------------------------

  const { targetTypes, customPath, customLabel } = await inquirer.prompt<{
    targetTypes: ('claude' | 'gemini' | 'agy' | 'cursor' | 'copilot' | 'codex' | 'custom')[];
    customPath: string;
    customLabel: string;
  }>([
    {
      type: 'checkbox',
      name: 'targetTypes',
      message: 'Which AI coding tools will you use? (Space to select · Enter to confirm)',
      choices: [
        { name: 'Claude Code           (.claude/agents/)', value: 'claude', checked: true },
        { name: 'Antigravity CLI (agy) (.gemini/agents/)', value: 'agy', checked: true },
        { name: 'Cursor Rules          (.cursor/rules/)', value: 'cursor' },
        { name: 'GitHub Copilot        (.github/prompts/)', value: 'copilot' },
        { name: 'Codex CLI             (.codex/agents/)',  value: 'codex' },
        { name: 'Gemini CLI (Legacy)   (.gemini/agents/)', value: 'gemini' },
        { name: 'Custom path           (any other tool)',  value: 'custom' },
      ],
    },
    {
      type: 'input',
      name: 'customPath',
      message: 'Custom agents output directory (relative to project root):',
      default: '.ai-agents',
      when: (ans) => ans.targetTypes.includes('custom'),
    },
    {
      type: 'input',
      name: 'customLabel',
      message: 'Label for this custom target (e.g. "Cursor"):',
      default: 'Custom',
      when: (ans) => ans.targetTypes.includes('custom'),
    },
  ]);

  const targets: TargetConfig[] = [];
  for (const t of targetTypes) {
    if (t !== 'custom') {
      targets.push(defaultTargetConfig(t));
    } else if (customPath) {
      targets.push({ type: 'custom', label: customLabel ?? 'Custom', outputDir: customPath, enabled: true });
    }
  }

  if (targets.length === 0) {
    targets.push(defaultTargetConfig('claude'));
    logger.warn('No targets selected — defaulting to Claude Code.');
  }

  // ------------------------------------------------------------------
  // Phase 3 — Guide scopes (Determined automatically to reduce prompts)
  // ------------------------------------------------------------------
  const guidePlan: AiGuidePlan = {
    claudeGlobal: false,
    claudeLocal: false,
    geminiGlobal: false,
    geminiLocal: false,
  };

  const selectedTypes = targets.map((t) => t.type);

  if (selectedTypes.includes('claude')) {
    guidePlan.claudeLocal = true;
  }
  if (selectedTypes.includes('gemini') || selectedTypes.includes('agy')) {
    guidePlan.geminiLocal = true;
  }

  // ------------------------------------------------------------------
  // Phase 4 — Confirmation summary
  // ------------------------------------------------------------------

  logger.blank();
  logger.header('Init summary');
  logger.blank();
  console.log(`  ${chalk.bold('Project:')}  ${projectName}`);
  console.log(`  ${chalk.bold('Profile:')}  ${projectType}`);
  console.log(`  ${chalk.bold('Targets:')}  ${targets.map((t) => t.type).join(', ')}`);
  console.log(`  ${chalk.bold('Guide:')}    Auto-inject local AI rules card (${selectedTypes.filter(t => ['claude', 'gemini', 'agy'].includes(t)).join(', ') || 'none'})`);
  logger.blank();

  const { confirmed } = await inquirer.prompt<{ confirmed: boolean }>([
    {
      type: 'confirm',
      name: 'confirmed',
      message: 'Proceed with initialization?',
      default: true,
    },
  ]);

  if (!confirmed) {
    logger.info('Cancelled.');
    return;
  }

  // ------------------------------------------------------------------
  // Phase 5 — Execute
  // ------------------------------------------------------------------

  const now = new Date().toISOString();
  const projectConfig = buildProjectConfig(projectName, targets, now, projectType);

  await executeInit(
    projectName,
    projectConfig,
    guidePlan,
  );
}

// ---------------------------------------------------------------------------
// Execution — creates all files after confirmation
// ---------------------------------------------------------------------------

async function executeInit(
  projectName: string,
  projectConfig: ProjectConfig,
  guidePlan: AiGuidePlan,
): Promise<void> {
  const projectRoot = fromProjectRoot();
  const cwd = process.cwd();

  logger.blank();
  logger.info('Creating .wai/ project structure...');

  // Directories
  ensureDir(AI_PATHS.root());
  ensureDir(AI_PATHS.templatesDir());
  ensureDir(AI_PATHS.rulesDir());
  ensureDir(AI_PATHS.docsDir());
  ensureDir(AI_PATHS.generatedDir());

  // Complete only what is missing. runInit's early return looks for the spec
  // tree, so a half-finished init reaches here with its configuration in place;
  // that configuration is kept exactly as it is.
  const hadConfig = projectConfigExists();
  if (!hadConfig) {
    // A NEW configuration seeds the store packs that declare `applyByDefault`, and
    // records the machine-wide decision explicitly. This is what a machine-wide
    // install should mean: a default for projects created from now on, written
    // where it is visible in review and removable — not retroactive authority over
    // projects that never mentioned it. A kept configuration reads no packs.
    createProjectConfig({
      ...projectConfig,
      extensions: {
        packs: defaultPackSelections(),
        useGlobalPacks: false,
      },
    });
  } else {
    logger.info('Kept the existing .wai/project.yaml.');
  }

  // No agent file is written here: agents are live briefs resolved from the spec
  // tree at read time, and `wairon generate` writes agent files only when
  // rules.materializeAgentFiles is on.
  const targetTypes = activeTargetTypes(projectConfig);

  // Starter docs + rules
  writeStarterDocs(projectName);
  writeStarterRules();
  writeStarterDesignGuide(projectName);
  writeStarterProjectContext(projectName);

  // Inject AI guides
  if (guidePlan.claudeGlobal) {
    const p = globalGuideFilePath('claude')!;
    injectGuide(p, 'global');
    logger.success(`Injected wairon guide into ${p}`);
  }
  if (guidePlan.claudeLocal) {
    const p = localGuideFilePath(projectRoot, 'claude')!;
    injectGuide(p, 'local');
    logger.success(`Injected wairon guide into ${path.relative(cwd, p)}`);
    writeRootGuideDelegator(projectRoot, 'claude');
    logger.success(`Created root CLAUDE.md delegator pointing to .claude/CLAUDE.md`);
  }
  if (guidePlan.geminiGlobal) {
    const p = globalGuideFilePath('gemini')!;
    injectGuide(p, 'global');
    logger.success(`Injected wairon guide into ${p}`);
  }
  if (guidePlan.geminiLocal) {
    const p = localGuideFilePath(projectRoot, 'gemini')!;
    injectGuide(p, 'local');
    logger.success(`Injected wairon guide into ${path.relative(cwd, p)}`);
    writeRootGuideDelegator(projectRoot, 'gemini');
    logger.success(`Created root GEMINI.md delegator pointing to .gemini/GEMINI.md`);
  }

  // Root instructions/rules for other targets if active
  if (targetTypes.includes('cursor')) {
    writeRootGuideDelegator(projectRoot, 'cursor');
    logger.success(`Created root .cursorrules pointing to .cursor/rules/`);
  }
  if (targetTypes.includes('copilot')) {
    writeRootGuideDelegator(projectRoot, 'copilot');
    logger.success(`Created root .github/copilot-instructions.md pointing to .github/prompts/`);
  }
  if (targetTypes.includes('codex')) {
    writeRootGuideDelegator(projectRoot, 'codex');
    logger.success(`Created root .codexrules pointing to .codex/agents/`);
  }

  // Register MCP server locally for Claude Code target
  if (targetTypes.includes('claude')) {
    try {
      const { runMcpInstall } = require('./mcp.js') as typeof import('./mcp.js');
      await runMcpInstall({ global: false, backend: 'claude' });
    } catch (err) {
      logger.warn(`Failed to automatically register MCP server for Claude: ${err}`);
    }
  }

  // Register MCP server for Antigravity (agy) target — project-local only.
  // Global registration ($HOME) is opt-in via `wairon mcp install --global`.
  if (targetTypes.includes('gemini') || targetTypes.includes('agy')) {
    try {
      const { runMcpInstall } = require('./mcp.js') as typeof import('./mcp.js');
      await runMcpInstall({ backend: 'gemini', global: false });
    } catch (err) {
      logger.warn(`Failed to automatically register MCP server for Antigravity: ${err}`);
    }
  }

  // Seed the context directory with auto-generated files (domains.md + wairon-guide.md)
  syncContextFiles();
  logger.verbose('Context files seeded in .wai/context/');

  // Bootstrap the L0 system spec through core — completing only what is missing,
  // the same bootstrap every chained subproject gets — then export the SDD skills
  // for this init's targets.
  try {
    ensureProjectInitialized(projectName);
    const skillsResult = exportSddSkills(targetTypes);
    logger.success(`Bootstrapped SDD spec system and installed SDD skills into ${skillsResult.destinations.length} target(s).`);
  } catch (err) {
    logger.warn(`Failed to bootstrap SDD Specs: ${String(err)}`);
  }

  // Done
  logger.blank();
  logger.success(`Project "${projectName}" initialized.`);
  logger.blank();
  logger.info('What was created:');
  logger.info('  .wai/               — source of truth for agent topology');
  if (!hadConfig) logger.info('  .wai/project.yaml   — project config');
  logger.info('  .wai/phased_design.md — spec kit alternative design workbook');
  logger.info('  .wai/specs/         — SDD spec tree (L0 .index.yaml bootstrapped)');
  logger.info('  .wai/context/       — shared context directory (domains.md, wairon-guide.md)');
  if (hadConfig) logger.info('Kept .wai/project.yaml as it was (not recreated).');
  logger.blank();
  logger.info('Next steps:');
  logger.info('  Edit .wai/context/project.md — describe the project concept and stack details for the AI');
  logger.info('  wairon status               — view the architecture completeness dashboard');
  logger.info('  wairon validate             — check the spec tree & component boundaries');
  logger.info('  Design your spec tree with the SDD architect skill or the wairon MCP sdd_* tools');
  logger.blank();
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Compose a new project's configuration. Its pack selections are seeded only
 *  when the configuration is actually created (see executeInit). */
function buildProjectConfig(
  name: string,
  targets: TargetConfig[],
  now: string,
  projectType: 'backend' | 'frontend-reactive' | 'frontend-controller' | 'lowlevel-os' | 'game-ecs' | 'realtime-embedded' | 'plc-cyclic' | 'fullstack',
): ProjectConfig {
  return {
    schemaVersion: '1.0.0',
    name,
    projectType,
    targets,
    // New projects start with budgets off — the same output a project got
    // before execution budgets existed. Opt in with `execution.tier`.
    execution: { tier: 'off', overrides: {} },
    rules: {
      noOverlappingOwnership: true,
      requireOwnedPaths: true,
      metaAgentTags: ['meta', 'guardian', 'architect'],
      enforceReproducibility: true,
      // Off by default (matches the schema + subproject provisioning): one owner
      // agent per subsystem is the file granularity; component-level delegation
      // is served as live MCP briefs. Per-component implementer FILES are a
      // legacy escape hatch — opt in with `true` on small trees only.
      generateComponentImplementers: false,
      // Off by default too: `init` (and every default `generate`) writes NO
      // agent files — agents are served as live briefs, and files are the
      // opt-in materialized view of the same briefs.
      materializeAgentFiles: false,
      sddRuleSeverity: {},
    },
    paths: {
      specsDir: '.wai/specs',
    },
    createdAt: now,
    updatedAt: now,
  };
}

function writeStarterDocs(projectName: string): void {
  const content = `# ${projectName} — Agent Topology Notes

This directory contains project-specific notes about the agent topology.

## Overview

Describe the overall agent strategy for this project here. See also [.wai/phased_design.md](../phased_design.md) for the active system design log.

## Agents

Agents are live briefs resolved from the spec tree (\`.wai/specs/\`) whenever they are needed — an AI tool fetches one through the \`sdd_get_agent_brief\` MCP tool, and \`wairon list\` shows the current topology. \`wairon generate\` writes agent files only when \`rules.materializeAgentFiles\` is on in \`.wai/project.yaml\`.

## Decisions

Document topology decisions and the reasoning behind them here.
`;
  writeFile(AI_PATHS.docsDir() + '/topology.md', content);
}

function writeStarterRules(): void {
  const rules = {
    version: '1.0.0',
    notes: [
      'Prefer existing agents before creating new ones.',
      'Only create a new agent when a durable architectural boundary exists.',
      'Every non-meta agent must have at least one owned path.',
      'Generated outputs must be reproducible from the registry.',
      'Avoid overlapping primary ownership between agents.',
    ],
  };
  writeYamlFile(AI_PATHS.rulesDir() + '/topology.yaml', rules);
}

function writeStarterDesignGuide(projectName: string): void {
  const content = `# SDD Phased Design Blueprint & Quest Log

This document serves as your living system-design workbook and project-level guide for AI Spec-Driven Development (SDD) in **${projectName}**. 
It aligns developer intent with structured, verified specifications under the \`wairon\` framework.

---

## Stage 1: The Constitution (Guardrails & Rules)

Define the non-negotiable architectural guardrails here. The AI agent must follow these constraints.

*   [ ] **Primary Language & Runtime:** Node.js (TypeScript) / Python / etc.
*   [ ] **Architectural Style:** Clean Architecture / Hexagonal / Domain-Driven Design (DDD).
*   [ ] **Data Persistence Rules:** E.g. No raw SQL in controllers; all DB operations must use a \`Store\` / \`Repository\`.
*   [ ] **Stereotype Dependencies:**
    *   \`Store\` components can only call other \`Stores\` or \`Registries\`.
    *   \`Adapter\` components cannot depend on \`Orchestrators\` or \`Stores\` directly.
    *   Only \`Portal\` components can accept external traffic.

---

## Stage 2: System Definition (Level 0 & Level 1)

*   [ ] **System Vision (L0):** Define \`.wai/specs/.index.yaml\`.
    *   *AI Action:* Run \`sdd_initialize_system\` to create the system vision.
*   [ ] **Subsystem Isolation (L1):** Define subsystems in \`.wai/specs/<subsystem>/.index.yaml\`.
    *   *AI Action:* Run \`sdd_add_subsystem\` to declare the core bounded contexts (e.g. \`billing\`, \`catalog\`, \`users\`).

---

## Stage 3: Ingress/Egress Portals (Level 2 & Level 3)

Portals are the boundaries of your subsystems. Define how requests enter and leave.

*   [ ] **Define Ingress Portals (REST / gRPC / MessageBus):**
    *   *AI Action:* Create L2 Portal components with \`status: draft\` and map their L3 interfaces.
    *   *Design check:* Ensure HTTP endpoints (method, path) or gRPC names are correctly declared in the method bindings.
*   [ ] **Define Egress Portals (Clients / Publishers):**
    *   *AI Action:* Declare any external event publishing or client communication Portals.

---

## Stage 4: Subsystem Core & Stereotypes (Level 2 & Level 3)

Flesh out the internal components that do the actual work.

*   [ ] **Orchestrators:** Handle transaction scripts and workflow coordination.
*   [ ] **Stores & Repositories:** Handle persistence.
*   [ ] **Adapters:** Call external third-party APIs (e.g. Stripe, SendGrid).
*   *AI Action:* Create components with \`status: draft\` and define their interfaces/signatures.

---

## Stage 5: Execution Flow Narratives (Level 4 & Level 5)

Map the behavior step-by-step.

*   [ ] **Write Narratives:** Write Level 5 narrative steps mapping methods to internal calls.
    *   *AI Action:* For each interface method, describe the sequential call stack (e.g. Call \`payment_store.save\`, then Call \`stripe_adapter.charge\`).
    *   *AI Action:* Call the \`sdd_get_status\` MCP tool to verify completeness, and \`sdd_validate_tree\` to ensure no circular loops or dependency leaks exist.

---

## Stage 6: Sandbox Implementation

Once the specs are clean and compiled, mark the components as \`status: complete\` to lock them, then generate the agents and write code!

*   [ ] **Validation Check (AI):** Call the \`sdd_validate_tree\` MCP tool (must return 0 errors).
*   [ ] **Agent Generation (human):** The developer runs \`wairon generate\` from their terminal to instantiate agent sandboxes — the AI does not run this.
*   [ ] **Code Implementation:** Let the agent implement the component code matching the narrative.
`;
  // Written verbatim: AI steps reference MCP tools; the one CLI step is explicitly
  // human-run, so `wairon` stays literal (no dev-path substitution).
  writeFile(fromProjectRoot('.wai', 'phased_design.md'), content);
}

function writeStarterProjectContext(projectName: string): void {
  const content = `# ${projectName}

## Overview
A new project initialized with Wairon.
(The AI agent should overwrite this description with a complete overview of the project concept and stack once the user specifies their choices)

## Tech Stack
- [Specify Language, Framework, and Databases here]

## Key Conventions
- Follow Spec-Driven Development (SDD) using Wairon.
- Refrain from writing code implementation until specifications are approved.
`;
  writeFile(AI_PATHS.contextProjectMd(), content);
}
