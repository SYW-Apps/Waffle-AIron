import { callersOf, enclosing, transportKind, SURFACE_AUDIENCES } from '../../models/index.js';
import type { ModelledCall, ReachModel, VerbReach } from '../../models/index.js';
import type { ValidationIssue } from '../validation.js';

// ---------------------------------------------------------------------------
// The network arbiter: judges a reach model against the network rules and
// answers the findings, deciding nothing else.
//
// - Inside a declared network only a gateway-variant Portal may take an
//   outside entry, and a modelled call from outside the network must land on
//   one: GATEWAY_BYPASSED.
// - More than one gateway taking outside entries in one network:
//   MULTIPLE_GATEWAYS.
// - A network-scoped entry with no enclosing network, in a family-scoped
//   model: ENTRY_SCOPE_UNBOUNDED (the family is the implicit boundary).
// - In a family-scoped model, a network-scoped entry no modelled caller inside
//   its boundary reaches: ENTRY_UNPROVEN.
// - An export wider than project on a network-transport verb that is not the
//   outermost network's outside-entered gateway: EXPORT_BEYOND_NETWORK.
//
// Pure: the same model always gives the same findings, in a stable order, each
// sited at the verb (spec: the Portal, site: the verb) or the call (spec: the
// calling component, site: its evidence) it names, so an allow covers exactly
// one. Scope-blind entry shape is entry-declarations', not this arbiter's.
// ---------------------------------------------------------------------------

/** A network finding with the site an allow names. */
type NetworkFinding = ValidationIssue & { at?: string };

/** How a network id reads in a finding ('' is the bound project's own). */
function networkName(id: string): string {
  return id === '' ? 'this project\'s network' : `the network of "${id}"`;
}

function verbName(v: VerbReach): string {
  return `${v.portal}.${v.verb}`;
}

/** Whether an audience is wider than project. */
function widerThanProject(audience: string | undefined): boolean {
  if (audience === undefined) return false;
  const rank = (SURFACE_AUDIENCES as readonly string[]).indexOf(audience);
  return rank === -1 || rank > 0;
}

/** Whether the call's caller sits inside a network (in it, or in a network nested in it). */
function insideNetwork(model: ReachModel, call: ModelledCall, network: string): boolean {
  return enclosing(model, call.fromNetwork).includes(network);
}

/** The codes judge reports, in the order its contract declares them. */
const FAMILY_CODES: readonly string[] = ['GATEWAY_BYPASSED', 'MULTIPLE_GATEWAYS', 'ENTRY_SCOPE_UNBOUNDED', 'ENTRY_UNPROVEN', 'EXPORT_BEYOND_NETWORK'];

/**
 * inetwork_arbiter.familyCodes — every code judge reports, for the lint-allow
 * audit: the family run judges each of them over every member (ENTRY_UNPROVEN
 * and ENTRY_SCOPE_UNBOUNDED only there), so an allow of one is a known code on
 * any spec, and only the family run can tell that it covers nothing. Pure.
 */
export function familyCodes(): string[] {
  return [...FAMILY_CODES];
}

/** inetwork_arbiter.judge — the network findings of a reach model. */
export function judge(model: ReachModel): (ValidationIssue & { at?: string })[] {
  const out: NetworkFinding[] = [];
  const verbFinding = (severity: ValidationIssue['severity'], code: string, v: VerbReach, message: string): void => {
    out.push({ severity, code, message, specId: v.portal, at: v.verb });
  };
  const family = model.scope === 'family';
  const byPortal = new Map<string, VerbReach[]>();
  for (const v of model.verbs) byPortal.set(v.portal, [...(byPortal.get(v.portal) ?? []), v]);

  // Steps 1-9: each network-transport verb.
  for (const v of model.verbs) {
    if (transportKind(v.transport) !== 'network') continue;
    const entry = v.entry?.kind === 'entry' ? v.entry : undefined;
    if (entry) {
      const scope = entry.scope ?? 'outside';
      // Steps 3-4: an outside entry inside a declared network must be on a gateway.
      if (scope === 'outside' && v.network !== undefined && !v.gateway) {
        verbFinding('error', 'GATEWAY_BYPASSED', v,
          `Portal verb "${verbName(v)}" sits inside ${networkName(v.network)} and is entered from outside it, but "${v.portal}" is not a gateway: callers from outside a network reach it only through its gateway. Make the Portal a gateway (variant: gateway), or route the outside callers through the network's gateway and narrow this entry to scope network.`);
      }
      // Steps 5-6: a network-scoped entry needs a boundary around it.
      if (scope === 'network' && v.network === undefined && family) {
        verbFinding('notice', 'ENTRY_SCOPE_UNBOUNDED', v,
          `Portal verb "${verbName(v)}" declares a network-scoped entry, but no declared network encloses "${v.project === '' ? 'the root' : v.project}": the family is its implicit boundary, so its callers are proven against the whole family and its flows cannot be narrowed by a network. Declare \`network\` on the project that should isolate it, or leave the entry unscoped.`);
      }
      // Steps 7-8: a family-scoped model proves a network-scoped entry.
      if (scope === 'network' && family) {
        const callers = callersOf(model, v.portal, v.verb);
        const proven = v.network === undefined
          ? callers.length > 0
          : callers.some((c) => insideNetwork(model, c, v.network!));
        if (!proven) {
          verbFinding('warning', 'ENTRY_UNPROVEN', v,
            `Portal verb "${verbName(v)}" declares a network-scoped entry (its callers are sibling services inside ${v.network === undefined ? 'the family' : networkName(v.network)}), but no modelled caller inside that boundary reaches it. Model the calling Adapter's call, or, for a genuinely unmodelled in-network caller such as an ops job or a non-wairon service, allow ENTRY_UNPROVEN at "${v.verb}" with the reason.`);
        }
      }
    }
    // Step 9: an export wider than project needs the outermost network's outside-entered gateway.
    if (widerThanProject(v.audience) && v.network !== undefined) {
      const chain = enclosing(model, v.network);
      const outermost = chain[chain.length - 1];
      const gatewayOfOutermost = v.network === outermost && v.gateway && (entry?.scope ?? 'outside') === 'outside' && entry !== undefined;
      if (!gatewayOfOutermost) {
        verbFinding('warning', 'EXPORT_BEYOND_NETWORK', v,
          `Portal verb "${verbName(v)}" is exported at audience "${v.audience}", so consumers beyond the family design against it, but they sit outside ${networkName(outermost)} and can reach only its gateway entered from outside. Export the network's gateway instead, make this Portal that gateway with an outside entry, or narrow the export's audience to project.`);
      }
    }
  }

  // Steps 10-11: a call entering a network it is not inside must land on that network's gateway.
  const verbOf = new Map(model.verbs.map((v) => [`${v.portal}#${v.verb}`, v] as const));
  for (const call of model.calls) {
    const target = verbOf.get(`${call.toPortal}#${call.verb}`) ?? byPortal.get(call.toPortal)?.[0];
    if (!target || transportKind(target.transport) !== 'network' || target.network === undefined) continue;
    const entered = enclosing(model, target.network).filter((n) => !insideNetwork(model, call, n));
    if (entered.length === 0) continue;
    const outermost = entered[entered.length - 1];
    const gateways = model.networks.find((n) => n.id === outermost)?.gateways ?? [];
    if (gateways.includes(call.toPortal)) continue;
    out.push({
      severity: 'error',
      code: 'GATEWAY_BYPASSED',
      message: `The modelled call ${call.evidence} from "${call.fromComponent}" enters ${networkName(outermost)} from outside it and lands on "${call.toPortal}.${call.verb}", which is not ${entered.length > 1 ? 'the gateway of every network it crosses' : 'that network\'s gateway'}. A call crossing into a network lands on its gateway, one per network level: call the gateway, and let it call inward.`,
      specId: call.fromComponent,
      at: call.evidence,
    });
  }

  // Step 12: more than one gateway in one network, sited on its first gateway
  // Portal, so the finding belongs to that gateway's project and an allow on
  // that Portal covers it.
  for (const n of model.networks) {
    if (n.gateways.length < 2) continue;
    const first = [...n.gateways].sort()[0];
    out.push({
      severity: 'notice',
      code: 'MULTIPLE_GATEWAYS',
      message: `${networkName(n.id).replace(/^t/, 'T')} has ${n.gateways.length} gateway Portals taking entries from outside it (${n.gateways.map((g) => `"${g}"`).join(', ')}). Allowed, not recommended: one front door per network keeps the boundary reviewable.`,
      specId: first,
    });
  }

  // Step 13: a stable order.
  return out.sort((a, b) =>
    (a.specId ?? '').localeCompare(b.specId ?? '') || a.code.localeCompare(b.code) || (a.at ?? '').localeCompare(b.at ?? '') || a.message.localeCompare(b.message));
}
