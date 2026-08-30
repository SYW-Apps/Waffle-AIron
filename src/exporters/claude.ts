import * as path from 'path';
import { writeFileIfChanged } from '../utils/fs.js';
import { ExecutionBudget, McpAccess, ModelTier, ToolClass } from '../models/execution.js';
import { Exporter, ExportContext, ExportResult } from './base.js';

// ---------------------------------------------------------------------------
// Claude Code exporter
//
// Generates agent definition files for Claude Code's sub-agent system.
// Output format: Markdown with YAML front-matter.
//
// Front-matter fields:
//   name        — display name shown in the Claude UI
//   description — used by Claude to decide when to invoke this sub-agent;
//                 keep it concise and action-oriented
//
// When the project has an execution budget tier enabled, this exporter also
// emits the COST shape of the agent. That is a deliberate reversal of the
// note that used to sit here ("wairon does not manage the tools list"): the
// generated file is the only place these constraints can be ENFORCED rather
// than merely requested.
//
// The reason it must be config and not instruction text: `model` defaults to
// `inherit`, so an agent file that omits it silently adopts the parent
// session's model — which, with a frontier-tier parent, is the single largest
// avoidable cost in a delegating workflow. Instructions in a prompt do not fix
// that; frontmatter does, whether or not the orchestrator is paying attention
// two hundred turns deep.
//
// Reference: https://code.claude.com/docs/en/sub-agents
//
// Generated file path: <outputDir>/<agent-id>.md
// ---------------------------------------------------------------------------

/**
 * Capability tier → Claude model alias. Aliases rather than pinned ids so the
 * generated file keeps working across model releases; Claude Code resolves
 * these to the current model in each family.
 */
const MODEL_BY_TIER: Record<ModelTier, string> = {
  small: 'haiku',
  standard: 'sonnet',
  large: 'opus',
  frontier: 'fable',
};

/**
 * Tool class → Claude tool allowlist.
 *
 * `orchestrate` is the load-bearing one. A manager gets delegation and
 * messaging but NOT Read/Grep/Glob/Bash, because a manager that can read
 * files will read them, and a manager that reads files accumulates context
 * exactly like a main session — at which point delegating stopped saving
 * anything. The restriction is the doctrine; no prompt text is needed to
 * carry it, and none has to be re-read by every worker.
 */
const TOOLS_BY_CLASS: Record<ToolClass, string[] | undefined> = {
  'read-only': ['Read', 'Grep', 'Glob'],
  implement: ['Read', 'Grep', 'Glob', 'Edit', 'Write', 'Bash'],
  orchestrate: ['Agent', 'SendMessage', 'TodoWrite'],
  // `full` means "inherit everything" — expressed by omitting the field.
  full: undefined,
};

function toolsFor(budget: ExecutionBudget): string[] | undefined {
  const base = TOOLS_BY_CLASS[budget.toolClass];
  if (!base) return undefined;
  if (budget.allowNestedDelegation && !base.includes('Agent')) {
    return [...base, 'Agent'];
  }
  if (!budget.allowNestedDelegation) {
    return base.filter((t) => t !== 'Agent');
  }
  return base;
}

/**
 * MCP access → the `mcpServers` frontmatter field.
 *
 * Only `none` is expressible here, and it is the one that matters: an explicit
 * empty list keeps the project's MCP tool schemas out of a worker's startup
 * context, which is most of the fixed per-spawn overhead. Both `project` and
 * `all` mean "inherit the session's servers", which Claude Code expresses by
 * omitting the field — so the distinction between them is a no-op for this
 * target and is left for exporters whose host tool can express it.
 */
function mcpServersFor(access: McpAccess): '[]' | undefined {
  return access === 'none' ? '[]' : undefined;
}

/** Quote a scalar only when YAML would otherwise misread it. */
function yamlScalar(value: string): string {
  return /[:#\n]/.test(value) ? `"${value.replace(/"/g, '\\"')}"` : value;
}

export interface ClaudeExporterOptions {
  /**
   * Whether this instance may emit execution-budget front-matter.
   *
   * The markdown SHAPE of a Claude agent file (front-matter + instruction
   * body) is reused by the cursor/copilot/codex targets, but the budget fields
   * are Claude Code's subagent contract specifically — `maxTurns`,
   * `mcpServers` and `effort` mean nothing to those tools, and emitting them
   * would put unrecognized keys in their files rather than constrain
   * anything. Reuse the shape; keep the encoding per-tool until another
   * tool's fields are actually verified.
   */
  emitBudget?: boolean;
}

export class ClaudeExporter implements Exporter {
  readonly targetType = 'claude';

  constructor(private readonly options: ClaudeExporterOptions = {}) {}

  outputPath(ctx: Omit<ExportContext, 'renderedInstructions'>): string {
    const { agent, target, projectRoot } = ctx;
    const outputDir = 'outputDir' in target ? target.outputDir : '.claude/agents';
    return path.resolve(projectRoot, outputDir, `${agent.id.replace(/::/g, '--')}.md`);
  }

  export(ctx: ExportContext): ExportResult {
    const { agent, renderedInstructions, budget } = ctx;
    const filePath = this.outputPath(ctx);

    const frontmatter: string[] = [
      `name: ${agent.name}`,
      `description: ${yamlScalar(agent.description)}`,
    ];

    if (budget && this.options.emitBudget) {
      // Absent modelTier means the policy deliberately expressed no choice —
      // omit the field so the agent keeps Claude Code's `inherit` default,
      // rather than baking in a tier the project did not ask for.
      if (budget.modelTier) frontmatter.push(`model: ${MODEL_BY_TIER[budget.modelTier]}`);

      if (budget.effort) frontmatter.push(`effort: ${budget.effort}`);
      if (budget.maxTurns !== undefined) frontmatter.push(`maxTurns: ${budget.maxTurns}`);

      const tools = toolsFor(budget);
      if (tools) frontmatter.push(`tools: ${tools.join(', ')}`);

      const servers = mcpServersFor(budget.mcp);
      if (servers) frontmatter.push(`mcpServers: ${servers}`);
    }

    const content = ['---', ...frontmatter, '---', '', renderedInstructions, ''].join('\n');

    const changed = writeFileIfChanged(filePath, content);
    return { outputPath: filePath, content, unchanged: !changed };
  }
}
