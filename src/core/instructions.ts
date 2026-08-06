import { loadProjectConfig } from '../config/loader.js';
import type { LoadedInstructionBlock } from './extensions.js';
import { listSkillResources, loadProjectExtensions, type SkillResourceDescriptor } from './skills.js';

// ---------------------------------------------------------------------------
// MCP server instructions — what wairon PUSHES to a connecting agent.
//
// The MCP protocol defines `instructions` on the initialize result as "how to
// use this server"; clients inject it into the agent's system prompt. Without
// it, an agent connecting to a wairon server learns nothing: resources are
// pull-only (a client must already know to fetch wairon-skill://…), so the
// quality of an agent's spec authoring came down to whether a human remembered
// to brief it. That defeats the point of shipping skills with the server.
//
// wairon owns the SDD model, so wairon must teach it — this text is the default,
// not something each wrapper reimplements and drifts on. It stays deliberately
// SHORT and POINTER-HEAVY: the depth already exists in templates/skills/*.md,
// and this is the map that makes an agent go read them. A pack appends its
// platform delta through `instructions` in pack.yaml (see extensions.ts); it
// never restates what is below.
//
// Layering (folded into this module, as skills.ts folds its own):
//   instructions_specialist → buildServerInstructions
// ---------------------------------------------------------------------------

// This module and skills.ts import each other: the guidance orchestrator in
// skills.ts forwards HERE to compose, and the composition reads back through
// skills.ts for the skill descriptors (skills_resource_specialist) and the pack
// load (skills_core_adapter). The cycle is safe in both the ESM and the bundled
// CJS output because every access happens inside a function body at call time —
// nothing here runs during module initialization.

/** The governing projectType/profile of the bound project, or null when it cannot be read. */
function governingProfile(): string | null {
  try {
    return loadProjectConfig().projectType ?? null;
  } catch {
    // An uninitialized project has no config — the briefing still applies.
    return null;
  }
}

/**
 * Does this block apply to the bound project? An unscoped block always applies;
 * a scoped one only when it names the governing profile. A block scoped to a
 * profile we cannot resolve is withheld — a pack that says "only under my
 * profile" must not leak its platform doctrine into an unrelated project.
 */
export function blockApplies(block: LoadedInstructionBlock, profile: string | null): boolean {
  if (!block.profile || block.profile.length === 0) return true;
  return profile !== null && block.profile.includes(profile);
}

/** Render the skill pointers an agent should read before authoring. */
function skillPointers(skills: SkillResourceDescriptor[]): string {
  if (skills.length === 0) return '(none published by this server)';
  return skills.map((s) => `- \`${s.resourceUri}\` — ${s.description || s.name}`).join('\n');
}

/**
 * wairon's OWN briefing: the model, the shape, the order, and where the depth
 * lives. `profile`, `packNames`, and `skills` are the bound project's live
 * facts, so the text describes THIS project rather than wairon in the abstract.
 */
function waironInstructions(
  profile: string | null,
  packNames: string[],
  skills: SkillResourceDescriptor[],
  variants: { id: string; base: string }[],
): string {
  return `# wairon — Spec-Driven Development (SDD)

This server owns one system's **spec tree**: its architecture, specified top-down
and machine-checked. Author it ONLY through this server's \`sdd_*\` tools — never by
writing spec files directly, and never via the \`wairon\` CLI (that is the human
developer's tool).

## The tree: L0 → L5

- **L0 System** — vision, boundaries, global requirements, target language.
- **L1 Subsystem** — an isolated service, its \`publicInterfaces\`, its trusted links.
- **L2 Component** — ONE building block (\`Portal\`, \`Orchestrator\`, \`Supervisor\`,
  \`Actor\`, \`Store\`, \`Index\`, \`Registry\`, \`Adapter\`, \`Observer\`, \`Specialist\`) or
  pattern (\`Repository\`, \`Gateway\`), plus \`owns\` (a pattern's private members) and
  \`dependsOn\` (collaborators).
- **L3 Interface** — the contract: method signatures with structured \`params\`,
  plus wire \`endpoint\` bindings for a Portal's methods.
- **L4 Implementation** — a concrete realization of one L3 contract: narrative
  detail level, bound \`technologies\` (the vendor swap seam), optional \`sourcePath\`.
- **L5 Narrative** — each method's logic as a FLAT numbered step list; \`call\` steps
  resolve to real dependency methods, and flow steps jump by step number.

These stereotypes are not labels — they carry enforced dependency rules (e.g. a
Portal may not depend on a Store; state lives in a Store, never as fields inside
an Orchestrator). \`sdd_validate_tree\` is the gate, and it is the authority on
whether a design is legal.

## Authoring order

1. \`sdd_initialize_system\` (L0), then \`sdd_add_subsystem\` (L1).
2. Then, **one subsystem at a time**: \`sdd_add_component\` (L2) → \`sdd_define_interface\`
   (L3) → \`sdd_set_endpoints\` for Portals → \`sdd_write_narrative\` (L4+L5).
3. Run \`sdd_validate_tree\` as you go — early and per subsystem, not once at the end.
   \`sdd_get_status\` reports completeness; \`sdd_get_spec\` reads any spec back as JSON.
4. Edit granularly with \`sdd_update_spec\` (it renumbers narrative steps and
   relocates jump targets for you).

## The tool schemas are the field reference

Every \`sdd_*\` tool's input schema is self-describing and authoritative — read the
schema rather than guessing field names, and prefer structured \`params\` over prose
signatures. Specs are ${profile === null ? 'validated against the project\'s configured profile' : `governed by the **\`${profile}\`** profile`}, which decides which stereotypes are legal
here, which narrative flow constructs the target language supports, and which
extra rules apply. A subsystem may override the profile for itself.

## Loaded extension packs

${packNames.length === 0 ? 'None — only wairon\'s built-in doctrine applies.' : `${packNames.map((n) => `\`${n}\``).join(', ')} — these inject profiles, language tables, patterns, and\nadditional conformance rules. Their doctrine is enforced by the same gate.`}

${variants.length === 0 ? '' : `## Component variants in play

This project defines variants — named, base-anchored kinds carrying implementation
guidance, so every component of the same kind is built alike: ${variants.map((v) => `\`${v.id}\` (a kind of ${v.base})`).join(', ')}.
Tag a component with \`variant\` where it fits, and read a component's resolved
guidance and its same-variant siblings from \`sdd_get_spec\` (kind: component).

`}## Read the skills BEFORE authoring

This server publishes its skills as MCP resources. **Read \`wairon-skill://sdd-architect\`
before you design anything**, and the others when their turn comes — they carry the
architecture standard, the narrative step reference, and the review checklist that
this briefing only points at:

${skillPointers(skills)}`;
}

/**
 * Compose the `instructions` returned on the MCP initialize handshake: wairon's
 * own briefing, then each governing pack's applicable blocks under an attributed
 * heading, in pack load order.
 *
 * Never throws. A connecting agent must always be taught something, so a failure
 * to resolve packs or skills degrades to the briefing rather than to silence.
 */
export function buildServerInstructions(): string {
  const profile = governingProfile();

  let skills: SkillResourceDescriptor[] = [];
  let blocks: LoadedInstructionBlock[] = [];
  let packNames: string[] = [];
  // The variant vocabulary is deliberately NOT listed here. Reading the variant
  // registry from this module would be an sdd_skills → sdd_core hop onto an
  // internal Adapter, which the boundary rules refuse; routing it through the
  // core portal would mean a barrel import cycle for what is only a pointer.
  // A component's variant guidance is served where the hop is already legal:
  // `sdd_get_spec` (kind: component) returns it resolved, with its siblings.
  const variants: { id: string; base: string }[] = [];
  try {
    skills = listSkillResources();
    const extensions = loadProjectExtensions();
    blocks = extensions.instructions;
    packNames = extensions.packNames;
  } catch {
    // Degrade to wairon's own briefing — see the contract above.
  }

  const sections = [waironInstructions(profile, packNames, skills, variants)];
  for (const block of blocks) {
    if (!blockApplies(block, profile)) continue;
    // Attribution is what keeps a pack's delta legible AS a delta instead of
    // blending into wairon's own doctrine.
    sections.push(`## From pack "${block.pack}"\n\n${block.text.trim()}`);
  }
  return sections.join('\n\n');
}
