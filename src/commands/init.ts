import * as path from 'path';
import chalk from 'chalk';
import inquirer from 'inquirer';
import { logger } from '../utils/logger.js';
import { ensureDir, writeFile, fromProjectRoot } from '../utils/fs.js';
import {
  globalGuideFilePath,
  localGuideFilePath,
  injectGuide,
  writeRootGuideDelegator,
} from '../utils/ai-guide.js';
import { writeYamlFile } from '../utils/yaml.js';
import { isProjectInitialized, AI_PATHS } from '../config/loader.js';
import {
  defaultTargetConfig,
  ARCHITECT_AGENT_ID,
  ARCHITECT_TEMPLATE_ID,
} from '../config/defaults.js';
import { createAgentRecord, AgentRecord } from '../models/agent.js';
import { ProjectConfig, TargetConfig } from '../models/project.js';
import { loadTemplate, renderTemplateInstructions } from '../core/templates.js';
import { getExporter } from '../exporters/index.js';
import { syncContextFiles } from '../core/context.js';

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

  // Already initialized → nothing to bootstrap; agents derive from the spec tree
  if (isProjectInitialized()) {
    logger.info('Project already initialized.');
    logger.info('Design your spec tree with the SDD architect skill, then run `wairon generate`.');
    return;
  }

  if (options.yes) {
    await runInitNonInteractive();
    return;
  }

  await runInitInteractive();
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
    targets,
    projectConfig,
    guidePlan,
    now,
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

  const { projectType } = await inquirer.prompt<{ projectType: 'backend' | 'frontend-reactive' | 'frontend-controller' | 'lowlevel-os' | 'game-ecs' | 'realtime-embedded' | 'fullstack' }>([
    {
      type: 'list',
      name: 'projectType',
      message: 'Project type / architecture profile:',
      choices: [
        { name: 'Backend-only (standard DDD backend/services)', value: 'backend' },
        { name: 'Frontend Reactive (React, Vue 3, Svelte, SolidJS)', value: 'frontend-reactive' },
        { name: 'Frontend Controller (Angular, Flutter, Mobile/Native)', value: 'frontend-controller' },
        { name: 'Low-Level OS (processes, devices, schedulers)', value: 'lowlevel-os' },
        { name: 'Game ECS (Entity-Component-System simulation)', value: 'game-ecs' },
        { name: 'Real-Time Embedded (control loops, sensors, actuators)', value: 'realtime-embedded' },
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

  const activeTargetTypes = targets.map((t) => t.type);

  if (activeTargetTypes.includes('claude')) {
    guidePlan.claudeLocal = true;
  }
  if (activeTargetTypes.includes('gemini') || activeTargetTypes.includes('agy')) {
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
  console.log(`  ${chalk.bold('Guide:')}    Auto-inject local AI rules card (${activeTargetTypes.filter(t => ['claude', 'gemini', 'agy'].includes(t)).join(', ') || 'none'})`);
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
    targets,
    projectConfig,
    guidePlan,
    now,
  );
}

// ---------------------------------------------------------------------------
// Execution — creates all files after confirmation
// ---------------------------------------------------------------------------

async function executeInit(
  projectName: string,
  targets: TargetConfig[],
  projectConfig: ProjectConfig,
  guidePlan: AiGuidePlan,
  now: string,
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

  writeYamlFile(AI_PATHS.projectConfig(), projectConfig);

  // Agents (including domain owners) are derived from the SDD spec tree and the
  // free-standing domains in .wai/topology.yaml at read time — nothing persisted here.
  const activeTargetTypes = targets
    .filter((t) => !('enabled' in t) || t.enabled)
    .map((t) => t.type);

  // The architect agent is generated as a file directly below. All other agents
  // are derived from the SDD spec tree at read time (resolveAgentTopology), so
  // no agents.json is persisted.
  const architectAgent = createAgentRecord({
    id: ARCHITECT_AGENT_ID,
    name: 'Agent Architect',
    description: 'Responsible for managing the AI agent topology of this project using the wairon CLI.',
    template: ARCHITECT_TEMPLATE_ID,
    ownedPaths: ['.wai/**'],
    tags: ['meta', 'architect'],
    creationReason: 'Bootstrapped by wairon init as the root agent for topology management.',
    targets: activeTargetTypes as AgentRecord['targets'],
  });

  // Generate architect agent file into each target
  logger.info('Generating architect agent files...');
  let template;
  try {
    template = loadTemplate(ARCHITECT_TEMPLATE_ID);
  } catch {
    logger.warn('Built-in "architect" template not found — skipping architect generation.');
    template = null;
  }

  if (template) {
    const vars: Record<string, string> = {
      agentId: architectAgent.id,
      agentName: architectAgent.name,
      agentDescription: architectAgent.description,
      ownedPaths: architectAgent.ownedPaths.join('\n'),
      tags: architectAgent.tags.join(', '),
    };
    const renderedInstructions = renderTemplateInstructions(template, vars);

    for (const targetConfig of targets) {
      const exporter = getExporter(targetConfig);

      const result = exporter.export({
        agent: architectAgent,
        template,
        renderedInstructions,
        projectRoot,
        target: targetConfig,
      });
      logger.success(`Generated: ${path.relative(cwd, result.outputPath)}`);
    }
  }

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
  if (activeTargetTypes.includes('cursor')) {
    writeRootGuideDelegator(projectRoot, 'cursor');
    logger.success(`Created root .cursorrules pointing to .cursor/rules/`);
  }
  if (activeTargetTypes.includes('copilot')) {
    writeRootGuideDelegator(projectRoot, 'copilot');
    logger.success(`Created root .github/copilot-instructions.md pointing to .github/prompts/`);
  }
  if (activeTargetTypes.includes('codex')) {
    writeRootGuideDelegator(projectRoot, 'codex');
    logger.success(`Created root .codexrules pointing to .codex/agents/`);
  }

  // Register MCP server locally for Claude Code target
  if (activeTargetTypes.includes('claude')) {
    try {
      const { runMcpInstall } = require('./mcp.js') as typeof import('./mcp.js');
      await runMcpInstall({ global: false, backend: 'claude' });
    } catch (err) {
      logger.warn(`Failed to automatically register MCP server for Claude: ${err}`);
    }
  }

  // Register MCP server for Antigravity (agy) target — project-local only.
  // Global registration ($HOME) is opt-in via `wairon mcp install --global`.
  if (activeTargetTypes.includes('gemini') || activeTargetTypes.includes('agy')) {
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

  // Bootstrap L0 System Spec and export SDD Skills for AI toolings
  try {
    const { saveSystemSpec } = require('../core/specs.js') as typeof import('../core/specs.js');
    saveSystemSpec({
      schemaVersion: '1.0.0',
      name: projectName,
      vision: `Core vision for ${projectName}`,
      boundaries: [],
      globalRequirements: [],
      createdAt: now,
      updatedAt: now,
    });

    const { exportSddSkills } = require('../core/skills.js') as typeof import('../core/skills.js');
    const skillsResult = exportSddSkills(activeTargetTypes);
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
  logger.info('  .wai/project.yaml   — project config');
  logger.info('  .wai/phased_design.md — spec kit alternative design workbook');
  logger.info('  .wai/specs/         — SDD spec tree (L0 system.yaml bootstrapped)');
  logger.info('  .wai/context/       — shared context directory (domains.md, wairon-guide.md)');
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

function buildProjectConfig(
  name: string,
  targets: TargetConfig[],
  now: string,
  projectType: 'backend' | 'frontend-reactive' | 'frontend-controller' | 'lowlevel-os' | 'game-ecs' | 'realtime-embedded' | 'fullstack',
): ProjectConfig {
  return {
    schemaVersion: '1.0.0',
    name,
    projectType,
    targets,
    rules: {
      noOverlappingOwnership: true,
      requireOwnedPaths: true,
      metaAgentTags: ['meta', 'guardian', 'architect'],
      enforceReproducibility: true,
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

| ID | Template | Purpose |
|----|----------|---------|
| agent-architect | architect | Manages agent topology using the wairon CLI |

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

*   [ ] **System Vision (L0):** Define \`.wai/specs/system.yaml\`.
    *   *AI Action:* Run \`sdd_initialize_system\` to create the system vision.
*   [ ] **Subsystem Isolation (L1):** Define subsystems in \`.wai/specs/subsystems/*.yaml\`.
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

