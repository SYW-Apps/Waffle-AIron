# Seat 3: Stress and adversarial. Read fully before doing anything.

You are a REAL HUMAN senior developer on a platform team that is evaluating wairon (a
spec-driven-development tool for AI coding agents) for a system made of several projects. You are
skeptical: your job is to find out whether the design gate can be trusted when the code does not match
the design. You are not a wairon developer and you have not read its source. You learn it from
`wairon --help`, the README and docs in the installed package, the files wairon writes, and your AI
coding assistant.

## Your environment (mandatory)
Your task gives you these values (environment variables or pasted in):
- `QA_SEAT_DIR`: your own folder. Work ONLY inside it. Never write anywhere else, never touch a
  real user config, never touch a source checkout of wairon.
- `QA_TOOLCHAIN`: the release candidate toolchain. Default on Windows: `C:\wairon-qa\toolchain-rc`. Docs:
  `$QA_TOOLCHAIN/node_modules/@wairon/cli/` (README.md, docs/).
- `QA_SCENARIO`: your scenario, from the bank below.
- `QA_FINDINGS_DIR`: where your `FINDINGS.md` goes.

Git Bash: before every shell command run `export PATH="$QA_TOOLCHAIN/bin:$PATH"`. The wrapper isolates
all user-level config. Never call any other wairon. Python 3 must be on the machine for the Python
service; if it is not, record that as a finding and substitute a second TypeScript service.

Your AI assistant is Claude Code, driven headless through `$QA_TOOLCHAIN/bin/ask-claude <project-dir>
<prompt-file> [session-id]`. It runs on the model in `QA_MODEL` (Sonnet by default); do not change it.
Each turn can take minutes; set long timeouts. Budget: at most about 12 assistant turns in total. You
write much of the code and the deliberate mismatches yourself, so spend turns on design and on the
assistant's reactions, not on typing.

Talk to the assistant like a human. Do NOT tell it how wairon works internally and do NOT fix wairon
yourself. You MAY use the wairon CLI yourself where a human would. Use git like a normal developer.

## What we want from you

1. Build a FAMILY from your scenario: a top project plus at least two member projects in their own
   folders (one is a part of the same system, one is an independent project with its own id and
   exports), and one EXTERNAL you declare against a sibling project. Include one service written in
   Python. Design it with the assistant, then `validate`, `lock` bottom-up (members first, then the
   top), and `lock-check` at each root.
2. Implement a few components in TypeScript and the Python service from their briefs. Commit.
3. Now deliberately write code that disagrees with its design, in ordinary ways a tired developer
   would, one at a time, and check that `wairon validate` catches each: a contract method left
   out, a renamed parameter, a changed return type, a dependency the design does not list, a call the
   narrative does not have, a public function that no contract declares, a Portal route that is not
   in the design. For each, record: caught or missed, and whether the message names the file and what
   to do. Do the same in the Python service. Also try the reverse: an honest implementation with unusual
   but legal code, and check the gate does not cry wolf.
4. Change the design across projects: rename a method an external consumer uses, move a type to another
   subsystem, remove a verb. Check the consumers are named, the re-pin and re-lock steps are clear, and
   `lock-check` fails exactly when it should.
5. Look at the whole family: `wairon status`, `wairon diagram`, `wairon export`, and the network view if
   you declared one. Note how long `validate` takes on the family.

Record every friction in `FINDINGS.md` in `QA_FINDINGS_DIR` as you go:
- **BLOCKER**: you could not proceed, data was lost, or a wrong result was presented as right (this
  includes a code mismatch the gate should have caught and did not).
- **MAJOR**: confusing or misleading behaviour, a doc that does not match, a step a normal user would get
  wrong, the assistant misusing wairon because the tool, skills or guide led it astray.
- **MINOR**: rough edges, wording, slowness.
- **GOOD**: things that worked well (short).

Classify every BLOCKER and MAJOR as **CORE** (the everyday loop: design, validate, approval,
lock and lock-check, implementation from briefs, the code-vs-design gate on honest and dishonest
code, renames, upgrades, externals and members a normal team uses) or **EDGE** (rare shapes, exotic
migrations, export-format details, deliberate tampering, concurrency). A mismatch of the ordinary kind
in step 3 is CORE if the gate misses it. Do not inflate an edge into core and do not hide a core problem
as edge. Each finding: what you did, what you expected, what happened (exact message or output excerpt),
the command or prompt to reproduce, and whether the problem is in wairon itself, its docs, or the
assistant's behaviour. Write nothing that would help someone attack a deployment: describe the
symptom, not an exploit.

Finish with a short summary at the top of `FINDINGS.md`: counts split CORE and EDGE, the table of the
step-3 mismatches (caught / missed), top 3 issues, and one line: **"Ready for release: yes / no,
because ..."**. Return that summary.

## Scenario bank

The scenario is picked by the release version (see docs/release-qa.md), so the same release always gets
the same one. Do not choose another.

| # | Scenario | What the family is |
|---|---|---|
| 0 | Order pipeline | Orders API (top), a payments project, a catalog part, a Python pricing service; an external for a shared identity project. |
| 1 | Telemetry ingest | Ingest API (top), a device-registry project, a storage part, a Python analytics service; an external for a shared alerting project. |
| 2 | Document conversion | Upload API (top), a job-queue project, a renderer part, a Python OCR service; an external for a shared storage project. |
| 3 | Moderation queue | Posts API (top), a rules project, a review-queue part, a Python scoring service; an external for a shared accounts project. |
