import * as path from 'path';
import { AgentRecord } from '../models/agent.js';
import { Domain } from '../models/domain.js';
import { ProjectConfig, TargetConfig } from '../models/project.js';
import { loadTemplate, renderTemplateInstructions } from '../core/templates.js';
import { loadDomainRegistry } from '../config/loader.js';
import { getPropagationTargets } from '../core/domains.js';
import { getExporter } from './registry.js';
import { ExportResult } from './base.js';

// ---------------------------------------------------------------------------
// Generate: domain-aware agent file generation
//
// For agents WITHOUT a domainRoot: generate only at project root (unchanged).
//
// For agents WITH a domainRoot:
//   1. Standalone render → written to <domainPath>/<target>/agents/<id>.md
//      Uses domain-relative ownedPaths and standalone framing.
//   2. Reference render  → written to <root>/<target>/agents/<id>.md
//      Uses project-absolute ownedPaths and delegation framing.
//      Only generated for parent domains based on domain.propagation setting.
// ---------------------------------------------------------------------------

export type RenderContext = 'standalone' | 'project-reference' | 'root';

export interface GenerateOptions {
  projectRoot?: string;
  filterTargets?: string[];
  dryRun?: boolean;
}

export interface GenerateSummary {
  agent: AgentRecord;
  results: ExportResult[];
}

export function generateAgent(
  agent: AgentRecord,
  projectConfig: ProjectConfig,
  options: GenerateOptions = {},
): GenerateSummary {
  const projectRoot = options.projectRoot ?? process.cwd();

  if (agent.domainRoot) {
    return generateDomainAgent(agent, projectConfig, projectRoot, options);
  }
  return generateRootAgent(agent, projectConfig, projectRoot, options);
}

export function generateAll(
  agents: AgentRecord[],
  projectConfig: ProjectConfig,
  options: GenerateOptions = {},
): GenerateSummary[] {
  return agents.map((agent) => generateAgent(agent, projectConfig, options));
}

// ---------------------------------------------------------------------------
// Root agents (no domainRoot) — single render at project root
// ---------------------------------------------------------------------------

function generateRootAgent(
  agent: AgentRecord,
  projectConfig: ProjectConfig,
  projectRoot: string,
  options: GenerateOptions,
): GenerateSummary {
  const template = loadTemplate(agent.template, projectConfig.globalTemplatesDir);
  const vars = buildVars(agent, agent.ownedPaths, 'root');
  const rendered = renderTemplateInstructions(template, vars);
  const results: ExportResult[] = [];

  for (const agentTarget of agent.targets) {
    const targetConfig = resolveTargetConfig(agentTarget, projectConfig);
    if (!targetConfig) continue;
    if (options.filterTargets) {
      const type = 'type' in targetConfig ? targetConfig.type : targetConfig;
      if (!options.filterTargets.includes(type as string)) continue;
    }
    if (!options.dryRun) {
      results.push(getExporter(targetConfig).export({
        agent, template, renderedInstructions: rendered, projectRoot, target: targetConfig,
      }));
    }
  }

  return { agent, results };
}

// ---------------------------------------------------------------------------
// Domain agents — two renders: standalone + parent references
// ---------------------------------------------------------------------------

function generateDomainAgent(
  agent: AgentRecord,
  projectConfig: ProjectConfig,
  projectRoot: string,
  options: GenerateOptions,
): GenerateSummary {
  const results: ExportResult[] = [];
  const domainRegistry = loadDomainRegistry();
  const domain = domainRegistry.domains.find((d) => d.id === agent.domainRoot);

  if (!domain) {
    // Domain no longer exists — fall back to root render
    return generateRootAgent(agent, projectConfig, projectRoot, options);
  }

  const template = loadTemplate(agent.template, projectConfig.globalTemplatesDir);

  // --- 1. Standalone render in the domain's own directory ---
  const domainRelativePaths = toDomainRelativePaths(agent.ownedPaths, domain.path);
  const standaloneVars = buildVars(agent, domainRelativePaths, 'standalone', domain);
  const standaloneRendered = renderTemplateInstructions(template, standaloneVars);
  const domainRoot = path.resolve(projectRoot, domain.path);

  for (const agentTarget of agent.targets) {
    const targetConfig = resolveTargetConfig(agentTarget, projectConfig);
    if (!targetConfig) continue;

    const targetType = 'type' in targetConfig ? targetConfig.type : targetConfig as string;
    if (options.filterTargets && !options.filterTargets.includes(targetType)) continue;

    if (!options.dryRun) {
      results.push(getExporter(targetConfig).export({
        agent,
        template,
        renderedInstructions: standaloneRendered,
        projectRoot: domainRoot,   // ← domain directory is the root for this render
        target: targetConfig,
      }));
    }
  }

  // --- 2. Reference renders in parent domains based on propagation ---
  const propagationTargets = getPropagationTargets(domain, domainRegistry);

  for (const parentDomain of propagationTargets) {
    const parentRoot = parentDomain.type === 'root'
      ? projectRoot
      : path.resolve(projectRoot, parentDomain.path);

    const refVars = buildVars(agent, agent.ownedPaths, 'project-reference', domain, parentDomain);
    const refRendered = renderTemplateInstructions(template, refVars);

    for (const agentTarget of agent.targets) {
      const targetConfig = resolveTargetConfig(agentTarget, projectConfig);
      if (!targetConfig) continue;

      const targetType = 'type' in targetConfig ? targetConfig.type : targetConfig as string;
      if (options.filterTargets && !options.filterTargets.includes(targetType)) continue;

      if (!options.dryRun) {
        results.push(getExporter(targetConfig).export({
          agent,
          template,
          renderedInstructions: refRendered,
          projectRoot: parentRoot,
          target: targetConfig,
        }));
      }
    }
  }

  return { agent, results };
}

// ---------------------------------------------------------------------------
// Template variable builders
// ---------------------------------------------------------------------------

function buildVars(
  agent: AgentRecord,
  ownedPaths: string[],
  context: RenderContext,
  domain?: Domain,
  parentDomain?: Domain,
): Record<string, string> {
  const contextNote = contextNoteFor(context, domain, parentDomain);
  return {
    agentId: agent.id,
    agentName: agent.name,
    agentDescription: agent.description,
    ownedPaths: ownedPaths.join('\n'),
    tags: agent.tags.join(', '),
    renderContext: context,
    contextNote,
    domainPath: domain?.path ?? '.',
    domainName: domain?.name ?? '',
  };
}

function contextNoteFor(
  context: RenderContext,
  domain?: Domain,
  _parentDomain?: Domain,
): string {
  if (context === 'standalone') {
    return `You are operating as a specialized agent within the \`${domain?.path ?? '.'}\` module. ` +
      `You may be invoked by a parent project agent via the waffagent delegation system. ` +
      `Focus deeply on your domain — you do not need awareness of the broader project.`;
  }
  if (context === 'project-reference') {
    return `This agent is canonically defined in the \`${domain?.path ?? '.'}\` subdomain. ` +
      `From this project context, it is responsible for \`${domain?.path ?? '.'}\`. ` +
      `For deep work in that domain, invoke via: \`waffagent delegate ${domain?.id ?? ''}\``;
  }
  return '';
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

/**
 * Convert project-absolute ownedPaths to domain-relative paths.
 * "services/core/**" with domainPath "services/core" → "**"
 */
function toDomainRelativePaths(ownedPaths: string[], domainPath: string): string[] {
  const normalizedDomain = domainPath.replace(/\\/g, '/').replace(/\/$/, '');
  return ownedPaths.map((p) => {
    const normalized = p.replace(/\\/g, '/');
    if (normalized.startsWith(normalizedDomain + '/')) {
      return normalized.slice(normalizedDomain.length + 1) || '**';
    }
    if (normalized === normalizedDomain) return '**';
    return p; // doesn't match domain prefix — keep as-is
  });
}

/**
 * Match an agent target to the project's TargetConfig.
 */
function resolveTargetConfig(
  agentTarget: AgentRecord['targets'][number],
  projectConfig: ProjectConfig,
): TargetConfig | undefined {
  const targetType = typeof agentTarget === 'string' ? agentTarget : agentTarget.type;
  return projectConfig.targets.find((t) => {
    if (typeof t === 'string') return t === targetType;
    return t.type === targetType;
  }) as TargetConfig | undefined;
}
