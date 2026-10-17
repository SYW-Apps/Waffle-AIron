# Code linkage leaves the approval; the pin gates, live drift is visible

Status: designed spec-first (specs validate with 0 errors), awaiting review and lock. No code yet.

Two changes, both driven by realistic user trials of design-first projects:

1. **Code linkage is not design.** Pointing a spec at the file that realizes it must not reopen the human approval, and a planned path must not be an error.
2. **Externals: the pin gates, live drift is visible.** A consumer whose producer broke must hear about it from plain `validate` and `status`, without the live producer becoming its gate.

Out of scope (a separate reachability redesign follows): mounts/listeners, entries, library surface, networking.

---

## 1. What the trials showed

- Setting `sourcePath` on an approved spec drifted the approval. Every trial re-locked three or four times for designs that did not change; one assistant proposed implementing everything first "so one lock covers it", which is the approval model pushing a team toward big-bang implementation.
- A planned `sourcePath` to a file not written yet was an error (`MISSING_SOURCE_FILE`), and no path at all was a warning (`MISSING_SOURCE_PATH`) that fails `validate --ci`. A design-only tree could not pass CI, and assistants stripped planned paths to get a lock through.
- `updatedAt` sat inside the approved per-spec digest, so a change-and-revert (or any no-op re-save) drifted the lock.
- A live brief's write fence grew only from declared paths, so the first file of a component was outside the fence.
- After a producer broke a used member, the consumer's plain `validate`, `lock-check` and `status` stayed green; only `validate --family` or `externals status` showed it, and `externals status` exited 0 in every state.
- A rename read as a removal on the consumer side (pin snapshot and surface export carried no rename trace).
- Declaring an external meant hand-editing `.wai/project.yaml`; `source: {git, commit}` was refused and `url#commit` produced a raw schema dump that also hid every other external from `externals list`.

---

## 2. Decisions

### D1. Code linkage leaves the approved digest

The approval certifies the design. Code linkage says where the design is realized, which conformance checks in CI. A linkage field is one that says **where or how the design is realized in code rather than what the design is**. Read from the schemas:

| Spec | Field | In the approval? | Why |
|---|---|---|---|
| implementation | `sourcePath` | **out** | the file realizing it; checked by source-file-linkage |
| implementation | `simPath` | **out** | the harness file; checked by integration-sim rules |
| implementation | `injectedParams` | **out** | how the realization's code signature maps to the contract; read only by param conformance |
| implementation | `conformance` (spec-level tier) | **out** | code-conformance tuning, the per-spec twin of `rules.conformance`, which the gate identity already leaves out |
| method implementation | `sourcePath`, `symbol`, `exportedVia`, `conformance` | **out** | code location, code name, export handle, conformance tuning |
| type | `sourcePath`, `symbol`; each method's `sourcePath`, `symbol` | **out** | where the declaration lives in code |
| component | `mounts[].via` | **out** | the router entry exported by the portal's file, held to code by `UNREALIZED_EXPORT_HANDLE` (`portal` and `prefixes` stay: they are design) |
| component | `externalLinks` | **out** | an `implementation` link stands in for a `sourcePath`; an `informative` link is documentation; neither can change a design verdict |
| every spec | `createdAt`, `updatedAt` | **out** | volatile metadata (the gate identity already dropped them; the per-spec digest now does too) |
| implementation | `technologies` | in | the vendor binding is design: `TECH_LEAKAGE` and `VENDOR_NAME_IN_CONTRACT` judge it |
| method implementation | `narrative`, `intent`, `detail`, `calls` | in | the realization's design |
| every spec | `previousIds` / `previousNames` | in | the rename trace is what consumers and generators rely on |
| every spec | `lint.allow` | in | a reviewed exception the approver signs (see fork F3) |
| every spec | `status`, `ext` | in | unchanged by this work |

The projection lives where behaviour over a value's own fields belongs: pure type methods `implementation_spec.designView()`, `type_spec.designView()` and `component_spec.designView()`. Every other kind drops only its timestamps. One definition, used by both the gate identity and the per-spec digests.

### D2. The gate identity hashes the design identity

`state_hash.ownDesign()` digests the bound project's own specs through their design views (algorithm marker `sha256-design`). `gate_identity.compute` stays pure; its algorithm marker now follows the content identity it is handed: `sha256+design+doctrine+inputs+members` for a design identity, the previous `sha256+content+doctrine+inputs+members` for a full-content identity (`state_hash.ownTree`, kept for exactly that). So one function both computes the current gate and recomputes an older lock's identity.

### D3. Per-spec approval digests are design digests

`approval_comparison.captureApprovedSpecs` parses each spec, projects its design view, canonicalizes and digests it; the lock records `specsReading: design`. `diffAgainstApproval` always compares in the reading the record names. Consequences: a `sourcePath` added after implementation is not a "changed spec"; whitespace and no-op re-saves never drift; draft relaxation (settledness) no longer flips because code got linked.

### D4. Lock record format 3, read compatibly — no forced re-lock

- New records: `format: 3`, `stateId` under the design gate algorithm, `specs` in the design reading (`specsReading: design`).
- A format-2 record stays valid as written. `validator_portal.computeGateStateId` returns the current identity and, while the record on disk carries the previous algorithm, also `asRecorded`: the same gate identity recomputed under that algorithm. `core_orchestrator.readLockState` accepts a match on either. An upgrade therefore never fails `lock-check` on an unchanged design.
- `wairon doctor --fix` re-expresses a format-2 record in place when it provably still holds (`record.stateId == gate.asRecorded`): new `stateId`, design-reading `specs`, `format: 3`, and `reexpressed: {at, fromAlgorithm, fromReading, by}`. `lockedAt`/`lockedBy`, the validation and code results and the member pins are kept: the approval stays the approver's, and the record says it was carried forward mechanically. After that, linkage never drifts it.
- A format-2 record whose own identity no longer matches (something it covered moved; possibly only linkage, which is no longer provable) reads stale once. `lock-check` and `status` say exactly that and that one `wairon lock` clears it for good.
- Hosted locks (the admin lock workflow) write format 3 the same way.

### D5. Planned code is a notice; conformance judges once realization has begun

"Realization has begun" is defined once, as a pure method on the code index: `code_index.holdsAny(files)`. An implementation has begun when any file it names (its `sourcePath` or a method's) exists; a type when its own file or a method's exists. A `simPath` harness does not count: it follows the code it wires.

| Situation | Before | After |
|---|---|---|
| Implementation names no file | `MISSING_SOURCE_PATH` warning | `MISSING_SOURCE_PATH` **notice** (unlinked design; declare a planned path now) |
| Named file missing, nothing begun | `MISSING_SOURCE_FILE` error | `SOURCE_FILE_PLANNED` **notice** ("planned, not written yet") |
| Named file missing, realization begun | `MISSING_SOURCE_FILE` error | `MISSING_SOURCE_FILE` error (a broken link) |
| Begun, some contract methods name no file | `MISSING_SOURCE_PATH` warning | `METHOD_SOURCE_PATH_MISSING` warning |
| Type file missing, type not begun | `MISSING_SOURCE_FILE` error | `SOURCE_FILE_PLANNED` notice |
| `simPath` missing, implementation not begun | `SIM_FILE_MISSING` warning | `SOURCE_FILE_PLANNED` notice |
| `simPath` missing, implementation begun | `SIM_FILE_MISSING` warning | unchanged |
| Sim-adopting subsystem, implementation not begun | (already skipped) | skipped, now via `holdsAny` |

Notices never fail `--ci`, so a freshly approved design-only tree is green, and since linkage costs no re-lock, declaring a planned path at design time is free. Because declaring or dropping a path no longer touches the approval, keeping `MISSING_SOURCE_FILE` an error once code exists is cheap to satisfy.

**Opt-in strictness:** `rules.conformance.requireCode: true` reports `MISSING_SOURCE_PATH` and `SOURCE_FILE_PLANNED` at error, naming the setting, for teams whose CI must say "every designed implementation has code". It is code-conformance tuning, so it sits outside the gate identity like the rest of `rules.conformance`. `sddRuleSeverity` overrides still work for finer control. Components with no L4 at all (a shallower `designDepth`) name no code and are not judged.

### D6. Briefs fence planned paths

The owner's/implementer's fence holds every code location its specs name, existing or planned: implementation and method source files, `simPath` harnesses, and the `sourcePath`s of the types its subsystem owns. Planned files are marked `(planned — create it)`. With no location declared, the brief tells the spawning session to declare the planned `sourcePath` now; it costs no re-lock. A planned file's extension also selects the brief's type mapping. (A fence home for tests and shared setup files stays a separate question.)

### D7. The pin gates; live drift is an advisory finding

- The owner gate (`validate`, `lock`, `lock-check`) keeps judging externals against the pin: reproducible.
- New `family_validator.advise` (published as `validator_portal.adviseExternals`) compares each external the run did not compose with its **live** producer, within the request's reach and **offline**, and reports:
  - `EXTERNAL_LIVE_INCOMPATIBLE` (warning, advisory): one per external, naming each moved member and how (changed at signature level; renamed to X; gone), every spec of this project that uses it, and the fix: adapt the uses, then `wairon externals pin <alias>`.
  - `EXTERNAL_DRIFTED` (notice, advisory): the producer moved, nothing used did; re-pin when convenient.
  - `EXTERNAL_LIVE_UNCOMPARED` (notice, advisory): the live producer could not be read (unreachable, unresolved, out of reach, git not fetched offline), so the pin alone judged it. Never presented as a pass, never a failure of the owner gate.
- `ValidationIssue.advisory: true` marks them: printed and counted, but neither `valid` nor `--ci` ever decides on them.
- Plain `validate` (CLI and `sdd_validate_tree`) appends them in their own section; `status` (CLI and `sdd_get_status`) prints an Externals section when anything moved, drifted or could not be compared.
- A family run keeps composing in-reach externals as its gate (`EXTERNAL_INCOMPATIBLE`, error): within one checkout, live is reproducible. Its composed aliases are passed to `advise` so they get no second word.
- **`wairon externals status` is the opt-in live gate:** exit 1 when any external is incompatible, 2 when nothing is incompatible but something could not be compared (never a pass), 0 otherwise, derived from `external_status.health()`. `externals pin` exits 1 when an alias could not be pinned.
- Offline means offline: a git external's head is only resolved by `externals status`/`pin`; plain `validate`/`status` report it not compared, naming that command.

### D8. A rename shows as a rename

- The surface projection carries the producer's rename trace as `formerly` on each contract entry, method and type. It is provenance, not signature: it enters neither `memberDigest` nor `contentDigest`, so no existing pin moves.
- The pin snapshot and `wairon surface export` therefore carry it too.
- The consumer comparison gains `renamed` (`ExternalUseState`) with `renamedTo`: a used name absent live but named by a live entry's `formerly`. It is incompatible like a removal, but the message names the new name. `EXTERNAL_INCOMPATIBLE` (family) and `EXTERNAL_LIVE_INCOMPATIBLE` (advisory) both say "renamed to X".

### D9. Declaring an external is a command

- `wairon externals add <alias> [<source>] [--project] [--ref] [--dir] [--use a,b|*] [--description] [--no-pin] [--dry-run]` and the MCP tool `sdd_add_external` (same fields), through a new workflow Orchestrator `external_declarations` in the surfaces subsystem.
- The source is the one location grammar members use: `../sibling`, `hosted:<id>`, `<git url>`, `<git url>#<commit>`. For an external, `#<commit>` is read as the ref the pin follows (fixed at that commit), so the shorthand that works for members works here.
- Refusals are one sentence naming the accepted form: malformed or taken alias, a source the grammar refuses, `ref`/`dir` beside a non-git source, a non-full commit.
- After writing, the declaration is checked against the producer it reaches: answering to another id, or not exporting a `use` name to this project, removes the declaration again and refuses, naming the id or the closest exported names. An unreadable producer leaves it declared, unpinned, and says why (declaring works offline).
- Pins by default, so the reproducible gate exists from the first validate.
- `.wai/project.yaml` reads `externals.<alias>.source` leniently in either form; a wrong shape, an object naming `commit` ("write `ref: <commit>` or `<url>#<commit>`"), or a refused string is the declaration's problem (`EXTERNAL_UNRESOLVED`), never a configuration that fails to load. `externals list` shows every declared external, the malformed one with its problem.

---

## 3. Codes

| Code | Status | Severity | Meaning |
|---|---|---|---|
| `SOURCE_FILE_PLANNED` | new | notice (error under `requireCode`) | named file not on disk, realization not begun |
| `METHOD_SOURCE_PATH_MISSING` | new | warning | realization begun, some contract methods name no file |
| `EXTERNAL_LIVE_INCOMPATIBLE` | new | warning, advisory | a used member changed/renamed/vanished in the reachable live producer |
| `EXTERNAL_LIVE_UNCOMPARED` | new | notice, advisory | the live producer could not be read; only the pin judged it |
| `MISSING_SOURCE_PATH` | changed | warning → notice (error under `requireCode`) | now only "realization not begun, names no file" |
| `MISSING_SOURCE_FILE` | changed | error (unchanged) | now only once realization has begun |
| `SIM_FILE_MISSING` | changed | warning (unchanged) | now only once the implementation has begun |
| `EXTERNAL_INCOMPATIBLE` | changed message | error (unchanged) | also reports renames with the new name |
| `EXTERNAL_DRIFTED` | reused | notice | also emitted by the advisory pass |
| `MISSING_INTEGRATION_SIM` | unchanged | warning | begun-ness now via `code_index.holdsAny` |

No code is retired. All new and changed codes belong to code-judging rules or to the advisory externals pass, so none enters the gate identity: shipping them stales no lock.

---

## 4. Maintainer forks

- **F1. Recovering already-drifted format-2 locks.** Decided here: compatible reading plus `doctor --fix` re-expression, so an unchanged design never needs a re-lock. Not included: a git-backed proof that spares the one re-lock for a project whose format-2 lock already drifted by linkage only before upgrading. It would recover the approved tree from the commit that last wrote `.wai/lock.json`, check the record's identity over it, and compare design identities. Recommendation: skip it. Those projects are in exactly the state they already re-lock from today, and the proof adds git plumbing to the approval path.
- **F2. Offline by default for plain `validate`/`status`.** Git externals are compared live only by `externals status`/`pin`. The alternative, fetching on every validate, makes validate network-dependent and slow. Recommendation: offline.
- **F3. `lint.allow` entries for code-judged codes.** These stay in the approval as reviewed exceptions. Taking them out would mirror the gate identity's treatment of code-code severity overrides, but the per-spec digest would then need the validator's code-rule registry (a cross-subsystem dependency for `approval_comparison`). Recommendation: keep them in; revisit if allow churn shows up in practice.

---

## 5. Implementation waves

Each wave is one subagent with the live brief of the components named, verified with `npm run build`, the relevant tests, and `sdd_validate_tree` (the warnings it closes are listed). Rebuild and reconnect the MCP server after each merge-worthy wave: a stale server corrupts writes.

**Wave 1: design view and identity** (sdd_core, sdd_validator; no behaviour change visible yet)
- `designView` on `ImplementationSpec`, `TypeSpec`, `ComponentSpec` in `src/models/specs.ts`, with one table of linkage fields and a unit test that every schema field is classified (a new schema field must be placed in or out, like the MCP re-authoring field-coverage test).
- `state_hash.ownDesign` (`computeOwnDesignStateId`); `approval_portal.computeOwnDesignId`; `validator_core_adapter.computeOwnDesignId`.
- `gate_identity.compute` marker follows the content algorithm; `spec_validator.computeGateStateId` uses the design identity and adds `asRecorded` for a format-2 record; `StateId.asRecorded`; `readLockState` accepts it.
- Tests: statehash determinism (linkage-only edits don't move `ownDesign`); gate identity before/after; a format-2 fixture lock stays `locked` after upgrade.

**Wave 2: lock format 3 and re-expression** (sdd_core, sdd_cli, sdd_host)
- `LockRecord.specsReading`, `reexpressed`, `format: 3`; `captureApprovedSpecs` design digests; `diffAgainstApproval` per reading; `approval_comparison.reexpress` + portal forward.
- `cli_lock_adapter.lockTree` writes format 3; `reexpressApproval`; `runDoctor` step; admin lock writes format 3.
- `approvalVerdict`/`checkApproval` wording for format-2 holds/stale.
- Tests: lock → add `sourcePath` → `lock-check` green, `status` "no spec has changed"; change-and-revert no drift; format-2 → `doctor --fix` → format 3 with `reexpressed`, `lockedBy` unchanged; format-2 drifted → one re-lock message.

**Wave 3: planned code and fences** (sdd_validator conformance rules, sdd_core agent resolver, models)
- `code_index.holdsAny`; source-file-linkage, type-realization, integration-sim-file, integration-sim-declaration per D5; `rules.conformance.requireCode`.
- `agent_resolver`: fence includes planned files, simPaths and owned types' files; planned marking; empty-fence message.
- Rule-matrix fixtures for each new/changed code (fire + control); design-only fixture passes `validate --ci`.
- Then set `sourcePath` on `external_declarations_impl` (planned `src/core/external-declarations.ts`).

**Wave 4: externals live drift and renames** (sdd_surfaces, sdd_core external producers, sdd_validator, sdd_cli, sdd_mcp)
- `offline` through `resolveDeclared` → `resolveExternals` → `getExternalsStatus` (portal, orchestrator, validator adapter).
- `formerly` in the surface projection (outside digests); `renamed`/`renamedTo` in the status comparison; `EXTERNAL_INCOMPATIBLE` message.
- `family_validator.advise` + `validator_portal.adviseExternals` + CLI/MCP adapter forwards; `ValidationIssue.advisory`; `--ci` ignores advisory.
- `runValidation`, `localStatus`, MCP `validateTree`/`getStatus` append the advisory section.
- `externals status` exit codes 0/1/2; `externals pin` exit 1 on failure.
- Tests: the trial scenario (producer renames a method and changes a signature): plain `validate` shows the advisory warning naming "renamed to X", `--ci` stays green, `externals status` exits 1, `--family` unchanged.

**Wave 5: declaring externals** (sdd_surfaces, sdd_core config, sdd_cli, sdd_mcp)
- Lenient `externals.<alias>.source` reading (string or object; problems, never a load failure); `#<commit>` as a ref.
- `external_declarations.declare`; `surfaces_core_adapter.declareExternal/removeExternal`; `surface_portal.declareExternal`; `externals add` CLI; `sdd_add_external` MCP tool (hosted: classify as a tree-scoped write in the data-plane tool table).
- Tests: each refusal's sentence; producer id mismatch compensates; unexported `use` compensates with closest names; offline declare; `--dry-run`.

**Wave 6: docs and skills**
- Guide (`src/utils/ai-guide.ts`) and shipped skills (`sdd-implement`, `sdd-delegate`, `sdd-architect`): declare planned `sourcePath`s at design time; linkage is not approved; what `requireCode` does; the externals story (pin gates, advisory live drift, `externals status` as the live CI gate with its exit codes, `externals add`); README CI step (`lock-check --strict` + `validate --ci`, optionally `externals status`).
- `wairon rules list` picks up the new codes from the rule registry.
