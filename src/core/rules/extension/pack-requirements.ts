import { SddRule } from '../types.js';
import { rangeProblem } from '../../../models/project.js';

/**
 * Reports a requirement in the bound project's own `composition.requirePolicies`
 * that cannot be read: no pack name, or a semver range that does not parse.
 *
 * An error on the REQUIRING project's own gate, because the requirement is its
 * own configuration: until it parses, the family run cannot judge any member
 * against it, and a requirement nobody can judge must not look like one that
 * holds. Only the syntax is judged here — whether members adopt the
 * requirement is the family run's question — and nothing here reads a
 * parent's requirements, so a member's own verdict never depends on them.
 */
export const packRequirementsRule: SddRule = {
  name: 'pack-requirements',
  judges: 'design',
  description:
    'Every requirement in the bound project\'s own composition.requirePolicies must be readable: a pack name and a semver range that parses (pack_requirement.rangeProblem). One that does not is POLICY_REQUIREMENT_INVALID, quoting the range and the unreadable token — an error on the requiring project\'s own gate, because the requirement is its own configuration and the family run cannot judge a member against it. It judges only the syntax: whether members adopt the requirement is the family run\'s question (family_validator.adoption), and nothing here reads a parent\'s requirements.',
  codes: [
    { code: 'POLICY_REQUIREMENT_INVALID', defaultSeverity: 'error', summary: 'A project\'s composition.requirePolicies names a pack range that does not parse' },
  ],
  check(ctx) {
    // Step 1: every requirement the bound project's own configuration declares.
    for (const requirement of ctx.ext.packRequirements) {
      // Step 2: a pack name and a readable range?
      const problem = requirement.pack.trim() === '' ? 'it names no pack' : rangeProblem(requirement);
      if (problem === null) continue;
      // Step 3: the requirement cannot be judged until it parses.
      const which = requirement.pack.trim() === '' ? 'A requirement' : `The requirement for pack "${requirement.pack}"`;
      ctx.addIssue(
        'error',
        'POLICY_REQUIREMENT_INVALID',
        `${which} in composition.requirePolicies cannot be read: range "${requirement.version}" — ${problem}. The family run cannot judge any member against it until it parses; write an exact version (1.2.0), a caret or tilde range (^1.2, ~1.2.3), an x-range (1.x, *), a comparator set (>=1.2.0 <2.0.0) or alternatives joined by \`||\`.`,
      );
      // Step 4: this requirement is judged.
    }
  },
};
