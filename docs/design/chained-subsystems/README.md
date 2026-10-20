# Chained subsystems — design investigation

**Status:** open · started 2026-09-12 · baseline `dev` at v5.1.1-dev.11 · stage 1 merged in #69 (v5.1.1-dev.13) · stage 2 decided, in design

A subsystem in wairon can be a whole project of its own (`projectPath`), loaded by its
parent as part of one system while also standing alone as its own root. Users work at
both scopes, locally and hosted, and several capabilities give different answers
depending on which root they run from. This folder collects the problem, independent
analyses, proposals and, eventually, the decision.

## Files

| Path | What it is |
|---|---|
| [`problem.md`](problem.md) | The self-contained problem statement: current behavior, issues 00–10, commitments. |
| [`prompt.md`](prompt.md) | The instructions to paste to an outside agent, before `problem.md`. |
| [`synthesis.md`](synthesis.md) | The lead review across all four analyses (v2, against `dev` e7d30d7): what changed since v1, models side by side, convergence and divergence with verdicts, per-issue directions, a recommended model, staging, risks, the decisions only the maintainer can make, and every claim checked against the code. The document to decide from. |
| [`decisions.md`](decisions.md) | The maintainer's decisions in the order taken, with the reasoning wherever one departs from the synthesis — including decision 9, reframed to export-only consumption between projects. |
| [`stage-2.md`](stage-2.md) | The plan for stage 2 — identity, exports and declared externals: formats, findings, the plan-first migration and the properties that prove it. |
| [`synthesis-v1.md`](synthesis-v1.md) | The first synthesis, written from three answers against the `fix/chaining-verdicts-confinement` branch before the repository-backed Astra review existed. Superseded by `synthesis.md`; kept for provenance. |
| `issues/<id>-<slug>/README.md` | One issue: a summary, the evidence in this repository, and an index of analyses and proposals. |
| `issues/<id>-<slug>/analyses/<source>.md` | One source's analysis of that issue. |
| `issues/<id>-<slug>/proposals/<slug>.md` | A candidate solution worth developing, possibly drawn from several analyses. |
| `responses/<source>.md` | A full response exactly as received, kept for provenance. |

## Issues

| Id | Issue | Status |
|---|---|---|
| 00 | [The model: what a chained subsystem is](issues/00-the-model/README.md) | partly decided |
| 01 | [Mount and realization: two specs for one subsystem](issues/01-mount-and-realization/README.md) | partly decided |
| 02 | [Identity and references across roots](issues/02-identity-and-references/README.md) | decided (stage 2) |
| 03 | [Governance: whose rules judge a child's specs](issues/03-governance/README.md) | open |
| 04 | [One edge, one verdict](issues/04-one-edge-one-verdict/README.md) | partly decided |
| 05 | [Contracts across the boundary: pins and freshness](issues/05-contracts-and-pins/README.md) | decided (stages 1–2) |
| 06 | [Working from the child's own root](issues/06-the-childs-own-root/README.md) | open |
| 07 | [Approval across a family](issues/07-approval-across-a-family/README.md) | partly decided |
| 08 | [Repository layouts and version control](issues/08-repository-layouts/README.md) | open |
| 09 | [Hosted: a child as a project, a part, or both](issues/09-hosted/README.md) | partly decided |
| 10 | [Migrations](issues/10-migrations/README.md) | partly decided |

## Adding a response

1. Save the full response as `responses/<source>.md` — for example
   `responses/gpt-6-astra.md` — with a first line naming the model, the date and the
   prompt revision used. **Suffix convention:** a `_chat` suffix (`<source>_chat.md`) marks
   an answer produced in a chat *without* repository access; no suffix marks a
   repository-backed review. A second rendering of the same answer (for example the chat
   text beside a generated file) takes a further `_response` suffix.
2. For each issue it addresses, put that section in
   `issues/<id>-<slug>/analyses/<source>.md` (same suffix as the response file), and add a
   line to the issue's **Analyses** list, labelled `(chat)` or `(repository)`. A response's
   model section and worked example belong under issue 00; a repository-backed review's
   scope, corrections and probes go under issue 00 too, and each correction or probe is
   also filed under the issue it concerns. Confinement findings are filed at design level
   only — never path-escape mechanics, bypasses or reproduction steps — and the provenance
   header says when a summary stands in for the source text.
3. When a solution is worth developing, write it up in
   `issues/<id>-<slug>/proposals/<slug>.md`, crediting the analyses it draws on.
4. Record a decision in the issue's **Decision** section only once it is made.

Keep analyses independent: an outside agent receives only `prompt.md` and `problem.md`,
never other sources' analyses.

## Revisions of `problem.md`

- **r1** (2026-09-12) — initial statement. Answered by: Fable 5.1.
- **r2** (2026-09-12) — corrections from Fable 5.1's code check (`responses/fable-5.1.md`
  § Corrections): resolving through the parent can soften a child's own findings; what a
  parent lock writes into a child; first-hit pin matching and silent `super::` clamping;
  one-level approval pins. Answered by: ChatGPT 5.6 Sol (`responses/chatgpt-5.6-sol_chat.md`)
  and ChatGPT 6 Astra (`responses/chatgpt-6-astra_chat.md`, with the chat text in
  `responses/chatgpt-6-astra_chat_response.md`), both without repository access; those
  three answers are reviewed together in [`synthesis-v1.md`](synthesis-v1.md), written
  against the `fix/chaining-verdicts-confinement` branch. Also answered by ChatGPT 6 Astra
  **with repository access** (`responses/chatgpt-6-astra.md`, via Codex on `dev` at
  `e7d30d7`, after PR #68 merged), with corrections to the statement and eight
  characterization probes. All four answers are reviewed in [`synthesis.md`](synthesis.md)
  (v2), which supersedes v1.
