import type { ComponentSpec } from '../../../models/index.js';

// ---------------------------------------------------------------------------
// The stereotype vocabulary the dependency rules report with.
//
// The matrix was ONE rule and these were its private helpers; it is five rules
// now, and they must keep saying the same words. A Store-link refusal that
// named the correct resolution in one finding and not in the next would read
// as two different doctrines.
// ---------------------------------------------------------------------------

// The one shortcut agents reach for when a Store link is refused is the one
// that must never happen: folding the store's state into the consumer. Say so
// on every Store-target violation, next to the CORRECT resolution.
const NEVER_INLINE_STATE =
  ' Never resolve this by merging the store\'s state into the consuming component — state hidden inside a logic block is invisible to the spec and unrecoverable.';

/**
 * The resolution a refused Store link is given. A Store is the default data
 * component and needs no Repository around it: the consumer that may not reach
 * it directly goes through an Orchestrator that may — read logic or a workflow.
 */
export const storeResolutionHint = (_consumerType: string, storeId: string): string =>
  ` Resolution: reach "${storeId}" through an Orchestrator that may depend on it (read logic or a workflow) — a Store needs no Repository around it.${NEVER_INLINE_STATE}`;

/** Pure logic: an Orchestrator whose dependencyClass is pure. Any block may use it. */
export const isPureLogic = (comp: ComponentSpec): boolean =>
  comp.componentType === 'Orchestrator' && comp.dependencyClass === 'pure';

/** Read logic: an Orchestrator whose dependencyClass is read. */
export const isReadLogic = (comp: ComponentSpec): boolean =>
  comp.componentType === 'Orchestrator' && comp.dependencyClass === 'read';

/** A component as a finding names it: its stereotype, with its dependencyClass when it declares one. */
export const stereotypeOf = (comp: ComponentSpec): string =>
  comp.dependencyClass ? `${comp.componentType} (dependencyClass ${comp.dependencyClass})` : comp.componentType;

/**
 * One finding a doctrine rule would report on a dependsOn edge, before it is
 * anchored: its severity, its code and its message. The edge rules compute
 * these from the two ends alone and report them on the source component, and
 * the same judgement answers whether an edge that does NOT exist yet would be
 * legal (directEdgeRefusals), so the question is asked one way only.
 */
export interface EdgeFinding {
  severity: 'error' | 'warning';
  code: string;
  message: string;
  /** The site the finding names inside its spec (FindingParts.at), when it has one: what a lint.allow's `at` matches. */
  at?: string;
}
