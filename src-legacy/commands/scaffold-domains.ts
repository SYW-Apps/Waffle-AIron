import chalk from 'chalk';
import inquirer from 'inquirer';
import { logger } from '../utils/logger.js';
import { filteredCheckbox } from '../utils/filteredCheckbox.js';
import {
  assertProjectInitialized,
  loadProjectConfig,
  loadRegistry,
  loadDomainRegistry as _loadDomainRegistry,
} from '../config/loader.js';
import { listBundleIds, loadBundle } from '../core/bundles.js';
import { expandBundleForDomain } from '../core/scaffold.js';
import { addAgent } from '../core/registry.js';
import { detectDomainCandidates } from '../core/detection.js';
import {
  addDomain, scaffoldDomain,
} from '../core/domains.js';
import { Domain, DomainSchema } from '../models/domain.js';
import { fromProjectRoot } from '../utils/fs.js';
import { WaironError } from '../utils/errors.js';
import { runGenerate } from './generate.js';

// ---------------------------------------------------------------------------
// scaffold-domains command
//
// Two modes:
//   - Normal: shows domains that are already in the registry but have no agents
//   - Rescan (called by init --reinit): scans for new domain candidates first,
//     adds them, then scaffolds agents for domains that still have none
// ---------------------------------------------------------------------------

export interface ScaffoldDomainsOptions {
  /** Also scan for untracked domain candidates and offer to add them first */
  rescan?: boolean;
}

export async function runScaffoldDomains(options: ScaffoldDomainsOptions = {}): Promise<void> {
  assertProjectInitialized();

  const projectConfig = loadProjectConfig();
  const bundleIds = listBundleIds();

  if (bundleIds.length === 0) {
    logger.warn('No bundles available. Cannot scaffold agents without a bundle.');
    return;
  }

  const activeTargetTypes = projectConfig.targets
    .filter((t) => !('enabled' in t) || t.enabled)
    .map((t) => t.type);

  // ------------------------------------------------------------------
  // Optional rescan: detect and add new domains
  // ------------------------------------------------------------------

  if (options.rescan) {
    await rescanAndAddDomains(projectConfig, activeTargetTypes);
    logger.blank();
  }

  // ------------------------------------------------------------------
  // Find domains that have no agents
  // ------------------------------------------------------------------

  const registry = loadRegistry();
  const domainRegistry = _loadDomainRegistry();

  const domainedAgentDomains = new Set(
    registry.agents.map((a) => a.domainRoot).filter(Boolean),
  );

  const unscaffolded = domainRegistry.domains.filter(
    (d) => d.type !== 'root' && !domainedAgentDomains.has(d.id),
  );

  if (unscaffolded.length === 0) {
    logger.success('All domains already have agents scaffolded.');
    logger.info('Run `wairon create-agent` or `wairon create-bundle` to add more.');
    return;
  }

  logger.header(`Scaffold Domains (${unscaffolded.length} without agents)`);
  logger.blank();

  // ------------------------------------------------------------------
  // Select which domains to scaffold
  // ------------------------------------------------------------------

  const selectedIds = await filteredCheckbox({
    message: 'Select domains to scaffold agents for',
    items: unscaffolded.map((d) => ({
      label: d.id,
      subtext: d.path,
      value: d.id,
      itemType: d.type,
    })),
  });

  if (selectedIds.length === 0) {
    logger.info('No domains selected.');
    return;
  }

  const selectedDomains = unscaffolded.filter((d) => selectedIds.includes(d.id));

  // ------------------------------------------------------------------
  // Default bundle
  // ------------------------------------------------------------------

  const savedDefault = projectConfig.defaultBundle;
  const defaultBundle = savedDefault && bundleIds.includes(savedDefault) ? savedDefault : null;

  const bundleChoices = [
    ...(defaultBundle ? [{ name: `${chalk.bold(defaultBundle)}  ${chalk.gray('(project default)')}`, value: defaultBundle }] : []),
    ...bundleIds
      .filter((id) => id !== defaultBundle)
      .map((id) => {
        try {
          const b = loadBundle(id);
          return { name: `${chalk.bold(id)}  — ${b.description.split('\n')[0].trim()}`, value: id };
        } catch {
          return { name: id, value: id };
        }
      }),
  ];

  const { defaultBundleId } = await inquirer.prompt<{ defaultBundleId: string }>([
    {
      type: 'list',
      name: 'defaultBundleId',
      message: 'Default bundle for all selected domains:',
      choices: bundleChoices,
      default: defaultBundle ?? bundleIds[0],
    },
  ]);

  // ------------------------------------------------------------------
  // Per-domain overrides
  // ------------------------------------------------------------------

  const assignments = new Map<string, string>(
    selectedDomains.map((d) => [d.id, defaultBundleId]),
  );

  if (selectedDomains.length > 1 && bundleIds.length > 1) {
    const { doOverride } = await inquirer.prompt<{ doOverride: boolean }>([
      {
        type: 'confirm',
        name: 'doOverride',
        message: 'Use a different bundle for specific domains?',
        default: false,
      },
    ]);

    if (doOverride) {
      const overrideIds = await filteredCheckbox({
        message: 'Select domains to override bundle',
        items: selectedDomains.map((d) => ({
          label: d.id,
          subtext: `${d.path}  →  ${defaultBundleId}`,
          value: d.id,
          itemType: d.type,
        })),
      });

      for (const domainId of overrideIds) {
        const { bundleId } = await inquirer.prompt<{ bundleId: string }>([
          {
            type: 'list',
            name: 'bundleId',
            message: `Bundle for "${domainId}":`,
            choices: bundleIds,
          },
        ]);
        assignments.set(domainId, bundleId);
      }
    }
  }

  // ------------------------------------------------------------------
  // Preview
  // ------------------------------------------------------------------

  logger.blank();
  logger.info('Plan:');
  for (const domain of selectedDomains) {
    const bundleId = assignments.get(domain.id)!;
    let agentCount = 0;
    try { agentCount = loadBundle(bundleId).agents.length; } catch { /* ignore */ }
    console.log(
      `  ${chalk.bold(domain.id)}  ${chalk.gray(domain.path)}` +
      `  →  ${chalk.cyan(bundleId)}  ${chalk.gray(`(${agentCount} agents)`)}`,
    );
  }
  logger.blank();

  const { confirmed } = await inquirer.prompt<{ confirmed: boolean }>([
    {
      type: 'confirm',
      name: 'confirmed',
      message: 'Create agents?',
      default: true,
    },
  ]);

  if (!confirmed) { logger.info('Cancelled.'); return; }

  // ------------------------------------------------------------------
  // Execute: create agents
  // ------------------------------------------------------------------

  let created = 0;
  let skipped = 0;

  for (const domain of selectedDomains) {
    const bundleId = assignments.get(domain.id)!;
    let agents;
    try {
      agents = expandBundleForDomain(domain, bundleId, activeTargetTypes);
    } catch (err) {
      logger.warn(`Could not load bundle "${bundleId}" for domain "${domain.id}": ${err instanceof Error ? err.message : String(err)}`);
      skipped++;
      continue;
    }

    for (const agent of agents) {
      try {
        addAgent(agent);
        logger.success(`Created: ${agent.id}`);
        created++;
      } catch (err) {
        const msg = err instanceof WaironError ? err.message : String(err);
        logger.warn(`Skipped ${agent.id}: ${msg}`);
        skipped++;
      }
    }
  }

  logger.blank();
  logger.info(`Done: ${created} agents created, ${skipped} skipped.`);

  if (created > 0) {
    const { generate } = await inquirer.prompt<{ generate: boolean }>([
      {
        type: 'confirm',
        name: 'generate',
        message: 'Generate agent files now?',
        default: true,
      },
    ]);
    if (generate) {
      logger.blank();
      await runGenerate();
    }
  }
}

// ---------------------------------------------------------------------------
// Rescan: detect new domain candidates and add any the user selects
// ---------------------------------------------------------------------------

async function rescanAndAddDomains(
  _projectConfig: ReturnType<typeof loadProjectConfig>,
  activeTargetTypes: string[],
): Promise<void> {
  const projectRoot = fromProjectRoot();
  const domainRegistry = _loadDomainRegistry();

  const trackedPaths = new Set(domainRegistry.domains.map((d) => d.path));
  const trackedIds   = new Set(domainRegistry.domains.map((d) => d.id));
  const candidates   = detectDomainCandidates(projectRoot, trackedPaths, trackedIds);
  const newOnes      = candidates.filter((c) => !c.alreadyTracked);

  if (newOnes.length === 0) {
    logger.info('No new domain candidates found.');
    return;
  }

  logger.info(`Found ${newOnes.length} new domain candidate(s).`);

  const selectedPaths = await filteredCheckbox({
    message: 'Select new domains to add',
    items: newOnes.map((c) => ({
      label: c.suggestedId,
      subtext: c.path,
      value: c.path,
      itemType: c.type,
    })),
  });

  if (selectedPaths.length === 0) return;

  const now = new Date().toISOString();
  let added = 0;

  for (const p of selectedPaths) {
    const c = newOnes.find((x) => x.path === p)!;
    const domain: Domain = DomainSchema.parse({
      id: c.suggestedId,
      name: c.suggestedName,
      path: c.path,
      type: c.type,
      parent: 'root',
      propagation: 'flat',
      status: 'active',
      detectedAt: now,
      addedAt: now,
    });

    try {
      addDomain(domain);
      scaffoldDomain(domain, activeTargetTypes);
      logger.success(`Added domain: ${domain.id} (${domain.path})`);
      added++;
    } catch (err) {
      const msg = err instanceof WaironError ? err.message : String(err);
      logger.warn(`Skipped "${c.suggestedId}": ${msg}`);
    }
  }

  logger.info(`${added} domain(s) added.`);
}

