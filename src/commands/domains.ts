import chalk from 'chalk';
import inquirer from 'inquirer';
import { logger } from '../utils/logger.js';
import { fromProjectRoot } from '../utils/fs.js';
import { assertProjectInitialized, loadDomainRegistry, loadProjectConfig } from '../config/loader.js';
import { detectDomainCandidates } from '../core/detection.js';
import {
  addDomain, removeDomain, listDomains, findDomain,
  getDomainChildren, scaffoldDomain,
} from '../core/domains.js';
import { Domain, DomainSchema, Propagation } from '../models/domain.js';

// ---------------------------------------------------------------------------
// domains subcommands
// ---------------------------------------------------------------------------

// ---- list ------------------------------------------------------------------

export async function runDomainsList(): Promise<void> {
  assertProjectInitialized();
  const domains = listDomains();

  if (domains.length === 0) {
    logger.info('No domains tracked. Run `wairon domains scan` to detect candidates.');
    return;
  }

  logger.header(`Domains (${domains.length})`);
  logger.blank();
  printDomainTree(domains);
}

function printDomainTree(domains: Domain[], parentId: string | null = null, indent = 0): void {
  const children = domains.filter((d) => d.parent === parentId);
  for (const domain of children) {
    const prefix = indent === 0 ? '' : '  '.repeat(indent) + '└─ ';
    const status = domain.status === 'active'
      ? chalk.green('active')
      : domain.status === 'excluded'
        ? chalk.gray('excluded')
        : chalk.yellow('pending');

    console.log(`${prefix}${chalk.bold(domain.id)}  ${chalk.gray(`[${domain.type}]`)}  ${status}`);
    console.log(`${'  '.repeat(indent + 1)}${chalk.gray(domain.path)}`);
    console.log(`${'  '.repeat(indent + 1)}${chalk.gray(`propagation: ${domain.propagation}`)}`);
    console.log();

    printDomainTree(domains, domain.id, indent + 1);
  }
}

// ---- scan ------------------------------------------------------------------

export async function runDomainsScan(options: { add?: boolean } = {}): Promise<void> {
  assertProjectInitialized();
  const projectRoot = fromProjectRoot();
  const registry = loadDomainRegistry();

  const trackedPaths = new Set(registry.domains.map((d) => d.path));
  const candidates = detectDomainCandidates(projectRoot, trackedPaths);

  const newCandidates = candidates.filter((c) => !c.alreadyTracked);

  if (newCandidates.length === 0) {
    logger.success('No new domain candidates found.');
    if (candidates.length > 0) {
      logger.info(`${candidates.length} already-tracked domain(s) re-confirmed.`);
    }
    return;
  }

  logger.header(`Domain Candidates (${newCandidates.length} new)`);
  logger.blank();

  for (const c of newCandidates) {
    console.log(`${chalk.bold(c.suggestedId)}  ${chalk.gray(`[${c.type}]`)}`);
    console.log(`  ${chalk.cyan(c.path)}`);
    console.log();
  }

  if (!options.add) {
    logger.info('Run `wairon domains scan --add` to interactively add these domains.');
    return;
  }

  // Interactive selection
  const { selected } = await inquirer.prompt<{ selected: string[] }>([
    {
      type: 'checkbox',
      name: 'selected',
      message: 'Select domains to add:',
      choices: newCandidates.map((c) => ({
        name: `${c.suggestedId}  ${chalk.gray(c.path)}  [${c.type}]`,
        value: c.path,
        checked: true,
      })),
    },
  ]);

  if (selected.length === 0) {
    logger.info('No domains selected.');
    return;
  }

  const projectConfig = loadProjectConfig();
  const enabledTargets = projectConfig.targets
    .filter((t) => !('enabled' in t) || t.enabled)
    .map((t) => 'type' in t ? t.type : t as string);

  for (const selectedPath of selected) {
    const candidate = newCandidates.find((c) => c.path === selectedPath)!;

    const { propagation, parentId } = await inquirer.prompt<{
      propagation: Propagation;
      parentId: string;
    }>([
      {
        type: 'list',
        name: 'propagation',
        message: `Propagation for "${candidate.suggestedId}":`,
        choices: [
          { name: 'flat       — agents appear at root and all parent domains', value: 'flat' },
          { name: 'parent-only — agents appear in immediate parent only', value: 'parent-only' },
          { name: 'none        — no propagation (use wairon delegate)', value: 'none' },
        ],
        default: 'flat',
      },
      {
        type: 'input',
        name: 'parentId',
        message: `Parent domain id (leave blank for root):`,
        default: '',
      },
    ]);

    const domain = DomainSchema.parse({
      id: candidate.suggestedId,
      name: candidate.suggestedName,
      path: candidate.path,
      type: candidate.type,
      parent: parentId.trim() || 'root',
      propagation,
      status: 'active',
      detectedAt: new Date().toISOString(),
      addedAt: new Date().toISOString(),
    });

    addDomain(domain);
    scaffoldDomain(domain, enabledTargets);
    logger.success(`Added domain: ${domain.id} (${domain.path})`);
  }
}

// ---- add (manual) ----------------------------------------------------------

export async function runDomainsAdd(options: { path?: string; id?: string } = {}): Promise<void> {
  assertProjectInitialized();
  const projectConfig = loadProjectConfig();

  const { domainPath, domainId, domainName, propagation, parentId } = await inquirer.prompt<{
    domainPath: string;
    domainId: string;
    domainName: string;
    propagation: Propagation;
    parentId: string;
  }>([
    {
      type: 'input',
      name: 'domainPath',
      message: 'Domain directory (relative to project root):',
      default: options.path,
      validate: (v: string) => v.trim().length > 0 || 'Path is required',
    },
    {
      type: 'input',
      name: 'domainId',
      message: 'Domain id (lowercase-alphanumeric-dashes):',
      default: options.id,
      validate: (v: string) => /^[a-z0-9-]+$/.test(v) || 'Must be lowercase alphanumeric with dashes',
    },
    {
      type: 'input',
      name: 'domainName',
      message: 'Display name:',
      default: (answers: { domainId: string }) =>
        answers.domainId.split('-').map((w: string) => w.charAt(0).toUpperCase() + w.slice(1)).join(' '),
    },
    {
      type: 'list',
      name: 'propagation',
      message: 'Agent propagation:',
      choices: [
        { name: 'flat (recommended — agents appear at root)', value: 'flat' },
        { name: 'parent-only', value: 'parent-only' },
        { name: 'none (delegation only)', value: 'none' },
      ],
      default: 'flat',
    },
    {
      type: 'input',
      name: 'parentId',
      message: 'Parent domain id (leave blank for root):',
      default: '',
    },
  ]);

  const enabledTargets = projectConfig.targets
    .filter((t) => !('enabled' in t) || t.enabled)
    .map((t) => 'type' in t ? t.type : t as string);

  const domain = DomainSchema.parse({
    id: domainId,
    name: domainName,
    path: domainPath.trim(),
    type: 'manual',
    parent: parentId.trim() || 'root',
    propagation,
    status: 'active',
    addedAt: new Date().toISOString(),
  });

  addDomain(domain);
  scaffoldDomain(domain, enabledTargets);

  logger.success(`Domain "${domain.id}" added and scaffolded.`);
  logger.info(`Now run \`wairon create-bundle\` to add agents for this domain.`);
}

// ---- remove ----------------------------------------------------------------

export async function runDomainsRemove(id: string): Promise<void> {
  assertProjectInitialized();

  const domain = findDomain(id);
  if (!domain) {
    logger.error(`Domain "${id}" not found.`);
    process.exit(1);
  }

  const registry = loadDomainRegistry();
  const children = getDomainChildren(id, registry);

  if (children.length > 0) {
    logger.warn(`Domain "${id}" has ${children.length} child domain(s): ${children.map((c) => c.id).join(', ')}`);
    logger.warn('Remove child domains first, or reassign their parent.');
    process.exit(1);
  }

  const { confirm } = await inquirer.prompt<{ confirm: boolean }>([
    {
      type: 'confirm',
      name: 'confirm',
      message: `Remove domain "${id}" (${domain.path})? Generated agent files will NOT be deleted.`,
      default: false,
    },
  ]);

  if (!confirm) {
    logger.info('Cancelled.');
    return;
  }

  removeDomain(id);
  logger.success(`Domain "${id}" removed from registry.`);
  logger.info('Agent files in the domain directory were not deleted. Remove manually if needed.');
}
