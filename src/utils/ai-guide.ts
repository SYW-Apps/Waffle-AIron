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
import { versionStamp } from '../core/stamp.js';

export const GUIDE_MARKER_START = '<!-- wairon-guide-start -->';
export const GUIDE_MARKER_END = '<!-- wairon-guide-end -->';

// ---------------------------------------------------------------------------
// Guide content
// ---------------------------------------------------------------------------

export const GLOBAL_GUIDE_BODY = `\
## wairon — Spec-Driven Development (optional)

If \`.wai/specs/\` exists, the wairon SDD workflow is active; otherwise ignore it. wairon does not orchestrate sessions — it equips yours.

### In SDD Projects:
- **Source of Truth**: All architecture lives in the spec tree under \`.wai/specs/\` (L0 System → L1 Subsystem → L2 Component → L3 Interface → L4 Implementation → L5 Narrative). Do not edit generated agent config files under \`.claude/agents/\` (rebuilt via \`wairon generate\`).
- **Validation**: Conformance checks (stereotype rules, cycle checks, reference integrity) are run via the \`sdd_validate_tree\` MCP tool.
- **Operating Rules**:
  1. **Skills**: Use \`sdd-architect\` to design (and \`sdd-implement\`, \`sdd-narrative\`, \`sdd-auditor\`). Refer to project's local guide file for detailed constraints.
  2. **MCP Tools Only**: Author/validate specs *only* via \`sdd_*\` tools (e.g. \`sdd_initialize_system\`, \`sdd_validate_tree\`).
  3. **No CLI Exec**: Do not run the \`wairon\` CLI (human tool). Use MCP tools \`sdd_validate_tree\` and \`sdd_get_status\` instead.
  4. **Subagents**: Spawn generated \`<component>-implementer\` subagents for coding.
  5. **Design First**: Complete spec and pass \`sdd_validate_tree\` before writing code.
  6. **Consistency**: Code must match L3 interfaces and L5 narratives exactly. If the spec is wrong, stop and update the spec.
  7. **Subprojects & Namespacing**: If a subsystem uses \`projectPath\` delegation, target its specs using namespaced IDs (e.g. \`subsystem::component\`). Use leading \`::\` to target root (e.g. \`::shared::type\`) and \`super::\` to go up a level (e.g. \`super::sibling\`). wairon automatically resolves the path and strips the prefix on writes.`;

const LOCAL_GUIDE_BODY = `\
## Wairon — Spec-Driven Development (you are operating inside it)

This project uses **wairon**. System specs live under \`.wai/specs/\` (L0 System → L1 Subsystem → L2 Component → L3 Interface → L4 Implementation → Narrative); agent topology and code are derived from it.

**Do NOT search files or read agent configs to learn about wairon or SDD. Use the context here and the \`sdd-architect\` skill to start.**

**Your first move: call the \`sdd_get_status\` MCP tool** (or \`wairon/sdd_get_status\`) to see the spec tree. Do not parse files or run CLI commands manually.

### How you operate
- **To design/modify specs**: Use **\`sdd-architect\`** skill (in \`.claude/skills/\` or \`.gemini/skills/\`).
- **Manage specs via MCP tools only**: Use \`sdd_initialize_system\`, \`sdd_add_subsystem\`, \`sdd_add_component\`, \`sdd_define_interface\`, \`sdd_write_narrative\`, \`sdd_add_type\`, \`sdd_get_spec\`, \`sdd_delete_spec\`, \`sdd_validate_tree\`, and \`sdd_get_status\` (namespaced if needed). Do not edit specs manually.
- **Subprojects & Namespacing (Chaining)**: If a subsystem defines a \`projectPath\`, its entire \`.wai/\` spec tree is recursively loaded and namespaced with the subsystem ID as a prefix (using \`::\`, e.g. \`billing::invoice::invoice_portal\`). Use the qualified namespaced ID with the parent MCP tools; wairon will resolve the path and strip the prefix automatically.
  - **Leading \`::\`**: Bypasses the local subsystem prefix to resolve absolute from the system root (e.g. \`::shared::error-type\`).
  - **\`super::\`**: Goes up one parent subsystem level (e.g. \`super::sibling_comp\`, \`super::super::parent_sibling\`).
- **Do not run the \`wairon\` CLI**: Use \`sdd_validate_tree\` and \`sdd_get_status\` instead of CLI commands.
- **Handoff to implementation**: Once design is complete and validates cleanly, tell the human: *"The specs are complete and validate. Please run \`wairon lock\` to confirm and generate the implementer agents, then restart this session to load them."*
- **To implement code**: Spawn the generated \`<component-id>-implementer\` subagent. Implementations must match L3 interfaces and L5 narratives exactly. If you are operating inside a subproject directory context (e.g. subfolder) and cannot see or spawn the generated implementer agent or its skills, instruct the user to start a new agent session from the parent wairon project directory root.

### Rules (enforced by \`sdd_validate_tree\`)
1. **Design before code**: Complete spec and pass validator before writing source code.
2. **Human-in-the-loop**: Ask user approval for each spec layer before proceeding.
3. **Spec consistency**: If a 1:1 narrative match is incorrect or conflicts with L0 requirements, escalate a spec revision first. Never ship mismatched code.
4. **No persistence shortcuts & strict layers**: A Portal must never depend directly on a Repository, Store, Registry, or Adapter (enforce Portal -> Orchestrator -> Repository/Store). Every stored entity (even simple configs/permissions/rules) must use a proper Repository (composed of Store, Registry, and Index). Never store state inside Orchestrators or Specialists directly, and never combine Store/Registry/Index roles into one component.

### Component Vocabulary
* **Blocks**: Portal, Orchestrator, Supervisor, Actor, Store, Index, Registry, Adapter, Observer, Specialist.
* **Patterns**: Repository, Gateway (these composable patterns \`own\` member blocks).
* Use \`owns\` for private member containment (exactly one hop) and \`dependsOn\` for collaborators. Never use generic suffixes like "Manager", "Helper", or "Utils".`;

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
  const section = `\n\n${GUIDE_MARKER_START}\n${versionStamp()}\n${body}\n${GUIDE_MARKER_END}\n`;

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
    // Gemini CLI / Antigravity auto-load the ROOT GEMINI.md but NOT .gemini/GEMINI.md,
    // and @-import expansion is not guaranteed — so inline the full guide here so the
    // agent actually has it (otherwise it's told "the guide is above" when it isn't).
    const content = `# Wairon SDD Project
${GUIDE_MARKER_START}
${versionStamp()}
${LOCAL_GUIDE_BODY}
${GUIDE_MARKER_END}
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

// Target types that carry a guide-bearing root delegator file.
const GUIDE_TARGETS = ['claude', 'gemini', 'agy', 'cursor', 'copilot', 'codex'];

/**
 * Re-inject the project-LOCAL wairon guide for each active target and refresh
 * its root delegator. This is what keeps `.claude/CLAUDE.md` / `.gemini/GEMINI.md`
 * current with the installed wairon — without it, `init` is the only thing that
 * ever writes the guide, so it silently goes stale. Global (home) guides are not
 * touched here; those remain opt-in via `wairon init`. Returns the guide file
 * paths that were (re)written.
 */
export function reinjectLocalGuides(projectRoot: string, targetTypes: string[]): string[] {
  const written: string[] = [];
  for (const type of targetTypes) {
    if (!GUIDE_TARGETS.includes(type)) continue;
    const guidePath = localGuideFilePath(projectRoot, type);
    if (guidePath) {
      injectGuide(guidePath, 'local');
      if (!written.includes(guidePath)) written.push(guidePath);
    }
    writeRootGuideDelegator(projectRoot, type);
  }
  return written;
}
