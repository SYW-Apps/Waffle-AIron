// ---------------------------------------------------------------------------
// The agent topology a project holds, as ONE face over the two modules that
// hold it — `topology_repository`, and nothing but a facade.
//
// Every function here is a single forward to the member that owns the work:
// the writes to `domain_registry` (./domains.ts), the file to `topology_store`
// (../config/loader.ts). It holds no logic of its own by construction, which is
// what a Repository facade is for; anything that needed a decision would belong
// in a member instead, and the moment one appears here the pattern has been
// misread.
//
// It exists because consumers were reaching both members directly and each
// caller had to know which of the two answered what — the domains from
// ./domains.ts, `loadTopologyConfig` from ../config/loader.ts, and no single
// place that said "the topology". Depending on THIS file is what makes the pair
// a Repository rather than two modules with a label.
//
// What it deliberately does NOT answer is "what domains exist". That spans the
// spec tree as well as the configuration, which is workflow and lives ABOVE
// this facade in `domain_projector`; the four methods that used to publish it
// from here — `resolve`, `find`, `listFreeStanding` and `deriveFromSubsystems`
// — went with it, together with a `saveConfig` no caller outside the registry
// ever wanted. A facade publishing a method for no consumer is a surface
// somebody has to keep true.
//
// The names shed the qualifier the members carry: inside a file that is only
// ever about the topology, `loadTopologyConfig` repeats what the module already
// said. The members keep their own names, because in their files the qualifier
// is the thing that says which of the two kinds of state they touch.
// ---------------------------------------------------------------------------

import type { Domain, TopologyConfig } from '../models/domain.js';
import { addFreeStandingDomain, removeFreeStandingDomain } from './domains.js';
import { loadTopologyConfig } from '../config/loader.js';

// ---------------------------------------------------------------------------
// The domains — through the registry.
//
// Only the writable set is here. A domain bound to a subsystem is derived from
// the spec tree on every call and can be neither added nor removed; a
// free-standing one is a decision about the repository's shape and lives in the
// configuration, which is the set these two methods change.
// ---------------------------------------------------------------------------

/** Register a domain the spec tree does not imply, and persist it. Refuses a duplicate id. */
export function addFreeStanding(domain: Domain): void {
  addFreeStandingDomain(domain);
}

/** Unregister a free-standing domain and persist the removal. */
export function removeFreeStanding(id: string): void {
  removeFreeStandingDomain(id);
}

// ---------------------------------------------------------------------------
// The file — through the store.
//
// For callers that want the DOCUMENT rather than the domains in it: `wairon
// generate` reads the configuration to decide what it owns, and the projector
// reads it for the registered half of what exists.
// ---------------------------------------------------------------------------

/** The topology configuration as the file holds it. Empty when the project has none. */
export function loadConfig(): TopologyConfig {
  return loadTopologyConfig();
}
