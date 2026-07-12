import { describe, it, expect } from 'vitest';
import { isCiDraftWaivable } from '../../src/commands/validate.js';
import type { ValidationIssue } from '../../src/core/validation.js';

// ---------------------------------------------------------------------------
// --ci draft-tolerance policy (validate command)
//
// SDD has an explicit draft → design → complete lifecycle, so the --ci gate
// must waive warnings that merely reflect declared drafts while keeping the
// gate strict for finished work. `isCiDraftWaivable` encodes exactly which
// warnings are excluded from the --ci failure decision. The warnings are still
// emitted/printed — this only classifies the pass/fail decision.
// ---------------------------------------------------------------------------

function warn(code: string, extra: Partial<ValidationIssue> = {}): ValidationIssue {
  return { severity: 'warning', code, message: `${code} message`, ...extra };
}

describe('isCiDraftWaivable (--ci draft tolerance)', () => {
  it('waives DRAFT_COMPONENT_WARNING (it only exists to surface a draft)', () => {
    expect(isCiDraftWaivable(warn('DRAFT_COMPONENT_WARNING', { draftContext: true }))).toBe(true);
    // Robust even if the draftContext flag were ever absent for this code.
    expect(isCiDraftWaivable(warn('DRAFT_COMPONENT_WARNING'))).toBe(true);
  });

  it('waives UNUSED_COMPONENT only when the referenced component is draft/design', () => {
    // Draft/design component → non-fatal.
    expect(isCiDraftWaivable(warn('UNUSED_COMPONENT', { specId: 'draft_store', draftContext: true }))).toBe(true);
    // Complete component (no draftContext) → stays fatal.
    expect(isCiDraftWaivable(warn('UNUSED_COMPONENT', { specId: 'complete_store' }))).toBe(false);
    expect(isCiDraftWaivable(warn('UNUSED_COMPONENT', { specId: 'complete_store', draftContext: false }))).toBe(false);
  });

  it('keeps every other warning fatal in --ci mode, even in a draft context', () => {
    expect(isCiDraftWaivable(warn('MISSING_ENDPOINT', { draftContext: true }))).toBe(false);
    expect(isCiDraftWaivable(warn('UNUSED_METHOD', { draftContext: true }))).toBe(false);
    expect(isCiDraftWaivable(warn('CIRCULAR_DEPENDENCY'))).toBe(false);
  });

  it('never waives an error, regardless of code or draft context', () => {
    expect(isCiDraftWaivable({ severity: 'error', code: 'UNUSED_COMPONENT', message: 'x', draftContext: true })).toBe(false);
    expect(isCiDraftWaivable({ severity: 'error', code: 'DRAFT_COMPONENT_WARNING', message: 'x', draftContext: true })).toBe(false);
  });
});
