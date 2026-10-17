import { qualifiedTypeId } from '../../../models/index.js';
import { SddRule, RuleContext } from '../types.js';

// ---------------------------------------------------------------------------
// rename-traces — a rename trace (a spec's previousIds, a contract method's
// previousNames) names keys that no longer exist. It is what lets a consumer
// of the design export tell a rename from a delete plus an add, so it must be
// unambiguous: an entry may not equal a live key of the same kind, and one
// former key may not be claimed by two elements of the same kind. The rename
// tools and the gated write refuse both (id-retired, name-retired), so a
// finding here means a hand edit. A trace entry is read in its holder's own
// namespace — a type's within its owner, a member's spec within its member.
// ---------------------------------------------------------------------------

const CODE = 'RENAME_TRACE_CONFLICT';

/** The namespace prefix (`ns::`) of a key, or '' for an unqualified one. */
function namespaceOf(key: string): string {
  const cut = key.lastIndexOf('::');
  return cut >= 0 ? key.slice(0, cut + 2) : '';
}

/** One element of a kind carrying a trace: its key, the spec a finding names, and the trace. */
interface Holder {
  key: string;
  specId: string;
  label: string;
  trace: string[];
}

/** Judge one kind: every trace entry against the live keys of the kind, and against the entries other holders claimed. */
function judgeKind(ctx: RuleContext, noun: string, live: ReadonlySet<string>, holders: Holder[], qualify: (entry: string, holder: Holder) => string): void {
  const claimed = new Map<string, Holder>();
  for (const holder of holders) {
    for (const entry of holder.trace) {
      const key = qualify(entry, holder);
      // Steps 4-5: a live key of the same kind, or one another element claimed.
      const other = claimed.get(key);
      if (live.has(key) && key !== holder.key) {
        report(ctx, holder, `${holder.label} lists "${entry}" in its rename trace, but a live ${noun} has that key — a consumer of the design export would read the live ${noun} as this one renamed. Rename the newcomer, or unset the trace entry and accept that a consumer reads a delete plus an add.`);
      } else if (live.has(key)) {
        report(ctx, holder, `${holder.label} lists its own key "${entry}" in its rename trace — a rename never records the name it keeps. Unset the entry.`);
      } else if (other && other !== holder) {
        report(ctx, holder, `${holder.label} and ${other.label} both list "${entry}" in their rename traces — a consumer holding the old key cannot tell which one it became. Unset the entry on the one that was not renamed from it.`);
      }
      // Step 6: the entry is claimed by this element.
      if (!other) claimed.set(key, holder);
    }
  }
}

function report(ctx: RuleContext, holder: Holder, message: string): void {
  if (!ctx.isSpecInScope(holder.specId)) return;
  ctx.addIssue('warning', CODE, message, holder.specId);
}

/** A spec-level trace entry read in its holder's namespace. */
const inNamespace = (entry: string, holder: Holder): string => (entry.includes('::') ? entry : namespaceOf(holder.key) + entry);

export const renameTracesRule: SddRule = {
  name: 'rename-traces',
  judges: 'design',
  description:
    'A rename trace (a spec\'s previousIds, a contract method\'s previousNames) names keys that no longer exist, and is what lets a consumer of the design export tell a rename from a delete plus an add; it must therefore be unambiguous. Reported: a trace entry equal to a live key of the same kind (a component, interface or implementation id; a type id within the same owner; `<interface>.<method>` of a declared method) — its holder\'s own current key included, which a trace of former names can never hold — and one former key claimed by two elements of the same kind. The rename tools and the gated write refuse both (id-retired, name-retired), so a finding means a hand edit; the message names both holders and the way out — rename the newcomer, or unset the trace entry and accept the delete plus an add a consumer will read.',
  codes: [
    { code: CODE, defaultSeverity: 'warning', summary: 'A rename-trace entry equals a live key of the same kind, or two elements claim one former key' },
  ],
  check(ctx) {
    // Step 1: the live keys by kind, and the holders that carry a trace.
    const specHolders = <T extends { id: string; previousIds?: string[] }>(specs: readonly T[], noun: string): Holder[] =>
      specs.filter((s) => s.previousIds?.length).map((s) => ({ key: s.id, specId: s.id, label: `${noun} "${s.id}"`, trace: s.previousIds! }));
    // Steps 2-6, per kind.
    judgeKind(ctx, 'component', new Set(ctx.components.map((c) => c.id)), specHolders(ctx.components, 'Component'), inNamespace);
    judgeKind(ctx, 'interface', new Set(ctx.interfaces.map((i) => i.id)), specHolders(ctx.interfaces, 'Interface'), inNamespace);
    judgeKind(ctx, 'implementation', new Set(ctx.implementations.map((i) => i.id)), specHolders(ctx.implementations, 'Implementation'), inNamespace);
    judgeKind(
      ctx,
      'type',
      new Set(ctx.types.map((t) => qualifiedTypeId(t))),
      ctx.types.filter((t) => t.previousIds?.length).map((t) => ({ key: qualifiedTypeId(t), specId: t.id, label: `Type "${qualifiedTypeId(t)}"`, trace: t.previousIds! })),
      inNamespace,
    );
    const methodHolders: Holder[] = [];
    const liveMethods = new Set<string>();
    for (const intf of ctx.interfaces) {
      for (const m of intf.methods) {
        const key = `${intf.id}.${m.name}`;
        liveMethods.add(key);
        if (m.previousNames?.length) methodHolders.push({ key, specId: intf.id, label: `Method "${key}"`, trace: m.previousNames });
      }
    }
    // A bare method name in a contract method's trace is read on its own contract.
    judgeKind(ctx, 'contract method', liveMethods, methodHolders, (entry, holder) =>
      (entry.includes('.') || entry.includes('::') ? inNamespace(entry, holder) : `${holder.key.slice(0, holder.key.lastIndexOf('.'))}.${entry}`));
    // A parameter's or a field's trace never holds the name it carries now.
    const ownName = (specId: string, label: string, name: string, trace: string[] | undefined): void => {
      if (trace?.includes(name)) report(ctx, { key: label, specId, label, trace }, `${label} lists its own name "${name}" in its rename trace — a rename never records the name it keeps. Unset the entry.`);
    };
    for (const intf of ctx.interfaces) {
      for (const m of intf.methods) for (const p of m.params ?? []) ownName(intf.id, `Parameter "${p.name}" of method "${intf.id}.${m.name}"`, p.name, p.previousNames);
    }
    for (const t of ctx.types) for (const f of t.fields ?? []) ownName(t.id, `Field "${f.name}" of type "${qualifiedTypeId(t)}"`, f.name, f.previousNames);
  },
};
