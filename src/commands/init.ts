import * as path from 'path';
import inquirer from 'inquirer';
import { logger } from '../utils/logger.js';
import { ensureDir, writeFile, fromProjectRoot } from '../utils/fs.js';
import { writeYamlFile, writeJsonFile } from '../utils/yaml.js';
import { isProjectInitialized, AI_PATHS } from '../config/loader.js';
import {
  defaultTargetConfig,
  ARCHITECT_AGENT_ID,
  ARCHITECT_TEMPLATE_ID,
} from '../config/defaults.js';
import { createAgentRecord } from '../models/agent.js';
import { createEmptyRegistry } from '../models/registry.js';
import { DomainSchema } from '../models/domain.js';
import { ProjectConfig } from '../models/project.js';
import { loadTemplate, renderTemplateInstructions } from '../core/templates.js';
import { detectDomainCandidates } from '../core/detection.js';
import { scaffoldDomain as _scaffoldDomain } from '../core/domains.js';
import { runDomainsScan } from './domains.js';
import { ClaudeExporter } from '../exporters/claude.js';
import { GeminiExporter } from '../exporters/gemini.js';
import { CustomExporter } from '../exporters/custom.js';

// ---------------------------------------------------------------------------
// init command
//
// Bootstraps a new waffagent project in the current directory.
// Creates the .ai/ source-of-truth structure, asks which targets to enable,
// and generates the initial architect agent into all selected targets.
// ---------------------------------------------------------------------------

interface InitOptions {
  yes?: boolean; // skip interactive prompts, use defaults
}

interface TargetSelection {
  claude: boolean;
  gemini: boolean;
  custom: boolean;
  customPath?: string;
  customLabel?: string;
}

export async function runInit(options: InitOptions = {}): Promise<void> {
  logger.header('waffagent init');

  // Already initialized → rescan mode
  if (isProjectInitialized()) {
    logger.info('Project already initialized. Scanning for new domains...');
    logger.blank();
    await runDomainsScan({ add: !options.yes });
    return;
  }

  // ------------------------------------------------------------------
  // 1. Gather project metadata
  // ------------------------------------------------------------------

  const cwd = process.cwd();
  const defaultProjectName = path.basename(cwd);

  let projectName: string;
  let targetSelection: TargetSelection;

  if (options.yes) {
    projectName = defaultProjectName;
    targetSelection = { claude: true, gemini: false, custom: false };
  } else {
    const answers = await inquirer.prompt<{
      projectName: string;
      targets: string[];
      customPath: string;
      customLabel: string;
    }>([
      {
        type: 'input',
        name: 'projectName',
        message: 'Project name:',
        default: defaultProjectName,
      },
      {
        type: 'checkbox',
        name: 'targets',
        message: 'Which AI coding tools will you use? (select all that apply)',
        choices: [
          { name: 'Claude Code (.claude/agents/)', value: 'claude', checked: true },
          { name: 'Gemini CLI (.gemini/agents/)', value: 'gemini' },
          { name: 'Other (custom path)', value: 'custom' },
        ],
      },
      {
        type: 'input',
        name: 'customPath',
        message: 'Custom agents output directory (relative to project root):',
        default: '.ai-agents',
        when: (ans) => ans.targets.includes('custom'),
      },
      {
        type: 'input',
        name: 'customLabel',
        message: 'Label for this custom target (e.g. "Cursor"):',
        default: 'Custom',
        when: (ans) => ans.targets.includes('custom'),
      },
    ]);

    projectName = answers.projectName;
    targetSelection = {
      claude: answers.targets.includes('claude'),
      gemini: answers.targets.includes('gemini'),
      custom: answers.targets.includes('custom'),
      customPath: answers.customPath,
      customLabel: answers.customLabel,
    };
  }

  // ------------------------------------------------------------------
  // 2. Build project config
  // ------------------------------------------------------------------

  const now = new Date().toISOString();

  const targets: ProjectConfig['targets'] = [];
  if (targetSelection.claude) targets.push(defaultTargetConfig('claude'));
  if (targetSelection.gemini) targets.push(defaultTargetConfig('gemini'));
  if (targetSelection.custom && targetSelection.customPath) {
    targets.push({
      type: 'custom',
      label: targetSelection.customLabel ?? 'Custom',
      outputDir: targetSelection.customPath,
      enabled: true,
    });
  }

  if (targets.length === 0) {
    // Fallback: always enable claude
    targets.push(defaultTargetConfig('claude'));
    logger.warn('No targets selected — defaulting to Claude Code.');
  }

  const projectConfig: ProjectConfig = {
    schemaVersion: '1.0.0',
    name: projectName,
    targets,
    rules: {
      noOverlappingOwnership: true,
      requireOwnedPaths: true,
      metaAgentTags: ['meta', 'guardian', 'architect'],
      enforceReproducibility: true,
    },
    defaultBackend: 'claude',
    createdAt: now,
    updatedAt: now,
  };

  // ------------------------------------------------------------------
  // 3. Scaffold the .ai/ directory
  // ------------------------------------------------------------------

  logger.blank();
  logger.info('Creating .ai/ project structure...');

  ensureDir(AI_PATHS.root());
  ensureDir(AI_PATHS.registryDir());
  ensureDir(AI_PATHS.templatesDir());
  ensureDir(AI_PATHS.bundlesDir());
  ensureDir(AI_PATHS.rulesDir());
  ensureDir(AI_PATHS.docsDir());
  ensureDir(AI_PATHS.generatedDir());

  writeYamlFile(AI_PATHS.projectConfig(), projectConfig);
  logger.verbose(`Wrote ${AI_PATHS.projectConfig()}`);

  // ------------------------------------------------------------------
  // 4. Create the initial registries (agents + domains)
  // ------------------------------------------------------------------

  const registry = createEmptyRegistry();

  // Initialize domain registry with the root domain
  const domainRegistry = { schemaVersion: '1.0.0', domains: [] as import('../models/domain.js').Domain[], updatedAt: now };
  const rootDomain = DomainSchema.parse({
    id: 'root',
    name: projectName,
    path: '.',
    type: 'root',
    parent: null,
    propagation: 'flat',
    status: 'active',
    addedAt: now,
  });
  domainRegistry.domains.push(rootDomain);
  writeJsonFile(AI_PATHS.domainsRegistry(), domainRegistry);

  // ------------------------------------------------------------------
  // 5. Create the architect agent
  // ------------------------------------------------------------------

  const activeTargets = targets
    .filter((t) => ('enabled' in t ? t.enabled : true))
    .map((t) => ('type' in t ? t.type : t)) as Array<'claude' | 'gemini' | { type: 'custom'; label: string; outputDir: string }>;

  const architectAgent = createAgentRecord({
    id: ARCHITECT_AGENT_ID,
    name: 'Agent Architect',
    description:
      'Responsible for managing the AI agent topology of this project using the waffagent CLI.',
    template: ARCHITECT_TEMPLATE_ID,
    ownedPaths: ['.ai/**'],
    tags: ['meta', 'architect'],
    creationReason: 'Bootstrapped by waffagent init as the root agent for topology management.',
    targets: activeTargets as AgentRecord['targets'],
  });

  registry.agents.push(architectAgent);
  writeJsonFile(AI_PATHS.agentsRegistry(), registry);
  logger.verbose(`Wrote ${AI_PATHS.agentsRegistry()}`);

  // ------------------------------------------------------------------
  // 6. Generate the architect agent into each selected target
  // ------------------------------------------------------------------

  logger.info('Generating architect agent files...');

  let template;
  try {
    template = loadTemplate(ARCHITECT_TEMPLATE_ID);
  } catch {
    logger.warn(`Built-in "architect" template not found — skipping agent file generation.`);
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
      const targetType = 'type' in targetConfig ? targetConfig.type : targetConfig;
      let exporter;

      if (targetType === 'claude') exporter = new ClaudeExporter();
      else if (targetType === 'gemini') exporter = new GeminiExporter();
      else exporter = new CustomExporter();

      const result = exporter.export({
        agent: architectAgent,
        template,
        renderedInstructions,
        projectRoot: fromProjectRoot(),
        target: targetConfig,
      });

      logger.success(`Generated: ${path.relative(cwd, result.outputPath)}`);
    }
  }

  // ------------------------------------------------------------------
  // 7. Write starter docs into .ai/docs/
  // ------------------------------------------------------------------

  writeStarterDocs(projectName);

  // ------------------------------------------------------------------
  // 8. Write topology rules starter
  // ------------------------------------------------------------------

  writeStarterRules();

  // ------------------------------------------------------------------
  // 9. Detect domain candidates and prompt user to add them
  // ------------------------------------------------------------------

  if (!options.yes) {
    const candidates = detectDomainCandidates(fromProjectRoot());
    if (candidates.length > 0) {
      logger.blank();
      logger.info(`Detected ${candidates.length} potential domain(s) in this project.`);
      await runDomainsScan({ add: true });
    }
  }

  // ------------------------------------------------------------------
  // Done
  // ------------------------------------------------------------------

  logger.blank();
  logger.success(`Project "${projectName}" initialized.`);
  logger.blank();
  logger.info('What was created:');
  logger.info('  .ai/               — source of truth for agent topology');
  logger.info('  .ai/project.yaml   — project config (edit to change targets/rules)');
  logger.info('  .ai/registry/      — agent registry (managed by CLI)');
  logger.info('  .ai/templates/     — project-local template overrides');
  logger.info('  .ai/bundles/       — project-local bundle definitions');
  logger.info('  .ai/rules/         — topology rules');
  logger.info('  .ai/docs/          — project-level topology notes');
  logger.blank();
  logger.info('Next steps:');
  logger.info('  waffagent validate      — check the current topology');
  logger.info('  waffagent generate      — regenerate all agent files');
  logger.info('  waffagent create-agent  — add a new agent');
  logger.blank();
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Needed for createAgentRecord call above
import { AgentRecord } from '../models/agent.js';

function writeStarterDocs(projectName: string): void {
  const content = `# ${projectName} — Agent Topology Notes

This directory contains project-specific notes about the agent topology.

## Overview

Describe the overall agent strategy for this project here.

## Agents

| ID | Template | Purpose |
|----|----------|---------|
| agent-architect | architect | Manages agent topology using the waffagent CLI |

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
