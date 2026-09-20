// ---------------------------------------------------------------------------
// The agent topology a project holds, as ONE face over the two modules that
// hold it — `topology_repository`, and nothing but a facade.
//
// Every function here is a single forward to the member that owns the work:
// the domains to `domain_registry` (./domains.ts), the file to `topology_store`
// (../config/loader.ts). It holds no logic of its own by construction, which is
// what a Repository facade is for; anything that needed a decision would belong
// in a member instead, and the moment one appears here the pattern has been
// misread.
//
// It exists because consumers were reaching both members directly and each
// caller had to know which of the two answered what — `resolveDomains` from
// ./domains.ts, `loadTopologyConfig` from ../config/loader.ts, and no single
// place that said "the topology". Depending on THIS file is what makes the pair
// a Repository rather than two modules with a label.
//
// The names shed the qualifier the members carry: inside a file that is only
// ever about the topology, `resolveDomains` and `loadTopologyConfig` repeat
// what the module already said. The members keep their own names, because in
// their files the qualifier is the thing that says which of the two kinds of
// state they touch.
// ---------------------------------------------------------------------------

import type { Domain, TopologyConfig } from '../models/domain.js';
import {
  resolveDomains,
  findDomain,
  listFreeStandingDomains,
  deriveSubsystemDomains,
  addFreeStandingDomain,
  removeFreeStandingDomain,
} from './domains.js';
import { loadTopologyConfig, saveTopologyConfig } from '../config/loader.js';

// ---------------------------------------------------------------------------
// The domains — through the registry.
//
// Derived and free-standing domains stay apart here exactly as they do in the
// member: a domain bound to a subsystem is derived from the spec tree on every
// call and cannot be added or removed, while a free-standing one is a decision
// about the repository's shape and lives in the configuration. `resolve`
// answers both because the difference matters to whoever writes a domain and
// not at all to whoever reads one.
// ---------------------------------------------------------------------------

/** Every domain this project has, derived and registered alike. */
export function resolve(): Domain[] {
  return resolveDomains();
}

/** The domain with this id, or nothing. Searches both kinds. */
export function find(id: string): Domain | undefined {
  return findDomain(id);
}

/** Only the domains the configuration registers — the set that can be written. */
export function listFreeStanding(): Domain[] {
  return listFreeStandingDomains();
}

/** The domains the spec tree implies, one per subsystem. */
export function deriveFromSubsystems(): Domain[] {
  return deriveSubsystemDomains();
}

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
// generate` reads the configuration to decide what it owns, and a caller
// holding a configuration must be able to write one back from the same place.
// ---------------------------------------------------------------------------

/** The topology configuration as the file holds it. Empty when the project has none. */
export function loadConfig(): TopologyConfig {
  return loadTopologyConfig();
}

/** Write the topology configuration back. */
export function saveConfig(config: TopologyConfig): void {
  saveTopologyConfig(config);
}
