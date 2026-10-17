# QA verdicts

One short file per release, `qa/verdicts/<version>.md`, committed on dev after the release candidate
(RC) passed the gate in `docs/release-qa.md`. CI (`qa/scripts/check-verdict.mjs`) reads it on pull
requests into main.

The repository is public. A verdict holds counts and names of limitations a user should know about,
nothing else: no exploit details, no internal-only names, no paths on anyone's machine. The full
FINDINGS files stay outside the repository.

## Format

YAML front matter, then a short body.

```
---
version: 6.0.0
rc: 0123456789abcdef0123456789abcdef01234567
date: 2026-10-20
seats:
  - { seat: upgrader,   scenario: "2 Ticket sales",        model: sonnet, result: pass, blockers: 0, coreMajors: 0, edgeMajors: 1 }
  - { seat: newcomer,   scenario: "2 Library desk",        model: sonnet, result: pass, blockers: 0, coreMajors: 0, edgeMajors: 0 }
  - { seat: stress,     scenario: "2 Document conversion", model: sonnet, result: pass, blockers: 0, coreMajors: 0, edgeMajors: 2 }
  - { seat: hosted,     scenario: "0 Team knowledge base", model: sonnet, result: pass, blockers: 0, coreMajors: 0, edgeMajors: 0 }
checklist: pass
result: PASS
knownLimitations:
  - "One-line description of an EDGE major that ships unfixed (also listed in the CHANGELOG)."
---
Three or four lines: what ran, what was fixed on the way (one line per fix round, no more), and
anything the next release's panel should look at first.
```

## Fields

| Field | Meaning |
|---|---|
| `version` | The release version, as in the CHANGELOG. It also picked each seat's scenario. |
| `rc` | The full 40-character sha of the RC: the dev commit the whole panel ran against, after the last fix. |
| `date` | The day the last seat finished. |
| `seats` | One entry per seat that ran. `seat` is `upgrader`, `newcomer`, `stress` or `hosted`. `scenario` is the bank number and name. `model` is the model the persona agent and the inner assistant ran on. `result` is `pass` when the seat's final run had 0 blockers and 0 core majors. The counts are the seat's last run. Leave `hosted` out when it did not run, and say why in the body. |
| `checklist` | `pass` when `qa/scripts/release-checklist.sh` passed on the RC toolchain. |
| `result` | `PASS` when every listed seat passed, the checklist passed, and every edge major is either fixed or in `knownLimitations`. Otherwise `FAIL`. |
| `knownLimitations` | The edge majors that ship unfixed, one line each, matching the CHANGELOG. Empty list when none. |

## What CI checks

A pull request into main passes the "Release QA verdict" job when a verdict file has `result: PASS`,
its `rc` is an ancestor of the pull request head, and nothing shipped (`src/`, `web/`, `sdk/`,
`schemas/`, `templates`, `package.json`, `package-lock.json`) changed between `rc` and the head. Lock
records, docs, the CHANGELOG, `qa/` and regenerated `.wai/` context may change after the RC. Anything
else means the QA runs again on a new RC.
