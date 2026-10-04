import { SddRule } from '../types.js';
import { isRetired } from '../../../models/index.js';

/** The data components a Supervisor may reach: what it owns is its own, the rest is shared. */
const DATA_COMPONENTS: ReadonlySet<string> = new Set(['Store', 'Registry', 'Repository', 'Index', 'Query']);

/**
 * What a Supervisor may do to data it does not own. Its supervision state —
 * the Stores and Registries it owns — is its own to read and write. Shared
 * data is reached only through read and lifecycle methods: a Supervisor may
 * look things up and bracket what exists (open a run, register a handle,
 * close it again), but a change to an entity's fields is a workflow's job,
 * and the Supervisor depends on the Orchestrator that does it.
 *
 * Judged from narrative call steps against the callee's declared effect. A
 * read made on behalf of a request still passes; in practice the paired write
 * is what forces the workflow out, and the read moves with it.
 */
export const supervisorSharedDataRule: SddRule = {
  name: 'supervisor-shared-data',
  judges: 'design',
  description:
    'A Supervisor keeps its own supervision state (the Stores and Registries it owns) with full read and write, but data it does not own is shared: a Supervisor narrative call step that reaches a method of a Store, Registry, Repository, Index or Query the Supervisor does not own is legal only when that method declares effect read or lifecycle. A write — or a method that declares no effect — goes through a workflow: the Supervisor depends on the Orchestrator that does it. A read on behalf of a request still passes; in practice the paired write is what forces the workflow out, and the read moves with it.',
  codes: [
    { code: 'SUPERVISOR_WRITE_SHORTCUT', defaultSeverity: 'error', summary: 'Supervisor narrative call reaches a method of a data component it does not own whose declared effect is neither read nor lifecycle — writes to shared data route through an Orchestrator' },
  ],
  check(ctx) {
    const ownership = ctx.ownershipIndex();
    for (const impl of ctx.implementations) {
      const contract = ctx.interfaceMap.get(impl.contract);
      const supervisor = contract ? ctx.componentMap.get(contract.component) : undefined;
      if (!supervisor || supervisor.componentType !== 'Supervisor' || isRetired(supervisor)) continue;
      const isDraftCtx = ctx.isImplementationDraft(impl);

      for (const implMethod of impl.methods) {
        for (const step of implMethod.narrative) {
          if (step.type !== 'call' || !step.targetComponent || !step.targetMethod) continue;
          const target = ctx.componentMap.get(step.targetComponent);
          if (!target || !DATA_COMPONENTS.has(target.componentType)) continue;
          // Its own supervision state: full read and write.
          if (ownership.ownerOf(target.id) === supervisor.id) continue;
          const called = ctx.interfaceMethodsOf(target.id).find(m => m.name === step.targetMethod);
          // An unresolved method is narrative-target-references' finding.
          if (!called || called.effect === 'read' || called.effect === 'lifecycle') continue;
          const what = called.effect === 'write'
            ? 'a write-effect method'
            : 'a method that declares no effect';
          const untaggedHint = called.effect === 'write'
            ? ''
            : ` If ${target.id}.${called.name} only reads, or only changes what exists, declare its effect (read or lifecycle).`;
          ctx.addIssue(
            'error',
            'SUPERVISOR_WRITE_SHORTCUT',
            `Supervisor "${supervisor.id}": step ${step.stepNumber} of "${implMethod.name}" calls ${target.id}.${called.name}, ${what} on ${target.componentType} "${target.id}", which the Supervisor does not own. A Supervisor reads shared data and changes what exists in it (read and lifecycle effects); a write to its fields goes through a workflow — depend on the Orchestrator that does it and call that instead.${untaggedHint}`,
            impl.id,
            isDraftCtx || ctx.isComponentDraft(target.id),
          );
        }
      }
    }
  },
};
