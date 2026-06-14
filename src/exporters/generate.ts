import { AgentRecord } from '../models/agent.js';
import { ProjectConfig, TargetConfig } from '../models/project.js';
import { loadTemplate, renderTemplateInstructions } from '../core/templates.js';
import { getExporter } from './registry.js';
import { ExportResult } from './base.js';

// ---------------------------------------------------------------------------
// Generate: agent file generation
//
// Agents are derived from the SDD spec tree and are written as native subagent
// files into each target's output dir at the project root. The host AI tool
// (Claude / Codex / aider) spawns these as its own subagents — wairon does not
// orchestrate sessions itself, so there is no per-directory or propagation
// rendering.
// ---------------------------------------------------------------------------

export interface GenerateOptions {
  projectRoot?: string;
  filterTargets?: string[];
  /**
   * If set, only generate agents whose domainRoot is in this set.
   * Use the special value 'root' to select agents with no domainRoot.
   */
  filterDomainIds?: string[];
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
  const template = loadTemplate(agent.template, projectConfig.globalTemplatesDir);
  const rendered = renderTemplateInstructions(template, buildVars(agent));
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

export function generateAll(
  agents: AgentRecord[],
  projectConfig: ProjectConfig,
  options: GenerateOptions = {},
): GenerateSummary[] {
  let pool = agents;

  if (options.filterDomainIds && options.filterDomainIds.length > 0) {
    const ids = new Set(options.filterDomainIds);
    pool = agents.filter((a) => ids.has(a.domainRoot ?? 'root'));
  }

  return pool.map((agent) => generateAgent(agent, projectConfig, options));
}

// ---------------------------------------------------------------------------
// Template variable builder
// ---------------------------------------------------------------------------

function buildVars(agent: AgentRecord): Record<string, string> {
  return {
    agentId: agent.id,
    agentName: agent.name,
    agentDescription: agent.description,
    ownedPaths: agent.ownedPaths.join('\n'),
    tags: agent.tags.join(', '),
    renderContext: 'root',
    contextNote: '',
    domainPath: '.',
    domainName: '',
  };
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
