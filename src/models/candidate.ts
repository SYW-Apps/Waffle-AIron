import type { ValidationIssue } from '../core/validation.js';

// ---------------------------------------------------------------------------
// The write gate's verdict on one component candidate (type candidate_verdict).
//
// It lives with the data model, not with the validator that produces it: the
// authoring seam in another subsystem receives one and has to say it back to an
// agent, and a method travels with its type — a caller that can be handed a
// verdict must be able to render one without reaching into the validator.
// ---------------------------------------------------------------------------

/**
 * A candidate's verdict, split by severity — errors refuse the write; warnings
 * and notices ride along as the write's notices, each list kept apart.
 */
export interface CandidateVerdict {
  /** Intrinsic violations. The write must be refused; each names its rule code. */
  errors: ValidationIssue[];
  /** Intrinsic advisories (e.g. MISSING_DURABILITY). Surface, but never block. */
  warnings: ValidationIssue[];
  /** Intrinsic findings the project set to notice severity. Surface beside the warnings, never block. */
  notices: ValidationIssue[];
}

/**
 * candidate_verdict.formatCandidateRefusal — the refusal an agent reads: the
 * codes, the messages, and the remedy. Written as one message because the
 * caller's channel is a tool error string — and it names `unset` explicitly,
 * since "remove the field" is the fix an agent most often cannot guess.
 */
export function formatCandidateRefusal(verdict: CandidateVerdict): string {
  const lines = verdict.errors.map(e => `- ${e.code}: ${e.message}`);
  return `Refused: this component's fields do not match its componentType.\n${lines.join('\n')}\n\n`
    + 'Nothing was written. Fix the fields and retry — on an EXISTING spec, remove a field with '
    + 'sdd_update_spec\'s "unset" (e.g. {"unset": ["basePath"]}); passing null leaves it in place.';
}
