import chalk from 'chalk';
import inquirer from 'inquirer';
import { logger } from '../utils/logger.js';
import { fromProjectRoot } from '../utils/fs.js';
import { filteredCheckbox } from '../utils/filteredCheckbox.js';
import { assertProjectInitialized } from '../config/loader.js';
import { detectDomainCandidates } from '../core/detection.js';
import {
  resolveDomains,
  addFreeStandingDomain,
  removeFreeStandingDomain,
  findDomain,
} from '../core/domains.js';
import { Domain, DomainSchema } from '../models/domain.js';

// ---------------------------------------------------------------------------
// domains subcommands
//
// Domains come from two sources:
//   - subsystem-derived (boundTo set) — read-only, from the spec tree
//   - free-standing — authored in .wai/topology.yaml (scan / add / remove)
// ---------------------------------------------------------------------------

// ---- list ------------------------------------------------------------------

export async function runDomainsList(): Promise<void> {
  assertProjectInitialized();
  const domains = resolveDomains();

  if (domains.length === 0) {
    logger.info('No domains yet.');
    logger.info('Define subsystems in the spec tree, or run `wairon domains scan --add` for free-standing domains.');
    return;
  }

  logger.header(`Domains (${domains.length})`);
  logger.blank();
  for (const d of domains) {
    printDomain(d);
  }
}

function printDomain(domain: Domain): void {
  const source = domain.boundTo
    ? chalk.gray(`[subsystem: ${domain.boundTo}]`)
    : chalk.cyan('[free-standing]');
  console.log(`${chalk.bold(domain.id)}  ${source}`);
  if (domain.name) console.log(`  ${chalk.gray(domain.name)}`);
  if (domain.path) console.log(`  ${chalk.gray(`path: ${domain.path}`)}`);
  if (domain.ownedPaths.length > 0) {
    console.log(`  ${chalk.gray(`owns: ${domain.ownedPaths.join(', ')}`)}`);
  }
  console.log();
}

// ---- scan ------------------------------------------------------------------

export async function runDomainsScan(options: { add?: boolean } = {}): Promise<void> {
  assertProjectInitialized();
  const projectRoot = fromProjectRoot();
  const existing = resolveDomains();

  const trackedPaths = new Set(existing.map((d) => d.path).filter((p): p is string => !!p));
  const trackedIds = new Set(existing.map((d) => d.id));
  const candidates = detectDomainCandidates(projectRoot, trackedPaths, trackedIds);

  const newCandidates = candidates.filter((c) => !c.alreadyTracked && !trackedIds.has(c.suggestedId));

  if (newCandidates.length === 0) {
    logger.success('No new domain candidates found.');
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
    logger.info('Run `wairon domains scan --add` to add these as free-standing domains.');
    return;
  }

  const selected = await filteredCheckbox({
    message: 'Select domains to add (as free-standing domains in .wai/topology.yaml)',
    items: newCandidates.map((c) => ({
      label: c.suggestedId,
      subtext: c.path,
      value: c.path,
      itemType: c.type,
    })),
  });

  if (selected.length === 0) {
    logger.info('No domains selected.');
    return;
  }

  let added = 0;
  let skipped = 0;

  for (const selectedPath of selected) {
    const candidate = newCandidates.find((c) => c.path === selectedPath)!;
    const domain = DomainSchema.parse({
      id: candidate.suggestedId,
      name: candidate.suggestedName,
      path: candidate.path,
      ownedPaths: [`${candidate.path}/**`],
    });

    try {
      addFreeStandingDomain(domain);
      logger.success(`Added free-standing domain: ${domain.id} (${candidate.path})`);
      added++;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`Skipped "${candidate.suggestedId}": ${msg}`);
      skipped++;
    }
  }

  logger.blank();
  logger.info(`Done: ${added} added, ${skipped} skipped.`);
  if (added > 0) logger.info('Run `wairon generate` to produce owner agents for the new domains.');
}

// ---- add (manual) ----------------------------------------------------------

export async function runDomainsAdd(options: { path?: string; id?: string } = {}): Promise<void> {
  assertProjectInitialized();

  const { domainId, domainName, domainPath, ownedPathsRaw } = await inquirer.prompt<{
    domainId: string;
    domainName: string;
    domainPath: string;
    ownedPathsRaw: string;
  }>([
    {
      type: 'input',
      name: 'domainId',
      message: 'Domain id (lowercase-alphanumeric, dashes/underscores):',
      default: options.id,
      validate: (v: string) => /^[a-z0-9-_]+$/.test(v) || 'Must be lowercase alphanumeric with dashes or underscores',
    },
    {
      type: 'input',
      name: 'domainName',
      message: 'Display name:',
      default: (answers: { domainId: string }) =>
        answers.domainId.split(/[-_]/).map((w: string) => w.charAt(0).toUpperCase() + w.slice(1)).join(' '),
    },
    {
      type: 'input',
      name: 'domainPath',
      message: 'Physical directory (optional, relative to project root):',
      default: options.path ?? '',
    },
    {
      type: 'input',
      name: 'ownedPathsRaw',
      message: 'Owned path globs (comma-separated):',
      default: (answers: { domainPath: string }) => (answers.domainPath ? `${answers.domainPath}/**` : ''),
      validate: (v: string) => v.trim().length > 0 || 'At least one owned path is required',
    },
  ]);

  const ownedPaths = ownedPathsRaw.split(',').map((s) => s.trim()).filter(Boolean);

  const domain = DomainSchema.parse({
    id: domainId,
    name: domainName,
    path: domainPath.trim() || undefined,
    ownedPaths,
  });

  addFreeStandingDomain(domain);

  logger.success(`Free-standing domain "${domain.id}" added to .wai/topology.yaml.`);
  logger.info('Run `wairon generate` to produce its owner agent.');
}

// ---- remove ----------------------------------------------------------------

export async function runDomainsRemove(id: string): Promise<void> {
  assertProjectInitialized();

  const domain = findDomain(id);
  if (!domain) {
    logger.error(`Domain "${id}" not found.`);
    process.exit(1);
  }

  if (domain.boundTo) {
    logger.error(`Domain "${id}" is derived from subsystem "${domain.boundTo}" and cannot be removed here.`);
    logger.info('Remove or rename the subsystem in the spec tree instead.');
    process.exit(1);
  }

  const { confirm } = await inquirer.prompt<{ confirm: boolean }>([
    {
      type: 'confirm',
      name: 'confirm',
      message: `Remove free-standing domain "${id}" from .wai/topology.yaml?`,
      default: false,
    },
  ]);

  if (!confirm) {
    logger.info('Cancelled.');
    return;
  }

  removeFreeStandingDomain(id);
  logger.success(`Domain "${id}" removed. Run \`wairon generate\` to refresh agent files.`);
}
