import { SddRule, RuleCode } from './types.js';

import { hierarchyRule } from './integrity/hierarchy-integrity.js';
import { reservedIdSegmentsRule } from './integrity/reserved-id-segments.js';
import { namespaceShadowingRule } from './integrity/namespace-shadowing.js';
import { roundtripRule } from './integrity/roundtrip-serialization.js';
import { typeDeclarationsRule } from './integrity/type-declarations.js';
import { fieldTypeReferencesRule } from './integrity/field-type-references.js';
import { signatureTypeReferencesRule } from './integrity/signature-type-references.js';
import { publicSurfaceBindingRule } from './integrity/public-surface-binding.js';
import { publicSurfaceDeclaredTypeRule } from './integrity/public-surface-declared-type.js';
import { publicSurfaceBoundContractRule } from './integrity/public-surface-bound-contract.js';
import { lintAllowsRule } from './integrity/lint-allows.js';
import { contractSymmetryRule } from './narrative/contract-symmetry.js';
import { narrativeTargetReferencesRule } from './narrative/narrative-target-references.js';
import { crossTreeReferencesRule } from './narrative/cross-tree-references.js';
import { surfaceReferenceBackingRule } from './narrative/surface-reference-backing.js';
import { guaranteeTokensRule } from './narrative/guarantee-tokens.js';
import { narrativeStepConfigRule } from './narrative/narrative-step-config.js';
import { narrativeReachabilityRule } from './narrative/narrative-reachability.js';
import { narrativeJumpEdgesRule } from './narrative/narrative-jump-edges.js';
import { meaninglessBranchesRule } from './narrative/meaningless-branches.js';
import { inescapableCyclesRule } from './narrative/inescapable-cycles.js';
import { unconditionalCallCyclesRule } from './narrative/unconditional-call-cycles.js';
import { narrativeDetailRule } from './narrative/narrative-detail.js';
import { detailSufficiencyRule } from './narrative/detail-sufficiency.js';
import { portalFieldsRule } from './intrinsic/portal-fields.js';
import { durabilityDeclarationRule } from './intrinsic/durability-declaration.js';
import { logicDeclarationRule } from './intrinsic/logic-declaration.js';
import { retiredStereotypesRule } from './intrinsic/retired-stereotypes.js';
import { portalsRule } from './doctrine/portal-endpoints.js';
import { nonPortalEndpointsRule } from './doctrine/non-portal-endpoints.js';
import { portalCallAuthRule } from './doctrine/portal-call-auth.js';
import { authSourceWiringRule } from './doctrine/auth-source-wiring.js';
import { subsystemBoundaryDepsRule } from './doctrine/subsystem-boundary-dependencies.js';
import { logicDependencyClassRule } from './doctrine/logic-dependency-class.js';
import { dataBlockDepsRule } from './doctrine/data-block-dependencies.js';
import { entrypointDepsRule } from './doctrine/entrypoint-dependencies.js';
import { portalWriteShortcutRule } from './doctrine/portal-write-shortcut.js';
import { patternMembershipRule } from './doctrine/pattern-membership.js';
import { patternContainmentRule } from './doctrine/pattern-containment.js';
import { unownedBlocksRule } from './doctrine/unowned-blocks.js';
import { memberVisibilityRule } from './doctrine/member-visibility.js';
import { facadeForwardingRule } from './doctrine/facade-forwarding.js';
import { profileRegistrationRule } from './extension/profile-registration.js';
import { profileStereotypeFencingRule } from './extension/profile-stereotype-fencing.js';
import { packProfileStereotypesRule } from './extension/pack-profile-stereotypes.js';
import { patternReferencesRule } from './extension/pattern-references.js';
import { variantReferencesRule } from './extension/component-variants.js';
import { assertionForbiddenEdgesRule } from './extension/assertion-forbidden-edges.js';
import { assertionRequiredFieldsRule } from './extension/assertion-required-fields.js';
import { assertionEndpointShapesRule } from './extension/assertion-endpoint-shapes.js';
import { packResolutionRule } from './extension/pack-resolution.js';
import { reproducibilityRule } from './extension/pack-reproducibility.js';
import { cyclesRule } from './wiring/dependency-cycles.js';
import { dispatchTableBindingsRule } from './wiring/dispatch-table-bindings.js';
import { dispatchStepRoutingRule } from './wiring/dispatch-step-routing.js';
import { lifecycleRule } from './wiring/lifecycle-entrypoints.js';
import { reachabilityRule } from './wiring/unused-detection.js';
import { invokedByDescriptionRule } from './wiring/invoked-by-description.js';
import { unusedTypesRule } from './wiring/unused-types.js';
import { durabilityRule } from './wiring/durability-round-trip.js';
import { untypedSeamRule } from './wiring/untyped-seams.js';
import { proseClaimRule } from './wiring/prose-claims.js';
import { uniqueInvariantIdsRule } from './wiring/unique-invariant-ids.js';
import { invariantBackingRule } from './wiring/invariant-backing.js';
import { invariantReferencesRule } from './wiring/invariant-references.js';
import { eventTopologyRule } from './wiring/event-topology.js';
import { sourceFileLinkageRule } from './conformance/source-file-linkage.js';
import { methodRealizationRule } from './conformance/method-realization.js';
import { findingRealizationRule } from './conformance/finding-realization.js';
import { callConformanceRule } from './conformance/call-conformance.js';
import { hiddenStateRule } from './conformance/hidden-state.js';
import { dependencyConformanceRule } from './conformance/dependency-conformance.js';
import { integrationSimDeclarationRule } from './conformance/integration-sim-declaration.js';
import { integrationSimFileRule } from './conformance/integration-sim-file.js';
import { integrationSimWiringRule } from './conformance/integration-sim-wiring.js';
import { integrationSimCoverageRule } from './conformance/integration-sim-coverage.js';
import { typeRealizationRule } from './conformance/type-realization.js';
import { unclaimedSourceRule } from './conformance/unclaimed-source.js';
import { exportConformanceRule } from './conformance/export-conformance.js';
import { carriedDebtRule } from './conformance/carried-debt.js';
import { couplingRule } from './heuristic/coupling-health.js';
import { signatureLanguageBuiltinsRule } from './heuristic/signature-language-builtins.js';
import { narrativeLanguageConstructsRule } from './heuristic/narrative-language-constructs.js';
import { technologyBindingRule } from './heuristic/technology-binding.js';
import { technologyRule } from './heuristic/technology-boundaries.js';
import { namingRule } from './heuristic/naming-conventions.js';
import { complexityRule } from './heuristic/complexity-and-metadata.js';
import { narrativeComplexityRule } from './heuristic/narrative-complexity.js';
import { namingDisciplineRule } from './heuristic/naming-discipline.js';
import { methodCohesionRule } from './heuristic/method-cohesion.js';

// ---------------------------------------------------------------------------
// Rule repository (rule_store + rule_registry + rule_index + rule_repository).
// The in-memory rule set for one validation run: the built-in rules plus any
// programmatic pack rules, in registration order. A ram-projection — reseeded
// each run, never persisted. `wairon rules list` and the validator read the
// composed run sequence and the aggregate known-code set from here.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// The registry. Order matters only for issue-list readability (hierarchy first,
// heuristics last) — rules are independent.
// ---------------------------------------------------------------------------

export const SDD_RULES: SddRule[] = [
  hierarchyRule,
  // Namespace integrity right after hierarchy: unresolvable/unwritable ids
  // explain many downstream findings, so surface them early in the list. Two
  // questions of the same ids: the segment no id may spend, and the local name
  // that would anchor a bare reference to the root instead.
  reservedIdSegmentsRule,
  namespaceShadowingRule,
  roundtripRule,
  // The type vocabulary in three questions: what a type declares about
  // itself, then the identifiers its fields name, then the ones its
  // contracts' signatures name.
  typeDeclarationsRule,
  fieldTypeReferencesRule,
  signatureTypeReferencesRule,
  // Contracts and the targets narratives name, in four questions with one
  // owner each: does the implementation mirror its contract, does a target
  // inside this tree resolve, does a target that leaves it pin to exactly one
  // declared surface, and does that surface back what the step asks of it.
  contractSymmetryRule,
  narrativeTargetReferencesRule,
  crossTreeReferencesRule,
  surfaceReferenceBackingRule,
  // Vocabulary check right after contracts: an unknown token explains why the
  // consistency findings around it are absent, so surface them together.
  guaranteeTokensRule,
  // Narrative control flow in three questions: does each step carry the
  // config its type requires, can every step be reached (and do the regions
  // nest), and where do the jump edges land. The last two run behind the
  // first's soundness verdict.
  narrativeStepConfigRule,
  narrativeReachabilityRule,
  narrativeJumpEdgesRule,
  // Antipatterns right after flow soundness: they read the same step graphs
  // and only make sense once the graphs are structurally valid. Three things
  // structure alone can prove, in widening scope: a decision that decides
  // nothing, a step cycle nothing leaves, and a call cycle with no guard.
  meaninglessBranchesRule,
  inescapableCyclesRule,
  unconditionalCallCyclesRule,
  // The detail dial in two questions: does a method carry the detail its level
  // promises, and is that level low enough to be hiding something.
  narrativeDetailRule,
  detailSufficiencyRule,
  // Field shape before endpoint bindings: a Portal-only field on the wrong
  // stereotype explains the endpoint findings around it, and this half is
  // spec-scoped so the write boundary refuses it first.
  portalFieldsRule,
  // Endpoints from both sides: a Portal binds every method to its transport,
  // and nothing that is not a Portal may bind one at all.
  portalsRule,
  nonPortalEndpointsRule,
  // Cross-call auth rides with the portal family, in two questions: does a
  // call into an authed Portal present a credential properly, and does the
  // source it names resolve to a provider it is wired to.
  portalCallAuthRule,
  authSourceWiringRule,
  // Dependencies in five questions, one owner each: where an edge is
  // allowed to LAND (the boundary, and what an unresolved id means), then
  // the intra-subsystem matrix by the layer that answers for it — an
  // Orchestrator's declared class, the data blocks, the entry points and
  // the process layer — and finally the Portal read-face guard, the one
  // that reads narratives and dispatch tables rather than dependsOn.
  subsystemBoundaryDepsRule,
  logicDependencyClassRule,
  dataBlockDepsRule,
  entrypointDepsRule,
  portalWriteShortcutRule,
  // Patterns in four questions: who may own and what a claim must name,
  // what each pattern must contain, which data blocks are left standing
  // alone, and who may see a private member.
  patternMembershipRule,
  patternContainmentRule,
  unownedBlocksRule,
  memberVisibilityRule,
  // Facade shape rides with pattern ownership: same §7 doctrine, narrative side.
  facadeForwardingRule,
  // Profiles in three questions, three owners: is the name real (the
  // project's config), does the built-in family doctrine allow this
  // stereotype (wairon), does the pack's declared doctrine allow it (the pack).
  profileRegistrationRule,
  profileStereotypeFencingRule,
  packProfileStereotypesRule,
  patternReferencesRule,
  variantReferencesRule,
  // Pack-instantiated declarative doctrine rides with the pack-reference
  // family: same data source, same provenance-bearing findings. One rule per
  // assertion kind — the kind is what a pack author writes, and each kind
  // asks its own question of its own collection.
  assertionForbiddenEdgesRule,
  assertionRequiredFieldsRule,
  assertionEndpointShapesRule,
  // The published surface in three questions: what backs the entry, whether
  // that component's stereotype can realize the type it declares, and whether
  // the contract it binds is that component's own.
  publicSurfaceBindingRule,
  publicSurfaceDeclaredTypeRule,
  publicSurfaceBoundContractRule,
  cyclesRule,
  // Semantic-edge family: dispatch/lifecycle validity BEFORE reachability so a
  // reader sees the broken edge finding next to the unused-detection fallout
  // it explains.
  dispatchTableBindingsRule,
  dispatchStepRoutingRule,
  lifecycleRule,
  // The declared entrypoint's own prose before the walk that its declaration
  // silences, then the walk, then the types no walk can reach.
  invokedByDescriptionRule,
  reachabilityRule,
  unusedTypesRule,
  // The declaration (spec-scoped, refused at the write boundary) before the
  // round-trip consequences it enables.
  durabilityDeclarationRule,
  // The other spec-scoped stereotype declarations ride with it: a
  // dependencyClass only on an Orchestrator, and no retired stereotype.
  logicDeclarationRule,
  retiredStereotypesRule,
  durabilityRule,
  untypedSeamRule,
  proseClaimRule,
  // Invariant registry rides with the semantic-edge family: declared entity
  // invariants must be asserted on every write path (declarations, not
  // proofs). Three questions of one registry: are the entity's ids unique,
  // does each invariant reach every write path of its owner, and does every
  // asserted reference name something declared.
  uniqueInvariantIdsRule,
  invariantBackingRule,
  invariantReferencesRule,
  // Pub/sub completeness: emitted topics need subscribers and vice versa.
  eventTopologyRule,
  // Code↔spec: structural conformance consumes the injected CodeModel (built
  // by the source analysis adapter next to the surface snapshots) and asks it
  // three questions — does the spec name files that exist, does the file
  // contain the method, does it report the codes the method declares;
  // dependency conformance lifts its import edges onto the declared
  // dependsOn/owns graph.
  sourceFileLinkageRule,
  methodRealizationRule,
  findingRealizationRule,
  // Level 3 opener: narrative call steps must be realized as callees of the
  // realized function (set membership, exact grade).
  callConformanceRule,
  // The fields-vs-Store criterion: mutable module state in logic-only files.
  hiddenStateRule,
  dependencyConformanceRule,
  // Integration wiring proof rides after the code↔spec family: it consumes
  // the same code model and speaks about the same sourcePath modules. Four
  // questions about one harness, in the order a reader meets them: is one
  // expected here, does the declared one exist, does it wire the real
  // modules, does it name every narrated path.
  integrationSimDeclarationRule,
  integrationSimFileRule,
  integrationSimWiringRule,
  integrationSimCoverageRule,
  // The data model's own claim on code, and the question no spec can ask
  // from the spec side: which files are named by nothing at all. Last in
  // the family because the second one reads what all the others named.
  typeRealizationRule,
  unclaimedSourceRule,
  exportConformanceRule,
  couplingRule,
  // Target-language fit in two questions: what a CONTRACT may name, and what
  // a NARRATIVE may describe.
  signatureLanguageBuiltinsRule,
  narrativeLanguageConstructsRule,
  // The declaration before the consequences: which stereotype may bind a
  // technology at all, then where its name may appear.
  technologyBindingRule,
  technologyRule,
  namingRule,
  complexityRule,
  // The doctrine heuristics ride with the structural caps: same subject
  // (size, name, shape), judgements rather than errors, and they read the
  // same complexity dial.
  narrativeComplexityRule,
  namingDisciplineRule,
  methodCohesionRule,
  // Pack resolution and reproducibility run late: they are about project
  // CONFIGURATION (does the declared pack set resolve, and can it be reproduced
  // elsewhere?) rather than spec content.
  packResolutionRule,
  reproducibilityRule,
  // MUST run last, in this order: each audits what the earlier rules did
  // with a declared exception. The debt register first (which carried
  // findings the conformance family actually matched), then the allows
  // (which suppressions any rule actually consumed).
  carriedDebtRule,
  lintAllowsRule,
];

let ruleSet: SddRule[] = [];

/** rule_store: append a rule to the held set (registration order preserved). Repository-internal. */
function addRule(rule: SddRule): void {
  ruleSet.push(rule);
}

/** rule_store: return the held rules in registration order. Repository-internal. */
function listRules(): SddRule[] {
  return ruleSet;
}

/** rule_store: empty the held set, so a new validation run seeds its rules from nothing. Repository-internal. */
function clear(): void {
  ruleSet = [];
}

/** rule_registry: seed the built-in SDD rule set, starting from an empty set so a repeated run never holds a rule twice. */
export function registerBuiltinRules(): void {
  clear();
  for (const rule of SDD_RULES) addRule(rule);
}

/** rule_registry: register programmatic pack rules after the built-ins (project pack order is precedence). */
export function registerPackRules(packRules: SddRule[]): void {
  for (const rule of packRules) addRule(rule);
}

/**
 * rule_index: the ordered run sequence — registration order with the two
 * audits of declared exceptions forced last, debt register before allows.
 * Both read what the earlier rules did, so a pack rule registered after the
 * built-ins must still run before them.
 */
export function ruleSequence(): SddRule[] {
  const audits = [carriedDebtRule, lintAllowsRule].filter(r => ruleSet.includes(r));
  return [...ruleSet.filter(r => !audits.includes(r)), ...audits];
}

/**
 * rule_index: the registered rules that are INTRINSIC to a single spec
 * (`scope: 'spec'`) — those whose verdict reads a spec's own fields and no
 * cross-spec relationship. This is the subset the candidate validator runs
 * against a not-yet-written spec, so the default ('tree') is the safe answer: a
 * rule that has not declared itself intrinsic is never handed a one-spec
 * context. Pack rules participate on the same terms.
 */
export function specScopedRules(): SddRule[] {
  return ruleSequence().filter(r => r.scope === 'spec');
}

/** rule_index: every issue code any registered rule can emit — the lint.allow validation set. */
export function knownIssueCodes(): RuleCode[] {
  return listRules().flatMap(r => r.codes);
}
