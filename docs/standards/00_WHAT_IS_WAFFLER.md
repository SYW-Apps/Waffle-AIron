# What Is Waffler

**Version:** 1.0 · **Date:** 2025-10-01

This document exists so that every contributor — human or AI — understands *why* Waffler
is built the way it is before touching any code. The architecture standards and principles
in this folder are not arbitrary rules. They follow directly from what Waffler is and
what it is trying to become.

---

## The Short Version

Waffler is a **visual programming language and automation platform** — two things at once.

On the surface it looks like a modern automation tool (think Make.com, n8n, or Zapier).
Users connect blocks together to automate tasks. Under the hood, it is a complete,
general-purpose execution environment: a runtime, a package system, an identity model,
a security layer, a virtual filesystem, an expression language, and an IDE. That is not
an automation tool with programming features bolted on. It is a programming language
whose primary representation happens to be visual.

---

## Waffler as a Programming Language

A traditional programming language has:
- A runtime that executes programs
- A standard library of built-in capabilities
- A way to import and use third-party code
- A syntax (text, in most cases)
- An IDE or editor

Waffler has all of these:

| Programming Language Concept | Waffler Equivalent |
|---|---|
| Runtime | `waffler_core` |
| Programs | Blueprints |
| Standard library | First-party packages (`syw.*`) |
| Third-party packages | Any installed package |
| Import / dependency | Package manifest `dependencies` field |
| Syntax | Visual node graph in `waffler_ui` |
| IDE | `waffler_ui` (desktop via Tauri, or web-hosted) |
| Variables | Blueprint / local / global variable scopes |
| Functions | Subroutines and expressions |
| Types | User-defined schemas |
| Control flow | Condition, Switch, Loop, Return, Throw nodes |

The reason this matters: the standards and architecture decisions in this codebase are
made for a *programming language runtime*, not for an automation script runner.
Correctness, robustness, modularity, and extensibility are non-negotiable properties
of the system — the same properties we expect from any serious language runtime.

---

## Waffler as an Automation Platform

At the same time, Waffler deliberately meets automation users where they are.
`waffler_ui` provides a visual interface that feels familiar to users of Make.com,
n8n, Zapier, or similar platforms: drag-and-drop nodes, visual connectors, live run logs.

This is Waffler's IDE. It is not a simplified view — it is the primary interface
for authoring, debugging, and deploying blueprints. The same IDE experience should
work whether Waffler is running:

- As a **desktop application** on a personal PC (via Tauri)
- As a **self-hosted web application** on a local network (HTTP-served `waffler_ui`)
- As a **multi-user server** serving a team or an organization
- On a **Raspberry Pi** or other single-board computer
- On **embedded hardware** or PLC-class devices
- As a component in a **larger platform or infrastructure**

Waffler does not pick one of these deployment targets and optimize for it. The core
must be lightweight enough for embedded use and robust enough for enterprise use.
The same binary, the same package ecosystem, the same blueprint format everywhere.

---

## The Role of `waffler_core`

`waffler_core` is Waffler's kernel. It is responsible for:

- The message bus (inter-component communication backbone)
- Blueprint execution (the runtime)
- Package lifecycle management (install, load, unload, crash recovery)
- The namespace and virtual filesystem
- The security and authorization layer
- The schema and type system
- The expression evaluator
- The storage layer

`waffler_core` is intentionally **domain-neutral and package-agnostic**. It does not
know what HTTP is. It does not know what a database looks like. It does not know what
a WebSocket connection means. These are capabilities provided by packages — the core
only knows how to load packages, communicate with them, and execute blueprints that
use them.

This is not a limitation. It is the foundation of Waffler's flexibility.

---

## The Modularity Principle — And Its Hard Boundary

Waffler is extended through **packages**. A package can add:
- New capabilities usable in blueprints (HTTP, databases, files, hardware, AI, anything)
- New UI components in `waffler_ui`
- New entity types in the namespace
- New schema types
- Middleware for cross-cutting concerns

This means that over time, **the majority of Waffler's useful capabilities will live in
packages**, not in the core. The core provides the infrastructure; packages provide the
value. The sky is genuinely the limit — if a package can do it, Waffler can do it.

### The Hard Boundary: Core Must Not Depend on Packages

This modularity creates a critical design constraint that must never be violated:

> **`waffler_core` must not contain any logic that is specific to, limited to,
> or dependent on any particular package or its internal behavior.**

This is a non-negotiable architectural rule. Specifically:

- Do not add special-case code to `waffler_core` for any package, including first-party
  `syw.*` packages. The core must treat all packages identically.
- Do not import, reference, or inspect a package's internal types or structures from
  within the core.
- Do not add behavior to the core that only makes sense if a specific package is installed.
- Do not add configuration to the core that is only relevant to one package's use case.

**Why:** If the core begins to know about packages, the modularity breaks. The core
becomes entangled with its extensions. Adding a new package now requires touching the
core. Removing a package breaks the core. The system stops being a platform and becomes
a collection of hardcoded integrations — exactly the kind of brittle, closed system that
Waffler is designed to replace.

If you find yourself writing core code that says "if the HTTP package is installed, do X",
that is always a design error. The feature belongs in the package, or in a new capability
that the core exposes as a generic interface that the package implements.

---

## Core Robustness vs. Package Reliability

Packages are external code. They may be:
- Written by third parties with varying quality standards
- Compiled from languages with different safety guarantees (Python, Node.js, Go, etc.)
- Running as child processes that can crash, hang, or produce garbage output
- Native plugins loaded in-process that can segfault or abort
- Deployed in environments the package author did not anticipate

**The core must be designed to survive any package failure.**

Concretely:
- A package crash must not crash `waffler_core`.
- A package that hangs must not deadlock the core's message bus or execution engine.
- A package that returns malformed output must be caught and reported as a capability
  error, not propagated as an internal core error.
- A package that exhausts its allocated resources must be isolated from other packages.
- A package that fails to load must not prevent other packages from loading.

This is not aspirational — it is a baseline requirement. A programming language runtime
that crashes when a third-party library misbehaves is not a usable runtime. Waffler's
core must be to packages what a process scheduler is to processes: the packages may fail;
the kernel does not.

All IPC calls to external packages must have timeouts. All WASM calls must be sandboxed.
All native plugin calls must be wrapped with `catch_unwind`. All process exits must be
detected and the package transitioned to `Failed` state. Blueprint executions that
encounter a package error must produce a structured error result and publish
`execution.finished` — they must never panic or silently stall.

---

## The Target User Spectrum

Waffler's design must work across a very wide range of users:

| User type | What they need |
|---|---|
| **Enterprise / large business** | Reliable multi-user hosting, fine-grained security, audit logs, large-scale automation, custom package development |
| **Small business / team** | Simple self-hosted setup, a useful package library, visual editing without needing to write code |
| **Developer / technical user** | Full extensibility, SDK access, ability to build custom packages in any supported language |
| **Hobbyist / maker** | Works on a Raspberry Pi or small device, low resource footprint, easy to experiment with |
| **Beginner / new to programming** | Visual IDE that teaches programming concepts through execution, clear error messages, low barrier to entry |

These users are not served by different versions of Waffler. They are all served by
the same core, the same package ecosystem, and the same IDE. Design decisions must
not favor one group at the expense of another. A feature that makes Waffler easier
for beginners must not compromise its capability for enterprise users, and vice versa.

---

## What This Means for Every Contributor

Before writing any code in this repository, ask:

1. **Does this belong in the core or in a package?**
   If it is domain-specific logic (HTTP, databases, UI behavior, specific protocol handling),
   it belongs in a package. If it is infrastructure (execution, routing, persistence, security),
   it belongs in the core.

2. **Does this change make the core depend on a specific package?**
   If yes, stop. Rethink the design. The core is the platform; packages are the tenants.

3. **What happens if the package this code interacts with crashes?**
   The core must handle it gracefully. If you cannot describe what happens when the
   package fails, the code is not finished.

4. **Does this work for all deployment targets?**
   A change that assumes a desktop environment, a fast network, or abundant memory
   is wrong for embedded or low-resource deployments. Design for the most constrained
   target unless there is an explicit reason not to.

5. **Does this maintain the visual-programming-language standard?**
   Waffler is not a script runner. Features should enrich the expressiveness of blueprints
   and the quality of the IDE experience, not just add another webhook trigger.

---

## Summary

| Property | Requirement |
|---|---|
| **Waffler is a visual programming language** | The core is a runtime; blueprints are programs; waffler_ui is the IDE |
| **Waffler is a modular automation platform** | All domain capabilities come from packages; the core is domain-neutral |
| **The core must not know about packages** | No package-specific logic, imports, or special cases in waffler_core |
| **The core must survive package failures** | Timeouts, sandboxing, catch_unwind, structured error results — always |
| **Waffler works everywhere** | Desktop, server, Raspberry Pi, embedded — one binary, same behavior |
| **Waffler serves all users** | Enterprise, developer, hobbyist, beginner — same core, same ecosystem |
