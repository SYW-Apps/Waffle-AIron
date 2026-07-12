# Feature Request: Presentation Modes & Guided Architecture Tour Generator

## Summary

Add a `wairon tour` capability that generates audience-specific walkthroughs of a Waffle-AIron project from the existing spec tree, architecture graph, generated agent topology, MCP tools, and diagram/canvas data.

The goal is to help users explain complex Waffle-AIron projects clearly by turning the structured L0–L5 specification model into a guided presentation route, speaking script, and optional interactive canvas tour.

## Problem

Waffle-AIron projects can contain a rich graph of concepts:

- L0 system specs
- L1 subsystems
- L2 components
- L3 interfaces
- L4 implementations
- L5 narrative method logic
- ownership domains
- generated agents and skills
- MCP authoring tools
- validation/conformance rules
- architecture diagrams and ERDs
- extension packs and rule profiles

This structure is excellent for technical correctness, but it can be difficult to explain to different audiences.

In spontaneous conversations, users often enter the system from an arbitrary point, such as a random component spec or implementation file. From there, it is easy to start explaining details before the listener has a map of the overall system. This leads to context gaps, interruptions, unexpected questions, and incomplete demos.

The system already contains enough structured information to generate a better communication path.

## Proposed Feature

Introduce a tour generation feature that derives structured presentation routes from the spec tree and architecture graph.

Example commands:

```bash
wairon tour generate --mode preview
wairon tour generate --mode adoption
wairon tour generate --mode onboarding
wairon tour generate --mode handover
wairon tour generate --mode masterclass
wairon tour generate --mode sales

wairon tour generate --audience developer --duration 20m
wairon tour generate --entry .wai/specs/<subsystem>/<component>/.implementation.yaml
wairon tour generate --format markdown
wairon tour generate --format slides
wairon tour generate --format canvas-tour
```

The generated output should include:

1. A recommended tour route
2. A short opening frame / map
3. Step-by-step presentation stops
4. What to show at each stop
5. What to say at each stop
6. What not to explain yet
7. Likely audience questions
8. Suggested short answers
9. Parking-lot guidance for questions that belong later
10. Optional deep-dive branches
11. Return phrases to get back to the main route
12. A summary / closing statement

## Core Concept: Map vs Tour

The feature should distinguish between a **map** and a **tour**.

### Map

The map is the initial orientation layer. It answers:

- What is this system?
- Why does it exist?
- What are the major parts?
- How do the parts relate?
- Where are we currently?
- What should the audience pay attention to?

Example map for Waffle-AIron:

> Waffle-AIron is built around one source of truth: the `.wai/specs` tree. That tree describes the system from L0 to L5: system, subsystems, components, interfaces, implementations, and narrative method logic. From that, Waffle-AIron validates architectural conformance, generates AI agents and skills, exposes MCP tools, and renders architecture diagrams. The product is essentially: specify the system once, then use that specification to guide both humans and AI.

### Tour

The tour is the selected route through the map. It should be chosen based on audience, goal, available time, and entry point.

Recommended default route for first-time technical demos:

1. One-sentence purpose
2. Top-level architecture map / diagram
3. L0–L5 spec model
4. One representative vertical slice
5. Conformance validation
6. Generated agents and skills
7. MCP authoring tools
8. Diagram/canvas payoff
9. Company/team relevance
10. Questions and deeper dive

## Recommended Default Pattern

For most first-time explanations, the generator should avoid both pure depth-first and pure layer-by-layer tours.

Instead, use:

```text
Map → Representative vertical slice → Derived outputs → Return to map
```

This gives the audience orientation before detail, while still showing a concrete end-to-end example.

### Example

```text
1. Show the top-level system/canvas
2. Explain the major subsystems briefly
3. Pick one representative subsystem/component
4. Follow it from L1 → L2 → L3 → L4 → L5
5. Show what validation checks for that slice
6. Show the generated agent(s) derived from it
7. Show how MCP tools interact with the spec model
8. Return to the full diagram and explain the larger value
```

## Presentation Modes

The tour generator should support multiple modes because the best explanation route depends on the communication goal.

### 1. Preview Mode

Goal: Give someone an initial understanding of what the project is.

Route:

```text
Problem → Big idea → Map → One example → Payoff
```

Emphasize:

- what the tool does
- why the spec tree matters
- the main outputs
- one concrete example
- visual diagram/canvas payoff

Avoid:

- full rule registry details
- deep L5 narrative logic
- internal implementation details

### 2. Adoption / Internal Buy-In Mode

Goal: Help a team or company decide whether to use Waffle-AIron.

Route:

```text
Current pain → Waffle-AIron model → Workflow → Risk reduction → Adoption path
```

Emphasize:

- reducing ad hoc AI prompting
- architecture conformance
- generated agent context
- auditability
- team ownership
- adoption workflow

Avoid:

- excessive internals
- rare edge cases
- advanced extension mechanics unless relevant

### 3. Developer Onboarding Mode

Goal: Teach a developer how to use Waffle-AIron on a project.

Route:

```text
Install → Init → Spec tree → Validate → Generate → Use agents → Iterate
```

Emphasize:

- commands
- file locations
- common workflow
- what developers edit manually
- what Waffle-AIron generates
- common mistakes

### 4. Handover / Maintainer Mode

Goal: Help someone maintain or extend Waffle-AIron itself or a Waffle-AIron-based project.

Route:

```text
Architecture map → Codebase modules → Spec schema → Validation pipeline → Generators → MCP/server → Tests → Extension points
```

Emphasize:

- internal architecture
- design decisions
- implementation modules
- extension points
- failure modes
- tests and validation boundaries

### 5. Sales / Product Pitch Mode

Goal: Make someone understand the product value quickly and want to try it.

Route:

```text
AI coding problem → Spec as control plane → Demo → Outcome → Call to action
```

Emphasize:

- AI needs architecture, not only prompts
- specs become executable guidance
- agents are generated from ownership
- validation catches drift
- diagrams prove the model visually

Avoid:

- jargon too early
- full L0–L5 technical explanation before the value is clear

### 6. Masterclass Mode

Goal: Deeply teach the philosophy and practice of spec-driven AI development.

Route:

```text
Why SDD → L0–L5 theory → Architecture rules → Authoring workflow → Agent topology → MCP → Advanced extensions → Case study
```

Emphasize:

- principles
- architectural tradeoffs
- modeling patterns
- exercises/examples
- best practices

### 7. One-on-One Deep Dive Mode

Goal: Support adaptive exploration with a technical person.

Route:

```text
Map → Ask interest → Follow selected branch → Return to map
```

The generated tour should include branches such as:

- spec model deep dive
- validator deep dive
- generated agents deep dive
- MCP deep dive
- diagram/canvas deep dive
- extension packs deep dive

## Entry-Point-Aware Tours

The tool should support starting from an arbitrary point in the project.

Example:

```bash
wairon tour generate --entry .wai/specs/billing/invoice-runner/.implementation.yaml --mode preview
```

If the user starts inside a random spec or component, the generated tour should include a rescue frame:

> We entered through this specific spec, but this is one node inside a larger L0–L5 tree. The tree drives validation, generated agents, MCP tools, and diagrams. I’ll quickly zoom out, then return to this node and show how it connects upward and downward.

This allows a spontaneous demo to recover structure without restarting completely.

## Suggested Tour Output Structure

Each generated stop could use this structure:

```yaml
stop: 3
title: Representative vertical slice
show:
  - .wai/specs/<subsystem>/<component>/.index.yaml
  - .wai/specs/<subsystem>/<component>/.interface.yaml
  - .wai/specs/<subsystem>/<component>/.implementation.yaml
say: |
  Let’s follow one component through the layers, because this shows the model better than explaining every folder.
do_not_explain_yet:
  - full rule registry
  - extension packs
  - hosting server
likely_questions:
  - question: Why not just write normal documentation?
    short_answer: Because these specs are validated and used to generate AI working context; they are not passive docs.
    return_phrase: So with that in mind, let’s continue down the slice.
deep_dive_branches:
  - validator details
  - narrative method logic
```

## Canvas Tour Mode

A particularly valuable output would be an interactive guided tour for the architecture canvas.

Example stops:

```text
Stop 1: L0 system overview
Camera: zoom to whole graph
Highlight: system boundary
Say: “This is the system boundary and the top-level purpose.”

Stop 2: L1 subsystems
Camera: highlight subsystem clusters
Say: “These are the major ownership areas.”

Stop 3: Representative component
Camera: zoom into selected component
Say: “This component is a good vertical slice because it touches interface, implementation, validation, and generated agent ownership.”

Stop 4: Contract and implementation
Camera: open side panel for L3/L4
Say: “The interface describes what the component promises; the implementation describes how it is fulfilled.”

Stop 5: Validation overlay
Camera: show dependency/rule edges
Say: “The conformance gate checks that these relationships are valid.”

Stop 6: Agent ownership overlay
Camera: show generated agent mapping
Say: “Because ownership is explicit, Waffle-AIron can derive the right agents.”

Stop 7: Return to full map
Camera: zoom out
Say: “The value is that architecture, validation, AI context, and diagrams all come from the same model.”
```

## Deterministic vs AI-Assisted Generation

The feature can be partly deterministic and partly AI-assisted.

### Deterministic Inputs

The following can be derived directly from the spec tree and graph:

- hierarchy order
- dependency order
- ownership boundaries
- interface/implementation links
- call graph
- generated agent topology
- validation rule relevance
- diagram clusters
- central or highly connected components
- entry-point distance to the system root

### AI-Assisted Decisions

The following are audience- and goal-dependent and may benefit from AI planning:

- what to emphasize
- what to skip
- what route best fits the available time
- which component is the best representative vertical slice
- how to phrase the explanation
- how to answer likely questions
- how to adapt the tone for sales, onboarding, handover, or masterclass modes

Recommended approach:

```text
Spec graph + deterministic scoring → candidate route
Candidate route + mode/audience/time → AI-generated script and branches
```

## Route Selection Heuristics

Potential node scoring factors:

```text
- centrality in the dependency graph
- relevance to selected audience/mode
- distance from the chosen entry point
- number of generated outputs connected to the node
- visual clarity on the diagram
- novelty / demonstration value
- complexity level
- prerequisite count
- business or architectural importance
```

For first demos, prefer:

```text
High value + low prerequisite burden + visual clarity + one strong representative slice
```

For handover, prefer:

```text
Architectural importance + implementation dependency order + extension points + failure modes
```

For onboarding, prefer:

```text
Workflow order + user actions + commands + feedback loops
```

## Question Handling

The tour should help presenters avoid getting derailed by early deep questions.

Generated output should classify likely questions into:

1. Answer now
2. Short answer now, full answer later
3. Park for later

Example:

```text
Question: How does MCP setup work?
Type: Short answer now, full answer later
Answer: MCP lets the AI interact with the spec model through structured `sdd_*` tools. I’ll show the setup after the spec tree makes sense.
Return phrase: For now, the important part is that MCP is one way the AI works against the same source of truth.
```

## Value

This feature would make Waffle-AIron useful not only for structuring AI-built software, but also for explaining and teaching that structure to humans.

It would support:

- better first demos
- internal adoption presentations
- developer onboarding
- architecture handovers
- guided canvas walkthroughs
- generated speaker notes
- product sales narratives
- technical masterclasses
- adaptive one-on-one deep dives

In short:

> Waffle-AIron already models complex systems. `wairon tour` would turn that model into a clear human explanation path.

## Possible MVP

A minimal first version could generate a Markdown tour plan:

```bash
wairon tour generate --mode preview --duration 15m --format markdown
```

MVP output:

- opening frame
- map summary
- recommended route
- one vertical slice selection
- stop-by-stop talking points
- likely questions
- parking-lot suggestions
- closing summary

Later versions could add:

- canvas camera paths
- slide export
- mode-specific templates
- AI-generated speaker script
- audience profiles
- interactive branching
- generated diagrams with highlighted route overlays
