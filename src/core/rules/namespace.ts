import { SddRule } from './types.js';
import { dryRunSerializeSpecs } from '../specs.js';

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
