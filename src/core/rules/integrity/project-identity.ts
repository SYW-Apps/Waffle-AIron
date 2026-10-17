import { SddRule, type RuleContext } from '../types.js';
import type { ProjectIdentity } from '../../../models/index.js';

// ---------------------------------------------------------------------------
// Project identity: a project is keyed on its id — a lock records it, and from
// stage 2 the declarations other projects make about this one name it — so the
// id must be declared, well-formed and the one the lock approved.
//
// The rule does no I/O. The validator resolves the bound root's identity from
// its configuration against the id its lock recorded (project_config.identity)
// and hands it over in ctx.projectIdentity; each problem kind the identity
// names becomes one finding. There is no identity to judge when the root has no
// readable configuration. A member's id is the family run's to judge
// (family_validator.checkMembers), never this rule's.
//
// The findings name no spec: the identity lives in .wai/project.yaml, which is
// configuration, not a spec. A project tunes them through
// rules.sddRuleSeverity, as it tunes any code.
// ---------------------------------------------------------------------------

export const projectIdentityRule: SddRule = {
  name: 'project-identity',
  judges: 'design',
  description:
    "The bound project is keyed on its id, so the id must be declared, well-formed, stable and its own: a project that declares none answers to its display name slugified until it writes one (PROJECT_ID_DEFAULTED), a project whose name yields no id or whose declared id breaks the grammar has nothing reliable to key on (PROJECT_ID_AMBIGUOUS), an id the rename migration moved from the one the lock approved is owed a re-lock and nothing more (PROJECT_ID_RENAMED: the approved id is one of the configuration's previousIds), and any other id that differs from the one the lock approved has moved under everything that keyed on it (PROJECT_ID_CHANGED). It judges the bound project's own identity only. The family half — a member with a defaulted id (named with its alias as the id to declare), a member with no id, and two members resolving to one id — is a family check (family_validator.checkMembers), which reads the family root's graph.",
  codes: [
    { code: 'PROJECT_ID_AMBIGUOUS', defaultSeverity: 'warning', summary: "Project has no usable id: its name yields no slug, or its declared id breaks the grammar" },
    { code: 'PROJECT_ID_CHANGED', defaultSeverity: 'error', summary: "Project id differs from the id the lock approved" },
    { code: 'PROJECT_ID_DEFAULTED', defaultSeverity: 'notice', summary: "Project declares no id; it answers to one derived from its display name" },
    { code: 'PROJECT_ID_RENAMED', defaultSeverity: 'notice', summary: "Project id was renamed from the id the lock approved; re-lock to approve the new id" },
  ],
  check(ctx) {
    // Step 1: the identity the validator resolved.
    const identity = ctx.projectIdentity;
    // Steps 2-3: no identity of the root's own to judge.
    if (identity) judgeOwnIdentity(ctx, identity);
    // The family half (a member's defaulted or missing id, two members on
    // one id) is a family check since stage 4: family_validator.checkMembers.
    // Step 10: judged.
  },
};

/** Steps 4-9: the bound root's own identity against its configuration and lock. */
function judgeOwnIdentity(ctx: RuleContext, identity: ProjectIdentity): void {
  const problem = (kind: 'defaulted' | 'ambiguous' | 'renamed' | 'changed') => identity.problems.find((p) => p.kind === kind);

  // Steps 4-5: an id derived from the display name.
  if (problem('defaulted')) {
    ctx.addIssue(
      'notice',
      'PROJECT_ID_DEFAULTED',
      `Project "${identity.name}" declares no id in .wai/project.yaml, so it answers to "${identity.id}", derived from its display name — renaming the project would move it. No save writes it for you; declare it with \`id: ${identity.id}\` (a project is keyed on an explicit id).`,
    );
  }
  // Steps 6-7: no usable id.
  const ambiguous = problem('ambiguous');
  if (ambiguous) {
    ctx.addIssue(
      'warning',
      'PROJECT_ID_AMBIGUOUS',
      `Project "${identity.name}" has no usable id: ${ambiguous.detail}. A project id is lower-case letters, digits, "-", "_" and ".", starting and ending with a letter or a digit — declare one in .wai/project.yaml.`,
    );
  }
  // The id the rename migration moved from the approved one (kept in
  // previousIds): only the re-lock is owed, so it never blocks that re-lock.
  if (problem('renamed')) {
    ctx.addIssue(
      'notice',
      'PROJECT_ID_RENAMED',
      `Project "${identity.id}" was renamed from "${identity.lockedId}", the id its lock approved (the old id is kept in previousIds) — the approval is owed until \`wairon lock\` approves the new id, and \`wairon lock-check\` fails until then.`,
    );
  }
  // Steps 8-9: the id moved since the lock approved it.
  if (problem('changed')) {
    const now = identity.id === undefined ? 'no id at all' : `"${identity.id}"`;
    ctx.addIssue(
      'error',
      'PROJECT_ID_CHANGED',
      `Project "${identity.name}" now resolves to ${now}, but its lock approved "${identity.lockedId}" — everything keyed on the approved id no longer finds this project. Restore \`id: ${identity.lockedId}\` in .wai/project.yaml, or rename deliberately and re-lock.`,
    );
  }
}
