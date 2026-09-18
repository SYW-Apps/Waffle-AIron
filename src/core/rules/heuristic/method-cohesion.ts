import type { ComponentSpec, ImplementationSpec, NarrativeStep } from '../../../models/index.js';
import { SddRule } from '../types.js';

// ---------------------------------------------------------------------------
// An Orchestrator is a workflow's one place: its methods drive the same
// collaborators towards the same outcome. When they split into groups that
// call NOTHING in common, the component is two components sharing a file —
// the classic "and" in a responsibility. Judged from the narratives' own call
// and dispatch edges, so it measures what the flows actually do rather than
// what the dependsOn list permits.
//
// Deliberately conservative in two ways:
//   - a group of one is a single specialized method beside a cohesive set,
//     which is normal, so only groups of two or more count;
//   - a PURE FORWARDER is exempt. A component whose every narrated method is
//     a single hand-off holds no responsibility of its own — the one it
//     forwards to does — so there is no cohesion to judge, and its methods
//     reach different components precisely because it is a switchboard. Same
//     reasoning as the stutter check's Adapter/Portal exemption, and the same
//     shape §7 already calls pure 1:1 forwarding on a Repository facade.
// ---------------------------------------------------------------------------

/** One Orchestrator's methods, each with the components its narrative reaches. */
interface Cohesion {
  implementation: ImplementationSpec;
  component: ComponentSpec;
  calledBy: Map<string, Set<string>>;
}

/** The connected groups of methods linked by a shared called component (union-find, read off as sets). */
function groupsSharingCollaborators(calledBy: Map<string, Set<string>>): string[][] {
  const parent = new Map<string, string>();
  const find = (m: string): string => {
    let root = m;
    while (parent.get(root) !== root) root = parent.get(root) as string;
    return root;
  };
  const union = (a: string, b: string): void => {
    const [ra, rb] = [find(a), find(b)];
    if (ra !== rb) parent.set(ra, rb);
  };

  const methods = [...calledBy.keys()];
  for (const m of methods) parent.set(m, m);
  for (let i = 0; i < methods.length; i++) {
    for (let j = i + 1; j < methods.length; j++) {
      const shares = [...(calledBy.get(methods[i]) as Set<string>)].some(c => calledBy.get(methods[j])?.has(c));
      if (shares) union(methods[i], methods[j]);
    }
  }

  const groups = new Map<string, string[]>();
  for (const m of methods) {
    const root = find(m);
    groups.set(root, [...(groups.get(root) ?? []), m]);
  }
  return [...groups.values()];
}

/**
 * Whether a method does nothing but hand off: exactly one `call`/`dispatch`
 * step, and no step beside it but the `return` that names the outcome. A
 * `local` step is in-component work, and a flow step is a decision — either
 * means the method does something of its own, so it is not a forwarder.
 */
function isForwardingMethod(narrative: NarrativeStep[]): boolean {
  let handoffs = 0;
  for (const step of narrative) {
    if (step.type === 'call' || step.type === 'dispatch') handoffs++;
    else if (step.type !== 'return') return false;
  }
  return handoffs === 1;
}

export const methodCohesionRule: SddRule = {
  name: 'method-cohesion',
  description:
    'An Orchestrator\'s methods share collaborators; when they split into groups that call no component in common, the component holds more than one responsibility. Reported only where two or more groups each hold two or more methods, so a single specialized method is not a finding — and never on a pure forwarder, whose every narrated method is a single hand-off and whose responsibility therefore lives in what it forwards to.',
  codes: [
    { code: 'INCOHESIVE_METHODS', defaultSeverity: 'warning', summary: 'Orchestrator\'s methods form two or more groups of two or more that share no called component' },
  ],
  check(ctx) {
    // 1. The call picture per Orchestrator: which components each method
    //    reaches. `register` hands over a callback rather than driving a
    //    collaborator, so only call and dispatch edges count, and a method
    //    that reaches nobody says nothing about cohesion either way.
    const subjects: Cohesion[] = [];
    for (const impl of ctx.implementations) {
      const intf = ctx.interfaceMap.get(impl.contract);
      const comp = intf ? ctx.componentMap.get(intf.component) : undefined;
      if (!comp || comp.componentType !== 'Orchestrator') continue;

      // A pure forwarder answers for no cohesion of its own. Judged over the
      // methods that carry an authored narrative — an unnarrated method is the
      // detail dial's business, not this rule's — so a switchboard whose every
      // hand-off is a single call is never accused of holding two
      // responsibilities, and one method of real logic is enough to be judged.
      const narrated = impl.methods.filter(m => (m.narrative ?? []).length > 0);
      if (narrated.length > 0 && narrated.every(m => isForwardingMethod(m.narrative ?? []))) continue;

      const calledBy = new Map<string, Set<string>>();
      for (const method of impl.methods) {
        const reached = new Set<string>();
        for (const step of method.narrative ?? []) {
          if ((step.type === 'call' || step.type === 'dispatch') && step.targetComponent) reached.add(step.targetComponent);
        }
        if (reached.size > 0) calledBy.set(method.name, reached);
      }
      subjects.push({ implementation: impl, component: comp, calledBy });
    }

    // 2. Judge each Orchestrator's groups.
    for (const { component, calledBy } of subjects) {
      if (calledBy.size < 2) continue;

      const groups = groupsSharingCollaborators(calledBy).filter(g => g.length >= 2);
      if (groups.length < 2) continue;

      const described = groups
        .map(g => {
          const collaborators = [...new Set(g.flatMap(m => [...(calledBy.get(m) as Set<string>)]))].sort();
          return `${g.join(', ')} (calling ${collaborators.join(', ')})`;
        })
        .join('; ');
      ctx.addIssue(
        'warning',
        'INCOHESIVE_METHODS',
        `Orchestrator "${component.id}" holds ${groups.length} groups of methods that share no called component: ${described}. Split it along those groups, move the logic out until every method is a single hand-off (a pure forwarder is exempt), or acknowledge a deliberate facade with a reasoned lint.allow for INCOHESIVE_METHODS.`,
        component.id,
        ctx.isComponentDraft(component.id),
      );
    }
  },
};
