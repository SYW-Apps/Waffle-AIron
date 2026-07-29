# Teaching the connecting agent — the MCP entrypoint

> Status: 7.1–7.5 all shipped. Written against wairon 5.1.0.
> Source request: "Teaching the connecting agent: wairon needs the entrypoint,
> packs only adjust it" (2026-07-27).

---

## The governing principle

**wairon owns the SDD model, so wairon must teach it.** If an agent connecting to
a wairon MCP server does not know what SDD is, what the stereotypes mean, or in
what order to use the `sdd_*` tools, supplying that is wairon's default — not
each wrapper's. A pack appends its **platform delta** ("and here is what each of
those means in Make.com") and never restates the model, which would drift on
every wairon release.

Every item below is shaped by that split.

---

## Shipped

### 7.1 — `instructions` on `initialize`

`createMcpServer` returns MCP `instructions`, the protocol's field for "how to
use this server", which clients inject into the agent's system prompt. Composed
by `instructions_specialist` (`src/core/instructions.ts`), it carries the L0→L5
tree shape, the authoring order by tool name, the fact that the `sdd_*` schemas
are self-describing, the bound project's governing `projectType`/profile, the
loaded packs, and the directive to read `wairon-skill://sdd-architect` **before**
authoring — with a pointer per published skill resource.

Deliberately short and pointer-heavy (~2.9 KB for this repo; a test pins a 6 KB
ceiling): the depth lives in `templates/skills/*.md`, and this is the map that
sends an agent to read them.

Composed **per `createMcpServer` call**, so the hosted per-request scoped server
(`server/request.ts:652`) reports its own bound project rather than a snapshot.
Never throws — a failed pack load or an uninitialized project degrades to
wairon's own briefing, because a connecting agent must always be taught
something.

Path: `mcp_server` → `mcp_skills_adapter` → `skills_portal` →
`skills_resource_orchestrator` → `instructions_specialist`. `sdd_mcp` stays a
transport subsystem.

### 7.2 — pack-contributed instruction blocks

`DeclarativePackSchema.instructions` accepts a bare string, one block, or a list,
normalized to `PackInstructionBlock[]`:

```yaml
instructions:
  - text: Applies to every project this pack governs.
  - text: Router branches never appear in a spec — model them as narrative branch steps.
    profile: [make-automation]
```

Appended after wairon's text under `## From pack "<name>"`, in **pack load
order** — the one merged field whose order is semantic, so blocks are never
deduped or overwritten. `profile` scopes a block to the governing profile exactly
as declarative assertions scope theirs; a block scoped to a profile that cannot
be resolved is **withheld**, so platform doctrine never leaks into an unrelated
project.

---

## Shipped (continued)

### 7.4 — skills as MCP prompts — SHIPPED

Resources are pull-only; prompts are what makes a skill *discoverable* to a human
driving an agent (as a slash command or attachable context).

- Register a prompts capability mirroring `listSkillResources()` — the SDK
  exposes `registerPrompt`, so the set cannot drift from the resource mirror.
- Prompt name = skill id (`sdd-architect`, `appenser-make-implementer`); the
  handler returns the skill markdown as a message.
- Resources stay for programmatic reads. Hosted inherits this via the shared
  factory, as the resource mirror already does.
- Test over an in-memory transport (`client.listPrompts()` / `getPrompt()`),
  matching `tests/mcp/skill-resources.test.ts`.

### 7.5 — variant guidance over MCP — SHIPPED

`agent_resolver.buildVariantGuidance` (`src/core/agent_resolver.ts:216`) is the
right hook for platform implementation guidance — it attaches to the component
the implementer is holding, with no doctrine duplication. But it only reaches
**generated agent files**, so hosted/cloud agents never see it.

- **Lift the composition into `src/core/variants.ts`** so the agent renderer and
  the MCP path share one implementation instead of a second copy that drifts.
- `sdd_get_spec` on a variant-tagged component returns the resolved variant
  guidance and its same-variant siblings as a clearly-derived, **read-only**
  field, documented in the tool description as not part of the spec.
- Naming the active variants in the `initialize` instructions was **not** built —
  see the outcome note below. The request said "and/or", and the `sdd_get_spec`
  half is the substantive one.

### 7.3 — pack skills that EXTEND a builtin — SHIPPED

Today `PackSkillSchema` is `{id, source, targets}` and pack skills are namespaced
`<pack>-<id>` so they cannot shadow `sdd-*`. A platform delta can therefore only
exist as a **parallel** skill (`appenser-make-implementer` beside `sdd-implement`),
leaving the agent to notice both and reconcile them — and tempting every wrapper
to fork the builtin wholesale, which is worse for everyone.

```yaml
skills:
  - extends: sdd-implement          # builtin skill name
    source: skills/make-implementer/SKILL.md
  - id: make-control-plane          # unchanged: a genuinely new skill
    source: skills/make-control-plane/SKILL.md
```

- `PackSkillSchema` becomes a union; `extends` must name a builtin
  (`SKILL_NAMES`), and an unknown target **fails the pack load loudly** — the
  `assertions` precedent: an old wairon must never silently not-apply a newer
  pack's doctrine.
- The pack section is appended to the builtin under `## Platform: <pack>`
  (multiple packs in load order), on install **and** on `resources/read`. The
  builtin stays wairon's, so an upgrade still updates it.
- An extending skill contributes **no separate resource** — it composes into the
  builtin's descriptor.

**The trap:** `checkSkillFreshness` (`src/core/skills.ts:166`) byte-compares the
installed file against the raw builtin template. Left alone, every extended skill
reports permanently **stale** in `wairon doctor`. It must compare against the
*composed* expectation.

Also touched: `exportSddSkills` (write composed), `readSkillResource` /
`readResource` (return composed), `listSkillResources` (descriptors), and the
`pack_skill` type spec.

---

## Sequencing (as built)

7.4 → 7.5 → 7.3, in ascending order of blast radius, after the pack-scoping work
(`docs/design/pack-scoping.md`) had settled the selection model — 7.3's
composition runs over whatever pack set resolution yields.

---

## Outcome notes

**7.5 — one half deliberately not built.** The request said "include the resolved
variant guidance in `sdd_get_spec` … **and/or** name the active variants in the
`initialize` instructions". The first is done. The second is not: reading the
variant registry from the instructions composer would be an `sdd_skills` →
`sdd_core` hop onto an internal Adapter, which the boundary rules refuse, and
routing it through the core portal would mean a barrel import cycle for what is
only a pointer. The substantive requirement — guidance reaching a hosted agent —
is satisfied by the tool that hands an implementer its component.

**7.3 — the trap was real.** `checkSkillFreshness` byte-compared installed skills
against the raw builtin template. Left alone, every extended skill would have
reported permanently *stale* in `wairon doctor`, telling users to run `generate`
on a loop. It now compares against what `exportSddSkills` would write.

**A latent bug found while testing 7.5.** `requireSpecs()` in `mcp/server.ts`
lazily required a relative path, which does not resolve under the test runner — so
every `sdd_*` tool built on it failed with a module error instead of running. No
test had ever driven one through an MCP client, so nothing caught it. The
remaining lazy requires in that file (loader / validation / provision) are the
same latent landmine for any future test that exercises those tools.
