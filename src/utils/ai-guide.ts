// ---------------------------------------------------------------------------
// AI Guide injection
//
// Injects a wairon usage guide into AI tool config files (CLAUDE.md,
// GEMINI.md) so the AI tool knows how to use wairon in this project.
//
// Injection is idempotent: the guide is wrapped in HTML comment markers and
// replaced if already present, so running it twice has no side-effects.
//
// Global scope:  ~/.claude/CLAUDE.md   or  ~/.gemini/GEMINI.md
// Local scope:   <project-root>/.claude/CLAUDE.md  or  <project-root>/.gemini/GEMINI.md
// ---------------------------------------------------------------------------

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export const GUIDE_MARKER_START = '<!-- wairon-guide-start -->';
export const GUIDE_MARKER_END = '<!-- wairon-guide-end -->';

// ---------------------------------------------------------------------------
// Guide content
// ---------------------------------------------------------------------------

export const GLOBAL_GUIDE_BODY = `\
## wairon — AI Agent Topology Manager

Projects you work in may use **wairon** to manage AI coding agent topology.
wairon keeps a registry of agents in \`.wai/registry/agents.json\`. Agent files
(like the ones in \`.claude/agents/\`) are generated from that registry —
**never edit them directly**.

### Domain & agent model

A **domain** is a scoped area of a repository — a package, service, library, or
sub-project — that has its own set of agents. Each domain has an \`id\` (e.g.
\`auth-service\`), a \`path\` (relative to project root), and a set of agents that
own paths within it.

An **agent** belongs to exactly one domain (via its \`domainRoot\` field) or to
the global root. Agents declare \`ownedPaths\` — glob patterns that describe
which files they are responsible for.

### When to delegate

Use \`wairon delegate\` when:
- A task is clearly bounded to a single domain (service, package, library)
- The work can proceed independently without coordinating with other domains
- You want a focused sub-agent context with only the relevant agent set loaded
- The task would benefit from isolation (tests, refactors, migrations)

Do **not** delegate when:
- The task spans multiple unrelated domains (handle it at the root level)
- The change requires coordinating cross-domain contracts first
- The domain doesn't exist or has no agents yet (run \`wairon scaffold-domains\`)

### Delegation workflow

1. Identify the target domain id: \`wairon domains list\`
2. Delegate the task:
   \`\`\`
   wairon delegate <domain-id> --prompt "description of the task"
   \`\`\`
   This creates a **job file** at \`.wai/jobs/<job-id>.yaml\` and spawns a new
   AI tool session in the domain directory with \`stdio:inherit\`.
3. The sub-agent session starts with the job context loaded automatically via
   environment variables (\`WAIRON_JOB_ID\`, \`WAIRON_JOB_FILE\`).
4. When the sub-agent finishes, it writes a result file at
   \`.wai/jobs/<job-id>.result.yaml\` and the parent session reads + displays it.

### Job lifecycle

| Status      | Meaning                                              |
|-------------|------------------------------------------------------|
| \`pending\`   | Job created, session not started yet                 |
| \`running\`   | Session is active                                    |
| \`completed\` | Sub-agent wrote a result file and exited cleanly     |
| \`abandoned\` | Session exited without writing a result              |
| \`failed\`    | Session exited with a non-zero code                  |

Inspect jobs: \`wairon jobs list\` / \`wairon jobs show <job-id>\`

### Sub-agent job pickup protocol

When a new session starts in a domain directory and \`WAIRON_JOB_FILE\` is set:

1. Read the job file: it contains the task, context files, and notes.
2. Acknowledge the job by checking its status (it should be \`running\`).
3. Work exclusively within the domain's \`path\` and \`ownedPaths\`.
4. When done, write a result file at \`<job-file-path>.result.yaml\`:
   \`\`\`yaml
   jobId: <id>
   summary: "What was done"
   filesChanged:
     - path/to/changed/file.ts
   flagged: "Anything out of scope or that needs parent attention"
   \`\`\`
5. Exit cleanly — the parent session will pick up the result automatically.

If no \`WAIRON_JOB_FILE\` env var is set, operate normally without job context.

### Key commands
\`\`\`
wairon list                       list all agents in the registry
wairon generate                   regenerate all agent files
wairon generate --domain <id>     regenerate only a specific domain
wairon validate                   check for topology issues
wairon create-agent               add a new agent interactively
wairon create-bundle              scaffold a set of agents from a template
wairon scaffold-domains           scaffold agents for domains that have none
wairon domains list               list all project domains
wairon domains scan --add         detect and add new domains
wairon delegate <domain-id>       spawn a focused session for a domain
wairon analyze                    analyze coverage gaps
wairon targets list               show configured output targets
wairon jobs list                  view all delegated jobs
wairon profiles list              view configured profiles (work/personal/etc.)
wairon mcp install                register the wairon MCP server in Claude Code
\`\`\`

To update an agent: edit \`.wai/registry/agents.json\` and run \`wairon generate\`.`;

const LOCAL_GUIDE_BODY = `\
## Agent Topology (managed by wairon)

Agent files in this project are generated by **wairon** — do not edit them directly.
The source of truth is \`.wai/registry/agents.json\`.

### Spec-Driven Development (SDD) Rules
This project follows a strict **Design-Before-Code** Spec-Driven Development framework:
1. **Spec File Segregation**:
   - L0 (System): Declared ONLY in \`.wai/specs/system.yaml\`.
   - L1 (Subsystems): Declared in a directory named after the subsystem under \`.wai/specs/\`, using \`subsystem.yaml\` as the reserved file name. (E.g. \`.wai/specs/billing/subsystem.yaml\`).
   - L2 (Components): Declared in a subdirectory under their parent subsystem, named after the component, using \`component.yaml\` as the reserved file name. (E.g. \`.wai/specs/billing/billing_store/component.yaml\`).
   - L3 (Interfaces): Declared in the same subdirectory as their component, using \`interface.yaml\` as the reserved file name. (E.g. \`.wai/specs/billing/billing_store/interface.yaml\`).
   - L4 (Implementations) & L5 (Narratives): Declared in the same subdirectory as their component, using \`implementation.yaml\` as the reserved file name. (E.g. \`.wai/specs/billing/billing_store/implementation.yaml\`).
   *(Note: If legacy flat folders like \`.wai/specs/subsystems/\` exist and contain files, respect them and continue placing new specs flat within those legacy folders. Otherwise, always default to the nested tree structure.)*
2. **Mandatory Iterative Feedback Loop**:
   - You must NOT generate multiple layers of specs or write any implementation code without explicit user feedback and approval at **each stage**.
   - For every spec or narrative you draft: present the drafted content (YAML format) and a concise summary of the key design choices directly in the chat/console message. Do NOT create temporary/intermediate markdown review files in the brain or workspace for the user to review.
   - Ask: "Is this correct, or is it off-track?" and get explicit approval for the current layer/stage before proceeding.
3. **No Implementation Without Design Sign-Off**:
   - Do NOT write any source code (e.g. \`.ts\`, \`.rs\`, \`.py\` etc.) for any component until the design has been finalized, validated using the \`sdd_validate_tree\` MCP tool with zero errors, and marked as \`status: complete\`.
4. **Exclusively Use MCP Tools**:
   - As an AI agent, you must ONLY use the Wairon MCP tools (\`sdd_get_status\`, \`sdd_validate_tree\`, \`sdd_initialize_system\`, \`sdd_add_subsystem\`, \`sdd_add_component\`, \`sdd_define_interface\`, \`sdd_write_narrative\`) to perform system status checks, validations, and design updates.
   - Do NOT execute CLI shell commands in the terminal (e.g. \`wairon status\`, \`wairon validate\`, \`wairon init\`). Those terminal commands are strictly reserved for the human developer.
5. **Mandatory Sub-Agent Task Delegation**:
   - You must NOT perform design updates, write method narratives, or generate component implementation source code directly yourself in the root context.
   - For all L0–L3 spec design, delegate to the **\`system-architect\`** subagent (or invoke the \`/sdd architect\` skill).
   - For all L4–L5 narrative design, delegate to the **\`sdd-narrative\`** subagent (or invoke the \`/sdd narrative\` skill).
   - For compiling specs to code (Stage 6 implementation), delegate the task to the specific **\`<component-id>-implementer\`** subagent (e.g. using the \`wairon delegate\` command or spawning the specific implementer subagent).
   - Always let the specialized subagents make file changes and report back.

### Quick Reference (For Human Developers)
\`\`\`
wairon generate              regenerate all agent files
wairon list                  list all agents
wairon validate              check for topology issues
wairon delegate <id>         delegate a task to a domain agent
wairon scaffold-domains      scaffold agents for domains that have none
\`\`\``;

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

export function globalGuideFilePath(targetType: string): string | null {
  if (targetType === 'claude') return path.join(os.homedir(), '.claude', 'CLAUDE.md');
  if (targetType === 'gemini') return path.join(os.homedir(), '.gemini', 'GEMINI.md');
  return null;
}

export function localGuideFilePath(projectRoot: string, targetType: string): string | null {
  if (targetType === 'claude') return path.join(projectRoot, '.claude', 'CLAUDE.md');
  if (targetType === 'gemini' || targetType === 'agy') return path.join(projectRoot, '.gemini', 'GEMINI.md');
  return null;
}

// ---------------------------------------------------------------------------
// Detect / inject
// ---------------------------------------------------------------------------

/** Returns true if the file exists and already contains the wairon guide. */
export function hasWaironGuide(filePath: string): boolean {
  if (!fs.existsSync(filePath)) return false;
  return fs.readFileSync(filePath, 'utf-8').includes(GUIDE_MARKER_START);
}

/**
 * Inject (or update) the wairon guide section in the given file.
 * Creates the file and any parent directories if they don't exist.
 */
export function injectGuide(filePath: string, scope: 'global' | 'local'): void {
  const body = scope === 'global' ? GLOBAL_GUIDE_BODY : LOCAL_GUIDE_BODY;
  const command = getCliCommandString();
  const customizedBody = body.replace(/\bwairon\b/g, command);
  const section = `\n\n${GUIDE_MARKER_START}\n${customizedBody}\n${GUIDE_MARKER_END}\n`;

  const existing = fs.existsSync(filePath)
    ? fs.readFileSync(filePath, 'utf-8')
    : '';

  const stripped = stripGuideSection(existing);
  const newContent = stripped.trimEnd() + section;

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, newContent, 'utf-8');
}

/** Remove the wairon guide section from a string (for clean replacement). */
export function stripGuideSection(content: string): string {
  const start = content.indexOf(GUIDE_MARKER_START);
  const end = content.indexOf(GUIDE_MARKER_END);
  if (start === -1 || end === -1) return content;
  return content.slice(0, start) + content.slice(end + GUIDE_MARKER_END.length);
}

export function writeRootGuideDelegator(projectRoot: string, targetType: string): void {
  if (targetType === 'claude') {
    const filePath = path.join(projectRoot, 'CLAUDE.md');
    const content = `@.claude/CLAUDE.md
@.claude/sdd-architect.md
@.claude/sdd-narrative.md
@.claude/sdd-auditor.md
@.claude/sdd-implement.md

# Wairon SDD Project

This project uses the Wairon Spec-Driven Development (SDD) framework. 
To start designing or modifying the system, you must invoke the **\`/sdd-architect\`** sub-agent.

Refer to [.claude/CLAUDE.md](.claude/CLAUDE.md) for full instructions and CLI references.
`;
    fs.writeFileSync(filePath, content, 'utf-8');
  } else if (targetType === 'gemini' || targetType === 'agy') {
    const filePath = path.join(projectRoot, 'GEMINI.md');
    const content = `@.gemini/GEMINI.md
@.gemini/skills/sdd-architect.md
@.gemini/skills/sdd-narrative.md
@.gemini/skills/sdd-auditor.md
@.gemini/skills/sdd-implement.md

# Wairon SDD Project

This project uses the Wairon Spec-Driven Development (SDD) framework. 
To start designing the system, invoke the **\`sdd-architect\`** skill.

Refer to [.gemini/GEMINI.md](.gemini/GEMINI.md) for full instructions and CLI references.
`;
    fs.writeFileSync(filePath, content, 'utf-8');
  } else if (targetType === 'cursor') {
    const filePath = path.join(projectRoot, '.cursorrules');
    const content = `# Wairon SDD Project

This project uses the Wairon Spec-Driven Development (SDD) framework.

Refer to the rules in [.cursor/rules/](.cursor/rules/) for full instructions and CLI references.
`;
    fs.writeFileSync(filePath, content, 'utf-8');
  } else if (targetType === 'copilot') {
    const filePath = path.join(projectRoot, '.github', 'copilot-instructions.md');
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const content = `# Wairon SDD Project

This project uses the Wairon Spec-Driven Development (SDD) framework.

Refer to the prompts in [.github/prompts/](.github/prompts/) for instructions and CLI references.
`;
    fs.writeFileSync(filePath, content, 'utf-8');
  } else if (targetType === 'codex') {
    const filePath = path.join(projectRoot, '.codexrules');
    const content = `# Wairon SDD Project

Refer to [.codex/agents/](.codex/agents/) for full instructions and CLI references.
`;
    fs.writeFileSync(filePath, content, 'utf-8');
  }
}

export function getCliCommandString(): string {
  const scriptPath = process.argv[1] ? path.resolve(process.argv[1]).replace(/\\/g, '/') : null;
  const useDirectNode = scriptPath && (scriptPath.endsWith('.js') || scriptPath.endsWith('.ts'));
  return useDirectNode ? `node "${scriptPath}"` : 'wairon';
}
