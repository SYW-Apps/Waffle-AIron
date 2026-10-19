import type { RuleContext } from '../types.js';
import type { ComponentSpec } from '../../../models/index.js';
import { resolvedEdge } from '../read-model.js';
import { assertionsOfKind, forbidsEdge } from '../extension/declared-assertion.js';
import { dataBlockEdgeFindings } from './data-block-dependencies.js';
import { entrypointEdgeFindings, maintainedRegistries } from './entrypoint-dependencies.js';
import { bridgeMissing, libraryOf, verbReachable } from './library-calls.js';
import { logicClassEdgeFindings } from './logic-dependency-class.js';
import { visibilityEdgeFinding } from './member-visibility.js';
import { portalShortcutMethod } from './portal-write-shortcut.js';
import { crossSubsystemEdgeFindings } from './subsystem-boundary-dependencies.js';
import { sharedDataWrite } from './supervisor-shared-data.js';

// ---------------------------------------------------------------------------
// Would doctrine allow this edge? The question a forwarder raises: an
// Orchestrator that only hands each call on is required when one of its
// callers could not make the call itself, and removable when every caller
// could. "Could" is the doctrine family's own verdict, asked of an edge that
// does not exist yet — so it is composed from the very judgements the edge
// rules report with, never from a table of its own that could drift from
// them. Each rule computes its findings on an edge from the two ends; this
// asks every one of them, for the edge classified exactly as the tree's own
// edges are (read-model's resolvedEdge: reach, retirement, pack licence).
//
// What it deliberately does NOT read is the project's severity overrides: a
// doctrine code turned off is a project's choice about reporting, not a
// change of doctrine, and a forwarder kept because of it is never wrong.
// ---------------------------------------------------------------------------

/** The Registries each Supervisor maintains, read once per run rather than once per question. */
const lookupsByRun = new WeakMap<RuleContext, Map<string, string[]>>();
function lookupsOf(ctx: RuleContext): Map<string, string[]> {
  let lookups = lookupsByRun.get(ctx);
  if (!lookups) lookupsByRun.set(ctx, (lookups = maintainedRegistries(ctx)));
  return lookups;
}

/**
 * The finding codes doctrine would report if `caller` depended on `target`
 * and called `method` on it directly — empty when the edge and the call are
 * legal. Pass no method to judge the edge alone.
 *
 * The edge is classified as resolvedEdge classifies a declared one, and then
 * judged by the rules that judge such an edge:
 *  - a retired end, or the caller itself, is never a legal shortcut;
 *  - a library edge (another project's InProcess Portal): the language bridge,
 *    and the purity bound on the verb's declared effect (library-calls);
 *  - a boundary crossing: the client-Adapter-or-trustedLink shape, the
 *    published front door and its listed consumers (subsystem-boundary-
 *    dependencies);
 *  - an intra-subsystem edge the governing pack profile does not license:
 *    the entry-point, data-layer and dependency-class matrix
 *    (entrypoint-dependencies, data-block-dependencies,
 *    logic-dependency-class) — a licensed pair skips exactly these, as it
 *    does for a declared edge;
 *  - always: a block another pattern or a Supervisor owns privately
 *    (member-visibility), and a pack's forbid-edge assertions on dependsOn;
 *  - and on the call: a Portal reaching a write- or lifecycle-effect facade
 *    method (portal-write-shortcut), or a Supervisor writing data it does not
 *    own (supervisor-shared-data), each with its own reading of an untagged
 *    method.
 */
export function directEdgeRefusals(ctx: RuleContext, caller: ComponentSpec, target: ComponentSpec, method?: string): string[] {
  if (caller.id === target.id) return ['SELF_EDGE'];
  const edge = resolvedEdge(ctx, caller, target.id, target);

  const codes: string[] = [];
  if (edge.reach === 'library') {
    const library = libraryOf(ctx, edge);
    if (library && bridgeMissing(ctx, caller, library)) codes.push('LANGUAGE_BRIDGE_MISSING');
    if (library && method !== undefined && !verbReachable(caller, library.effectOf(method))) codes.push('LIBRARY_CALL_IMPURE');
  } else if (edge.reach === 'cross-subsystem') {
    codes.push(...crossSubsystemEdgeFindings(ctx, caller, target).map(f => f.code));
  } else if (!edge.licensed) {
    codes.push(
      ...entrypointEdgeFindings(ctx, caller, target, lookupsOf(ctx)).map(f => f.code),
      ...dataBlockEdgeFindings(ctx, caller, target).map(f => f.code),
      ...logicClassEdgeFindings(caller, target).map(f => f.code),
    );
  }

  const hidden = visibilityEdgeFinding(ctx, ctx.ownershipIndex(), caller, target.id);
  if (hidden) codes.push(hidden.code);
  for (const a of assertionsOfKind(ctx, 'forbid-edge')) {
    if (forbidsEdge(a, 'dependsOn', caller, target, ctx)) codes.push(a.fullCode);
  }

  if (method !== undefined) {
    if (caller.componentType === 'Portal' && portalShortcutMethod(ctx, target, method)) codes.push('PORTAL_WRITE_SHORTCUT');
    if (caller.componentType === 'Supervisor' && sharedDataWrite(ctx, ctx.ownershipIndex(), caller, target, method)) codes.push('SUPERVISOR_WRITE_SHORTCUT');
  }
  return codes;
}
