# Direction: wairon as the tailorable frame of an AI development workflow

Status: direction, not a design. Nothing here is built yet beyond what "What exists" names.

## The goal

wairon enforces spec-driven development (SDD) by default and gives people good tooling around it: a
machine-checked spec tree, human approval, a conformance gate, live agent briefs, and a UI and canvas
for reading and reviewing a design before it is implemented. That part stays fixed.

What should become tailorable is everything around it: **how** a design is reached and **what matters
most** while it is designed and built. People work differently, and so do the parts of one system.

- Some want speed: a lean design, minimal scope, quick iterations, with quality kept as high as that
  allows. Others take their time and push every part toward the best design they can reach.
- One project may want strict test-first work, heavy use of subagents and formal review. Another keeps
  it simple.
- Within one project, priorities differ by part. A security-sensitive component wants a security
  focus and the quality that keeps it auditable. A financial calculation wants accuracy above all. A
  small to-do list component needs much less. A user interface may care most about the experience,
  while the service behind it cares most about its design.
- Sessions and agents differ too: a session dedicated to security review, an implementer on one
  component, a designer working across subsystems.

wairon should let a person or team state these practices once, scope them, and have every agent that
works on the project receive the right ones at the right moment. It could then be the only workflow
tool a team needs, while it still works next to any other tool someone chooses.

## Principles

1. **The frame is core, the content is packs.** wairon owns the parts that make the frame work: the
   phases (design, approval, implementation, conformance), the scope a setting applies to, and how a
   setting reaches an agent. A practice ("build only what is used", "tests first", "security review
   before approval", how to run a design discussion) is content, and it ships in packs, never in core
   doctrine. Process advice changes much faster than an architecture model.
2. **Stated where it applies.** A practice is scoped like a profile: the project, a subsystem, a
   component, and also a session or an agent role. The closest scope wins.
3. **Delivered through the channels agents already read.** The connecting-agent instructions, the
   skills, the live briefs and the generated guide. An implementer of one component gets that
   component's practices in its brief, not the whole project's.
4. **Enforced where it can be checked, advised where it cannot.** A practice that can be checked
   becomes a rule with a severity (for example: a component under a test-first practice has tests for
   its source). One that cannot stays guidance, and is labelled as guidance.
5. **Core is explicit about itself and silent about others; packs may target anything.** Core states
   its own invariants plainly — the spec tree is the design of record, the lock is the approval, a
   design gap found during implementation goes back to the specs — and names no other tool. That alone
   makes it work beside other workflows. Tailoring to one specific tool is a legitimate pack goal: a
   pack can map another workflow's design documents, plans and approvals onto wairon's, or reproduce
   that workflow inside wairon. Core never needs to know such a pack exists.

## A worked stance: minimal scope versus the best boundary

"Build only what is needed" is right about **capability**: an endpoint nobody calls, an option no
caller sets, a fallback with no reason. It is not an argument about **structure**. A separate concern
deserves its own component even with one consumer, because that is what lets the second consumer find
it instead of writing it again. The usual rule — separate by concern now, generalize the interface when
the second consumer arrives — is one practice among several a team might choose, and a team that wants
to push every part toward the best design it can reach should be able to say so. That choice belongs
in a practice setting, scoped where it applies, not hard-coded in either direction.

## What exists today

- **Packs** contribute rules, profiles (with their own doctrine, severities and design depth), language
  tables, skills (including sections that extend wairon's built-in skills), and instruction blocks
  appended to wairon's own agent instructions, scoped by profile.
- **Profiles resolve per subsystem**, so a part of a project can already follow different doctrine.
- **Per-agent guidance** (`wairon agent customize <id>`) is folded into every brief of that agent.
- **Execution budgets** set model tiers per role.
- **Briefs are composed per call** from the current spec tree, so they can carry scoped content
  without regenerating files.

## What is missing

- A **practice axis** separate from the architecture profile: process and priority settings (scope
  stance, test-first, review depth, security or accuracy focus, use of subagents) with their own scope
  resolution.
- **Component and session scope.** Profiles stop at the subsystem; there is no way yet to select
  practices for one session or one agent role.
- **Every delivery channel open to packs.** A pack's instruction blocks reach only wairon's MCP server
  instructions today. They should also reach the generated guide (the project instructions file many
  tools rank above their own skills) and the live briefs, and follow the practice scope rather than
  only the profile.
- **Checks for the checkable practices**, as rules a practice turns on.
- **The core statements of principle 5** in the generated guide and skills.

## Decided

- **A practice is a new pack element, not a kind of profile.** Profiles stay architecture doctrine
  (stereotypes, flow constructs, rules); practices are process and priorities. Keeping them apart
  keeps both legible, and it keeps the whole direction additive: existing profiles, packs and
  projects keep their meaning.
- **It ships as 6.x minors, not as a major.** A major is earned only when existing project or pack
  forms change meaning and need a migration. Nothing above requires that. If a later step does (for
  example, moving built-in doctrine out of core into a default pack, or a new rule that is on by
  default and fails today's trees), that step carries its own migration and its own major.

## Stages

1. **Core statements and open channels (6.8).** The principle-5 statements in the generated guide,
   the server instructions and the skills, and the rule-4 wording that "smallest" is about capability,
   never structure. A pack's instruction block names the channels it reaches — the server
   instructions (the default, as today), the generated guide, and the live briefs — and follows the
   same profile scope in each: the project's governing profile for the guide, the component's
   subsystem profile for a brief.
2. **The practice element (6.9).** Practices declared by packs, selected per project, subsystem,
   component, session or agent role, and delivered through the channels of stage 1.
3. **Checks and visibility (6.10).** Rules a practice switches on, and practices shown in the UI.
4. **A pack that targets another workflow**, outside core, as the first real test of principle 5.

## Stage 2: the practice element

- **Declared by packs.** A pack lists `practices`, each with an `id`, a one-line `description` and
  the `guidance` an agent receives. Declaring a practice applies it nowhere.
- **Selected in `.wai/project.yaml`, outside the specs.** Process is not design, so changing a
  selection never re-opens the approval:

  ```yaml
  practices:
    use: [lean-scope, test-first]        # the whole project
    subsystems:
      payments: [accuracy-first]
    components:
      ledger: ['!lean-scope']            # `!` drops an inherited practice
    roles:
      reviewer: [security-review]        # the agent template a brief is composed from
  ```

  Scopes apply in the order project, subsystem, component, role, then the session; each adds to what
  it inherits, and `!<id>` drops one.
- **Picked per session with a tool.** `sdd_use_practices` lists the declared practices and adds or
  drops practices for the session. A stdio session keeps its picks, and briefs fetched afterwards
  carry them; the hosted server is built per request, so there the answer covers that call only.
- **Delivered through the existing channels.** The generated guide carries the project's own
  practices; each brief carries the practices in force for its subsystem, component and role plus
  the session's; the server instructions name the project's practices and point at the tool.
- **Checked where it can be.** `UNKNOWN_PRACTICE` (a selection names a practice no loaded pack
  declares) and `UNKNOWN_PRACTICE_SCOPE` (a key names no subsystem, component or known role).

## Open questions

- How practices show up in the UI, so a reviewer can see which ones governed a component.
