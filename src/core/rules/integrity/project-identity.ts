import { SddRule } from '../types.js';

// ---------------------------------------------------------------------------
// Project identity: a project is keyed on its id — a lock records it, and from
// stage 2 the declarations other projects make about this one name it — so the
// id must be declared, well-formed and the one the lock approved.
//
// The rule does no I/O. The validator resolves the bound root's identity from
// its configuration against the id its lock recorded (project_config.identity)
// and hands it over in ctx.projectIdentity; each problem kind the identity
// names becomes one finding. There is no identity to judge when the root has no
// readable configuration, or on the run that is the parent's verdict on a
// chained child — that run judges the child's specs, not the parent's identity.
//
// The findings name no spec: the identity lives in .wai/project.yaml, which is
// configuration, not a spec. A project tunes them through
// rules.sddRuleSeverity, as it tunes any code.
// ---------------------------------------------------------------------------

export const projectIdentityRule: SddRule = {
  name: 'project-identity',
  description:
    'A project is keyed on its id, so the id must be declared, well-formed and stable: a project that declares none answers to one derived from its display name until it writes one (PROJECT_ID_DEFAULTED), a project whose name yields no id or whose declared id breaks the grammar has nothing reliable to key on (PROJECT_ID_AMBIGUOUS), and an id that differs from the one the lock approved has moved under everything that keyed on it (PROJECT_ID_CHANGED).',
  codes: [
    { code: 'PROJECT_ID_DEFAULTED', defaultSeverity: 'notice', summary: 'Project declares no id; it answers to one derived from its display name' },
    { code: 'PROJECT_ID_AMBIGUOUS', defaultSeverity: 'warning', summary: 'Project has no usable id: its name yields no slug, or its declared id breaks the grammar' },
    { code: 'PROJECT_ID_CHANGED', defaultSeverity: 'error', summary: 'Project id differs from the id the lock approved' },
  ],
  check(ctx) {
    // Step 1: the identity the validator resolved.
    const identity = ctx.projectIdentity;
    // Steps 2-3: nothing to judge.
    if (!identity) return;
    const problem = (kind: 'defaulted' | 'ambiguous' | 'changed') => identity.problems.find((p) => p.kind === kind);

    // Steps 4-5: an id derived from the display name.
    if (problem('defaulted')) {
      ctx.addIssue(
        'notice',
        'PROJECT_ID_DEFAULTED',
        `Project "${identity.name}" declares no id in .wai/project.yaml, so it answers to "${identity.id}", derived from its display name — renaming the project would move it. No save writes it for you; declare it with \`id: ${identity.id}\` (stage 3 requires an explicit id).`,
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
    // Steps 8-9: the id moved since the lock approved it.
    if (problem('changed')) {
      const now = identity.id === undefined ? 'no id at all' : `"${identity.id}"`;
      ctx.addIssue(
        'error',
        'PROJECT_ID_CHANGED',
        `Project "${identity.name}" now resolves to ${now}, but its lock approved "${identity.lockedId}" — everything keyed on the approved id no longer finds this project. Restore \`id: ${identity.lockedId}\` in .wai/project.yaml, or rename deliberately and re-lock.`,
      );
    }
    // Step 10: judged.
  },
};
