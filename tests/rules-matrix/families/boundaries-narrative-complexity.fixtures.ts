/**
 * Narrative-complexity family (src/core/rules/heuristic/narrative-complexity.ts):
 * the two independent narrative axes — the cognitive band a narrative's SHAPE
 * earns, and the number of steps its LENGTH runs to.
 *
 * Documented intents pinned here:
 *  - NARRATIVE_COMPLEXITY (warning): the band is above the one configured to
 *    warn, defaulting to above `moderate`.
 *  - NARRATIVE_COMPLEXITY_OVER_MAX (error): the band is above a configured
 *    `maxCognitiveLevel` — reported ONLY where a maximum is configured.
 *  - EXCESSIVE_NARRATIVE_STEPS (warning): more steps than the limit, which
 *    DEFAULTS to 25 — this axis bites with nothing configured at all.
 *  - NARRATIVE_STEPS_OVER_MAX (error): more steps than a configured
 *    `narrativeStepsHardMax` — reported ONLY where a maximum is configured.
 * Both axes fire only ABOVE the limit; controls sit exactly AT it.
 */
import { defineRuleFixture } from '../harness.js';

const SYSTEM = {
  name: 'Assurely',
  vision: 'Property insurance platform covering quoting, underwriting, claims intake, and settlement.',
};

const CLAIMS_SUB = { id: 'claims', description: 'Claim intake, underwriting review, and settlement decisions.' };

/**
 * The claims-triage orchestrator, whose single reviewClaim narrative varies per
 * fixture — the one thing each scenario is about.
 */
function triageTree(narrative: object[], rules?: Record<string, unknown>) {
  return {
    system: SYSTEM,
    subsystems: [CLAIMS_SUB],
    ...(rules ? { rules } : {}),
    components: [
      { id: 'claim-triage-orchestrator', componentType: 'Orchestrator', description: 'Reviews an incoming claim and decides whether it proceeds to settlement.' },
    ],
    interfaces: [
      {
        id: 'iclaim_triage',
        component: 'claim-triage-orchestrator',
        methods: [{ name: 'reviewClaim', description: 'Review an incoming claim against the underwriting guards.' }],
      },
    ],
    implementations: [
      { id: 'claim_triage_impl', contract: 'iclaim_triage', methods: [{ name: 'reviewClaim', narrative }] },
    ],
  };
}

/**
 * `count` sequential underwriting guards: each one continues to the next on a
 * pass and drops out to the shared rejection on a fail. Cognitive score is the
 * guard count, since none of them nest.
 */
function guards(count: number, checks: string[]): object[] {
  const accept = count + 1;
  const reject = count + 2;
  return [
    ...checks.slice(0, count).map((check, i) => ({
      stepNumber: i + 1,
      type: 'branch',
      description: `Guard ${i + 1}: does the claim satisfy the ${check} rule?`,
      condition: `the claim satisfies the ${check} rule`,
      onTrueStep: i + 2,
      onFalseStep: reject,
    })),
    { stepNumber: accept, type: 'return', description: 'Pass the claim through to settlement.', outcome: 'success' },
    { stepNumber: reject, type: 'return', description: 'Reject the claim and record the failing guard.', outcome: 'failure' },
  ];
}

const CHECKS = [
  'policy-in-force', 'coverage-window', 'deductible', 'peril-covered', 'documentation',
  'prior-claim-history', 'reserve-ceiling', 'fraud-screen', 'adjuster-assignment', 'reinsurance-notice',
];

/** `count` flat intake checks — long, but linear: no branching at all. */
function intake(count: number): object[] {
  const subjects = [
    'policyholder identity', 'policy number', 'coverage window', 'loss date', 'loss location',
    'peril code', 'damage description', 'photo evidence', 'police report', 'repair estimate',
    'contractor licence', 'deductible amount', 'reserve estimate', 'prior claim history', 'lienholder record',
    'mortgagee record', 'contact preferences', 'bank account details', 'tax identifier', 'adjuster availability',
    'catastrophe code', 'reinsurance treaty', 'salvage estimate', 'subrogation lead', 'litigation flag',
    'regulatory notice',
  ];
  return subjects.slice(0, count).map((subject, i) => ({
    stepNumber: i + 1,
    type: 'local',
    description: `Validate the ${subject} recorded on the submitted claim.`,
  }));
}

export default [
  // -------------------------------------------------------------------------
  // NARRATIVE_COMPLEXITY
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'NARRATIVE_COMPLEXITY',
    severity: 'warning',
    anchoredTo: 'claim_triage_impl',
    expectFire: true,
    scenario:
      'The claim-triage review runs ten underwriting guards in one narrative, which lands it in the complex band — above the moderate default.',
    tree: triageTree(guards(10, CHECKS)),
  }),
  defineRuleFixture({
    code: 'NARRATIVE_COMPLEXITY',
    expectFire: false,
    reason: 'Five guards score exactly moderate, and the default warns only ABOVE the moderate band.',
    scenario:
      'The claim-triage review runs five underwriting guards, the rest having moved to the guard orchestrator it calls.',
    tree: triageTree(guards(5, CHECKS)),
  }),

  // -------------------------------------------------------------------------
  // NARRATIVE_COMPLEXITY_OVER_MAX
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'NARRATIVE_COMPLEXITY_OVER_MAX',
    severity: 'error',
    anchoredTo: 'claim_triage_impl',
    expectFire: true,
    scenario:
      'With the cognitive maximum set to simple, the ten-guard claim-triage review lands in the complex band.',
    tree: triageTree(guards(10, CHECKS), { complexity: { maxCognitiveLevel: 'simple' } }),
  }),
  defineRuleFixture({
    code: 'NARRATIVE_COMPLEXITY_OVER_MAX',
    expectFire: false,
    reason: 'Four guards score exactly simple — the configured maximum — and the error fires only above it.',
    scenario:
      'With the cognitive maximum set to simple, the claim-triage review is down to four guards.',
    tree: triageTree(guards(4, CHECKS), { complexity: { maxCognitiveLevel: 'simple' } }),
  }),

  // -------------------------------------------------------------------------
  // EXCESSIVE_NARRATIVE_STEPS — with nothing configured (the default of 25)…
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'EXCESSIVE_NARRATIVE_STEPS',
    severity: 'warning',
    anchoredTo: 'claim_triage_impl',
    expectFire: true,
    scenario:
      'With no complexity dial configured at all, the claim-triage review spells out twenty-six flat intake checks.',
    tree: triageTree(intake(26)),
  }),
  defineRuleFixture({
    code: 'EXCESSIVE_NARRATIVE_STEPS',
    expectFire: false,
    reason: 'Twenty-five steps is exactly the rule\'s own default limit, and the cap fires only above it.',
    scenario:
      'With no complexity dial configured at all, the claim-triage review spells out twenty-five flat intake checks.',
    tree: triageTree(intake(25)),
  }),

  // -------------------------------------------------------------------------
  // …and against a configured maxNarrativeSteps, which replaces the default.
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'EXCESSIVE_NARRATIVE_STEPS',
    severity: 'warning',
    anchoredTo: 'claim_triage_impl',
    expectFire: true,
    scenario:
      'With narratives capped at two steps, the claim-triage review spells out three intake checks.',
    tree: triageTree(intake(3), { complexity: { maxNarrativeSteps: 2 } }),
  }),
  defineRuleFixture({
    code: 'EXCESSIVE_NARRATIVE_STEPS',
    expectFire: false,
    reason: 'The narrative has exactly the configured maximum (2 steps) — the cap fires only above the limit.',
    scenario:
      'With narratives capped at two steps, the claim-triage review validates the policyholder and the policy number.',
    tree: triageTree(intake(2), { complexity: { maxNarrativeSteps: 2 } }),
  }),

  // -------------------------------------------------------------------------
  // NARRATIVE_STEPS_OVER_MAX
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'NARRATIVE_STEPS_OVER_MAX',
    severity: 'error',
    anchoredTo: 'claim_triage_impl',
    expectFire: true,
    scenario:
      'With the hard step maximum set to three, the claim-triage review spells out four intake checks.',
    tree: triageTree(intake(4), { complexity: { narrativeStepsHardMax: 3 } }),
  }),
  defineRuleFixture({
    code: 'NARRATIVE_STEPS_OVER_MAX',
    expectFire: false,
    reason: 'Four steps is exactly the configured hard maximum, and the error fires only above it.',
    scenario:
      'With the hard step maximum set to four, the claim-triage review spells out four intake checks.',
    tree: triageTree(intake(4), { complexity: { narrativeStepsHardMax: 4 } }),
  }),
];
