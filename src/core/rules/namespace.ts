import { SurfaceContractEntry, SurfaceSnapshot } from '../../models/index.js';
import { RuleContext, SddRule } from './types.js';
import { dryRunSerializeSpecs } from '../specs.js';

/**
 * True when an unresolved reference points OUTSIDE the current loading root,
 * rather than being a genuine local typo — so it warrants the softer
 * CROSS_TREE_REF_UNRESOLVED warning ("validate from the parent project")
 * instead of a hard "does not exist" error. Two shapes qualify:
 *  - an explicit relative form (`::x` / `super::x`), and
 *  - a qualified id whose leading namespace segment is not a subsystem in THIS
 *    tree — e.g. `waffler_core::blueprints-portal` authored from a parent root,
 *    where `waffler_core` is absent when the same specs are validated from the
 *    child subproject's own directory. This is exactly the "different root,
 *    different verdict" case: from the child root such a ref is unresolvable but
 *    honest, not broken, so it must not flood the report with hard errors.
 */
export function isExternalNamespaceRef(ctx: RuleContext, ref: string): boolean {
  if (ref.startsWith('::') || ref.startsWith('super::')) return true;
  const sep = ref.indexOf('::');
  if (sep === -1) return false; // a bare unresolved id is a local typo, not cross-tree
  return !ctx.subsystemIds.has(ref.slice(0, sep));
}

/**
 * How a cross-tree reference fared against the stored surface snapshots.
 *
 * `ambiguous` is a verdict of its own, not a kind of resolution: several
 * snapshots expose the name with different contracts and the reference does not
 * single one out, so no declared contract may judge the edge.
 */
export type SurfaceRefResolution =
  | { kind: 'resolved'; snapshot: SurfaceSnapshot; entry: SurfaceContractEntry }
  | { kind: 'ambiguous'; providers: string[] }
  | { kind: 'unresolved' };

/**
 * True when a snapshot was published by the named provider. A snapshot's key is
 * its projectName: the family surface is keyed by the parent system name and a
 * sibling's by `<systemName>::<subsystemId>`, so a reference names a sibling by
 * its subsystem id and the family surface or a foreign import by its name.
 */
function isProvidedBy(snapshot: SurfaceSnapshot, provider: string): boolean {
  return snapshot.projectName === provider || snapshot.projectName.split('::').pop() === provider;
}

/**
 * Two entries carry the same contract when they front the same component with
 * the same methods and the same dispatch table — whichever of them judges an
 * edge, the verdict is the same. Snapshots carry a component's local name, so
 * that is what identifies it.
 */
function sameContract(a: SurfaceContractEntry, b: SurfaceContractEntry): boolean {
  return a.component.split('::').pop() === b.component.split('::').pop()
    && JSON.stringify(a.methods) === JSON.stringify(b.methods)
    && JSON.stringify(a.dispatch ?? []) === JSON.stringify(b.dispatch ?? []);
}

/**
 * Resolve an unresolved cross-tree reference (a `super::`/`::` form whose
 * target is outside this loading root) against the stored surface snapshots,
 * matched by provider. The final segment is the local name, matched against
 * each snapshot's exported entry ids and backing component names; the segment
 * before it, when there is one, names the provider, and only that provider's
 * snapshots are consulted — never another's that happens to expose the same
 * name.
 *
 * A hit means the edge is validated against the DECLARED contract instead of
 * falling back to the unresolvable warning. When the matching snapshots of the
 * first pool that has any disagree on the contract, the reference is ambiguous:
 * picking whichever loaded first would judge the edge against a contract its
 * author may never have meant.
 */
export function resolveSurfaceRef(
  ctx: RuleContext,
  ref: string,
  fromSubsystem?: string,
): SurfaceRefResolution {
  const segments = ref.split('::').filter(seg => seg && seg !== 'super');
  const local = segments.pop();
  if (!local) return { kind: 'unresolved' };
  const provider = segments.pop();
  // For a reference made from inside a chained mount, the snapshots that mount
  // holds come first, nearest mount first — what the child authored against,
  // exactly as it resolves from the child's own root — then the bound root's
  // own. A mount's snapshots are never consulted for a reference made outside it.
  const mountPools = fromSubsystem
    ? enclosingMounts(ctx, fromSubsystem)
      .reverse()
      .map((ns) => ctx.mountSurfaceSnapshots.find((m) => m.namespace === ns)?.snapshots ?? [])
    : [];
  for (const pool of [...mountPools, ctx.surfaceSnapshots]) {
    const candidates: { snapshot: SurfaceSnapshot; entry: SurfaceContractEntry }[] = [];
    for (const snapshot of pool) {
      if (provider !== undefined && !isProvidedBy(snapshot, provider)) continue;
      const entry = snapshot.interfaces.find(e => e.component === local || e.id === local);
      if (entry) candidates.push({ snapshot, entry });
    }
    if (candidates.length === 0) continue;
    const [first] = candidates;
    if (candidates.every((c) => sameContract(c.entry, first.entry))) {
      return { kind: 'resolved', ...first };
    }
    return { kind: 'ambiguous', providers: [...new Set(candidates.map((c) => c.snapshot.projectName))] };
  }
  return { kind: 'unresolved' };
}

/**
 * Report a cross-tree reference whose matching surface snapshots disagree on
 * the contract. Every rule that resolves references against snapshots reports
 * it through here, so the finding reads the same whatever kind of edge it is on.
 * It is never surface-resolved: no contract judged the edge.
 *
 * `subject` is the clause that leads up to the reference, e.g.
 * `Component "invoice-client" depends on`.
 */
export function reportAmbiguousSurfaceRef(
  ctx: RuleContext,
  subject: string,
  ref: string,
  providers: string[],
  specId: string,
  isDraftContext: boolean,
): void {
  const local = ref.split('::').filter(seg => seg && seg !== 'super').pop() ?? ref;
  ctx.addIssue(
    'error',
    'SURFACE_REF_AMBIGUOUS',
    `${subject} cross-tree component "${ref}", which the surface snapshots of ${providers.map((p) => `"${p}"`).join(', ')} expose with different contracts — the reference matches more than one declared contract, so none of them can judge it. Name the provider it means (super::<provider>::${local}), or remove the snapshot that no longer applies.`,
    specId,
    isDraftContext,
  );
}

/**
 * The chained mounts enclosing a subsystem, outermost first: every prefix of
 * its qualified id that is a subsystem carrying `projectPath`.
 */
export function enclosingMounts(ctx: RuleContext, subsystemId: string): string[] {
  const mounts: string[] = [];
  let prefix = '';
  for (const segment of subsystemId.split('::')) {
    prefix = prefix ? `${prefix}::${segment}` : segment;
    if (ctx.subsystems.some((s) => s.id === prefix && s.projectPath)) mounts.push(prefix);
  }
  return mounts;
}

/**
 * True when an unresolved reference made from inside a chained mount was
 * authored in a cross-tree form that the loader collapsed at THIS root.
 *
 * The loader qualifies every reference a mount's spec authors locally into the
 * mount's own namespace (`kid::x`). Only a `super::` / `::` form climbs out of
 * it — and at a parent root that climb lands on an id WITHOUT the mount prefix,
 * typically a bare `x`, which isExternalNamespaceRef cannot tell from a local
 * typo. So: made from inside mount M and not under `M::` means it was authored
 * to leave M.
 *
 * This only licenses consulting the snapshots M holds. A reference they do not
 * cover is judged exactly as it was before.
 */
export function isCollapsedCrossTreeRef(ctx: RuleContext, ref: string, fromSubsystem: string): boolean {
  const nearest = enclosingMounts(ctx, fromSubsystem).pop();
  return nearest !== undefined && ref !== nearest && !ref.startsWith(`${nearest}::`);
}

// ---------------------------------------------------------------------------
// Namespace integrity: the :: grammar must stay round-trippable. Two rules:
// the writer dry-run (validate predicts every save/lock refusal) and the id
// hygiene checks that keep the qualify/relativize grammar unambiguous.
// ---------------------------------------------------------------------------

/**
 * Registered as a real rule (not an ad-hoc loader injection) so the code is
 * visible in `wairon rules list`, tunable via rules.sddRuleSeverity, scoped by
 * ctx.addIssue like every other finding, and recognized by the lint-allow
 * audit (errors are still never locally suppressible).
 */
export const roundtripRule: SddRule = {
  name: 'roundtrip-serialization',
  description:
    'Every loaded spec must re-serialize through the exact writer pipeline (same relativization, same schema, no I/O) — validate must predict every refusal that lock\'s status promotion or any later save would otherwise raise mid-write.',
  codes: [
    { code: 'ROUNDTRIP_SERIALIZATION', defaultSeverity: 'error', summary: 'Spec cannot be re-serialized through the writer schema (any save or lock would refuse it)' },
  ],
  check(ctx) {
    for (const issue of dryRunSerializeSpecs(ctx.isSpecInScope)) {
      ctx.addIssue('error', 'ROUNDTRIP_SERIALIZATION', issue.message, issue.specId);
    }
  },
};

export const namespaceHygieneRule: SddRule = {
  name: 'namespace-hygiene',
  description:
    'Ids must stay resolvable in the :: namespace grammar: no id segment may be the reserved keyword "super", and a subproject-local name must not shadow a root-level subsystem id — a bare reference to a shadowed name silently anchors to the ROOT subsystem, so the local spec becomes unaddressable.',
  codes: [
    { code: 'RESERVED_ID_SEGMENT', defaultSeverity: 'error', summary: 'Id uses the reserved namespace keyword "super"' },
    { code: 'NAMESPACE_SHADOWING', defaultSeverity: 'error', summary: 'Subproject-local id shadows a root subsystem id (bare references anchor to the root)' },
  ],
  check(ctx) {
    const rootSubs = new Set(ctx.subsystems.filter(s => !s.id.includes('::')).map(s => s.id));

    const checkId = (id: string, kindLabel: string): void => {
      if (!ctx.isSpecInScope(id)) return;
      const segments = id.split('::');
      if (segments.includes('super')) {
        ctx.addIssue(
          'error',
          'RESERVED_ID_SEGMENT',
          `${kindLabel} id "${id}" uses the reserved namespace keyword "super" — stored references to it would be consumed as a namespace hop and resolve to a different spec.`,
          id,
        );
      }
      if (segments.length > 1) {
        const local = segments[segments.length - 1];
        if (rootSubs.has(local)) {
          ctx.addIssue(
            'error',
            'NAMESPACE_SHADOWING',
            `${kindLabel} "${id}" shadows root subsystem "${local}" — inside its subproject a bare reference to "${local}" anchors to the ROOT subsystem, so this spec cannot be addressed reliably. Rename one of them.`,
            id,
          );
        }
      }
    };

    for (const s of ctx.subsystems) checkId(s.id, 'Subsystem');
    for (const c of ctx.components) checkId(c.id, 'Component');
    for (const i of ctx.interfaces) checkId(i.id, 'Interface');
    for (const im of ctx.implementations) checkId(im.id, 'Implementation');
    for (const t of ctx.types) checkId(t.id, 'Type');
  },
};
