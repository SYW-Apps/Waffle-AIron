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
## wairon — Spec-Driven Development (optional)

A project *may* use **wairon**, an optional spec-driven development (SDD) workflow.
If a \`.wai/specs/\` tree exists, the workflow is active for that project; otherwise
you can ignore wairon and work normally. wairon does not run or orchestrate AI
sessions — it *equips* yours.

### What wairon owns when active

- \`.wai/specs/\` is a typed spec tree: L0 System → L1 Subsystem → L2 Component →
  L3 Interface → L4 Implementation → L5 Narrative. It is the source of truth for
  the project's **architecture**.
- Agent files in \`.claude/agents/\` (and other tools) are **generated from the
  spec tree** — never edit them by hand. Run \`wairon generate\` to refresh them.
- \`wairon validate\` is an architecture-conformance gate: reference integrity,
  contract↔implementation method symmetry, component-stereotype dependency rules
  (e.g. Portals may not depend on Stores), and dependency-cycle detection.

### How wairon fits your session

- **Subagents:** the generated agent files (a \`system-architect\`, a \`*-owner\`
  per subsystem/domain, a \`*-implementer\` per component). Spawn them with your
  tool's own native subagent mechanism — wairon does not spawn sessions itself.
- **Skills:** \`sdd-architect\`, \`sdd-narrative\`, \`sdd-auditor\`, \`sdd-implement\` —
  run them in-session to drive the workflow.
- **MCP tools:** \`sdd_*\` tools to author and validate specs (see the project guide).

### Strict once enabled

If the SDD workflow is active, follow it strictly:
1. **Design before code.** Do not write source for a component until its spec is
   complete and \`sdd_validate_tree\` passes with zero errors.
2. **Spec is law.** Generated code maps 1:1 to the interfaces and narrative steps.
   If the spec is incomplete, stop and extend the spec — do not improvise.
3. **Human-in-the-loop.** Present each drafted spec layer for approval before
   moving on; do not design several layers ahead unprompted.

### Key commands (human-run)
\`\`\`
wairon status                spec-tree completeness dashboard
wairon validate              architecture-conformance gate
wairon generate              regenerate agent files + (re)install skills
wairon list                  list agents resolved from the spec tree
wairon domains list          list domains (subsystem-derived + free-standing)
wairon skills install        (re)install the SDD skills into your tools
wairon mcp install           register the wairon MCP server
\`\`\``;

const LOCAL_GUIDE_BODY = `\
## Wairon — Spec-Driven Development (you are operating inside it)

This project uses **wairon**. You build a typed **spec tree** under \`.wai/specs/\`
(L0 System → L1 Subsystem → L2 Component → L3 Interface → L4 Implementation →
L5 Narrative); the agent topology and the implementation are derived from it.

**This guide plus the \`sdd-architect\` skill already contain everything you need.
Do NOT search the filesystem or read agent files to figure out what wairon or SDD
is — you have the full context right here. When the user describes what they want,
get to work.**

### How you operate
- **To design or change the system** (subsystems, components, interfaces, narratives):
  invoke the **\`sdd-architect\`** skill (in \`.claude/skills/\` or \`.gemini/skills/\`).
  It is your complete playbook — it walks the spec tree with you, level by level.
- **Author and validate specs through the wairon MCP tools only** —
  \`sdd_initialize_system\`, \`sdd_add_subsystem\`, \`sdd_add_component\`,
  \`sdd_define_interface\`, \`sdd_write_narrative\`, \`sdd_add_type\`,
  \`sdd_validate_tree\`, \`sdd_get_status\`. Don't hand-edit spec YAML.
- **You never run the \`wairon\` CLI — that is the human developer's tool.**
  Everything the CLI does, you do through MCP: to validate the tree call
  \`sdd_validate_tree\` (never \`wairon validate\`); to check completeness/status call
  \`sdd_get_status\` (never \`wairon status\`). Don't run shell commands for these.
- **To implement a component** (only after its spec is \`complete\` and validates):
  spawn the \`<component-id>-implementer\` subagent via your tool's native subagent
  mechanism. The code must map 1:1 to the spec's interface + narrative.
- The **spec tree is the source of truth**. Files under \`.claude/agents/\` /
  \`.gemini/agents/\` are generated outputs — never edit them.

### The rules (enforced by \`sdd_validate_tree\`)
1. **Design before code.** Don't write source for a component until its spec is
   \`complete\` and \`sdd_validate_tree\` passes with zero errors.
2. **Human-in-the-loop.** Present each drafted spec layer to the user for approval
   before moving on; don't design several layers ahead unprompted.
3. **Spec is law.** Generated code maps exactly to the interfaces and narrative steps.

### Component vocabulary (full detail in the sdd-architect skill)
Building blocks: Portal, Orchestrator, Supervisor, Actor, Store, Index, Registry,
Adapter, Observer, Specialist. Patterns (which \`own\` member blocks): Repository,
Gateway. Use \`owns\` for a pattern's private members and \`dependsOn\` for
collaborators. Never use generic names like "Manager", "Helper", or "Utils".`;

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

export function globalGuideFilePath(targetType: string): string | null {
  // Respect custom config dirs (account aliases) — same as MCP install.
  if (targetType === 'claude') return path.join(process.env['CLAUDE_CONFIG_DIR'] || path.join(os.homedir(), '.claude'), 'CLAUDE.md');
  if (targetType === 'gemini') return path.join(process.env['GEMINI_CONFIG_DIR'] || path.join(os.homedir(), '.gemini'), 'GEMINI.md');
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
  // Use `wairon` literally in injected docs — never substitute a dev path. The
  // guide is documentation (the AI uses MCP tools; the human runs `wairon`).
  const body = scope === 'global' ? GLOBAL_GUIDE_BODY : LOCAL_GUIDE_BODY;
  const section = `\n\n${GUIDE_MARKER_START}\n${body}\n${GUIDE_MARKER_END}\n`;

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

# Wairon SDD Project

This project uses the Wairon Spec-Driven Development (SDD) framework. The imported
\`.claude/CLAUDE.md\` above is your complete operating guide — you already have the
full context, so don't search the project to learn how wairon or SDD works.

To design or modify the system, invoke the **\`sdd-architect\`** skill
(in \`.claude/skills/\`). Author and validate specs with the \`sdd_*\` MCP tools;
the \`wairon\` CLI is the human developer's tool, not yours.
`;
    fs.writeFileSync(filePath, content, 'utf-8');
  } else if (targetType === 'gemini' || targetType === 'agy') {
    const filePath = path.join(projectRoot, 'GEMINI.md');
    const content = `@.gemini/GEMINI.md

# Wairon SDD Project

This project uses the Wairon Spec-Driven Development (SDD) framework. The imported
\`.gemini/GEMINI.md\` above is your complete operating guide — you already have the
full context, so don't search the project to learn how wairon or SDD works.

To design or modify the system, invoke the **\`sdd-architect\`** skill
(in \`.gemini/skills/\`). Author and validate specs with the \`sdd_*\` MCP tools;
the \`wairon\` CLI is the human developer's tool, not yours.
`;
    fs.writeFileSync(filePath, content, 'utf-8');
  } else if (targetType === 'cursor') {
    const filePath = path.join(projectRoot, '.cursorrules');
    const content = `# Wairon SDD Project

This project uses the Wairon Spec-Driven Development (SDD) framework.

Refer to the rules in [.cursor/rules/](.cursor/rules/) for full instructions.
`;
    fs.writeFileSync(filePath, content, 'utf-8');
  } else if (targetType === 'copilot') {
    const filePath = path.join(projectRoot, '.github', 'copilot-instructions.md');
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const content = `# Wairon SDD Project

This project uses the Wairon Spec-Driven Development (SDD) framework.

Refer to the prompts in [.github/prompts/](.github/prompts/) for instructions.
`;
    fs.writeFileSync(filePath, content, 'utf-8');
  } else if (targetType === 'codex') {
    const filePath = path.join(projectRoot, '.codexrules');
    const content = `# Wairon SDD Project

Refer to [.codex/agents/](.codex/agents/) for full instructions.
`;
    fs.writeFileSync(filePath, content, 'utf-8');
  }
}
