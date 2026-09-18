import { SddRule } from '../types.js';
import { PATTERN_TYPES, isPattern, isRetired } from '../../../models/index.js';

/**
 * Who may own members, and what a membership claim must name. Only patterns
 * own member blocks; a pattern owns at least one; a claim names a component
 * that exists and is itself a building block; and a block has exactly one
 * owner. What those members must BE is pattern-containment's question.
 */
export const patternMembershipRule: SddRule = {
  name: 'pattern-membership',
  description:
    'Only patterns (Repository/FeatureComponent/RouterComponent) own member blocks, and every pattern owns at least one. Each claim must name a component that exists and is itself a building block — patterns compose at the subsystem (L1) level, never by owning one another — and a block has exactly one owner, the first pattern to claim it.',
  codes: [
    { code: 'EMPTY_PATTERN', defaultSeverity: 'error', summary: 'Pattern with no owned member blocks' },
    { code: 'BLOCK_OWNS_MEMBERS', defaultSeverity: 'error', summary: 'Building block using owns' },
    { code: 'INVALID_OWNED_MEMBER', defaultSeverity: 'error', summary: 'owns names a non-existent component' },
    { code: 'PATTERN_OWNS_PATTERN', defaultSeverity: 'error', summary: 'Pattern owning another pattern' },
    { code: 'SHARED_OWNED_MEMBER', defaultSeverity: 'error', summary: 'Block owned by two patterns' },
  ],
  check(ctx) {
    // A retired component (a Specialist or Gateway) is skipped by both passes:
    // it records no ownership and gets no membership finding — retired-
    // stereotypes reports it once, and its migration decides what its owns
    // becomes.

    // 1. The shape of a component's own `owns`, against its stereotype.
    for (const comp of ctx.components) {
      if (isRetired(comp)) continue;
      const isDraftCtx = ctx.isComponentDraft(comp.id);
      const pattern = isPattern(comp);

      if (pattern && comp.owns.length === 0) {
        ctx.addIssue('error', 'EMPTY_PATTERN', `Pattern "${comp.id}" (${comp.componentType}) must own member blocks via "owns".`, comp.id, isDraftCtx);
      }
      if (!pattern && comp.owns.length > 0) {
        ctx.addIssue('error', 'BLOCK_OWNS_MEMBERS', `Building block "${comp.id}" (${comp.componentType}) cannot own members; only patterns (${Array.from(PATTERN_TYPES).join('/')}) use "owns".`, comp.id, isDraftCtx);
      }
    }

    // 2. Each claim in turn. The tree's ONE ownership reading decides who the
    //    first owner of a member is; its skips (a retired or building-block
    //    claimant records nothing, so do an unresolved member and an inner
    //    pattern) are stated once in read-model.ts.
    const ownership = ctx.ownershipIndex();
    for (const comp of ctx.components) {
      if (isRetired(comp)) continue;
      const isDraftCtx = ctx.isComponentDraft(comp.id);
      const pattern = isPattern(comp);

      for (const memberId of comp.owns) {
        const member = ctx.componentMap.get(memberId);
        if (!member) {
          ctx.addIssue('error', 'INVALID_OWNED_MEMBER', `Component "${comp.id}" owns "${memberId}" which does not exist.`, comp.id, isDraftCtx);
          continue;
        }
        // A building block's owns is wholly the BLOCK_OWNS_MEMBERS finding
        // above: the block records no owner, so a Store or Registry it claims
        // stays standalone for UNOWNED_STORE / REGISTRY_WITHOUT_STORE, and its
        // dependants are judged as if the claim were absent.
        if (!pattern) continue;
        if (isPattern(member)) {
          ctx.addIssue('error', 'PATTERN_OWNS_PATTERN', `Pattern "${comp.id}" owns "${memberId}", which is itself a pattern. Patterns own only building blocks — compose patterns at the subsystem (L1) level.`, comp.id, isDraftCtx);
          // The inner pattern gets no owner: it is composed at L1, so its
          // dependants get no VISIBILITY_VIOLATION on top of this finding.
          continue;
        }
        // The first pattern to claim a member stays its owner, so every later
        // claimant is reported against that first owner.
        const firstOwner = ownership.ownerOf(memberId);
        if (firstOwner && firstOwner !== comp.id) {
          ctx.addIssue('error', 'SHARED_OWNED_MEMBER', `Block "${memberId}" is owned by both "${firstOwner}" and "${comp.id}"; a block has exactly one owner.`, comp.id, isDraftCtx);
        }
      }
    }
  },
};
