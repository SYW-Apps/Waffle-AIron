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
import { writeFile } from './fs.js';

export const GUIDE_MARKER_START = '<!-- wairon-guide-start -->';
export const GUIDE_MARKER_END = '<!-- wairon-guide-end -->';

// ---------------------------------------------------------------------------
// Guide content
// ---------------------------------------------------------------------------

const GLOBAL_GUIDE_BODY = `\
## wairon — Spec-Driven Development (optional)

If \`.wai/specs/\` exists, the wairon SDD workflow is active; otherwise ignore it. wairon does not orchestrate sessions — it equips yours.

### In SDD Projects:
- **Source of Truth**: All architecture lives in the spec tree under \`.wai/specs/\` (L0 System → L1 Subsystem → L2 Component → L3 Interface → L4 Implementation → L5 Narrative). Agent files under \`.claude/agents/\` are an opt-in generated view (\`rules.materializeAgentFiles\`) — never edit them; agents are served as live briefs.
- **Validation**: Conformance checks (stereotype rules, cycle checks, reference integrity) are run via the \`sdd_validate_tree\` MCP tool.
- **Operating Rules**:
  1. **Skills**: Use \`sdd-architect\` to design (and \`sdd-implement\`, \`sdd-narrative\`, \`sdd-auditor\`). Refer to project's local guide file for detailed constraints.
  2. **MCP Tools Only**: Author/validate specs *only* via \`sdd_*\` tools (e.g. \`sdd_initialize_system\`, \`sdd_validate_tree\`).
  3. **No CLI Exec**: Do not run the \`wairon\` CLI (human tool). Use MCP tools \`sdd_validate_tree\` and \`sdd_get_status\` instead.
  4. **Delegation**: Delegate implementation via the \`sdd-delegate\` skill — live agent briefs (\`sdd_get_agent_brief\` MCP tool / \`wairon-agent://\` resource) are composed per call and always current; no session restart. Generated agent files are an optional materialized view of the same topology. User-owned per-agent guidance may live in \`.wai/agents/<agent-id>.md\` (folded into every brief; scaffold via \`wairon agent customize <id>\`).
  5. **Design First, then approval**: Complete the spec and pass \`sdd_validate_tree\`, then ask the human to approve it with \`wairon lock\` before writing code. Approval is the lock record (\`.wai/lock.json\`), not a spec's \`status\` — the lock does not rewrite statuses; \`sdd_get_status\` reports the approval state. Code linkage (\`sourcePath\`, \`symbol\`, \`simPath\`, …) is not part of the approval: declare planned source paths at design time, they cost no re-lock.
  6. **Prose is design; linkage is not**: an L4/L5 prose change — an implementation's or a method's description, intent or narrative step text — IS a design change: it re-opens the approval, so \`wairon lock\` is owed before code is implemented against it (an implement step asked for in the same turn as a prose edit waits for the human's re-lock; sequence spec turn → lock → code turn). Only code linkage is outside it.
  7. **Consistency**: Code must match L3 interfaces and L5 narratives exactly. If the spec is wrong, stop and update the spec.
  8. **Members & References**: A project may declare **members** in its \`.wai/project.yaml\` \`members\` (create one with \`sdd_add_member\`). A **part** (the default) stores some of this project's subsystems in another folder or repository: local ids, this project's lock. A **project** member is an independent boundary with its own spec tree and lock, designed from its own root. Reference what another project exports as \`alias::name\` (the alias is a member or a declared external, the name a public name of its L0 export table); an id without \`::\` is local. A leading \`::\`, \`super::\`, member paths and an L1 subsystem carrying \`projectPath\` are deprecated: they still resolve for one release, are reported, and \`wairon doctor --fix\` rewrites them.
  9. **Reachability**: every Portal verb is reached by a modelled caller or declared an entry (\`invokedBy: { kind: entry }\`) for real callers outside the design — never an entry invented to silence a finding.`;

const LOCAL_GUIDE_BODY = `\
## Wairon — Spec-Driven Development (you are operating inside it)

This project uses **wairon**. System specs live under \`.wai/specs/\` (L0 System → L1 Subsystem → L2 Component → L3 Interface → L4 Implementation → Narrative); agent topology and code are derived from it.

**Do NOT search files or read agent configs to learn about wairon or SDD. Use the context here and the \`sdd-architect\` skill to start.**

**Your first move: call the \`sdd_get_status\` MCP tool** (or \`wairon/sdd_get_status\`) to see the spec tree. Do not parse files or run CLI commands manually. If no \`sdd_*\` tools are available, this folder is not the root of the project this guide came from — say so instead of guessing.

### How you operate
- **To design/modify specs**: Use **\`sdd-architect\`** skill (in \`.claude/skills/\` or \`.gemini/skills/\`).
- **Manage specs via MCP tools only** (namespaced if needed; do not edit specs manually): author with \`sdd_initialize_system\`, \`sdd_add_subsystem\`, \`sdd_add_component\`, \`sdd_define_interface\`, \`sdd_set_endpoints\`, \`sdd_write_narrative\`, \`sdd_add_type\`, \`sdd_set_public_interfaces\`, \`sdd_update_spec\` (a granular delta, with \`dryRun\`) and \`sdd_delete_spec\`; rename and move with traces with \`sdd_rename_component\`, \`sdd_rename_method\` (with \`dryRun\`: it names the consumers a renamed verb breaks), \`sdd_rename_param\`, \`sdd_rename_type\`, \`sdd_rename_field\` and \`sdd_move_methods\`; read with \`sdd_get_status\`, \`sdd_get_spec\`, \`sdd_validate_tree\`, \`sdd_get_agent_brief\`, \`sdd_get_network_flows\` and \`sdd_explain_flow\` (the network), \`sdd_list_consumers\` and \`sdd_surface_diff\` (who uses this project's exports, method by method, and what its public surface changed since the last approval), \`sdd_get_externals_status\` and \`sdd_pack_impact\`; the network with \`sdd_set_network\`; externals with \`sdd_add_external\`, \`sdd_update_external\`, \`sdd_pin_externals\` and \`sdd_remove_external\`; the family's shape with the member tools below. The legacy topology tools \`getAgent\`, \`getProjectConfig\`, \`listAgents\`, \`listDomains\` and \`validateTopology\` read the generated agent registry only.
- **Growing a system — subsystems → parts → projects**: boundaries are earned. Start with subsystems in one folder. A piece that needs its own folder or repository but stays the same system is a **part**: declared in \`.wai/project.yaml\` \`members\` by one location key (\`scheduler: services/scheduler\`, \`admin: ../admin\`, \`payments: git@host:acme/payments.git#<commit>\`; long form \`{ source, as, description }\`), its subsystems this project's own — local ids, this project's lock. \`sdd_add_member\` creates a part by default (\`as: project\` for a project) and \`sdd_externalize_subsystem\` moves a subsystem into one. A **project** is an independent boundary — its own id, exports, lock — reached as \`alias::name\`; make one only when it needs its own team, release, approval or public surface: \`sdd_promote_member\` (\`sdd_demote_member\` back). What a member is follows from its content (an id, an L0 or a lock make a project).
- **Members & cross-project references**: relocate a member with \`sdd_move_member\`. Every other change of the family's shape is a **family migration**, each with \`dryRun\`: promote/demote, make an existing project a member with \`sdd_attach_member\`, take one out and back with \`sdd_detach_member\` / \`sdd_adopt_member\`, rename a project's id with \`sdd_rename_project\` or an alias with \`sdd_rename_member_alias\`, move a subsystem into a part with \`sdd_externalize_subsystem\` and fold a member back in with \`sdd_internalize_member\`. Run it with \`dryRun: true\` first and show the plan (the human's CLI calls the same plan \`--report\`); applied, it writes every project it touches or none, and never locks — it names the projects to re-lock. A project member is never a subsystem of its parent: it has its own \`.wai/\` tree and is designed from its own root — its specs, its L0 export table and its \`project.yaml\` are written by a session opened in that member's folder (its own guide and \`.mcp.json\`), and the tools here refuse such a write naming that folder.
  - **\`alias::name\`**: An id without \`::\` is local to the project that writes it. Anything another project provides is referenced as \`alias::name\` — the alias is one of your members or declared \`externals\`, the name a public name in that project's L0 export table. A reference to something it does not export is reported (\`EXTERNAL_NOT_EXPORTED\`).
  - **Deprecated forms** (they still resolve for one release, are reported, and \`wairon doctor --fix\` rewrites them): a leading \`::\` (\`::shared::error-type\`), \`super::\` (\`super::sibling_comp\`), member paths (\`billing::invoice::invoice_portal\`), and an L1 subsystem carrying \`projectPath\` (\`DEPRECATED_MOUNT_FORM\`).
- **Do not run the \`wairon\` CLI**: Use \`sdd_validate_tree\` and \`sdd_get_status\` instead of CLI commands.
- **Handoff to implementation**: Once design is complete and validates cleanly, tell the human: *"The specs are complete and validate. Please run \`wairon lock\` to approve them, and commit \`.wai/lock.json\`."* The lock records the approval; it does not rewrite spec files or their \`status\`. No session restart is needed after the lock — delegate implementation right away via the \`sdd-delegate\` skill.
- **Approval, not status**: a design is ready to implement when it is APPROVED — \`sdd_get_status\` reports the approval state (approved, or which specs changed since), and \`wairon lock-check\` gives the same verdict in CI. A spec's \`status\` (draft/design/complete) is authoring readiness only; never wait for it to become \`complete\`. It is left out of the approval, so promoting a status never reopens an approved design.
- **Prose is design; linkage is not**: an L4/L5 prose change — an implementation's or a method's description, intent or narrative step text — IS a design change: it re-opens the approval, so \`wairon lock\` is owed before code is implemented against it (an implement step asked for in the same turn as a prose edit is refused until the human re-locks; sequence spec turn → lock → code turn). Only code linkage is outside it.
- **Code linkage is not approval**: the lock approves the DESIGN. Where it is realized — \`sourcePath\`, \`symbol\`, \`exportedVia\`, \`simPath\`, \`injectedParams\`, conformance tiers, timestamps — is outside the approved digests, so setting or changing it never asks for a re-lock. Declare each implementation's planned \`sourcePath\` at design time: a named file not written yet is \`SOURCE_FILE_PLANNED\` (a notice), at method level as at implementation level; once the component's realization begins (any file it names exists), a contract method naming no file is \`METHOD_SOURCE_PATH_MISSING\` (warning) and one its existing file does not hold is \`UNREALIZED_METHOD\`. \`rules.conformance.requireCode: true\` makes the planned and unlinked notices errors. Briefs fence planned files, marked \`(planned — create it)\`.
- **Externals — the pin gates, live drift is visible**: declare a project this one consumes with \`sdd_add_external\` (alias, and a source \`../sibling\`, \`hosted:<id>\`, \`<git url>\` or \`<git url>#<commit>\`) — never by hand-editing \`.wai/project.yaml\`; it is checked against the producer and pinned. Change its \`use\` imports with \`sdd_update_external\` and remove it (declaration and pin together) with \`sdd_remove_external\`. A name the producer exports to a narrower audience (\`project\` < \`department\` < \`instance\` < \`partner\` < \`external\`) than this project is read at is refused, naming both. The owner's gate judges every external against its pin. \`sdd_validate_tree\` and \`sdd_get_status\` also compare each external with its LIVE producer, offline, as ADVISORY findings (\`advisory: true\`): \`EXTERNAL_LIVE_INCOMPATIBLE\` (a used member changed, was renamed — the new name is given — or is gone), \`EXTERNAL_DRIFTED\`, \`EXTERNAL_LIVE_UNCOMPARED\`. They never make the tree invalid or fail \`--ci\`; the fix is to adapt the uses, then ask the human to re-pin (\`wairon externals pin <alias>\`). A git producer is compared live only by \`wairon externals status\` — the opt-in live CI gate (exit 1 incompatible, 2 not compared, 0 otherwise).
- **To implement code**: Delegate via the \`sdd-delegate\` skill: fetch the component's live brief with the \`sdd_get_agent_brief\` MCP tool (or the \`wairon-agent://\` resource) and spawn a subagent from it. Briefs are composed per call from the current spec tree, so they are always current — never wait for a restart. Implementations must match L3 interfaces and L5 narratives exactly. Generated agent files under \`.claude/agents/\` are an optional materialized view of the same topology — the live briefs are canonical.

### Rules (enforced by \`sdd_validate_tree\`)
1. **Design before code**: Complete spec and pass validator before writing source code.
2. **Human-in-the-loop**: Ask user approval for each spec layer before proceeding.
3. **Spec consistency**: If a 1:1 narrative match is incorrect or conflicts with L0 requirements, escalate a spec revision first. Never ship mismatched code.
4. **No persistence shortcuts & strict layers**: A Portal must never depend directly on a Store, Registry, or Adapter. Portal reads MAY go through a Repository/Index facade (passthrough reads need no per-entity Orchestrator ceremony), but a Portal narrative call or dispatch-table binding that reaches a write-effect facade method is an error (\`PORTAL_WRITE_SHORTCUT\`) — writes always route through an Orchestrator. Held domain state always lives in a dedicated data component, never as fields inside an Orchestrator. Design the SMALLEST sound shape: genuinely simple state (keyed reads and writes) is one standalone Store — the sanctioned shape, with workflow-layer consumers and a lint.allow reason on the UNOWNED_STORE warning — and the Repository pattern (a facade owning Store + Registry + one Index per real lookup) is for state with real lookup or index needs. Never split Store/Registry/Index for simple state, never combine their roles into one component, and never fold state into a consuming component because a link was refused.
5. **Every Portal verb is reached**: a modelled caller reaches it (a \`call\` step along \`dependsOn\`, \`alias::portal.verb\` across projects), or it is an **entry** — callers outside the design reach it: \`invokedBy: { kind: entry, caller }\` on the Portal (every verb inherits it) or on one verb. Declare an entry only for real outside callers (browsers, a CLI user, an AI tool over stdio, applications linking a library) — **never invent one to silence an \`UNUSED_*\` finding**: model the caller, or remove the verb. A Portal states one \`transport\` (\`HTTP\`, \`gRPC\`, \`GraphQL\`, \`MessageBus\`, \`CLI\`, \`IPC\`, \`NamedPipe\`, \`JSONRPC\` for stdio JSON-RPC, \`InProcess\` for a library, which binds no endpoint). A project may declare a network (\`sdd_set_network\`; the human runs \`wairon network declare\` — never a hand edit of \`project.yaml\`): an entry's \`scope\` is then \`outside\` (default) or \`network\` (sibling services), and inside a network only a \`gateway\` Portal is entered from outside. Another project's \`InProcess\` library is called directly from any component — no client Adapter — within the purity (\`effect\`) and language-bridge (\`abi\`) checks.
6. **Naming follows the target language**: methods are named in the project's method casing (camelCase for TypeScript/Java, snake_case for Rust/Python, from \`targetLanguage\` unless \`rules.naming\` says otherwise); a wire name that differs (an HTTP path, a CLI command, a JSON-RPC method) belongs on the method's \`endpoint\`, never in the method name.

### Component Vocabulary
* **Blocks**: Portal, Orchestrator, Supervisor, Actor, Store, Index, Query, Registry, Adapter, Observer.
* **Patterns**: Repository — the composable pattern that \`owns\` its member blocks: one Store with its Registry, Indexes and Queries, and optionally an Adapter.
* **Variants**: \`gateway\`, a Portal that authenticates, authorizes, validates or rate-limits before it dispatches. Logic is an Orchestrator, and \`dependencyClass: pure | read\` bounds what it may depend on (unset = a workflow). Specialist and Gateway are retired stereotypes.
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

/** guide_scope — which guide file a body is for: a user-level one (global) or a project's own (local). */
export type GuideScope = 'global' | 'local';

/** The guide body for a scope: the global body for a user-level guide file,
 *  the local body for a project's own. */
export function guideBody(scope: GuideScope): string {
  return scope === 'global' ? GLOBAL_GUIDE_BODY : LOCAL_GUIDE_BODY;
}

/**
 * Inject (or update) the wairon guide section in the given file.
 * Creates the file and any parent directories if they don't exist.
 */
export function injectGuide(filePath: string, scope: GuideScope): void {
  // Use `wairon` literally in injected docs — never substitute a dev path. The
  // guide is documentation (the AI uses MCP tools; the human runs `wairon`).
  const body = guideBody(scope);
  const section = `\n\n${GUIDE_MARKER_START}\n${versionStamp()}\n${body}\n${GUIDE_MARKER_END}\n`;

  const existing = fs.existsSync(filePath)
    ? fs.readFileSync(filePath, 'utf-8')
    : '';

  const stripped = stripGuideSection(existing);
  const newContent = stripped.trimEnd() + section;

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  writeFile(filePath, newContent); // keeps the file's line endings
}

/** Remove the wairon guide section from a string (for clean replacement). */
export function stripGuideSection(content: string): string {
  const start = content.indexOf(GUIDE_MARKER_START);
  const end = content.indexOf(GUIDE_MARKER_END);
  if (start === -1 || end === -1) return content;
  return content.slice(0, start) + content.slice(end + GUIDE_MARKER_END.length);
}

// ---------------------------------------------------------------------------
// Root pointers
//
// The repository-root file a tool loads first (CLAUDE.md, GEMINI.md,
// .cursorrules, …) is usually the USER's own file: a repository that adopts
// wairon has one already, and a team keeps adding to it. wairon therefore owns
// only its block between the root markers, exactly as it owns only its guide
// section in .claude/CLAUDE.md: every byte outside the markers is kept, and no
// command ever deletes text a person wrote there. A root file that holds the
// unmarked pointer an earlier release wrote is recognised and migrated into
// the marked block, keeping whatever followed it.
// ---------------------------------------------------------------------------

export const ROOT_MARKER_START = '<!-- wairon-root-start -->';
export const ROOT_MARKER_END = '<!-- wairon-root-end -->';

/** The import line that loads the in-project guide into Claude's context. */
const CLAUDE_IMPORT = '@.claude/CLAUDE.md';

/** What the claude root pointer says below its import line. */
const CLAUDE_POINTER_TEXT = `# Wairon SDD Project

This project uses the Wairon Spec-Driven Development (SDD) framework. The imported
\`.claude/CLAUDE.md\` above is your complete operating guide — you already have the
full context, so don't search the project to learn how wairon or SDD works.

To design or modify the system, invoke the **\`sdd-architect\`** skill
(in \`.claude/skills/\`). Author and validate specs with the \`sdd_*\` MCP tools;
the \`wairon\` CLI is the human developer's tool, not yours.
`;

/** The unmarked root pointers earlier releases wrote, by file: recognised at the start of a file and migrated. */
const LEGACY_POINTERS: Record<string, string[]> = {
  'CLAUDE.md': [
    `${CLAUDE_IMPORT}\n\n${CLAUDE_POINTER_TEXT}`,
    `${CLAUDE_IMPORT}\n@.claude/skills/sdd-architect.md\n@.claude/skills/sdd-narrative.md\n@.claude/skills/sdd-auditor.md\n@.claude/skills/sdd-implement.md\n\n# Wairon SDD Project\n\nThis project uses the Wairon Spec-Driven Development (SDD) framework.\nTo start designing or modifying the system, you must invoke the **\`/sdd-architect\`** sub-agent.\n\nRefer to [.claude/CLAUDE.md](.claude/CLAUDE.md) for full instructions and CLI references.\n`,
    `${CLAUDE_IMPORT}\n@.claude/sdd-architect.md\n@.claude/sdd-narrative.md\n@.claude/sdd-auditor.md\n@.claude/sdd-implement.md\n\n# Wairon SDD Project\n\nThis project uses the Wairon Spec-Driven Development (SDD) framework.\nTo start designing or modifying the system, you must invoke the **\`/sdd-architect\`** sub-agent.\n\nRefer to [.claude/CLAUDE.md](.claude/CLAUDE.md) for full instructions and CLI references.\n`,
  ],
  '.cursorrules': ['# Wairon SDD Project\n\nThis project uses the Wairon Spec-Driven Development (SDD) framework.\n\nRefer to the rules in [.cursor/rules/](.cursor/rules/) for full instructions.\n'],
  'copilot-instructions.md': ['# Wairon SDD Project\n\nThis project uses the Wairon Spec-Driven Development (SDD) framework.\n\nRefer to the prompts in [.github/prompts/](.github/prompts/) for instructions.\n'],
  '.codexrules': ['# Wairon SDD Project\n\nRefer to [.codex/agents/](.codex/agents/) for full instructions.\n'],
};

/** A target's root file and the body of wairon's block in it (the text between the markers), given the user's own text. */
function rootPointerOf(projectRoot: string, targetType: string): { file: string; body: (userText: string) => string } | null {
  switch (targetType) {
    case 'claude':
      return {
        file: path.join(projectRoot, 'CLAUDE.md'),
        // The user's own text may import the guide already: never load it twice.
        body: (userText) => (importsLine(userText, CLAUDE_IMPORT) ? CLAUDE_POINTER_TEXT : `${CLAUDE_IMPORT}\n\n${CLAUDE_POINTER_TEXT}`),
      };
    case 'gemini':
    case 'agy':
      // Gemini CLI / Antigravity auto-load the ROOT GEMINI.md but NOT .gemini/GEMINI.md,
      // and @-import expansion is not guaranteed — so the full guide is inlined here so the
      // agent actually has it (otherwise it's told "the guide is above" when it isn't).
      return {
        file: path.join(projectRoot, 'GEMINI.md'),
        body: () => `# Wairon SDD Project\n${GUIDE_MARKER_START}\n${versionStamp()}\n${LOCAL_GUIDE_BODY}\n${GUIDE_MARKER_END}\n`,
      };
    case 'cursor':
      return { file: path.join(projectRoot, '.cursorrules'), body: () => LEGACY_POINTERS['.cursorrules'][0] };
    case 'copilot':
      return { file: path.join(projectRoot, '.github', 'copilot-instructions.md'), body: () => LEGACY_POINTERS['copilot-instructions.md'][0] };
    case 'codex':
      return { file: path.join(projectRoot, '.codexrules'), body: () => LEGACY_POINTERS['.codexrules'][0] };
    default:
      return null;
  }
}

/** Whether a text holds `line` as one of its own lines (surrounding space aside). */
function importsLine(text: string, line: string): boolean {
  return text.split(/\r?\n/).some((l) => l.trim() === line);
}

/** The line ending a file's existing text uses: CRLF when it holds one, else LF. */
function eolOf(text: string): '\r\n' | '\n' {
  return text.includes('\r\n') ? '\r\n' : '\n';
}

/** The text's lines, each with its own line ending kept. */
function linesOf(text: string): string[] {
  return text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

/**
 * How many characters at the start of `text` an earlier release's unmarked
 * pointer occupies — compared line by line with line endings and trailing
 * space aside, and taking the blank lines after it — or -1 when the text does
 * not open with one. A GEMINI.md opened by the `# Wairon SDD Project` heading
 * over a guide section is one too, whatever release wrote its guide.
 */
function legacyPointerLength(fileName: string, text: string): number {
  const lines = linesOf(text);
  const bare = (l: string): string => l.replace(/\r?\n$/, '').trimEnd();
  const withBlanks = (count: number): number => {
    let n = count;
    while (n < lines.length && bare(lines[n]) === '') n++;
    return lines.slice(0, n).join('').length;
  };
  if (fileName === 'GEMINI.md') {
    if (lines.length < 2 || bare(lines[0]) !== '# Wairon SDD Project' || bare(lines[1]) !== GUIDE_MARKER_START) return -1;
    const end = lines.findIndex((l, i) => i > 1 && bare(l) === GUIDE_MARKER_END);
    return end < 0 ? -1 : withBlanks(end + 1);
  }
  for (const legacy of LEGACY_POINTERS[fileName] ?? []) {
    const want = legacy.replace(/\n$/, '').split('\n').map((l) => l.trimEnd());
    if (lines.length < want.length) continue;
    if (want.every((l, i) => bare(lines[i]) === l)) return withBlanks(want.length);
  }
  return -1;
}

/**
 * The root file's new content with wairon's block written into `existing`:
 * the marked block replaced in place; an earlier release's unmarked pointer at
 * the start migrated into the block, the user's text after it kept; else the
 * block appended after the user's own text, separated by a blank line. Every
 * byte outside wairon's block is kept as it was — only the block takes the
 * file's line endings. Pure.
 */
export function withRootPointer(fileName: string, existing: string, body: (userText: string) => string): string {
  const eol = eolOf(existing);
  const block = (userText: string): string =>
    `${ROOT_MARKER_START}\n${body(userText)}${ROOT_MARKER_END}\n`.replace(/\n/g, eol);
  const start = existing.indexOf(ROOT_MARKER_START);
  const end = existing.indexOf(ROOT_MARKER_END, start);
  if (start >= 0 && end > start) {
    // The marked block, replaced in place: the text after its end marker keeps its own line ending.
    let after = end + ROOT_MARKER_END.length;
    if (existing.startsWith('\r\n', after)) after += 2;
    else if (existing.startsWith('\n', after)) after += 1;
    const userText = existing.slice(0, start) + existing.slice(after);
    return existing.slice(0, start) + block(userText) + existing.slice(after);
  }
  const legacy = legacyPointerLength(fileName, existing);
  if (legacy >= 0) {
    const rest = existing.slice(legacy);
    return block(rest) + (rest.length > 0 ? eol : '') + rest;
  }
  if (existing.length === 0) return block('');
  const separator = existing.endsWith('\n') ? eol : `${eol}${eol}`;
  return existing + separator + block(existing);
}

/**
 * The text of a root file with wairon's block (marked, or an earlier
 * release's unmarked pointer at its start) taken out — the user's own text,
 * byte for byte. What a demote leaves behind when it removes a session
 * scaffold. Pure.
 */
export function withoutRootPointer(fileName: string, text: string): string {
  const start = text.indexOf(ROOT_MARKER_START);
  const end = text.indexOf(ROOT_MARKER_END, start);
  if (start >= 0 && end > start) {
    let after = end + ROOT_MARKER_END.length;
    if (text.startsWith('\r\n', after)) after += 2;
    else if (text.startsWith('\n', after)) after += 1;
    return text.slice(0, start) + text.slice(after);
  }
  const legacy = legacyPointerLength(fileName, text);
  return legacy >= 0 ? text.slice(legacy) : text;
}

/**
 * ai_tool_guide.writeDelegator — write wairon's block of a target's
 * repository-root pointer file between the root markers, keeping every byte
 * of the user's own text, migrating an earlier release's unmarked pointer.
 * Written only when the content changed.
 */
export function writeRootGuideDelegator(projectRoot: string, targetType: string): void {
  // Step 1: the target's root file and its block; a target with none writes nothing.
  const pointer = rootPointerOf(projectRoot, targetType);
  if (!pointer) return;
  // Step 2: the file as it stands.
  const existing = fs.existsSync(pointer.file) ? fs.readFileSync(pointer.file, 'utf-8') : null;
  // Steps 3-9: the block written into it.
  const fileName = path.basename(pointer.file);
  if (existing === null) {
    // A new file takes the convention around it (writeFile's line endings).
    writeFile(pointer.file, withRootPointer(fileName, '', pointer.body));
    return;
  }
  const next = withRootPointer(fileName, existing, pointer.body);
  // Step 10: only when it changed, every byte outside the block as it was.
  if (next !== existing) fs.writeFileSync(pointer.file, next, 'utf-8');
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

/**
 * iai_tool_guide.registerServer — register the wairon MCP server in the
 * project's own portable Claude configuration (<projectRoot>/.mcp.json) when it
 * registers none: the `wairon mcp serve` entry, every other key kept. A file
 * that already registers wairon, or that cannot be parsed, is left exactly as
 * it is. Answers the path written, or null when nothing was written.
 */
export function registerProjectServer(projectRoot: string): string | null {
  const file = path.join(projectRoot, '.mcp.json');
  let settings: Record<string, unknown> = {};
  if (fs.existsSync(file)) {
    try {
      settings = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    } catch {
      return null;
    }
  }
  const servers = (settings.mcpServers ?? {}) as Record<string, unknown>;
  if (servers.wairon !== undefined) return null;
  settings.mcpServers = { ...servers, wairon: { command: 'wairon', args: ['mcp', 'serve'] } };
  writeFile(file, JSON.stringify(settings, null, 2) + '\n');
  return file;
}
