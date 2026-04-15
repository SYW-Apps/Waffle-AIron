import * as path from 'path';
import chalk from 'chalk';
import inquirer from 'inquirer';
import { logger } from '../utils/logger.js';
import { ensureDir, writeFile, fromProjectRoot } from '../utils/fs.js';
import { filteredCheckbox } from '../utils/filteredCheckbox.js';
import {
  globalGuideFilePath,
  localGuideFilePath,
  hasWaironGuide,
  injectGuide,
} from '../utils/ai-guide.js';
import { writeYamlFile, writeJsonFile } from '../utils/yaml.js';
import { isProjectInitialized, AI_PATHS } from '../config/loader.js';
import {
  defaultTargetConfig,
  ARCHITECT_AGENT_ID,
  ARCHITECT_TEMPLATE_ID,
} from '../config/defaults.js';
import { createAgentRecord, AgentRecord } from '../models/agent.js';
import { createEmptyRegistry } from '../models/registry.js';
import { Domain, DomainSchema } from '../models/domain.js';
import { ProjectConfig, TargetConfig } from '../models/project.js';
import { loadTemplate, renderTemplateInstructions } from '../core/templates.js';
import { detectDomainCandidates } from '../core/detection.js';
import { DetectedDomainCandidate } from '../models/domain.js';
import { scaffoldDomain } from '../core/domains.js';
import { expandBundleForDomain } from '../core/scaffold.js';
import { listBundleIds, loadBundle } from '../core/bundles.js';
import { ClaudeExporter } from '../exporters/claude.js';
import { GeminiExporter } from '../exporters/gemini.js';
import { CustomExporter } from '../exporters/custom.js';
import { runScaffoldDomains } from './scaffold-domains.js';
import { runGenerate } from './generate.js';
import { syncContextFiles } from '../core/context.js';

// ---------------------------------------------------------------------------
// init command
// ---------------------------------------------------------------------------

interface InitOptions {
  yes?: boolean;
}

interface DomainAssignment {
  candidate: DetectedDomainCandidate;
  bundleId: string | null; // null = skip bundle for this domain
}

interface AiGuidePlan {
  claudeGlobal: boolean;
  claudeLocal: boolean;
  geminiGlobal: boolean;
  geminiLocal: boolean;
}

export async function runInit(options: InitOptions = {}): Promise<void> {
  logger.header('wairon init');

  // Already initialized → offer rescan + scaffold
  if (isProjectInitialized()) {
    logger.info('Project already initialized.');
    logger.blank();
    await runScaffoldDomains({ rescan: true });
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

  const targets: TargetConfig[] = [defaultTargetConfig('claude')];
  const projectConfig = buildProjectConfig(projectName, targets, null, now);

  executeInit(projectName, targets, projectConfig, [], null, { claudeGlobal: false, claudeLocal: false, geminiGlobal: false, geminiLocal: false }, now);

  logger.success(`Project "${projectName}" initialized (non-interactive).`);
  logger.info('Run `wairon domains scan --add` to add domains, then `wairon scaffold-domains` to create agents.');
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
  // Phase 2 — Targets
  // ------------------------------------------------------------------

  const { targetTypes, customPath, customLabel } = await inquirer.prompt<{
    targetTypes: string[];
    customPath: string;
    customLabel: string;
  }>([
    {
      type: 'checkbox',
      name: 'targetTypes',
      message: 'Which AI coding tools will you use? (Space to select · Enter to confirm)',
      choices: [
        { name: 'Claude Code  (.claude/agents/)', value: 'claude', checked: true },
        { name: 'Gemini CLI   (.gemini/agents/)', value: 'gemini' },
        { name: 'Custom path  (any other tool)',  value: 'custom' },
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
  if (targetTypes.includes('claude')) targets.push(defaultTargetConfig('claude'));
  if (targetTypes.includes('gemini')) targets.push(defaultTargetConfig('gemini'));
  if (targetTypes.includes('custom') && customPath) {
    targets.push({ type: 'custom', label: customLabel ?? 'Custom', outputDir: customPath, enabled: true });
  }
  if (targets.length === 0) {
    targets.push(defaultTargetConfig('claude'));
    logger.warn('No targets selected — defaulting to Claude Code.');
  }

  const activeTargetTypes = targets
    .filter((t) => !('enabled' in t) || t.enabled)
    .map((t) => t.type);

  // ------------------------------------------------------------------
  // Phase 3 — Default bundle
  // ------------------------------------------------------------------

  const bundleIds = listBundleIds();
  let defaultBundleId: string | null = null;

  if (bundleIds.length > 0) {
    const bundleChoices = [
      { name: chalk.gray('none  — scaffold agents manually later'), value: '__none__' },
      ...bundleIds.map((id) => {
        try {
          const b = loadBundle(id);
          return { name: `${chalk.bold(id)}  — ${b.description.split('\n')[0].trim()}`, value: id };
        } catch {
          return { name: id, value: id };
        }
      }),
    ];

    const { selectedBundle } = await inquirer.prompt<{ selectedBundle: string }>([
      {
        type: 'list',
        name: 'selectedBundle',
        message: 'Default bundle for domain scaffolding:',
        choices: bundleChoices,
      },
    ]);

    defaultBundleId = selectedBundle === '__none__' ? null : selectedBundle;
  }

  // ------------------------------------------------------------------
  // Phase 4 — Domain detection + selection
  // ------------------------------------------------------------------

  const projectRoot = fromProjectRoot();
  const allCandidates = detectDomainCandidates(projectRoot);
  const domainAssignments: DomainAssignment[] = [];

  if (allCandidates.length > 0) {
    logger.blank();
    logger.info(`Detected ${allCandidates.length} potential domain candidate(s).`);
    logger.blank();

    const selectedPaths = await filteredCheckbox({
      message: 'Select domains to include',
      items: allCandidates.map((c) => ({
        label: c.suggestedId,
        subtext: c.path,
        value: c.path,
        itemType: c.type,
      })),
    });

    const selected = allCandidates.filter((c) => selectedPaths.includes(c.path));

    // Phase 5 — Per-domain bundle overrides
    if (selected.length > 0 && defaultBundleId !== null && bundleIds.length > 1) {
      const { doOverride } = await inquirer.prompt<{ doOverride: boolean }>([
        {
          type: 'confirm',
          name: 'doOverride',
          message: `Use a different bundle for specific domains? (default: ${chalk.bold(defaultBundleId)})`,
          default: false,
        },
      ]);

      if (doOverride) {
        const overridePaths = await filteredCheckbox({
          message: 'Select domains to override',
          items: selected.map((c) => ({
            label: c.suggestedId,
            subtext: c.path,
            value: c.path,
            itemType: c.type,
          })),
        });

        const overrideSet = new Set(overridePaths);

        // Group override domains and pick bundles for them
        for (const c of selected) {
          if (overrideSet.has(c.path)) {
            const { bundleId } = await inquirer.prompt<{ bundleId: string }>([
              {
                type: 'list',
                name: 'bundleId',
                message: `Bundle for "${c.suggestedId}":`,
                choices: [
                  { name: chalk.gray('none'), value: '__none__' },
                  ...bundleIds,
                ],
              },
            ]);
            domainAssignments.push({
              candidate: c,
              bundleId: bundleId === '__none__' ? null : bundleId,
            });
          } else {
            domainAssignments.push({ candidate: c, bundleId: defaultBundleId });
          }
        }
      } else {
        for (const c of selected) {
          domainAssignments.push({ candidate: c, bundleId: defaultBundleId });
        }
      }
    } else {
      for (const c of selected) {
        domainAssignments.push({ candidate: c, bundleId: defaultBundleId });
      }
    }
  }

  // ------------------------------------------------------------------
  // Phase 6 — AI guide injection
  // ------------------------------------------------------------------

  const guidePlan: AiGuidePlan = {
    claudeGlobal: false,
    claudeLocal: false,
    geminiGlobal: false,
    geminiLocal: false,
  };

  for (const targetType of ['claude', 'gemini'] as const) {
    if (!activeTargetTypes.includes(targetType)) continue;

    const globalPath = globalGuideFilePath(targetType);
    const localPath  = localGuideFilePath(projectRoot, targetType);
    const toolName   = targetType === 'claude' ? 'Claude Code' : 'Gemini CLI';

    const globalAlready = globalPath ? hasWaironGuide(globalPath) : false;

    logger.blank();
    logger.info(`${chalk.bold(toolName)} guide injection:`);
    if (globalAlready) {
      logger.info(`  ${chalk.green('✔')} Global config already contains wairon guide.`);
    }

    const choices = [];
    if (!globalAlready && globalPath) {
      choices.push({ name: `Global config  (${globalPath})`, value: 'global' });
    }
    if (localPath) {
      choices.push({ name: `Local project  (${path.relative(projectRoot, localPath)})`, value: 'local' });
    }
    if (choices.length === 0) continue;

    const { guideScopes } = await inquirer.prompt<{ guideScopes: string[] }>([
      {
        type: 'checkbox',
        name: 'guideScopes',
        message: `Add wairon usage guide to: (Space to select · Enter to confirm)`,
        choices,
        default: globalAlready ? [] : choices.slice(0, 1).map((c) => c.value),
      },
    ]);

    if (targetType === 'claude') {
      guidePlan.claudeGlobal = guideScopes.includes('global');
      guidePlan.claudeLocal  = guideScopes.includes('local');
    } else {
      guidePlan.geminiGlobal = guideScopes.includes('global');
      guidePlan.geminiLocal  = guideScopes.includes('local');
    }
  }

  // ------------------------------------------------------------------
  // Phase 7 — Confirmation summary
  // ------------------------------------------------------------------

  logger.blank();
  logger.header('Init summary');
  logger.blank();
  console.log(`  ${chalk.bold('Project:')}  ${projectName}`);
  console.log(`  ${chalk.bold('Targets:')}  ${targets.map((t) => t.type).join(', ')}`);
  console.log(`  ${chalk.bold('Bundle:')}   ${defaultBundleId ?? chalk.gray('none')}`);

  if (domainAssignments.length > 0) {
    console.log(`  ${chalk.bold('Domains:')}  ${domainAssignments.length} selected`);
    const withBundle    = domainAssignments.filter((a) => a.bundleId !== null);
    const withoutBundle = domainAssignments.filter((a) => a.bundleId === null);
    if (withBundle.length > 0) {
      console.log(chalk.gray(`    ${withBundle.length} will have agents scaffolded`));
    }
    if (withoutBundle.length > 0) {
      console.log(chalk.gray(`    ${withoutBundle.length} added without agents (manual later)`));
    }
    const totalAgents = withBundle.reduce((sum, a) => {
      try {
        return sum + loadBundle(a.bundleId!).agents.length;
      } catch {
        return sum;
      }
    }, 0);
    if (totalAgents > 0) {
      console.log(chalk.gray(`    ~${totalAgents} agents to create`));
    }
  } else {
    console.log(`  ${chalk.bold('Domains:')}  none selected`);
  }

  const guideLines = [
    guidePlan.claudeGlobal && 'Claude global',
    guidePlan.claudeLocal  && 'Claude local',
    guidePlan.geminiGlobal && 'Gemini global',
    guidePlan.geminiLocal  && 'Gemini local',
  ].filter(Boolean);

  console.log(`  ${chalk.bold('Guide:')}    ${guideLines.length > 0 ? guideLines.join(', ') : chalk.gray('skip')}`);
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
  // Phase 8 — Execute
  // ------------------------------------------------------------------

  const now = new Date().toISOString();
  const projectConfig = buildProjectConfig(projectName, targets, defaultBundleId, now);

  await executeInit(
    projectName,
    targets,
    projectConfig,
    domainAssignments,
    defaultBundleId,
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
  domainAssignments: DomainAssignment[],
  _defaultBundleId: string | null,
  guidePlan: AiGuidePlan,
  now: string,
): Promise<void> {
  const projectRoot = fromProjectRoot();
  const cwd = process.cwd();

  logger.blank();
  logger.info('Creating .wai/ project structure...');

  // Directories
  ensureDir(AI_PATHS.root());
  ensureDir(AI_PATHS.registryDir());
  ensureDir(AI_PATHS.templatesDir());
  ensureDir(AI_PATHS.bundlesDir());
  ensureDir(AI_PATHS.rulesDir());
  ensureDir(AI_PATHS.docsDir());
  ensureDir(AI_PATHS.generatedDir());

  writeYamlFile(AI_PATHS.projectConfig(), projectConfig);

  // Domain registry + root domain
  const rootDomain: Domain = DomainSchema.parse({
    id: 'root',
    name: projectName,
    path: '.',
    type: 'root',
    parent: null,
    propagation: 'flat',
    status: 'active',
    addedAt: now,
  });

  const domainRegistry = {
    schemaVersion: '1.0.0',
    domains: [rootDomain] as Domain[],
    updatedAt: now,
  };

  // Add selected domains to the domain registry and scaffold their directories
  const activeTargetTypes = targets
    .filter((t) => !('enabled' in t) || t.enabled)
    .map((t) => t.type);

  for (const assignment of domainAssignments) {
    const { candidate } = assignment;
    const domain: Domain = DomainSchema.parse({
      id: candidate.suggestedId,
      name: candidate.suggestedName,
      path: candidate.path,
      type: candidate.type,
      parent: 'root',
      propagation: 'flat',
      status: 'active',
      detectedAt: now,
      addedAt: now,
    });
    domainRegistry.domains.push(domain);
    scaffoldDomain(domain, activeTargetTypes);
  }

  writeJsonFile(AI_PATHS.domainsRegistry(), domainRegistry);

  // Agent registry: start with architect
  const registry = createEmptyRegistry();

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

  registry.agents.push(architectAgent);

  // Create bundle agents for each selected domain
  let agentsCreated = 0;
  for (const assignment of domainAssignments) {
    if (!assignment.bundleId) continue;

    const domain = domainRegistry.domains.find((d) => d.id === assignment.candidate.suggestedId);
    if (!domain) continue;

    const bundleAgents = expandBundleForDomain(domain, assignment.bundleId, activeTargetTypes);
    for (const agent of bundleAgents) {
      if (!registry.agents.some((a) => a.id === agent.id)) {
        registry.agents.push(agent);
        agentsCreated++;
      } else {
        logger.warn(`Skipped duplicate agent id: ${agent.id}`);
      }
    }
  }

  writeJsonFile(AI_PATHS.agentsRegistry(), registry);
  logger.verbose(`Wrote ${AI_PATHS.agentsRegistry()} (${registry.agents.length} agents)`);

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
      const targetType = targetConfig.type;
      let exporter;
      if (targetType === 'claude') exporter = new ClaudeExporter();
      else if (targetType === 'gemini') exporter = new GeminiExporter();
      else exporter = new CustomExporter();

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
  }

  // Generate all domain agents
  if (agentsCreated > 0) {
    logger.blank();
    logger.info(`Generating ${agentsCreated} domain agent(s)...`);
    await runGenerate();
  }

  // Seed the context directory with auto-generated files (domains.md + wairon-guide.md)
  syncContextFiles();
  logger.verbose('Context files seeded in .wai/context/');

  // Done
  logger.blank();
  logger.success(`Project "${projectName}" initialized.`);
  logger.blank();
  logger.info('What was created:');
  logger.info('  .wai/               — source of truth for agent topology');
  logger.info('  .wai/project.yaml   — project config');
  logger.info(`  .wai/registry/      — ${registry.agents.length} agent(s) registered`);
  logger.info(`  domains             — ${domainAssignments.length} domain(s) added`);
  logger.info('  .wai/context/       — shared context directory (domains.md, wairon-guide.md)');
  logger.blank();
  logger.info('Next steps:');
  logger.info('  wairon context init         — describe the project so all AI sessions share context');
  logger.info('  wairon validate             — check the topology');
  logger.info('  wairon scaffold-domains     — add agents for any remaining domains');
  logger.info('  wairon create-agent         — add a custom agent');
  logger.blank();
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildProjectConfig(
  name: string,
  targets: TargetConfig[],
  defaultBundle: string | null,
  now: string,
): ProjectConfig {
  return {
    schemaVersion: '1.0.0',
    name,
    targets,
    rules: {
      noOverlappingOwnership: true,
      requireOwnedPaths: true,
      metaAgentTags: ['meta', 'guardian', 'architect'],
      enforceReproducibility: true,
    },
    defaultBackend: 'claude',
    defaultBundle: defaultBundle ?? undefined,
    createdAt: now,
    updatedAt: now,
  };
}

function writeStarterDocs(projectName: string): void {
  const content = `# ${projectName} — Agent Topology Notes

This directory contains project-specific notes about the agent topology.

## Overview

Describe the overall agent strategy for this project here.

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
