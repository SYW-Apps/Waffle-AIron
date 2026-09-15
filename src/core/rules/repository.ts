import { SddRule, RuleCode } from './types.js';

import { hierarchyRule } from './integrity/hierarchy-integrity.js';
import { namespaceHygieneRule } from './integrity/namespace-hygiene.js';
import { roundtripRule } from './integrity/roundtrip-serialization.js';
import { typeReferencesRule } from './integrity/type-references.js';
import { publicSurfaceRule } from './integrity/public-surface.js';
import { lintAllowsRule } from './integrity/lint-allows.js';
import { contractsRule } from './narrative/contract-symmetry-and-narratives.js';
import { guaranteeTokensRule } from './narrative/guarantee-tokens.js';
import { narrativeFlowRule } from './narrative/narrative-flow.js';
import { narrativeAntipatternsRule } from './narrative/narrative-antipatterns.js';
import { narrativeDetailRule } from './narrative/narrative-detail.js';
import { portalFieldsRule } from './intrinsic/portal-fields.js';
import { durabilityDeclarationRule } from './intrinsic/durability-declaration.js';
import { portalsRule } from './doctrine/portal-endpoints.js';
import { portalCallAuthRule } from './doctrine/portal-call-auth.js';
import { stereotypeDepsRule } from './doctrine/stereotype-dependencies.js';
import { patternsRule } from './doctrine/pattern-ownership.js';
import { facadeForwardingRule } from './doctrine/facade-forwarding.js';
import { profilesRule } from './extension/architectural-profiles.js';
import { patternReferencesRule } from './extension/pattern-references.js';
import { variantReferencesRule } from './extension/component-variants.js';
import { declarativeAssertionsRule } from './extension/declarative-assertions.js';
import { packResolutionRule } from './extension/pack-resolution.js';
import { reproducibilityRule } from './extension/pack-reproducibility.js';
import { cyclesRule } from './wiring/dependency-cycles.js';
import { dispatchRule } from './wiring/dispatch-tables.js';
import { lifecycleRule } from './wiring/lifecycle-entrypoints.js';
import { reachabilityRule } from './wiring/unused-detection.js';
import { durabilityRule } from './wiring/durability-round-trip.js';
import { untypedSeamRule } from './wiring/untyped-seams.js';
import { proseClaimRule } from './wiring/prose-claims.js';
import { invariantBackingRule } from './wiring/invariant-backing.js';
import { eventTopologyRule } from './wiring/event-topology.js';
import { structuralConformanceRule } from './conformance/structural-conformance.js';
import { callConformanceRule } from './conformance/call-conformance.js';
import { hiddenStateRule } from './conformance/hidden-state.js';
import { dependencyConformanceRule } from './conformance/dependency-conformance.js';
import { integrationConformanceRule } from './conformance/integration-conformance.js';
import { couplingRule } from './heuristic/coupling-health.js';
import { languageRule } from './heuristic/target-language.js';
import { technologyRule } from './heuristic/technology-boundaries.js';
import { namingRule } from './heuristic/naming-conventions.js';
import { complexityRule } from './heuristic/complexity-and-metadata.js';

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
  // explain many downstream findings, so surface them early in the list.
  namespaceHygieneRule,
  roundtripRule,
  typeReferencesRule,
  contractsRule,
  // Vocabulary check right after contracts: an unknown token explains why the
  // consistency findings around it are absent, so surface them together.
  guaranteeTokensRule,
  narrativeFlowRule,
  // Antipatterns right after flow soundness: they analyze the same step
  // graphs and only make sense once the graphs are structurally valid.
  narrativeAntipatternsRule,
  narrativeDetailRule,
  // Field shape before endpoint bindings: a Portal-only field on the wrong
  // stereotype explains the endpoint findings around it, and this half is
  // spec-scoped so the write boundary refuses it first.
  portalFieldsRule,
  portalsRule,
  // Cross-call auth: a narrative call into an authed Portal must name its
  // credential source (rides with the portal family).
  portalCallAuthRule,
  stereotypeDepsRule,
  patternsRule,
  // Facade shape rides with pattern ownership: same §7 doctrine, narrative side.
  facadeForwardingRule,
  profilesRule,
  patternReferencesRule,
  variantReferencesRule,
  // Pack-instantiated declarative doctrine rides with the pack-reference
  // family: same data source, same provenance-bearing findings.
  declarativeAssertionsRule,
  publicSurfaceRule,
  cyclesRule,
  // Semantic-edge family: dispatch/lifecycle validity BEFORE reachability so a
  // reader sees the broken edge finding next to the unused-detection fallout
  // it explains.
  dispatchRule,
  lifecycleRule,
  reachabilityRule,
  // The declaration (spec-scoped, refused at the write boundary) before the
  // round-trip consequences it enables.
  durabilityDeclarationRule,
  durabilityRule,
  untypedSeamRule,
  proseClaimRule,
  // Invariant registry rides with the semantic-edge family: declared entity
  // invariants must be asserted on every write path (declarations, not proofs).
  invariantBackingRule,
  // Pub/sub completeness: emitted topics need subscribers and vice versa.
  eventTopologyRule,
  // Code↔spec: structural conformance consumes the injected CodeModel (built
  // by the source analysis adapter next to the surface snapshots); dependency
  // conformance lifts its import edges onto the declared dependsOn/owns graph.
  structuralConformanceRule,
  // Level 3 opener: narrative call steps must be realized as callees of the
  // realized function (set membership, exact grade).
  callConformanceRule,
  // The fields-vs-Store criterion: mutable module state in logic-only files.
  hiddenStateRule,
  dependencyConformanceRule,
  // Integration wiring proof rides after the code↔spec family: it consumes
  // the same code model and speaks about the same sourcePath modules.
  integrationConformanceRule,
  couplingRule,
  languageRule,
  technologyRule,
  namingRule,
  complexityRule,
  // Pack resolution and reproducibility run late: they are about project
  // CONFIGURATION (does the declared pack set resolve, and can it be reproduced
  // elsewhere?) rather than spec content.
  packResolutionRule,
  reproducibilityRule,
  // MUST run last: it audits which lint.allow entries the earlier rules
  // actually consumed (stale/unknown allows).
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

/** rule_index: the ordered run sequence — registration order with the lint-allows audit forced last. */
export function ruleSequence(): SddRule[] {
  const base = ruleSet.filter(r => r !== lintAllowsRule);
  return ruleSet.includes(lintAllowsRule) ? [...base, lintAllowsRule] : base;
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
