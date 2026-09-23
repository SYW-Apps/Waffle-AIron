# Contributing to wairon

The conventions for making a delegated change — never hand-edit `.wai/`, read
every write back, the lock is the human's, measure before repairing, prove a
behaviour by revert without `git checkout` — are **not** in this file. They ship
with the tool, as the **Working conventions** section of the `sdd-implement`
skill (`src/templates/skills/sdd-implement.md`, installed as
`.agents/skills/sdd-implement/SKILL.md` and its siblings). Read them there: they
are true of any wairon project, and the brief-writing half is in `sdd-delegate`.

This file is only what is true of **this repository** and would be wrong to ship
to a wairon user.

---

## Line endings: CRLF in the working tree, LF in the index

Git stores LF and checks out CRLF here. `.gitattributes` pins only `*.sh` to LF
(a CRLF shebang breaks `#!/usr/bin/env bash` on the Linux CI runners).

Most tools that write files emit LF, which turns a three-line change into a
whole-file diff. After any scripted or tool-driven write, normalise the file back
and confirm `git diff --stat` shows only the lines you meant.

**The rule is preserve what the file has, not "make it CRLF".** The heading above
describes the common case, not a uniform one: measured across `src/**/*.ts`, 212
files are CRLF, 52 are LF and 3 are mixed. `install.ps1`, `src/commands/aliases.ts`
and several tests are LF. Because `core.autocrlf` is true, git normalises on the way
in and `git status` reads clean either way, so the difference is invisible until a
scripted edit built for the wrong ending fails to match its anchor — or silently
rewrites the whole file. Detect each file's endings before editing it and write back
what was there.

Most obvious ways to check for carriage returns lie, including one that wraps the correct check:

| Command | What it actually does |
|---|---|
| `grep '\r' f` | In a basic regular expression `\r` is the letter `r`. It matches every line containing an `r`, so an LF-only file "has carriage returns". |
| `grep $'\r' f` | Passes a real CR byte — but grep opens the file in text mode here and strips CR before matching, so it reports **0** on a genuinely CRLF file. |
| `grep -Uc $'\r' f` | Correct. `-U` suppresses the text conversion, so the CR survives to the match. |
| `file f` | Correct. Says `with CRLF line terminators`, or says nothing about them. |
| `x=$(grep -Uc $'\r' f)` | Lies, even though the command inside it is the correct one. Capturing it collapses the lone-CR argument to an empty pattern, which matches every line, so what comes back is the file's **line count** whatever its endings are. Run the check unwrapped, or put the CR in a variable first (`CR=$'\r'; grep -Uc "$CR" f`). |

Two traps for scripted edits specifically:

- **Never let a normaliser touch text that itself contains `\r` or `\n` escapes.**
  A script that rewrites every line ending to CRLF will also rewrite the escape
  sequence you meant to insert, putting a real carriage return inside a string
  literal — which is an unterminated-string parse error, found at build time
  rather than at write time. Build such text with `String.fromCharCode(13)`.
- **A quoted heredoc still loses doubled backslashes here.** `<<'EOF'` keeps a lone
  backslash but collapses `\\` to `\`, so `p.replace(/\\/g, "/")` arrives as
  `p.replace(/\/g, "/")` — an unterminated character class, and a syntax error at run
  time. Write the script with the file-writing tool, or avoid doubled backslashes.

Byte counts show it too: a CRLF file loses exactly one byte per line when it is
flattened, so `wc -c` before and after a rewrite is evidence.

**Four generated files are deliberately LF — do not "fix" them:**

```
.wai/context/domains.md
.wai/context/wairon-guide.md
.wai/docs/topology.md
.wai/rules/topology.yaml
```

---

## Run wairon from this checkout, not the global install

```
npm run build
node dist/cli/index.js <command>
```

A globally installed `wairon` can lag this working tree — including its
validator, so it can pass a tree the code here rejects, or lock one under an
older rule set. The MCP server also runs `dist/`, so build *before* reconnecting
it.

---

## The gates, and today's baseline

| Gate | Baseline |
|---|---|
| `npx tsc --noEmit` | clean |
| `npx vitest run` | 221 files / 3758 tests |
| `npx vitest run --config vitest.e2e.config.ts` | 5 files / 25 tests |
| `npm run build` | clean |
| `node dist/cli/index.js validate` | 0 errors, 0 warnings |
| `node dist/cli/index.js validate --ci` | 0 errors, 0 warnings |

The counts are a floor, not a target — they move as the suite grows, so update
this table when they do. `validate` also prints the **conformance debt register**
(findings carried under `rules.conformance.carried`); it is informational and
does not fail the gate, but a number that moved is a result worth reporting.

Some tests assert on the text of the shipped skill and agent templates
(`tests/core/template-vocabulary.test.ts`, `tests/core/skill-composition.test.ts`).
Changing that text is *supposed* to fail them — that is the assertion doing its
job. Fix it to match the new text; loosening it to match anything removes the one
thing keeping the templates and the validator's vocabulary in step.

A rule's `summary` is spec data, not a code string. `tests/core/rule-catalog.test.ts`
proves the registry's codes and the L3 `findings[].summary` values on
`iheuristic_rules.yaml` (and its siblings) are ONE list, so changing a summary in
the rule file alone fails the suite. Change it through the authoring tools first and
let the code string follow. This catches every contributor who touches a rule's
codes, and the suite is currently the only place that says so.

---

## A stale MCP server

Every `sdd_*` write answers with `staleServer: true`, and a `⚠ STALE SERVER`
banner on the text, when the build on disk changed after the server started —
which is exactly what `npm run build` does mid-session. Restart the MCP session
before editing specs further: a stale process can silently drop fields a newer
schema introduced, and has. For a server old enough not to carry the flag, the
tell is the shape of the answer: a current `sdd_update_spec` returns a structured
change report naming what moved, an old one a single sentence.

---

## Untracked paths are somebody else's work in flight

Run `git status` before you start. This repo regularly carries an uncommitted
design folder under `docs/design/` while an investigation is open (at the time of
writing, `docs/design/chained-subsystems/`). Do not touch, commit, stash, or
clean anything untracked that your task did not name.

---

## Where repo-local guidance lives — and where it cannot

`CLAUDE.md`, `GEMINI.md`, and `.github/copilot-instructions.md` at the repo root
are rewritten wholesale by `wairon generate` (`writeRootGuideDelegator`), and
`.claude/` is gitignored entirely. Neither survives, so neither is a home for
anything a future contributor or agent should inherit. That home is **this file**
— and a brief points at it by name rather than paraphrasing it.

---

## Bugs and questions

Actively developed. Open an issue.
