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

/** The resolution a refused Store link is given, by what the refused consumer is. */
export const storeResolutionHint = (consumerType: string, storeId: string): string => {
  if (consumerType === 'Orchestrator') {
    return ` Resolution: wrap "${storeId}" in a Repository pattern (owns: Store + Registry + Index) and depend on that Repository facade instead.${NEVER_INLINE_STATE}`;
  }
  // Any other consumer (a Portal, Observer, View or Supervisor): even the
  // Repository facade is out of its reach — the hop goes through the logic side.
  return ` Resolution: wrap "${storeId}" in a Repository pattern and reach it through an Orchestrator that uses the Repository facade.${NEVER_INLINE_STATE}`;
};

/** Pure logic: an Orchestrator whose dependencyClass is pure. Any block may use it. */
export const isPureLogic = (comp: ComponentSpec): boolean =>
  comp.componentType === 'Orchestrator' && comp.dependencyClass === 'pure';

/** Read logic: an Orchestrator whose dependencyClass is read. */
export const isReadLogic = (comp: ComponentSpec): boolean =>
  comp.componentType === 'Orchestrator' && comp.dependencyClass === 'read';

/** A component as a finding names it: its stereotype, with its dependencyClass when it declares one. */
export const stereotypeOf = (comp: ComponentSpec): string =>
  comp.dependencyClass ? `${comp.componentType} (dependencyClass ${comp.dependencyClass})` : comp.componentType;
