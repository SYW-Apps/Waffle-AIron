import * as path from 'path';
import * as fs from 'fs';
import { Domain, DomainRegistry } from '../models/domain.js';
import { loadDomainRegistry, saveDomainRegistry } from '../config/loader.js';
import { WaironError } from '../utils/errors.js';
import { ensureDir, writeFile, fromProjectRoot } from '../utils/fs.js';

// ---------------------------------------------------------------------------
// Domain CRUD operations
// ---------------------------------------------------------------------------

export function addDomain(domain: Domain): void {
  const registry = loadDomainRegistry();

  if (registry.domains.some((d) => d.id === domain.id)) {
    throw new WaironError(`Domain "${domain.id}" already exists.`);
  }
  if (registry.domains.some((d) => d.path === domain.path)) {
    throw new WaironError(`A domain for path "${domain.path}" already exists.`);
  }

  registry.domains.push(domain);
  saveDomainRegistry(registry);
}

export function updateDomain(updated: Domain): void {
  const registry = loadDomainRegistry();
  const index = registry.domains.findIndex((d) => d.id === updated.id);
  if (index === -1) throw new WaironError(`Domain "${updated.id}" not found.`);
  registry.domains[index] = updated;
  saveDomainRegistry(registry);
}

export function removeDomain(id: string): void {
  const registry = loadDomainRegistry();
  const index = registry.domains.findIndex((d) => d.id === id);
  if (index === -1) throw new WaironError(`Domain "${id}" not found.`);
  registry.domains.splice(index, 1);
  saveDomainRegistry(registry);
}

export function findDomain(id: string): Domain | undefined {
  return loadDomainRegistry().domains.find((d) => d.id === id);
}

export function listDomains(): Domain[] {
  return loadDomainRegistry().domains;
}

export function replaceDomainRegistry(registry: DomainRegistry): void {
  saveDomainRegistry(registry);
}

// ---------------------------------------------------------------------------
// Domain tree helpers
// ---------------------------------------------------------------------------

/**
 * Return the ordered chain from a domain up to the root domain.
 * e.g. core-utils → core-service → root
 */
export function getDomainAncestors(domainId: string, registry: DomainRegistry): Domain[] {
  const ancestors: Domain[] = [];
  let current = registry.domains.find((d) => d.id === domainId);

  while (current?.parent) {
    const parent = registry.domains.find((d) => d.id === current!.parent);
    if (!parent) break;
    ancestors.push(parent);
    current = parent;
  }

  return ancestors;
}

/**
 * Return direct children of a domain.
 */
export function getDomainChildren(domainId: string, registry: DomainRegistry): Domain[] {
  return registry.domains.filter((d) => d.parent === domainId);
}

/**
 * Determine which parent domains should receive a reference agent for an
 * agent owned by the given domain, based on propagation settings.
 *
 * 'flat'        → all ancestors up to root
 * 'parent-only' → immediate parent only
 * 'none'        → empty list (no propagation)
 */
export function getPropagationTargets(
  domain: Domain,
  registry: DomainRegistry,
): Domain[] {
  if (domain.propagation === 'none') return [];

  const ancestors = getDomainAncestors(domain.id, registry);
  if (domain.propagation === 'parent-only') {
    return ancestors.slice(0, 1);
  }

  // 'flat': all ancestors
  return ancestors;
}

// ---------------------------------------------------------------------------
// Domain scaffolding
//
// When a domain is added, scaffold its local .wai/ and agent output directories.
// ---------------------------------------------------------------------------

export function scaffoldDomain(domain: Domain, targets: string[]): void {
  const domainAbsPath = fromProjectRoot(domain.path);

  // Create local agent output directories for each target
  for (const target of targets) {
    let agentDir: string;
    if (target === 'claude') agentDir = path.join(domainAbsPath, '.claude', 'agents');
    else if (target === 'gemini') agentDir = path.join(domainAbsPath, '.gemini', 'agents');
    else continue;

    ensureDir(agentDir);
  }

  // Write a CLAUDE.md with job pickup instructions if the claude target is active
  if (targets.includes('claude')) {
    writeDomainClaudeMd(domain, domainAbsPath);
  }
}

/**
 * Write a CLAUDE.md to the domain directory with standard wairon instructions,
 * including the job handoff pickup protocol.
 *
 * The relative path from the domain directory back to the root .wai/jobs/ is
 * computed so the instruction works regardless of nesting depth.
 */
function writeDomainClaudeMd(domain: Domain, domainAbsPath: string): void {
  const projectRoot = fromProjectRoot();
  const relativeToRoot = path.relative(domainAbsPath, projectRoot).replace(/\\/g, '/');
  const jobsPath = `${relativeToRoot}/.wai/jobs`;

  const content = `# ${domain.name} — Agent Instructions

This directory is a managed domain in the wairon topology.

## Agent Files

AI agent definitions for this domain live in \`.claude/agents/\`.
They are generated by wairon — do not edit them directly.
To update an agent: modify the registry at the root project's
\`.wai/registry/agents.json\`, then run \`wairon generate\`.

## Job Handoff Protocol

When this session was started by \`wairon delegate\`, a job file
was written by the parent agent. If the environment variable
\`WAIRON_JOB_FILE\` is set, read that file immediately on startup
and treat it as your primary task.

If the variable is not set, check \`${jobsPath}/\` for any \`.yaml\`
file with \`domain: ${domain.id}\` and \`status: pending\`.

When your task is complete, write your result to the path specified in
\`WAIRON_RESULT_FILE\` (if set), or to
\`${jobsPath}/<job-id>.result.yaml\`.

Include in your result:
- A brief summary of what was done
- Which files were changed
- Anything out of scope that you noticed but did not act on (flagged)

## Domain Context

- Domain ID: \`${domain.id}\`
- Domain path: \`${domain.path}\`
- Part of a larger project managed at: \`${relativeToRoot || '.'}\`
- You are a specialized agent for this domain. A parent project agent
  may invoke you via \`wairon delegate\` for focused tasks.
`;

  const claudeMdPath = path.join(domainAbsPath, 'CLAUDE.md');

  // Only write if it doesn't already exist — respect existing project instructions
  if (!fs.existsSync(claudeMdPath)) {
    writeFile(claudeMdPath, content);
  }
}
