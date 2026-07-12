import { SurfaceContractEntry, SurfaceSnapshot } from '../../models/index.js';
import { RuleContext, SddRule } from './types.js';
import { dryRunSerializeSpecs } from '../specs.js';
import { checkChildSurfaceFreshness } from '../surfaces.js';

/**
 * Resolve an unresolved cross-tree reference (a `super::`/`::` form whose
 * target is outside this loading root) against the stored surface snapshots:
 * the ref's final segment is matched against each snapshot's exported entry
 * ids and backing component names. A hit means the edge is validated against
 * the DECLARED contract instead of falling back to the unresolvable warning.
 */
export function resolveSurfaceRef(
  ctx: RuleContext,
  ref: string,
): { snapshot: SurfaceSnapshot; entry: SurfaceContractEntry } | null {
  const local = ref.split('::').filter(seg => seg && seg !== 'super').pop();
  if (!local) return null;
  for (const snapshot of ctx.surfaceSnapshots) {
    const entry = snapshot.interfaces.find(e => e.component === local || e.id === local);
    if (entry) return { snapshot, entry };
  }
  return null;
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

/**
 * Parent-side surface freshness: a chained child holds the parent-surface
 * snapshot it validates against standalone; when the parent's exported
 * contracts change without regenerating, the child is verifying against a
 * stale truth. Computable exactly here — the only context where both sides
 * (the live parent tree and the child's held snapshot) are visible.
 */
export const surfaceFreshnessRule: SddRule = {
  name: 'surface-freshness',
  description:
    'Every chained child\'s stored parent-surface snapshot must match the parent\'s CURRENT exported contracts — a drifted snapshot means the child validates standalone against a stale truth. Regenerate with `wairon surface generate-children`.',
  codes: [
    { code: 'SURFACE_STALE', defaultSeverity: 'warning', summary: 'A chained child holds a parent surface snapshot whose contracts no longer match the current tree' },
  ],
  check(ctx) {
    for (const issue of checkChildSurfaceFreshness()) {
      ctx.addIssue('warning', 'SURFACE_STALE', issue.message, issue.specId);
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
