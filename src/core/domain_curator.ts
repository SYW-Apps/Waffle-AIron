// ---------------------------------------------------------------------------
// Registering a domain into the project's topology, and taking one back out —
// `domain_curator`, a workflow Orchestrator.
//
// It exists because the check a registration needs cannot be made where the
// write happens. Refusing an id the spec tree already answers to takes BOTH the
// derived domains and the registered ones, and a Registry may reach only its
// own Store — so the decision is made here, over the projector, and only then
// handed to the repository to persist.
//
// The two refusals are deliberately in different components, and neither is
// duplicated: a clash with the derived half is only visible from here, and a
// clash inside the registered set is only answerable from the store, so each is
// caught where it can actually be seen. The messages stay distinguishable
// because they tell the caller different things to do — one says change the
// spec tree, the other says the configuration already holds the id.
//
// This is also the workflow step the standard asks for between a Portal and a
// write: `core_portal` calls this, never the facade's writes directly.
// ---------------------------------------------------------------------------

import { Domain } from '../models/domain.js';
// Both collaborators bound as namespaces, so each call SITE names the contract
// method it reaches rather than a local alias.
import * as projector from './domain_projector.js';
import * as topology from './topology.js';
import { WaironError } from '../utils/errors.js';

/**
 * Register a domain the spec tree does not imply, and persist it. Refuses an id
 * anything already answers to, derived or registered.
 */
export function registerDomain(domain: Domain): void {
  const taken = projector.resolveDomains().find((d) => d.id === domain.id);
  if (taken) {
    throw new WaironError(refusal(taken));
  }
  topology.addFreeStanding(domain);
}

/**
 * Says which kind already holds the id. A free-standing domain shadowing a
 * subsystem would silently outrank the tree it came from, and the caller could
 * not tell from the outside that it had.
 */
function refusal(taken: Domain): string {
  return taken.boundTo
    ? `Domain id "${taken.id}" collides with a subsystem-derived domain.`
    : `A free-standing domain "${taken.id}" already exists in .wai/topology.yaml.`;
}

/**
 * Take a free-standing domain back out and persist the removal. The repository
 * refuses by name when the registered set does not hold the id — a derived
 * domain is not there to remove, and answering "removed" would be a lie the
 * caller could not detect.
 */
export function unregisterDomain(id: string): void {
  topology.removeFreeStanding(id);
}
