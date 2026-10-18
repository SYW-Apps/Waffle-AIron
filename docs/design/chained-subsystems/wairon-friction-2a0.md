# Wairon friction met while authoring 2a-0 (unverified proposals — the user decides)

## F1. Nested `[]` does not clear, yet the write reports success
- `sdd_update_spec` implementation `core_orchestrator_impl`, delta
  `{"methods":[{"name":"createChainedSubsystem","narrative":[]}]}` → "Successfully updated", file unchanged.
- The tool description promises "pass [] to clear any array outright".
- Hit again in the rule fixes (wiring agent): `{"methods":[{"name":"dependencyCycles","narrative":[]}]}` reported
  success and kept all 11 steps. The workaround, deleting the method and adding it back, moved `dependencyCycles` to
  the end of `wiring_rules_impl.yaml`, out of its interface's order.

## F2. Step-level `unset` is a silent no-op
- Delta `{"methods":[{"name":"createChainedSubsystem","narrative":[{"stepNumber":7,"unset":["condition","onTrueStep","onFalseStep"]}]}]}`
  → "Successfully updated", file unchanged. `unset` is documented only at spec level.

## F3. Changing a step's type keeps the old type's fields
- Upsert by `stepNumber` merges fields; a branch rewritten as a local kept `condition`/`onTrueStep`/`onFalseStep`
  (→ MALFORMED_FLOW_STEP), and a call rewritten as a branch kept `outcome`.

## F4. No rule catches a field that belongs to another step type
- `outcome` (return-only) on a branch step: validator silent. MALFORMED_FLOW_STEP only covers flow config on non-flow steps.

## F5. The project binding has no modeled home
- `project_config_repository.specsDir` is called by the composition root (CLI start, MCP server start, hosted
  binding) — not a modeled component, so it needs `invokedBy: runtime`. Honest today; noted only.

## F6. The call-step check can't see a half-finished migration (reported by the consumers agent)
- CALL_STEP_UNREALIZED matches callees by NAME. The old direct reader in `src/config/loader.ts` is also called
  `loadProjectConfig`, so every new `core_portal.loadProjectConfig` step already counts as realized by the direct file
  read. A migration that is only half done passes the gate.
- Mitigation inside 2a-0: the code migration deletes `loader.ts`'s `loadProjectConfig`/`saveProjectConfig`, so leftovers
  fail to compile.
- Proposal: resolve a call step's callee by import origin (the module that exports the target component), not by name.

## F7. The order in which one delta applies is undocumented (reported by the consumers agent)
- Inserting a step and editing a later step in the same delta: the application order isn't documented, so agents split
  deltas into separate calls. Proposal: document array-order application, or accept labels in update deltas.

## F8. Method-level `action: delete` works; nested clears don't (contrast to F1/F2)
- Deleting `setGlobalPacksEnabled` from 8 specs with `{"name": ..., "action": "delete"}` landed every time. The silent
  no-op is specific to nested `[]` and step-level `unset`.

## Evidence for F3/F4: scan of the whole tree (2026-09-13, scratchpad/stale-step-fields.cjs)
206 implementations, 7 steps carry another type's fields, none flagged by the validator:
- admin_orchestrator_impl.executeApprovedLock step 11 (call): outcome
- admin_orchestrator_impl.lockProject step 15 (call): outcome
- cli_packs_adapter_impl.installPack step 3 (local): targetComponent, targetMethod
- cli_runner_impl.runRemote step 7 (call): error
- cli_runner_impl.runRemote step 13 (throw): targetComponent, targetMethod
- cli_runner_impl.runLogin step 3 (local): targetComponent, targetMethod
- surface_exchange_orchestrator_impl.exportProjectSurface step 7 (branch): outcome
Not config-related: fix with the P2/P3 tooling change, not in 2a-0.

## F9. A step delete by number has no guard (consumers agent)
- Delete is refused only when the step is a jump target; a wrong number deletes the wrong step silently.
- Proposal: let a delete name the step's label or expected description, refused on mismatch.

## F10. Intent-only methods keep their calls out of the graph (consumers agent)
- usePack/unusePack/bundlePack reached their registry writes only in prose, so usage and call-graph conformance could
  not see them. Fixed in 2a-0 with calls-only narratives. Proposal: a structured `calls:` list on intent methods, or a
  lint when an intent names a dependency method no step calls.

## F11. A dispatch-hub Orchestrator has one sourcePath (consumers agent)
- cli_runner_impl points at src/cli/index.ts, but the runSubsystem* commands live in src/commands/subsystem.ts, so their
  call steps are not checked at all (the execution commands only avoid this by conformance: off).
- Proposal: a per-method `sourcePath` override beside `symbol`.

## F12. Nested `params` replace wholesale, and a delete marker becomes a param (sdd_host agent)
- A `{name, action: delete}` element inside `params` was written as a literal parameter, failing with the confusing
  `params.0.type: Required`. Proposal: upsert params by name like other identity arrays, or document the replace.

## F13. No nullable parameter types (sdd_host agent)
- `ProjectConfig | null` cannot be a param type, so "no configuration" was modelled as `optional: true`. Proposal: allow
  a `nullable: true` flag or `T | null` in param types, matching what `returns` already allows.

## F14. Restructuring flow steps in `update_spec` (sdd_host agent + my own use)
- Later inserts in one delta relocate the jumps of steps inserted earlier in the same delta; deleting a run repeats the
  same stepNumber; matched steps merge shallowly.
- Labels DO work in update_spec deltas (my insert with `onFalseLabel: bootstrap_l0` resolved to the right number), but
  the tool description never says so; the agents did not know. Proposal: document labels in update_spec, and add a
  per-method narrative replace for restructuring.

## F15. New specs always start as draft (sdd_host agent)
- `sdd_add_component`, `sdd_define_interface` and `sdd_write_narrative` take no `status`, so already-approved content
  moved into a new component needed three extra `update_spec` calls to mark it complete. Proposal: a `status` parameter.

## F16. No method-move operation (sdd_host agent)
- Splitting exposure policy out meant re-sending two contracts and narratives by hand, then deep-comparing against HEAD to
  prove nothing changed. Proposal: a tool that moves methods between components (contract + narrative + status) and
  re-points callers' call steps.

## F17. Source files no spec names belong to no owner (topology gap, found when delegating 2a-0 code)
- An owner brief's ownedPaths come only from spec sourcePaths. `src/core/provision.ts` (core_orchestrator's provision,
  chained create and externalize code), `src/config/loader.ts`, `src/core/context.ts` and `src/core/authoring.ts` are
  named by no implementation, so no agent's write fence covers them — and structural conformance never reports a source
  file that no spec claims.
- Workaround in 2a-0: the lead extended the sdd_core owner's fence to those four files, explicitly, for wave 1. A fifth
  surfaced mid-wave: `src/index.ts`, the public library barrel, whose star re-exports collided (TS2308) once the core
  surface gained `loadProjectConfig` — the agent stopped at its fence and asked, as it should.
- Proposal: an `UNCLAIMED_SOURCE_FILE` notice for files under a subsystem's source roots that no sourcePath names, and
  extra claimed files on an implementation (`sourcePaths: [...]`, related to F11's per-method sourcePath) so an
  orchestrator whose code spans files (core_orchestrator: specs.ts + provision.ts) is fenced and checked.

## F18. `lint.allow` is per code, not per edge (wave-1 agent)
- diagram_specialist_impl's UNDECLARED_DEPENDENCY allow was written for its direct validateSddTree call; the new
  diagram.ts → project_config_repository edge slipped under it silently. Proposal: an allow may name its target
  (`{ code, target, reason }`), and an allow whose reason does not cover a newly matched edge is reported.

## F19. N:1 source files hide calls between their own members (wave-1 agent)
- Five components share src/config/project-config.ts; the index called a private store helper no contract covered, and
  no check noticed. Proposal: a lint for calls between co-located members that no member contract covers.

## F20. Validation cannot see a worktree
- The MCP server reads the main checkout, so worktree agents cannot run sdd_validate_tree on their own changes; the lead
  validates only after integration. Proposal: a `root` override on sdd_validate_tree (read-only, confined to worktrees of
  the bound repository).

## F21. Aliased imports hide call steps (cli agent)
- Source analysis records the name used at the call site, not the imported name: `setExecutionTier as
  writeExecutionTier` would not satisfy `cli_core_adapter.setExecutionTier`. Proposal: record aliases under the imported
  name too.

## F22. A method with no function body in its sourcePath is skipped silently (cli agent)
- cli_runner_impl's runInit/runGenerate/runExecution*/runSubsystem* live in src/commands/*.ts while the impl points at
  src/cli/index.ts; the call check finds no function and continues, reporting nothing. Proposal: a notice for an
  exact-grade method with no body found, plus per-method sourcePath (F11).

## F23. A call step cannot target a type method (host agent)
- `declaredPackNames`/`declaredProfileIds` are project_config type methods; hosted code had to forward them on hostCore,
  which ihost_core_adapter's contract cannot name. Proposal: call steps (and adapter contracts) may reference
  `<type>.<method>` for pure type behaviour.

## F24. Tests are outside the typecheck (host agent)
- tsconfig excludes tests, so a deleted export fails only at test runtime. Proposal: typecheck tests in CI.

## F25. A spec pass does not say which existing tests it changes (host agent)
- Eight hosted tests encoded behaviour the committed specs changed; nothing in the spec pass listed them, so a
  "keep existing tests green" brief collided with the spec. Proposal: authoring tools report tests referencing a changed
  or deleted method (by symbol) as "tests to revisit".

## F26. sdd_get_spec output overflows on large implementations (host agent)
- project_policy_orchestrator_impl (55 KB) overflowed the tool output. Proposal: a method filter on sdd_get_spec.

## F27. Commit messages with double quotes break on Windows PowerShell 5.1 (environment, not wairon — hit twice)
- `git commit -m @'…"quoted"…'@` — PowerShell 5.1 re-quotes native arguments and splits the message at embedded double
  quotes, passing the pieces to git as pathspecs; nothing is committed. Workaround: `git commit -F <message file>`, or no
  double quotes in the message. Candidate for the delegation briefs' commit instructions (sdd-delegate / sdd-implement).

## F28. UNUSED_TYPE ignores a type's own method signatures (found authoring PR A's L3)
- `spec_delta_application` is the return type of `spec_delta.applyTo`, yet UNUSED_TYPE flags it: the rule scans type
  fields and interface method signatures only (`src/core/rules/graph.ts:340-364`), never the methods declared on types.
  Proposal: scan type method signatures and returns too; a type naming only itself in its own methods stays unused.

## F29. Method-level `unset` is silently dropped too (found linking wairon's own methods, schema PR)
- `sdd_update_spec` on `cli_runner_impl` with `{ methods: [{ name: runMcpInstall, unset: [sourcePath] }] }` answered
  "Successfully updated", and the method's `sourcePath` stayed on disk. Same class as F2 (step-level `unset`); A2's
  "`unset` works at every level" covers it. Until PR A lands, the only way to drop a method field is to restate the
  method or re-author the implementation.

## F30. Deleting the last lint allow leaves an empty `lint` block (found authoring the rule model's L3)
`sdd_update_spec` on type `rule_context` with `{"lint": {"allow": [{"code": "UNUSED_TYPE", "action": "delete"}]}}`
removed the allow but left `lint:\n  allow: []` in the file, and the write reported plain success. Removing the empty
block took a second write, `{"unset": ["lint"]}` (spec-level `unset` works; verified on disk). Harmless to validation,
but a reader sees a lint block that suppresses nothing. **Proposal:** when a delete empties an optional container, drop
the container; failing that, the write result says it is now empty (A1: a write reports what it changed).
**Decided (maintainer, 2026-09-14):** when a delete removes the last element of an optional array, the write removes
the property — an empty array only confuses a reader or triggers warnings. Folded into A2. Hit again on 2026-09-15:
deleting `spec_validator_impl`'s only allow left `lint: allow: []`, removed with a second `unset`.

## F31. `sdd_validate_tree` cannot narrow to one spec (rule model L4/L5, conformance agent)
Eight agents wrote the eight rule families at once, and each ran `sdd_validate_tree` with `subsystem: sdd_validator`.
Every result carried every sibling's in-progress findings, so each agent scanned for its own spec ids by hand.
**Proposal:** an optional `specIds` filter (the spec and its implementation/contract ids) applied after validation, the
same way the subsystem scope filters findings today; the whole tree is still loaded, so cross-spec rules stay correct.

## F32. A branch that continues a loop is undocumented (rule model L4/L5, conformance agent)
The sdd-narrative skill shows only a `jump` to continue a loop. A `branch` whose false path targets the enclosing loop
header works — the flow lint exempts it (`src/core/rules/narrative-flow.ts:341`) — and saves a step per `continue`,
but an author only finds that in the rule's code. **Proposal:** the skill documents both forms, with when to prefer each.
The same authors also found, by trial, that a jump from an outer loop to a step that closes several nested loops at
once reads as JUMP_INTO_REGION; the fix is a distinct closing step per loop level, which belongs in the same section.

## F33. The prose-claims lint fires on text that names a value or quotes a message (rule model L4/L5)
`UNREALIZED_CLAIM` matches `persist(s|ed|ent)?`, `durabl[ey]`, `survives restart`, `written to disk` and `registered
into` in any `local` step of a logic component with no data-layer edge (`src/core/rules/semantic-edges.ts:444-495`).
Two validator narratives tripped it without claiming anything: `intrinsic_rules.durabilityDeclaration` names the
`durable` durability value while describing the `MISSING_DURABILITY` message, and `doctrine_rules.patternOwnership`
paraphrased the `REGISTRY_WITHOUT_STORE` message ("persisted state"), which its author reworded away from the message.
**Proposal:** the lint skips text inside quotes or backticks, so a narrative can name a value or quote a message; a
claim still has to be made in the step's own words to fire.

## F34. Adding a labeled method through `sdd_update_spec` can report its own labels as unknown (integrity agent)
Reported call: `sdd_update_spec` on `integrity_rules_impl` with `delta.methods: [{ name: "namespaceHygiene", sourcePath,
symbol, narrative: [...] }]`, the narrative using `label`, `onFalseLabel` and `endLabel`. The write was refused with
`onFalseLabel references unknown label "nsSubEnd" (declared: ..., nsSubEnd, ...)` — the label named as unknown is in the
declared list. Nothing was saved; the agent re-authored the whole spec with `sdd_write_narrative`, which resolved the
same labels. The same day a new labeled method (`spec_validator_impl.validateComponentCandidate`, forward `onFalseLabel`
and `endLabel`) was added through `sdd_update_spec` without error, so the trigger is narrower — not yet reproduced.
**Proposal:** reproduce in PR A's tests (a method upserted into an implementation that already holds it, labels
referenced before declaration) and fix the resolution order; the refusal message should never contradict itself.

## F35. Appending narrative steps has no documented form (rule fixes, doctrine agent)
To add steps 48–52 at the end of `doctrine_rules.patternOwnership`, the agent found that several `action: 'insert'`
steps in one delta move a new loop's own `endStep` as later inserts shift numbers. Sending the new steps as plain upserts
with unused step numbers appended them correctly — but the tool description documents only insert and delete, so the
working form was found by trial. **Proposal:** document append (an upsert whose stepNumber is past the end appends, jumps
resolved after all steps are placed), or accept `action: 'append'`; in either case resolve the delta's labels and jump
fields against the final numbering, not step by step.

## F36. `captureJumps` also captures a loop's own continue jump (rule fixes, wiring agent)
Inserting a step at 27 in `wiring_rules.dispatchTables` with `captureJumps: true` rightly retargeted the entry jump
from step 24 onto the new step. It also captured a continue jump inside the loop body (`onFalseStep: 27`, pointing at
the loop header), which should have followed the header to 28; the agent fixed it by hand. **Proposal:** capture only
jumps from before the insertion point that enter it, never a backward jump to a loop header from inside that loop;
and have the NOTICE list the jumps it captured, so a wrong capture is visible without reading the file back.

## F37. Conformance cannot tell a spec-first change from drift (D1 layer 4/5, core and gate-identity agents)
While narratives lead code, CALL_STEP_UNREALIZED, UNREALIZED_DEPENDENCY and an UNDECLARED_DEPENDENCY exposed by removing an allow all look exactly like real drift. The receiver is ignored too: `admin.ts` already calls a function named `computeGateStateId`, so moving the step from `host_core_adapter` to `host_validator_adapter` raised nothing. **Proposal:** mark a conformance finding as draft context when its method's spec changed since the lock, as missing-source findings on drafts already are; and match a call's receiver where exact-grade analysis resolves it (PR B, B1).

## F38. `validate`'s tip line quotes a real finding code (D1 wave 2 agent)
When validation fails, the closing tip suggests overriding a severity, using `rules.sddRuleSeverity.CIRCULAR_DEPENDENCY` as its example. A script that counts findings by grepping for codes then counts one CIRCULAR_DEPENDENCY that is not a finding. **Proposal:** keep example codes out of the tip (say "a finding code"), or print the tip on stderr, apart from the findings.

## F39. A severity override naming an unknown code is silently ignored (D1 CHANGELOG)
Nothing checks `rules.sddRuleSeverity` keys against the registered codes: `src/core/rules/index.ts:487` only looks a code up. D1 retires `ARCHITECTURE_VIOLATION_SPECIALIST_DEP`, which the unreleased Specialist-matrix entry told users to retune there, so a project that followed that advice keeps a dead entry and nothing says so. A misspelt code is just as silent. `lint.allow` already reports the same mistake as `UNKNOWN_LINT_ALLOW_CODE`. **Proposal:** an integrity finding (warning) for a `sddRuleSeverity` key, in the project config or a profile, that no registered rule or loaded pack emits; spec first, in D2 or the next rule-fixes pass.

## F40. A rename shows in the approval view as deletions and additions (D1 wave 6, tree agent)
`sdd_rename_component` moves each spec to a new path and leaves `.wai/lock.json` alone, as its contract says. The 14 renames therefore read as 42 removed and 42 new specs, which hides that their content barely changed. **Proposal:** the approval diff pairs a removed path with an added one when a rename links them, and shows a move with its content diff.

## F41. Reference rewrites keep a spec's old `updatedAt` (D1 wave 6, tree agent)
`rewriteRefFields` and `rebaseImplementationPaths` in `src/core/provision.ts` write raw YAML without stamping `updatedAt`, while `patchSubsystemIndex` stamps it and the save path stamps every real edit. After the renames, `tree_transfer_orchestrator` still says 2026-08-12. The rewriter predates D1, and subsystem moves use it too. **Proposal:** stamp `updatedAt` on every raw rewrite that changes a spec, spec first, in PR A.

## F42. The rename report's `rewritten` drops each spec's kind (D1 wave 6, tree agent)
`rewritten` is a list of bare ids, so the type `pack_scaffold_request` sits among components and implementations, and a type sharing an id with a component would be ambiguous. The internal result already carries `{kind, id}`. **Proposal:** return `{kind, id}`, as `renamed` does (an L3 change to `component_rename`).

## F43. A rename does not report prose that names the old component (D1 wave 6, tree agent)
About 110 prose lines named renamed components in words ("auth specialist", "the permission resolver"), and one lint reason named an old id; the agent found them by grep. **Proposal:** a read-only `mentions` list in the report, naming the specs whose text contains the old id or its spaced form.

## F44. Display names need a second write per spec (D1 wave 6, tree agent)
The rename leaves `name` alone by contract, which cost 42 extra writes. **Proposal:** an optional `name` that sets the component's name and derives "<name> Interface" and "<name> Implementation" for the specs that move with it.

## F45. Changing one phrase rewrites the whole text field (D1 wave 6, tree agent)
`sdd_update_spec` replaces a text field whole, so a one-phrase change to a ~2KB description is rebuilt by hand, and silent drift is possible. **Proposal:** a `str_replace` delta (field, old string, new string) that must match exactly once.

## F46. `sdd_get_spec` only returns a whole spec (D1 wave 6, tree agent)
`identity_orchestrator_impl` read back at 57KB and spilled to a file, so the agent verified it by grep. **Proposal:** let `sdd_get_spec` select fields or methods; related to F26.

## Doctrine notes met in the hosted migration (for the user's decision)
- `operations_orchestrator` crossed GOD_COMPONENT/EXCESSIVE_DEPENDENCIES (11 > 10) with the config edge. The rule caught
  a real second responsibility: exposure-policy administration (the component's only write) uses policy_repository and
  audit_repository, which the read-only health/usage/quota workflows never touch.
- `pack_registry.readProjectReferences(projectId, config?)` is now a pure derivation that reads no storage — a method on
  a Store that is not storage.

## Spec gaps found (not friction, pre-existing)
- `src/core/approver.ts` (local approver identity) has no component of its own. Its header named an "Approver Identity Specialist", which no spec defines. Only `core_portal.localApprover` re-exports it (found by the D1 leftovers agent). Candidate for track D: model the approver identity as a pure or read Orchestrator in sdd_core, or record that the portal step is its only spec.
- `execution show` topology/budget derivation (`deriveExecutionProfile`, `resolveBudget`) has no spec; modelled as local
  steps. Candidate: a core portal read `resolveExecutionAllowances()` plus the component that owns budget derivation.
- `ispec_validator.validateSddTree()` declares no params; the code receives rules and projectType from its caller.
- The `removePack` intent said a missing pack is not an error; the narrative and code exit with code 1 (fixed in 2a-0).
- `ivalidator_portal.validateAsComplete()` declares no params, but the code takes `options?: ValidationOptions` (rules,
  projectType, scope…) — same gap as `validateSddTree()`. It kept `host_validator_adapter` from becoming a pure forward.
- The MCP tools `validateTopology` and `getProjectConfig` have no spec (no mcp_portal/mcp_orchestrator method).
- The spec migration's reader map missed three readers (mcp sdd_validate_tree, `wairon rules list`, the hosted
  as-complete adapter); found only by grepping code for loader calls. A per-file "unclaimed read of held state" check
  would have caught them — ties into F17.

## Workaround used
Insert a clean step with `captureJumps: true` (takes over the entry jumps), label the downstream target and use
`onFalseLabel`, then delete the stale step. Five calls to fix one step.

## Proposals
- P1 (F1, F2): a write reports what it changed; a delta that changes nothing returns "no change" naming the ignored
  keys instead of "Successfully updated". Honour `[]` and `unset` at every element level (method, step).
- P2 (F3): a delta that changes a step's `type` replaces the step (fields of the old type are dropped), or is refused
  naming the leftovers. Recommended: replace.
- P3 (F4): generalize MALFORMED_FLOW_STEP into a per-type field check (a field that does not belong to the step's type).

## F47. `validateSddTree()` invents findings when a caller omits the rules config (D2a, my own measurement)
Called with no arguments from a script, `validateSddTree()` does not load the project's `rules` config; every rule falls back to its own default. Measuring wairon's tree that way produced 9 GOD_COMPONENT findings against the rule's default of 8, while the project configures 10 with a written reason — plus a phantom UNUSED_LINT_ALLOW. The CLI passes the config and reports none of them. Nothing in the result says which configuration produced it, so a wrong answer looks exactly like a right one. Note also that the CLI truncates at 100 findings per severity, so neither channel gives a complete, correct list by default. **Proposal:** `validateSddTree` loads the project config itself when the caller passes none (it already knows the project root), or refuses to run without one; and the result carries the effective config it used, so a report can state what it was judged against. Related: the spec gap already logged — `ispec_validator.validateSddTree()` declares no params while the code takes rules and projectType from its caller.

## F48. An older CLI silently regenerates the guides with retired vocabulary (D2a, after the merge)
`wairon generate` run from a globally installed 5.1.1-dev.16 rewrote `.claude/CLAUDE.md`, `GEMINI.md` and six skill files back to pre-D1 text: Specialist and Gateway as live stereotypes, no Query, no dependency class. The files carry a `<!-- wairon-version: -->` stamp, so the tool knows both the version that wrote them and its own, yet it downgrades without a word. In a repo whose guides are committed, that lands retired doctrine in a commit unless someone notices. **Proposal:** when regenerating a guide whose stamp names a NEWER version than the running CLI, warn and require `--force` — the same shape as the stale-server guard, which does exactly this for spec writes.

## F49. A lock taken by an older validator is written, not refused (D2a, after the merge)
The same dev.16 CLI wrote `.wai/lock.json` with `validatorVersion: 5.1.1-dev.16`, `warnings: 90` (its doctrine does not know D2's codes, so the tree's 58 allows read as unknown codes), and a stateId under the old `sha256+doctrine+inputs` marker. The current build reads that record as `stale` immediately — so the approval never gated anything, and nothing said so at lock time. The human had every reason to think the tree was approved. **Proposal:** `wairon lock` compares its own doctrine identity with the project's build (or refuses when the CLI is older than the version stamped in the tree's generated guides), and says plainly that the record it is about to write will not verify.

## F50. `sdd_write_narrative` warns of its danger without naming the way out (rename-method L4/L5 agent)
Adding one method to a 45-method implementation through `sdd_write_narrative` means re-sending all 45, because it replaces the method list; the description says as much but leaves the agent to discover the alternative. `sdd_update_spec` with a `methods` upsert does it safely — merged by name, other methods and the spec's `lint` block untouched. **Proposal:** one line in `sdd_write_narrative`'s description pointing at `sdd_update_spec` for adding or changing a single method on an existing implementation.

## Not a finding: draft warnings through MCP (checked 2026-09-17)
An agent reported that `sdd_validate_tree` filters draft findings out of its warnings, since it saw none where 12 were expected. The CLI reports none either: the approval ratchet presents specs the human approved, and that have not moved since, as complete (`validation.ts` `settledStatusBearing`). The two views agree; nothing is hidden.

## F51. A component can serve only one interface in the nested layout (rename-method code agent)
`assertPathHoldsNoOtherSpec` refuses a second `i<id>` file for the same component, so a component with two contracts is unreachable in the nested layout — the layout `doctor` migrates towards. The rename-method narrative says "every interface of the component that declares it", and the agent could only exercise that branch by writing a flat-layout fixture by hand. **Proposal:** decide whether a multi-contract component is a supported shape. If it is, the nested layout needs a second-contract filename and `normalizeComponentLayout` must carry it; if it is not, say so in the standard and let the rename read one contract.

## F52. The mention scan's prose fields are a hand-kept set (rename-method code agent)
`renameMethod` collects mentions by scanning `description`, `intent`, `summary`, `condition`, `over`, `outcome`, `error`, `note` and `caller`. A prose field added to the schema later is silently not scanned, so a rename would under-report what still names the old method. **Proposal:** a test that walks the string fields in `src/models/specs.ts` and fails when a prose-shaped field is not classified, the way `schema-field-coverage` holds the authoring tools to the schema.

## F29 again, on `symbol` (D2b-1, my own use)
`{"methods": [{"name": "syncScope", "unset": ["symbol"]}]}` returned "Successfully updated implementation spec" and left `symbol: syncBackingScope` in place. F29 logged this for method-level `unset` during the schema PR; it is unchanged, and it bites hardest exactly here — after a rename, removing a now-redundant pin is the natural edit, and the tool says it did it. The workaround was to write `symbol` equal to the method name, which is truthful but leaves a redundant field. **Proposal (PR A):** honour `unset` at method level, or refuse the delta and say method-level `unset` is unsupported. Reporting success for a write that changed nothing is the worst of the three.

## F53. A rename can break a second component bound to the same function (D2b-1)
`identity.ts` realizes both `identity_orchestrator.listIdentityProviders` (by `symbol`) and `identity_portal.listIdentityProviders` (by name, anchored tier) with one function — wairon's documented N:1 collapse. Renaming the function for the orchestrator silently moved it out from under the Portal, and only `validate` caught it, as three fresh UNREALIZED_METHOD warnings. `sdd_rename_method` had no way to warn, because the other component's binding is by name and lives in a different spec. **Proposal:** when a rename pins or changes a symbol, report every other implementation whose method maps to the same source file and would now match by name — the rename already reads those files for mentions.

## F54. A rule's private helper has no spec representation, so the narrative unrolls it (D2b-2c wave B analysis)
`integrity_rules.namespaceHygiene` scores 25 over 31 steps. Neither number measures the rule: its two checks are each written five times, once per id kind, because the code's private `checkId(id, kindLabel)` closure is not a component method and a narrative has no step that calls one. The same shape will recur wherever a rule folds repetition into a local function — the score then measures what the spec language cannot say, and the only remedies are to promote the helper onto a type or context (a real design change, for a private detail) or to leave the narrative five times longer than the code. **Proposal:** decide whether L5 gets a way to name a local derivation — a `derive` step, or a private method on the implementation that is not part of the contract — so that a helper the code already has can be narrated once. Until then `EXCESSIVE_NARRATIVE_STEPS` and the cognitive score both punish the honest narrative of a rule that factored itself properly.

## F55. `wairon lock` writes files and leaves the human to find them (D2b-2c, third occurrence)
A lock writes `.wai/lock.json`, freezes the specs and regenerates the guides, then says nothing about the files it changed. Locking after a merge strands the record on a branch that is already merged, and it takes a third PR to carry it to dev — #74, #82 and #87 are all that PR. The deeper cause is ordering (lock belongs on the branch, before the merge, so the approval ships with the change it approves), but the tool could help either way. **Proposal:** `wairon lock` prints the paths it wrote, and takes an optional `--stage` to `git add` them, or `--git:commit` to stage and open an editor so the human writes the message. Robbe: worth having, not urgent — decide how common it is before building it.

## F56. A stale MCP server answers a validate as if it were authoritative (draft promotion, 2026-09-18)
The promotion wave ran `sdd_validate_tree` through an MCP server started before the cohesion PR merged, and it reported two `INCOHESIVE_METHODS` warnings that the current `dist` does not fire — the stale build was still running the pre-exemption cohesion rule. Both named specs were untouched, already complete, and carried no allow. The write path warns about staleness ("writes through a stale server can silently drop fields"), which reads as though READS are safe; an agent trusting the MCP validator over the CLI would have chased two phantom findings and might have "fixed" them. **Proposal:** extend the stale-server notice to `sdd_validate_tree` and the other read tools whose answers depend on rule code, or have the server refuse to validate once the build beneath it has moved. A validator that answers confidently out of retired doctrine is worse than one that declines to answer.

## F57. MCP spec writes emit LF into a CRLF working tree (draft promotion, 2026-09-18)
All 36 spec files written through `sdd_update_spec` came back as LF in a repo whose working tree is CRLF, and had to be normalised afterwards; `git diff --stat` was byte-identical before and after the normalisation, so the content was right and only the line endings were wrong. This is mechanical, it hits every spec write in this repo, and it is why every wave brief has had to carry a CRLF warning. **Proposal:** the spec writer preserves each file's existing EOL, or honours `core.autocrlf` / `.gitattributes`, instead of pushing the fix-up onto the caller. Related: [[repo-line-endings]].

## F58. F57 is not about the spec writer — every wairon writer emits LF (move-methods, 2026-09-20)
F57 scoped the LF problem to `sdd_update_spec`. Three distinct surfaces produced it in one session: the MCP spec writes again (19 files), **`wairon lock`** writing `.wai/lock.json`, and **`wairon generate`** rewriting `GEMINI.md` as the lock regenerated the root guides. Each had to be normalised by hand before committing, and the lock one matters most because a whole-file diff on `.wai/lock.json` is the single artifact a reviewer most needs to read as a small diff. **Proposal:** move the fix below the spec writer, to wherever wairon writes any file in a project: preserve the file's existing EOL, or honour `core.autocrlf` / `.gitattributes`. Fixing only the spec writer leaves the lock and the guide generators still doing it. Related: [[repo-line-endings]], F57.

## F59. A forwarding chain collapsed into one function cannot be conformant (move-methods, 2026-09-20)
Portal -> Orchestrator -> Adapter is the standard shape in this tree, and when all three are realized by one function in one file, the outer component's narrative can never claim what the inner one's legitimately does. Built both ways and measured: with the inner call reachable the Portal reports `UNDECLARED_COLOCATED_CALL`; with it hidden in a closure the Orchestrator reports `CALL_STEP_UNREALIZED`. Exactly one finding either way, permanently, per method. `authoring_portal.addComponent` already carried it; `moveMethods` now does too. **Proposal:** either a colocated claim satisfies the components that forward to it, or the doctrine says such a seam is one component and stops modelling three. The current state taxes the shape the standard recommends.

## F60. A tree-scoped rule cannot gate a write (move-methods, 2026-09-20)
`maxComponentDependencies` is exactly the rule an authoring gate most wants — it is what refused the D2b move — but `componentCandidateGate` judges one candidate and the rule needs the tree, so `sdd_move_methods` had to re-implement the ceiling check by hand. The next gate that wants it will implement it a third way. **Proposal:** a sanctioned tier for rules that need one candidate plus a count, so a gate can reach them without re-deriving them.

## F61. `this.<method>()` is invisible to the conformance reader in both directions (move-methods, 2026-09-20)
A call through a `this` receiver resolves to no file, so `CALL_ORIGIN_UNRESOLVED` fires; but spelling the same calls bare makes the *other* colocated calls in that method resolvable and fires `UNDECLARED_COLOCATED_CALL` instead. Net zero findings, and the only way to score better is to mix two receiver styles in one method for a reason no reader could see. `SpecWorkspace` — the largest component in the tree — is structurally unreadable for this reason, and the debt register carries the consequence. **Proposal:** worth naming plainly, because the incentive currently points at writing code the reader cannot follow.

## F62. A contract can promise a parameter it never passes, and no rule sees it (C6, 2026-09-20) — FIXED, and the lesson outlives the fix
`ispec_file_store.remove`'s narrative said "prune each parent directory the deletion left empty, stopping at the specs root" while its L3 declared `remove(specPath: string)` and nothing else — and the component's own description says it never reads `project.yaml`, so the store had no way to know that root. A store left to infer it deletes `.wai/specs` itself when the tree empties. **Every gate stayed green.** Level 1 realization reads a symbol and a body, not a signature, and `src/core/rules/conformance/` contains no param-conformance check at all: `grep -rln "params.length|arity|paramCount"` returns nothing. `UNREALIZED_METHOD` tells you the symbol it wanted and says nothing about arity. **Proposal:** at exact analysis grade the analyzer already has per-function facts; compare the declared `params` against the realized function's parameters and report a mismatch. Without it, an L5 that needs a value its L3 does not pass is invisible to the whole conformance set — which is the one class of drift the conformance dial exists to catch.


**FIXED 2026-09-23** by `param-conformance` (`UNREALIZED_PARAM`, `UNDECLARED_PARAM`, `PARAM_NAME_MISMATCH`, `PARAM_OPTIONALITY`, all carryable), closing the third and last of the code-to-spec readings — surface, data, signature. Of 1545 implementation methods, 488 declare no parameters and 132 are forwarders the named file only calls (left to `methodRealization`, which already reports the body is not there); 925 are comparable. After the 40 implementations that declare their injected wiring, 303 findings remain over 399 units, carried as `undecided` in two groups. The headline catch: `enableGit` takes a `pat` no contract declares — a credential in a signature nobody had ever read against its contract.

**The design was forced by a measurement that kept being wrong.** Twice I tried to INFER which leading parameters are injected wiring rather than domain arguments, and twice the inference was indistinguishable from a rename: `globalPath(target)` realized as `globalGuideFilePath(targetType)`, and `seed(config: HostConfig)` as `bootstrapInstance(cfg: HostConfig)`. A name-based prefix strip eats the renamed parameter and then reports the code as having dropped an argument. That is why `injectedParams` is a declared field on the implementation with no inferring fallback, and why the derived candidate list was filtered by TYPE alignment rather than by name — which is what kept both of those implementations out of it.

**Three decisions worth keeping.** Parameters are matched by POSITION from the front, because that is the correspondence a signature has; aligning from the back looks reasonable and destroys the motivating case, blaming `credential` and rename-reporting every position after it while never naming `pat`. The declared TYPE qualifies a rename rather than accusing on its own, so a position whose type the code does not annotate says nothing about the name. And a name with several bodies in one file — a class member and the module facade that forwards to it, which 54 spec-pointed names have and 15 with differing signatures — is judged on what ALL the candidates agree on, the same stance the field-type facts already take; reading the first body silently accused three methods of taking an argument the contract may not have meant.

**What it does not read: types.** See [[F73]]. And 114 of the 303 are one modelling question rather than many mistakes — a portal contract models the call as the caller makes it, one `request`, while the realization takes the transport apart. Declaring those four as wiring does not close it; it changes the finding's shape. Carried as its own group with the decision named.

## F63. In a file realizing many components, extracting a function creates a component boundary (C6, 2026-09-20)
`src/mcp/server.ts` realizes eleven components. Extracting `advertiseHostedTools` — a pure, behaviour-identical refactor asked for by the design — gave `createMcpServer` a 23rd colocated crossing on a debt-register entry written for 22, so a refactor that closed one finding opened another. This is not a bug in the rule; it is the honest consequence of N:1 file-to-component realization, and it means **the cost of extracting a function in such a file is a register edit**, which no brief can predict in advance. Related: F59. **Proposal:** worth stating in the standard, so the cost is expected rather than discovered.

## F64. An adapter may publish what its contract never named, and nothing sees it (Track D, 2026-09-20)
`src/commands/subsystem.ts` realizes `cli_core_adapter` and exports seven forwarders its contract does not declare — `generateComponentDiagram`, `generateSequenceDiagram`, `generateDiagramSet`, `toMarkdown`, `diagramSetIndex`, `loadSpecGraph`, `buildCanvasDataModel`. `ihost_core_adapter` has the identical gap and predates it (26 contracted methods; `hostCore` forwards past them). **Zero findings, either case.** This is F62 in the other direction: there a contract promised a parameter the code never took, here the code publishes a surface the contract never promised. Both are invisible for the same underlying reason — realization is checked contract-to-code and never code-to-contract, so a file may export anything it likes under a component’s name. The practical cost is that a reader who trusts the contract does not know what a subsystem can actually reach through that adapter, which is exactly what an adapter contract is for. **Proposal:** at exact analysis grade the analyzer already has each file’s exported names; report an export that crosses a component boundary and is named by no contract method. Related: F62.

## F65. An aliased import makes a real call invisible, and the message says the opposite (Track D, 2026-09-21)
`CALL_STEP_UNREALIZED` reads "each call site is resolved through this file's import bindings", but the name test is `sites.filter(s => target.accepted.has(s.name))` at `src/core/rules/conformance/call-conformance.ts:294`, and `s.name` is the name written AT THE CALL SITE. `ImportBindingFact.imported` — the `as`-rename record — is read in exactly one place in the tree, `src/core/rules/conformance/method-realization.ts:70`, and never by call-conformance. So `import { resolve as resolveTopologyDomains }` followed by `resolveTopologyDomains()` resolves to the right file, fails the name test, and is reported as an unrealized claim — an accusation, not the honest `CALL_ORIGIN_UNRESOLVED` "not checked". Measured: the first pass at `core/index.ts` and `agent_resolver.ts` used that shape and produced four false findings; a namespace binding (`import * as topology` -> `topology.resolve()`) produced none. Worse, the aliases already in `src/commands/subsystem.ts` (`loadSystemSpec as coreLoadSystemSpec`) pass for an unrelated reason — the N:1 identity exemption at line 288, where the caller's own symbol equals the target's method name — so the shape looks supported until the day it is not. **Proposal:** add `binding.imported` to the accepted names, exactly as `method-realization.ts:70` already does; it is one line, and the two readers then agree. Failing that, stop promising that bindings are followed.

## F66. The rule that forbids a Portal write is dark on 226 of 239 interfaces (Track D, 2026-09-21)
`PORTAL_WRITE_SHORTCUT` is a default-**error** rule enforcing rule 4 of the standard, and it judges only methods carrying `effect: write` — "untagged methods are not yet judged" is stated plainly in the rule. Measured across the tree: **13 of 239 interfaces carry any write tag, 29 tags in total.** So `core_portal.addDomain` -> `topology_repository.addFreeStanding` — a Portal persisting through a Repository facade with no Orchestrator anywhere in the path — validates clean, and so does every other untagged write. The gap is not that the rule is wrong; it is that a rule whose coverage depends on an optional tag reports silence as compliance, and the tree reads as if rule 4 holds everywhere. This is the deferred effect-tag flood-check seen from the enforcement side. **Proposal:** either derive the effect from the narrative (a method whose L5 reaches a Store's write is a write, and the analyzer already has that graph), or report the untagged facade methods on a data component as their own finding, so the dark area is visible instead of silent. Tagging one interface by hand is not a fix — it makes that component the only one in the tree actually held to the rule. **Measured since:** tagging `itopology_repository`'s two writes and pointing `core_portal.addDomain` back at the facade makes the rule fire as an ERROR immediately — the rule works perfectly, it was simply looking at methods nobody had tagged. So the dark area is not a rule defect but a coverage one, and the cost of leaving it dark is that the tree reads as compliant everywhere the tag is missing.

## F67. A type spec's fields are never compared to the code (Track D, 2026-09-21) — FIXED, and the lesson outlives the fix
`execution_budget` is a committed, LOCKED type spec naming `src/models/execution.ts`. It declares two fields, `modelTier` and `effort`, both `optional: false`. The real `ExecutionBudget` has **six** — `modelTier`, `effort`, `maxTurns`, `toolClass`, `allowNestedDelegation`, `mcp` — and the two the spec does name are the two that are actually OPTIONAL in code, so every fact the spec states about them is inverted. Zero findings, through a lock and a CI conformance gate. `HOLLOW_TYPE` fires only when a type declares nothing at all, and `src/core/rules/conformance/` contains no rule that reads a type's `fields` against the file its `sourcePath` claims (the one conformance file mentioning "fields" is `hidden-state.ts`, which is about state on Orchestrators). This is the third face of F62/F64: realization is checked contract-to-code for METHODS and never at all for type shape, so a type spec is documentation nothing verifies — while the ERD, the briefs and every implementer read it as truth. It is arguably the worst of the three, because a wrong param list at least breaks at the call site eventually, whereas a type spec that lies is only ever read by humans and agents. **Proposal:** at exact analysis grade the analyzer already parses the target file; compare a value-object's declared `fields` against the exported shape at its `sourcePath` and report missing, extra and optionality mismatches. Related: F62, F64.


**FIXED 2026-09-23** by `type-shape` (`UNREALIZED_TYPE_FIELD`, `UNDECLARED_TYPE_FIELD`, `TYPE_FIELD_OPTIONALITY`, all carryable), which compares a type spec's `fields` to the shape at its `sourcePath` at exact grade. It reads both a DECLARED shape, whose members the file lists, and a DERIVED one, an alias followed one hop to the object literal its schema is built from. Of 220 source-pathed type specs, 215 are readable; 41 drifted, 119 units. Declaring the 32 envelope fields the spec types had silently omitted took that to 87 units over 38 types, carried as `undecided`.

**The scoping lesson is in the exemplar.** `execution_budget`, the type this entry was written about, is a `z.infer` alias — so a rule that read only declared interfaces, which was the cheap and obviously-safe half, would never have looked at the very case that motivated it. The 166 interfaces were 87% clean; the 49 derived shapes held two thirds of the debt. Scoping a checker to what is easy to read selects for the code that was already easy to keep honest.

**And a lesson about measuring.** The number that justified this rule needed four corrections before it could be trusted, each found by attacking the previous one, and each moving it by 20-50%: method signatures counted as data fields (which made every behavioural interface, and `StatusDecor`, look catastrophically drifted); zod's `.default()` read as optional when it makes the inferred field REQUIRED; a chain walk that took `z.object({...}).refine(fn, { message })` for a one-field shape; and optionality read off a property's source TEXT, so a `.default()` nested inside a record lied about the outer key — that last one found by the implementing agent, against my prototype. A measurement that has not been attacked is not a measurement, and three of the four would have shipped a rule that accused real code of drift it did not have.

**One finding worth keeping separate from its neighbours.** Of the 28 optionality units, 19 are a spec calling a defaulted field optional — true of what an author may omit, false of the value the type holds — and 9 run the other way, where the spec promises a field is always present and the code lets it be missing. Identical in a diff, opposite in consequence: the first omits, the second misleads. A rule that reported only "these disagree" would have buried the nine that matter.

## F68. Fan-out rules count edges and cannot see what the edges are for (Track D, 2026-09-21) — FIXED, and the lesson outlives the fix
`GOD_COMPONENT` and `EXCESSIVE_DEPENDENCIES` both reduce to `comp.dependsOn.length > threshold`. Adding two PURE dependencies to `core_portal` tripped both, and there was no arrangement of the design that would untrip them: the portal was already sitting at exactly the limit. Measured across the tree first, rather than reaching for an allow — of 243 components only 13 reach 8 dependencies, and they fall into two disjoint shapes with no overlap at all: **every high-fan-out Portal narrates 100% hand-offs** (`core_portal` 80/80, `web_portal` 82/82) while **every high-fan-out Orchestrator holds real flow** (`cli_runner` 34% thin, `admin_orchestrator` 0/27, `landscape_orchestrator` 0/7, nine more at 0-8%). A routing table and a god component are not the same thing, and the raw count reports them identically.

Three things make this worth recording beyond the one-line fix. **First, the tree had already learned this lesson twice and not generalized it**: #88 changed `INCOHESIVE_METHODS` to exempt pure forwarders on precisely this reasoning, and `naming-discipline.ts` exempts Adapters and Portals from the stutter check "because a forwarder's method mirrors the command or route it exposes". The fan-out rules were the only ones still counting. A lesson learned per-rule instead of per-concept is a lesson that has to be learned again every time.

**Second, the only documented escape was an allow.** `cli_runner` carries reasoned allows for both codes, so the precedent for "suppress it" was sitting right there and was the easy answer. A rule whose normal resolution is a suppression is training its users to suppress — and an end user hitting this has less context than we do to tell a wrong rule from a wrong design.

**Third, the obvious alternatives were worse.** Raising `maxComponentDependencies`, or scaling it with project size, would loosen the rule for Orchestrators too — which is exactly where it should stay tight, since an Orchestrator coordinating ten stateful collaborators is suspect at any project size. Routing the reads through `core_orchestrator` to keep the portal at ten would have moved a number below a threshold while making the design slightly worse. The count was never the thing worth measuring.

**Fixed** by applying the existing `isForwardingMethod` test from `method-cohesion.ts:66` in both rules, with `narrated.length > 0` load-bearing: absence of narrative is not evidence of forwarding. `cli_runner` keeps firing and keeps its allows, which is the check that the exemption is narrow rather than a blanket stereotype pass. **Proposal beyond this fix:** a coupling metric that weighted an edge by what it reaches — pure logic carries no state, no lifecycle, no ordering and no failure mode — would measure coupling rather than proxy it, and would have answered this without a special case at all.

## F69. A string union can only be modelled as a value-object with no values (Track D, 2026-09-21)
`TypeKindSchema` is `z.enum(['entity', 'value-object'])`. There is no kind for an enumeration, so a TypeScript string union has two homes and both are wrong. Measured across three attempts in two slices:

**Leave it unmodelled.** Works only while no contract mentions it. `budget_tier` and `model_tier` were deliberately left out on the grounds that inventing a field-less value object for `'off' | 'free' | 'default' | 'trade' | 'aggressive'` would be modelling structure the code does not have — and that held, because `BudgetTier` appears only inside `ExecutionConfig`, never in a signature. One slice later `UpdateChannel` DOES appear in a signature (`channel(): UpdateChannel`), `UNDEFINED_TYPE_REFERENCE` fires as an ERROR, and the same reasoning is suddenly unavailable. So whether an enum may go unmodelled depends on nothing about the enum — only on whether some method happens to name it.

**Model it as a value-object.** `update_channel` now exists with `fields: []`, which says a UpdateChannel is an object with no fields. It is a string. The ERD will draw it as an entity-shaped box with nothing in it, and `HOLLOW_TYPE` is dodged only because a method was hung on it. Had there been no natural method, the honest choices would have been a fabricated `value: string` field or a fabricated method.

The loss is not cosmetic. **The one thing worth saying about an enum is its members, and there is nowhere to put them.** `UPDATE_CHANNELS` — the ordered list, narrowest first, whose ordering is a load-bearing invariant (each channel is a superset of the one before, so widening can only add candidates) — survives only as prose in the description. A reader cannot see the members, a diagram cannot show them, and no rule can check that the code's union and the spec's list agree. Same for `BudgetTier`'s ordering, which the budget policy's whole safety argument rests on.

**Proposal:** a third `kind: enumeration` carrying `values: [...]` in declaration order, with the ordering treated as significant. It costs one schema field and one ERD shape, and it closes a check that cannot exist today — comparing a declared member list against the union at the type's `sourcePath`, which is F67's proposal applied to the case where the shape is nothing but its members. Related: F67.

## F70. A field's declared type cannot name its parameters (Track D, 2026-09-23)
`status_decor` models a set of presentation roles a caller supplies — seven functions from text to text. Declaring `type: function` is refused, correctly, since no such type exists. Declaring the honest TypeScript, `(text: string) => string`, is refused too: `fieldTypeReferencesRule` calls `fieldTypeRefs`, which extracts every identifier from the declared type string and requires each to resolve, so `text`, `kind` and `pct` are reported as undefined types. The only spelling that validates is `(string) => string` — parameter names stripped — which in real TypeScript means a parameter NAMED `string` of type `any`, so the one form the model accepts is the one form that is wrong in the language it describes.

The cost is small but exactly backwards: a reader of `layer: (string, string) => string` cannot tell which argument is the layer kind and which is the text, and that was the whole reason the roles were named rather than numbered. It had to go in the field description instead, where no rule can check it against the code. **Proposal:** parse a function type rather than scanning it for identifiers — the parameter names in `(name: T)` are bindings, not references, exactly as the rule's own comment already says about a type's generic parameters ("the type's own generic parameters are left out by fieldTypeRefs, so none remain in scope"). The same reasoning applies one level down and the helper simply does not go there yet. Related: F69, which is the same gap for enumerations — in both cases the model can hold the shape only by writing something untrue about it.

## F71. A contract cannot say which of its findings are carryable (Track D, 2026-09-23)
`carryable` is the flag that decides whether a code may appear in `rules.conformance.carried` at all — `UNCARRYABLE_FINDING` is an **error**, and it is what keeps the debt register holding measured drift instead of doctrine somebody wants quiet. It is therefore one of the most consequential facts about a finding. It lives in exactly one place: the `codes: []` literal inside the rule's TypeScript. Authoring `UNDECLARED_EXPORT` on `iconformance_rules` with `carryable: true` returned *"the level does not have this field, so the write dropped it"* — the L3 `findings[]` schema has `code`, `severity` and `summary`, and nothing else.

The asymmetry is the point. `rule-catalog.test.ts` exists precisely to prove the registry's codes and the L3 summaries are one list, and it compares code, severity and summary — three of the four things a code declaration says. The fourth is invisible to the spec, so the one property that governs whether a finding can be *carried* is the one property the contract cannot state, cannot be diffed on, and cannot be reviewed without opening the source. A reader of the spec tree sees which codes a rule emits and how loud they are, and has no way to learn which ones the register will accept until the validator refuses one.

**Proposal:** add `carryable?: boolean` to the L3 `findings[]` schema and extend `rule-catalog.test.ts` to compare all four fields. It costs one schema field and one line in an existing test, and it closes the gap in the direction the project already chose everywhere else — the registry and the contract say the same thing about a code, or the test fails. Note the MCP re-authoring seam applies: a new canonical schema field must be declared expressed or update_spec-only, or `schema-field-coverage.test.ts` fails.


## F72. The model described a method's realization completely, except for the value that ships it (Track D, 2026-09-23) — FIXED, and the lesson is in how it was found
`symbol` names the function realizing a contract method. For 90 of wairon's own methods that function is `check`, a member of an exported rule object — `callConformanceRule`, `retiredStereotypesRule` — that also carries the rule's name, its description and its codes. The spec models all three of those already: they are the L3 method's `name`, `description` and `findings`. It had no field for the object that composes them, so the one name a consumer actually imports was the one thing the design could not say. `src/core/rules/repository.ts` imports all 90, and until a rule looked at the export surface nothing in the tree knew those names existed.

The new `UNDECLARED_EXPORT` rule reported every one of them, and every one was a true positive: the registry reaches a name no contract declares. They were also unactionable — no edit to the spec tree silenced them truthfully, because the field to edit did not exist. That combination is the whole finding: **90 of the rule's 164 first-run units, 55% of the debt, were a missing schema field wearing 90 hats.**

The tell was the uniformity. Real code-to-spec debt is ragged — different shapes, different ages, different fixes. This class was one shape, one finding per rule file, 100% of the population, with the same fix missing in every single case. A rule that reports a large, perfectly uniform class is usually reporting a gap in the model rather than a debt in the code, and the debt register is exactly what would have hidden it: 90 entries under one reason group, in one commit, would have read as a decision taken rather than a question never asked. The cheap path and the wrong path were the same path.

**Fixed** by `exportedVia` on `MethodImplementation` — the export a consumer imports to REACH the method, where `symbol` names the function inside it — paired with `UNREALIZED_EXPORT_HANDLE`, deliberately not carryable, so declaring a handle the file does not export is itself a finding and the field can never become a free-text way to silence the rule. **Lesson beyond this fix:** when a new rule's first run is dominated by one repeated shape, classify the shape before carrying any of it. Related: F68, where a rule counted edges because it could not see what the edges were for; F64, whose whole point was that nothing read the export surface at all.

## F73. A signature's types are the one axis still unread (Track D, 2026-09-23)
`param-conformance` closes the signature gap for arity, position, names and optionality. It does not compare TYPES. The declared type is used only to qualify a rename — a name may differ at a matched position only when the type agrees — so a contract promising `credential: string` where the code takes `credential: string | null` says nothing, and neither does one promising a `Project` where the code takes a `ProjectId`. Of the five things a signature states, four are now read and the fifth is the one that decides whether a call type-checks.

It is left out deliberately rather than forgotten, because comparing types properly is a different problem from comparing names. A contract spells a type two ways — a spec type id (`remote_target`) or the code's own name (`HostConfig`) — and the rename check already has to resolve an id to its `symbol ?? name` just to work at all. Doing it honestly means a mapping between the spec's type grammar and the target language's, which is the same missing machinery F69 wants for enumerations and F70 for function types: three findings all asking for the model to understand what a type expression MEANS rather than how it is spelled.

**Proposal:** treat it as its own slice, after the type grammar exists. The cheap version — report only when both sides resolve to a known type and the two differ outright — would catch the `Project` vs `ProjectId` class and stay silent on spelling, which is probably most of the value for a fraction of the work. Related: F62 (this rule), F69, F70.

## F74. UNDECLARED_EXPORT cannot see a surface taken through a namespace import (Track D, 2026-09-24) — FIXED
`export-conformance` shipped in #124 treating `import * as x from './m.js'` as taking NOTHING, on the reasoning that a namespace import "cannot name which export it takes". That reasoning was wrong, and the web_portal refactor is what exposed it. The call site does name it: `webadmin.setSecret(cfg, sessionId, key, value)` resolves statically to the `setSecret` export of `webadmin.ts`, and the analyzer already records exactly the facts needed — a namespace binding (`ImportBindingFact.namespace`) and a member call on it (`CallSiteFact.member`, with the receiver). So `setSecret` crossed from `web_instance_admin_orchestrator`'s file into `web_portal`'s, declared by NO contract on either side, and the rule built to catch precisely that said nothing — it was not even carried, because it never fired.

It is not an edge case in this tree. `web.ts` reaches every one of its four orchestrators — `webadmin`, `webproject`, `projectops`, `shareadmin` — through a namespace import, so the ENTIRE portal-to-orchestrator surface of the largest portal was invisible to the rule. Across `src/`, 15 files make 36 namespace imports of sibling modules. The conservative choice was defensible for a bare `import * as m` whose members are never called; it is not defensible once `m.name(...)` is written down, because then the name is right there.

**Found by accident, and that is the lesson.** Nothing flagged `adminSetSecret`'s missing contract: not param-conformance (a route with no contract has no params to compare), not method-realization (nothing claims the method), not unclaimed-source (the file is claimed). An HTTP route with no contract method is invisible to every rule, from every direction — the reverse of endpoint conformance does not exist. The refactoring agent noticed only because it was reading the router line by line.

**Proposal, two parts.** (1) In `export-conformance`, resolve a member call on a namespace binding to the named export of that binding's module, and treat it as taking that name — exact grade, same "the taker must name this file" rule. Expect a new yield when it lands; measure it before carrying any of it. (2) A route-coverage check: every route a portal's router dispatches must be bound to some contract method's `endpoint`. The router is not modelled, so this needs either the dispatch table the tree already supports for Portals, or reading the router's own route literals — worth its own design pass. Related: F64 (this rule), F72.

**Part 1 FIXED 2026-09-24.** A namespace import now takes each name the file CALLS through it, resolved by the call site's receiver (`CallSiteFact.via`) against the binding's own specifier; a namespace bound and never called through still takes nothing. No analyzer change was needed — the facts were already recorded, and their own doc comment said the receiver was provable. It surfaced five units and none of the carried entries went stale. One was a plain contract gap: `git_adapter.excludeLocalFiles`, which decides whether an approval reaches the remote (it deliberately stops excluding `.wai/lock.json`), was declared by no contract and missing from the narrative of the `enable` that calls it — both fixed. **The other four were one shape**: each control-plane portal's HTTP entry point (`handleIdentityRequest`, `handlePolicyRequest`, `handleLandscapeRequest`, `handleOperationsRequest`), called by the listener in `http.ts` to mount that portal's routes — and `handleWebRequest` was already carried with the same shape. Five of five router entries, the F72 signature of a missing concept rather than five debts.

**Part 2 is therefore sharper now.** It is not only that a route with no contract is invisible; it is that the ROUTER is unmodelled. A portal's routes exist as `endpoint` bindings, but nothing says which listener mounts them, so the call that does is a crossing no contract can describe — and a contract method per portal for it would put the wire back into the contracts #126 just took it out of. The five are carried with that named. **Proposal:** model mounting once, as a concept — which listener serves which portal, by which entry point — and derive from it both the crossing these five are and the route-coverage check that would have caught the missing secrets contract.

**Part 2, mounting half, DONE 2026-09-24.** A listener Portal now declares `mounts: [{ portal, prefixes, via? }]` — `via` when it calls a router entry, absent when it calls the portal's own methods (share). The new `portal-mounts` rule checks a mount names a Portal, every HTTP endpoint of a mounted portal lies under one of its prefixes, and every HTTP portal is mounted unless it is a listener itself; export-conformance counts a mount's `via` as declared surface and reports one the portal's files do not export. Declared on the two listeners exactly as `routeData` and `routeAdmin` route: all 8 HTTP portals mounted, zero endpoints outside a prefix, all five entries really exported, and the five carried router entries paid. The measurement before the declarations was 8 `UNMOUNTED_PORTAL` and nothing else — a check landing at a known, explainable count. Rename and the update merge were taught mounts in the same slice, so a renamed portal carries its mounts and a mount can be edited alone.

**Still open: route-literal coverage.** Mounting says which listener serves which portal; it does not say every route a router actually handles has a contract endpoint. That is what would have caught the secrets route, and it needs the analyzer to read route literals out of the router code (`parts[0] === 'identity'`, each `handleWebRequest` branch) — now with a declared mount to read them against.

**Route coverage DONE 2026-09-24 — F74 closed.** `route-coverage` reads the routes a mounted router answers out of its guards — the branch's condition joined with every enclosing one, since routers nest, and the leading segment the router never checks supplied by the mount's prefix — and compares them with the portal's contract endpoints. On this tree: 120 routes read, 113 matched exactly, **0 endpoints without a route**, and 7 routes no contract declared. Five were closed in the same slice (landscape, health, usage, the approvals list and the approval decision — a write), by the #126 convention; the two left (`canvas-model`, `openapi`) are carried as drift because their gap runs through the orchestrator and an adapter method too. A router in any other idiom is reported UNREADABLE rather than passed.

It found a second CSRF gap on the way — the approval decision was a cookie write missing from the mutation list, the same class #126 fixed for project config — and one false positive in an old rule: `GOD_COMPONENT` treated a portal serving its own static app shell as holding flow, so declaring the five routes' collaborators would have flagged `web_portal`. The fan-out rules now judge a ROUTING TABLE — every method that reaches a collaborator is a single hand-off, one reaching none is neutral — while cohesion keeps its stricter pure-forwarder test. Whole-tree finding diff for that change: exactly −1. **Lesson, the third time this programme:** when a new check lands, measure it against the tree before trusting it, and when it fires, ask whether the rule or the code is wrong before choosing.

## F75. Tests-to-revisit matches a method by NAME, not by the module a test imports it from (authoring seam, 2026-09-25)

Removing eleven thin forwarding methods from `mcp_core_adapter` (`saveSystemSpec`, `saveSubsystemSpec`, ...) reported roughly 250 test files to revisit - every test that imports CORE's function of the same name. The adapter's own methods are tested by none of them. The same happened for `authoring_core_adapter.saveComponentSpec` (41 files) and for the MCP orchestrator's `addComponent`, whose code symbol is `sdd_add_component` but whose contract name matched the authoring seam's old `addComponent` test. On an adapter - where forwarding under the provider's own name is the convention - the report is noise, and noise trains the reader to skip the section that exists to stop a brief from promising green tests it already broke.

**Proposal:** resolve the search to the realizing MODULE: a test counts as "imported" only when its import specifier resolves to the method's own source file (or a file that re-exports it from there); a same-named import from another module is at most "mentioned". A method realized by an import binding (the thin-adapter shape) has no body of its own to test, so it should report nothing, or report the provider method's tests labelled as such.

## F76. A stale MCP server is only announced on reads, after the fact (authoring seam, 2026-09-25)

`sdd_get_spec` answered with `staleServer: true` - the only signal that the build on disk had moved on since the server started. Writes through a stale server have corrupted specs three times in this programme (a replaced params list, a no-op'd unset, stripped fields). The warning arrives on whatever call happens first, and nothing stops a write.

**Proposal:** a write tool on a stale server refuses (or requires an explicit acknowledgement) instead of writing through old code, and `sdd_get_status` leads with the staleness so the first call of a session surfaces it.


## F77. `sdd_move_methods` cannot move into a component that has no contract yet (portal split, 2026-09-25)

Splitting `core_portal` meant moving methods into six brand-new portals. The first dry run refused: `"approval_portal" declares no contract, so the methods would have nowhere to arrive.` Each target first needed an empty interface and an empty implementation authored by hand (twelve extra writes), with a `sourcePath` the move could have inherited from the source. The refusal also read `Error: Error: unmovable request ...` - the doubled prefix #131 removed from the create tools is still on this one.

**Proposal:** when the target has no contract, the move creates `i<target>` and `<target>_impl` (the implementation inheriting the source implementation's `sourcePath` unless told otherwise) and says so in the report; and the MCP error rendering drops the doubled prefix everywhere, not tool by tool.

## F78. Renaming a component rewrites every spec but not the debt register (portal split, 2026-09-25)

`sdd_rename_component core_portal -> spec_tree_portal` rewrote 24 specs, yet `.wai/project.yaml` kept `spec: core_portal_impl` and `'1:core_portal.loadProjectExtensions'` in `rules.conformance.carried`. The next validate reported those entries STALE and the very same findings as NEW under the new ids - debt that did not change looks both paid and fresh. The register is keyed by exactly the ids the rename exists to rewrite.

**Proposal:** the rename (and `sdd_move_methods`, which re-homes a method's units) rewrites `spec`, `at` and `covers` in the carried register and in `lint.allow`, and lists those edits in its report like any other reference it followed.

## F79. A narrative insert or delete is reported as a positional diff of every later step (portal split, 2026-09-25)

Inserting one `register` step at 46 in a 97-step narrative answered with **124 changes**: every later step reported as its description, target and type "set" to its predecessor's values. Deleting four steps read the same way. The write was correct; the report describes a renumbering as a rewrite of fifty steps, which buries the one line that matters and makes a real accidental rewrite impossible to spot beside it.

**Proposal:** diff narratives by step identity after the renumbering the delta applied (a step keeps its identity across the shift), so an insert reads "step 46 added; steps 46-97 renumbered to 47-98; step 1 endStep relocated 97 -> 98".


## F80. An aliased re-export is not followed by call-step conformance (PR 3a, 2026-09-26)

A thin client adapter re-exporting its provider under the adapter's contract name (`export { listSnapshots as listSurfaceSnapshots } from ...`) is the natural shape for an adapter whose contract speaks the consumer's language. Call-step conformance does not follow the alias: the consumer's call resolves to nothing it can match, and the step reads unrealized. Four adapter methods (validator_surfaces_adapter x2, host_surfaces_adapter, host_core_adapter) were renamed to the provider's names to get past it - the contract bent to the reader.

**Proposal:** treat `export { a as b } from 'm'` as an identity forward from b to m.a in the landing-side resolution, the same way an unaliased re-export already is; then the renames can be reverted where the provider's name was the worse contract name.


## F81. `sdd_add_type` accepts a subsystem that does not exist (friction PR F1, 2026-09-26)

Found while pinning the single `Error:` prefix across the write tools: no refusal of `sdd_add_type` is reachable past its input schema, because naming a `subsystem` the tree does not have succeeds without complaint. The type is written, owned by nothing, and nothing says so at the write. Every other create tool requires its parent (the seam's `spec_restatement.parent`), and a type's owning subsystem is the same kind of reference.

**Proposal:** `spec_restatement.parent()` answers the owning subsystem for a type that names one (a system-level value object names none and stays parentless), so the seam refuses an unknown owner exactly as it refuses a component under an unknown subsystem.

## F82. Every registry save rewrites project.yaml and drops its comments (stage 2a identity, 2026-09-26)

`project_config_store.write` overlays the configuration onto the parsed document and writes it back with `writeYamlFile`: the order of keys survives, but every comment is lost. The debt register in this repo's `.wai/project.yaml` is maintained through its comments: each carried group says why it exists and how many findings and units it covers. So any pack, profile or tier change made through the registry silently strips that record. It surfaced when stage 2a planned an id backfill on every save. That would have made the loss certain on the next ordinary save, and the backfill was dropped (a defaulted id could also be wrong for a chained child). The loss itself predates stage 2a: it happens on any registry save.

**Proposal:** give `write` the treatment `rewriteScalars` already has: edit the parsed YAML Document (the yaml library keeps comments on its node tree) rather than re-serialising a plain object, and add a regression test that a registry save keeps a carried-group comment byte-for-byte.

## F83. A technology token that is also a format name floods TECH_LEAKAGE (stage 2c, 2026-09-26) — FIXED

**Fixed:** a `technologies` entry may be `{ name, matches }` and is then policed by those tokens alone; project_config_fs_adapter_impl binds `{ name: yaml, matches: [yaml package, parseDocument] }` with 0 warnings (the bare name measured 100).

Binding `technologies: [yaml]` on the project-config file adapter's implementation (the `yaml` npm package, chosen for the comment-preserving save) added about 75 TECH_LEAKAGE warnings across every subsystem. The leakage check matches the bare token, and `yaml` is also the file format the whole tree names (`project.yaml`, YAML snapshots). The binding was reverted, and the package is named in the adapter's prose instead, so the vendor-swap seam cannot record this dependency.

**Proposal:** let a technology declare the token the leakage check matches (or an exclusion list of format words), so a package named after its format can be bound without the format counting as leakage.

## F84. `wairon generate` leaves wairon-guide.md stale when project.md is missing (stage 3 wave C, 2026-09-27) — FIXED

**Fixed:** `hasContext` (context_store.isPresent) now asks for the `.wai/context/` directory, and runGenerate branches on it explicitly, so generate refreshes the derived documents whenever doctor --fix would.

`runGenerate` refreshes the derived context documents only behind `hasContext()`, which is true only when the human-written `.wai/context/project.md` exists. This repository has no `project.md` but does carry a generated `domains.md` and `wairon-guide.md`, so `wairon generate` never rewrites the guide: it keeps whatever the last `doctor --fix` or `init` wrote, and the member and stage-3 wording shipped this stage does not reach it through generate. `doctor --fix` calls `syncContextFiles()` unconditionally, so the two commands disagree about when a derived document is owed; the staleness check in a plain `doctor` run then flags a file `generate` will never repair.

**Proposal:** gate the sync on the derived documents themselves (refresh any that exist, or all of them once `.wai/context/` exists), not on the one human-written file, so `generate` and `doctor --fix` keep the same documents current. Behaviour left unchanged in wave C: the gate is not specified anywhere, and changing it is not a one-line fix.

## F85. `doctor --fix` writes machine-global configuration without saying so in its plan (stage 3 wave C, 2026-09-27) — FIXED

**Fixed:** doctor plans the MCP install (planInstall), lists every write outside the root with old and new value, asks its own confirmation (`--yes` counts only with `--global`, non-interactive without it skips and says so), backs up the replaced file and moves the legacy plugin aside; generate skips an outside output dir unless `--global`.

Running `doctor --fix --yes` on a temp copy of a real family (to prove the chaining migration) also rewrote the user's GLOBAL Antigravity MCP config (`~/.gemini/antigravity-cli/mcp_config.json`), because the project's targets include `agy` and doctor's fixed MCP-install step writes that file. The plan-first migration showed every project-local write, but the global write was neither in the plan nor covered by its confirmation, and the previous value was not kept, so it could not be restored. A project-scoped repair command silently changed machine state shared by every project.

**Proposal:** doctor lists every write outside the project root in its plan (target file, old and new value), requires its own confirmation (`--yes` does not cover it unless `--global` is also given), and keeps a backup of the replaced file.

## F86. `sdd_update_spec` crashes when a delta adds an implementation method without `narrative` (stage 6, 2026-10-01) — FIXED

**Fixed:** a new method without `narrative` is intent-level (`[]`, the schema default), a non-list narrative is refused naming the field, and an `unset` of a defaulted list resets it instead of crashing the save.

Adding a new method to an implementation spec through `sdd_update_spec` with no `narrative` field failed with `TypeError: Cannot read properties of undefined (reading 'map')`. Retrying with `narrative: []` applied cleanly. A write tool should either default the missing array or refuse with a message naming the field, never throw a raw TypeError.

**Proposal:** treat an absent `narrative` on a new method as `[]` (an intent-level method), or refuse with "a new implementation method needs `narrative` (use [] for an intent-level method)"; add a test.

## F87. One `sdd_update_spec` delta that inserts a branch and then a throw shifts the branch's jump by one (stage 7, 2026-10-01) — FIXED

**Fixed:** jumps a delta writes are pinned in the delta's final numbering and never relocated by its own later inserts/deletes; only stored jumps relocate (tests/core/delta-new-elements-and-jumps.test.ts).

Inserting a branch step and, in the same delta, a later throw step left the branch's stored `onFalseStep` pointing one step too far: the second insert's renumbering relocated the jump the first insert had just written. The validator caught it as UNREACHABLE_STEP; the author fixed it by hand and re-read the narrative.

**Proposal:** resolve every jump written in a delta against the numbering after ALL of the delta's inserts (or require labels for jumps inside a delta that also inserts), and add a test that inserts a branch plus a later step in one delta.

## F88. A method entry named in an `sdd_update_spec` delta without its narrative can clear that narrative (stage 8, 2026-10-03) — FIXED

**Fixed:** an absent narrative never cleared it (the incident's stray entry carried an explicit `narrative: []`, the documented clear); the real gap was one level down — a delta element's `null`/`undefined` field overwrote the stored value — so null/undefined fields are now stripped at every depth before the merge, the tool description says `narrative: []` clears, and tests/core/delta-absent-fields.test.ts pins both.

While editing one implementation, a delta that carried a stray entry for another method (`computeStateIdAt`, with no narrative of its own in the delta) would have replaced that method's stored narrative with an empty one; only a dry run caught it before the write. A delta that names a method should merge into it, not reset fields it does not mention.

**Proposal:** a method element in a delta merges field by field like every other identity-keyed element; an absent `narrative` leaves the stored one untouched (only an explicit `narrative: []` or an `unset` clears it). Add a test.
