/**
 * Narrative-flow family (src/core/rules/narrative-flow.ts): structural
 * soundness of L5 control flow. Flow steps carry their required config, every
 * jump lands on a real step, every step is reachable, loop/try/parallel
 * regions nest or stay disjoint and are entered through their header, try
 * bodies do not fall through into their handlers on the success path, and
 * backward jumps are only idiomatic as a continue to an enclosing loop header.
 */
import { defineRuleFixture } from '../harness.js';

/** Shared miniature system: one customs-clearance orchestrator whose method narrative varies per fixture. */
function customsTree(narrative: object[]) {
  return {
    subsystems: [{ id: 'customs', description: 'Customs declaration filing for cross-border parcels.' }],
    components: [
      {
        id: 'customs-clearance-orchestrator',
        componentType: 'Orchestrator',
        description: 'Files customs declarations for outbound parcels.',
      },
    ],
    interfaces: [
      {
        id: 'icustoms_clearance_orchestrator',
        component: 'customs-clearance-orchestrator',
        methods: [{ name: 'fileDeclaration', description: 'File the customs declaration for one outbound parcel.' }],
      },
    ],
    implementations: [
      {
        id: 'customs_clearance_orchestrator_impl',
        contract: 'icustoms_clearance_orchestrator',
        methods: [{ name: 'fileDeclaration', narrative }],
      },
    ],
  };
}

export default [
  // -------------------------------------------------------------------------
  // MALFORMED_FLOW_STEP
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'MALFORMED_FLOW_STEP',
    severity: 'error',
    anchoredTo: 'customs_clearance_orchestrator_impl',
    expectFire: true,
    scenario:
      'The customs branch step decides whether the destination requires documents but carries no onFalseStep, so the false arm of the decision is unspecified.',
    tree: customsTree([
      { stepNumber: 1, type: 'local', description: 'Look up the customs profile for the destination country.' },
      { stepNumber: 2, type: 'branch', description: 'Decide whether the destination requires customs documents.', condition: 'the destination requires customs documents' },
      { stepNumber: 3, type: 'local', description: 'Attach the generated customs documents to the parcel.' },
      { stepNumber: 4, type: 'return', description: 'Report the declaration filed.', outcome: 'success' },
    ]),
  }),
  defineRuleFixture({
    code: 'MALFORMED_FLOW_STEP',
    expectFire: false,
    reason: 'The branch carries its condition and both arm targets, so the flow config is complete.',
    scenario:
      'The customs branch step routes document-requiring destinations to the attach step and all others straight to the filing return.',
    tree: customsTree([
      { stepNumber: 1, type: 'local', description: 'Look up the customs profile for the destination country.' },
      { stepNumber: 2, type: 'branch', description: 'Decide whether the destination requires customs documents.', condition: 'the destination requires customs documents', onTrueStep: 3, onFalseStep: 4 },
      { stepNumber: 3, type: 'local', description: 'Attach the generated customs documents to the parcel.' },
      { stepNumber: 4, type: 'return', description: 'Report the declaration filed.', outcome: 'success' },
    ]),
  }),

  // -------------------------------------------------------------------------
  // INVALID_STEP_JUMP
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'INVALID_STEP_JUMP',
    severity: 'error',
    anchoredTo: 'customs_clearance_orchestrator_impl',
    expectFire: true,
    scenario:
      'The oversize-parcel branch jumps its false arm to step 9, but the narrative has no step 9 — the jump target does not exist.',
    tree: customsTree([
      { stepNumber: 1, type: 'local', description: 'Measure the parcel against the oversize thresholds.' },
      { stepNumber: 2, type: 'branch', description: 'Route oversize parcels to the freight declaration path.', condition: 'the parcel is oversize', onTrueStep: 3, onFalseStep: 9 },
      { stepNumber: 3, type: 'local', description: 'File the freight-class customs declaration.' },
      { stepNumber: 4, type: 'return', description: 'Report the declaration filed.', outcome: 'success' },
    ]),
  }),
  defineRuleFixture({
    code: 'INVALID_STEP_JUMP',
    expectFire: false,
    reason: 'Both arm targets name existing steps of the narrative.',
    scenario:
      'The oversize-parcel branch routes its false arm to the existing standard-declaration return step.',
    tree: customsTree([
      { stepNumber: 1, type: 'local', description: 'Measure the parcel against the oversize thresholds.' },
      { stepNumber: 2, type: 'branch', description: 'Route oversize parcels to the freight declaration path.', condition: 'the parcel is oversize', onTrueStep: 3, onFalseStep: 4 },
      { stepNumber: 3, type: 'local', description: 'File the freight-class customs declaration.' },
      { stepNumber: 4, type: 'return', description: 'Report the declaration filed.', outcome: 'success' },
    ]),
  }),

  // -------------------------------------------------------------------------
  // DUPLICATE_STEP_LABEL
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'DUPLICATE_STEP_LABEL',
    severity: 'error',
    anchoredTo: 'customs_clearance_orchestrator_impl',
    expectFire: true,
    scenario:
      'Two steps carry the label "filed" — the symbolic anchor a later delta addresses a step by, so every reference to it is ambiguous.',
    tree: customsTree([
      { stepNumber: 1, type: 'local', description: 'Measure the parcel against the oversize thresholds.' },
      { stepNumber: 2, type: 'local', label: 'filed', description: 'File the freight-class customs declaration.' },
      { stepNumber: 3, type: 'local', label: 'filed', description: 'File the standard customs declaration.' },
      { stepNumber: 4, type: 'return', description: 'Report the declaration filed.', outcome: 'success' },
    ]),
  }),
  defineRuleFixture({
    code: 'DUPLICATE_STEP_LABEL',
    expectFire: false,
    reason: 'Each label anchors exactly one step, so every symbolic reference resolves to one place.',
    scenario:
      'The two declaration steps carry distinct labels.',
    tree: customsTree([
      { stepNumber: 1, type: 'local', description: 'Measure the parcel against the oversize thresholds.' },
      { stepNumber: 2, type: 'local', label: 'filed-freight', description: 'File the freight-class customs declaration.' },
      { stepNumber: 3, type: 'local', label: 'filed-standard', description: 'File the standard customs declaration.' },
      { stepNumber: 4, type: 'return', description: 'Report the declaration filed.', outcome: 'success' },
    ]),
  }),

  // -------------------------------------------------------------------------
  // UNREACHABLE_STEP
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'UNREACHABLE_STEP',
    severity: 'warning',
    anchoredTo: 'customs_clearance_orchestrator_impl',
    expectFire: true,
    scenario:
      'The broker-notification step sits after the return terminator and nothing jumps to it, so the step is dead code in the narrative.',
    tree: customsTree([
      { stepNumber: 1, type: 'local', description: 'Compute the customs value of the shipment.' },
      { stepNumber: 2, type: 'return', description: 'Report the declaration filed.', outcome: 'success' },
      { stepNumber: 3, type: 'local', description: 'Notify the customs broker of the filed declaration.' },
    ]),
  }),
  defineRuleFixture({
    code: 'UNREACHABLE_STEP',
    expectFire: false,
    reason: 'A branch routes flow into the notification step, so every step is reachable from the entry.',
    scenario:
      'A branch decides whether the customs broker needs notifying, keeping the notification step on a live path.',
    tree: customsTree([
      { stepNumber: 1, type: 'local', description: 'Compute the customs value of the shipment.' },
      { stepNumber: 2, type: 'branch', description: 'Decide whether the broker needs a notification.', condition: 'the shipment uses a customs broker', onTrueStep: 3, onFalseStep: 4 },
      { stepNumber: 3, type: 'local', description: 'Notify the customs broker of the filed declaration.' },
      { stepNumber: 4, type: 'return', description: 'Report the declaration filed.', outcome: 'success' },
    ]),
  }),

  // -------------------------------------------------------------------------
  // REGION_OVERLAP
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'REGION_OVERLAP',
    severity: 'error',
    anchoredTo: 'customs_clearance_orchestrator_impl',
    expectFire: true,
    scenario:
      'The per-parcel loop body ends at step 5 while the carrier-timeout try region opened at step 4 runs on to step 7 — the two regions interleave and cannot map onto structured code.',
    tree: customsTree([
      { stepNumber: 1, type: 'local', description: 'Collect the pending parcels for the outbound truck.' },
      { stepNumber: 2, type: 'loop', description: 'Process each pending parcel.', loopKind: 'forEach', over: 'the pending parcels', endStep: 5 },
      { stepNumber: 3, type: 'local', description: 'Compute the parcel customs value.' },
      { stepNumber: 4, type: 'try', description: 'Guard the carrier filing call.', endStep: 7, catches: [{ error: 'CarrierTimeout', step: 8 }] },
      { stepNumber: 5, type: 'local', description: 'Build the parcel declaration payload.' },
      { stepNumber: 6, type: 'local', description: 'Submit the declaration to the carrier gateway.' },
      { stepNumber: 7, type: 'local', description: 'Record the carrier confirmation number.' },
      { stepNumber: 8, type: 'local', description: 'Queue the declaration for manual retry after a timeout.' },
      { stepNumber: 9, type: 'return', description: 'Report the batch filed.', outcome: 'success' },
    ]),
  }),
  defineRuleFixture({
    code: 'REGION_OVERLAP',
    expectFire: false,
    reason: 'The try region is fully nested inside the loop body, so the regions map onto structured code.',
    scenario:
      'The carrier-timeout try region nests entirely inside the per-parcel loop body, with the success path jumping past the handler.',
    tree: customsTree([
      { stepNumber: 1, type: 'local', description: 'Collect the pending parcels for the outbound truck.' },
      { stepNumber: 2, type: 'loop', description: 'Process each pending parcel.', loopKind: 'forEach', over: 'the pending parcels', endStep: 7 },
      { stepNumber: 3, type: 'local', description: 'Compute the parcel customs value.' },
      { stepNumber: 4, type: 'try', description: 'Guard the carrier filing call.', endStep: 6, catches: [{ error: 'CarrierTimeout', step: 7 }] },
      { stepNumber: 5, type: 'local', description: 'Submit the declaration to the carrier gateway.' },
      { stepNumber: 6, type: 'jump', description: 'Skip the timeout handler on the success path.', toStep: 8 },
      { stepNumber: 7, type: 'local', description: 'Queue the declaration for manual retry after a timeout.' },
      { stepNumber: 8, type: 'return', description: 'Report the batch filed.', outcome: 'success' },
    ]),
  }),

  // -------------------------------------------------------------------------
  // JUMP_INTO_REGION
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'JUMP_INTO_REGION',
    severity: 'warning',
    anchoredTo: 'customs_clearance_orchestrator_impl',
    expectFire: true,
    scenario:
      'The cached-manifest branch jumps straight into the middle of the manifest-page loop body, bypassing the loop header that owns the region.',
    tree: customsTree([
      { stepNumber: 1, type: 'branch', description: 'Skip ahead when a cached manifest already exists.', condition: 'a cached manifest exists', onTrueStep: 4, onFalseStep: 2 },
      { stepNumber: 2, type: 'loop', description: 'Fetch each manifest page from the carrier.', loopKind: 'forEach', over: 'the manifest pages', endStep: 4 },
      { stepNumber: 3, type: 'local', description: 'Fetch the next manifest page.' },
      { stepNumber: 4, type: 'local', description: 'Merge the page into the working manifest.' },
      { stepNumber: 5, type: 'return', description: 'Report the manifest assembled.', outcome: 'success' },
    ]),
  }),
  defineRuleFixture({
    code: 'JUMP_INTO_REGION',
    expectFire: false,
    reason: 'The cached-manifest branch lands after the loop region, so the region is only ever entered through its header.',
    scenario:
      'The cached-manifest branch skips the whole manifest-page loop and lands on the assembled-manifest return.',
    tree: customsTree([
      { stepNumber: 1, type: 'branch', description: 'Skip the fetch loop when a cached manifest already exists.', condition: 'a cached manifest exists', onTrueStep: 5, onFalseStep: 2 },
      { stepNumber: 2, type: 'loop', description: 'Fetch each manifest page from the carrier.', loopKind: 'forEach', over: 'the manifest pages', endStep: 4 },
      { stepNumber: 3, type: 'local', description: 'Fetch the next manifest page.' },
      { stepNumber: 4, type: 'local', description: 'Merge the page into the working manifest.' },
      { stepNumber: 5, type: 'return', description: 'Report the manifest assembled.', outcome: 'success' },
    ]),
  }),

  // -------------------------------------------------------------------------
  // FALLTHROUGH_INTO_HANDLER
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'FALLTHROUGH_INTO_HANDLER',
    severity: 'warning',
    anchoredTo: 'customs_clearance_orchestrator_impl',
    expectFire: true,
    scenario:
      'The guarded rate-table fetch ends its body on a plain local step that falls straight into the fallback handler, so the fallback would also run on every SUCCESS.',
    tree: customsTree([
      { stepNumber: 1, type: 'try', description: 'Guard the remote rate-table refresh.', endStep: 2, catches: [{ error: 'any', step: 3 }] },
      { stepNumber: 2, type: 'local', description: 'Fetch and apply the remote customs rate table.' },
      { stepNumber: 3, type: 'local', description: 'Fall back to the cached customs rate table.' },
      { stepNumber: 4, type: 'return', description: 'Report the rate table ready.', outcome: 'success' },
    ]),
  }),
  defineRuleFixture({
    code: 'FALLTHROUGH_INTO_HANDLER',
    expectFire: false,
    reason: 'The try body ends with a return, so the handler region only runs on the error path.',
    scenario:
      'The guarded rate-table fetch returns on success, leaving the cached-table fallback to the error path alone.',
    tree: customsTree([
      { stepNumber: 1, type: 'try', description: 'Guard the remote rate-table refresh.', endStep: 2, catches: [{ error: 'any', step: 3 }] },
      { stepNumber: 2, type: 'return', description: 'Report the freshly fetched rate table ready.', outcome: 'success' },
      { stepNumber: 3, type: 'local', description: 'Fall back to the cached customs rate table.' },
      { stepNumber: 4, type: 'return', description: 'Report the cached rate table ready.', outcome: 'success' },
    ]),
  }),

  // -------------------------------------------------------------------------
  // BACKWARD_JUMP
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'BACKWARD_JUMP',
    severity: 'warning',
    anchoredTo: 'customs_clearance_orchestrator_impl',
    expectFire: true,
    scenario:
      'The failed-lookup branch jumps backwards to the quote request with no loop header in sight — an unstructured retry loop in disguise.',
    tree: customsTree([
      { stepNumber: 1, type: 'local', description: 'Request a fresh duty quote from the carrier.' },
      { stepNumber: 2, type: 'local', description: 'Validate the duty quote response.' },
      { stepNumber: 3, type: 'branch', description: 'Retry the quote when the rate lookup failed.', condition: 'the rate lookup failed', onTrueStep: 1, onFalseStep: 4 },
      { stepNumber: 4, type: 'return', description: 'Report the duty quote accepted.', outcome: 'success' },
    ]),
  }),
  defineRuleFixture({
    code: 'BACKWARD_JUMP',
    expectFire: false,
    reason: 'The backward jump is a continue to the enclosing loop header — the one idiomatic backward edge.',
    scenario:
      'The duty-quote retry is modeled as a while loop whose body jumps back to the loop header to re-check staleness.',
    tree: customsTree([
      { stepNumber: 1, type: 'loop', description: 'Retry while the duty quote is stale.', loopKind: 'while', condition: 'the duty quote is stale', endStep: 3 },
      { stepNumber: 2, type: 'local', description: 'Request a fresh duty quote from the carrier.' },
      { stepNumber: 3, type: 'jump', description: 'Continue with the next staleness check.', toStep: 1 },
      { stepNumber: 4, type: 'return', description: 'Report the duty quote accepted.', outcome: 'success' },
    ]),
  }),
];
