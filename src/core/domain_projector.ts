// ---------------------------------------------------------------------------
// What domains this project has — `domain_projector`, a `read` Orchestrator.
//
// Domains come from two places at once: the subsystems the spec tree declares,
// and the free-standing domains the configuration registers. Combining two
// sources is workflow, which is exactly why this is not a member of the
// topology Repository. A Store, Registry or Index may reach its own store, a
// backend Adapter or pure logic and nothing else — and this reads the spec tree
// as well, so nothing here would be legal inside that boundary. It used to live
// in ./domains.ts anyway, and the import of ./specs.js from a Registry is the
// finding that moved it out.
//
// Both halves are read on every call and nothing is cached, so two commands in
// one process cannot disagree about what exists, and a renamed subsystem cannot
// leave a stale domain behind.
//
// Each half is reached through the surface that publishes it — the spec tree
// through the spec repository's facade, the configuration through
// ./topology.js, never ../config/loader.js, which is one of that facade's
// members. Reaching the store directly would recreate the violation this file
// exists to fix, one component further out.
//
// Declared `read`, so the component that answers what exists provably cannot
// change it: registering and unregistering are `domain_curator`'s.
// ---------------------------------------------------------------------------

import * as path from 'path';
import { Domain } from '../models/domain.js';
import {
  loadSubsystemSpecs,
  loadComponentSpecs,
  getSubsystemPath,
  getComponentPath,
} from './specs.js';
// The configuration through the Repository facade, bound as a namespace so the
// call SITE names the contract method it reaches — `topology.loadConfig()`, not
// an `as`-renamed local that tells neither a reader nor the conformance
// analysis which method was called.
import * as topology from './topology.js';

function rel(p: string): string {
  return path.relative(process.cwd(), p).replace(/\\/g, '/');
}

/**
 * Only the domains the spec tree implies — one per subsystem, bound to it,
 * owning the subsystem's path and every component path under it. Projected on
 * every call, never stored.
 */
export function deriveSubsystemDomains(): Domain[] {
  const subsystems = loadSubsystemSpecs();
  const components = loadComponentSpecs();

  return subsystems.map((sub) => {
    const ownedPaths = [
      rel(getSubsystemPath(sub.id)),
      ...components
        .filter((c) => c.subsystem === sub.id)
        .map((c) => rel(getComponentPath(c.id, sub.id))),
    ];
    return {
      id: sub.id,
      name: sub.name,
      description: sub.description,
      boundTo: sub.id,
      ownedPaths,
    };
  });
}

/**
 * Every domain this project has, derived and registered alike. The distinction
 * matters to whoever writes a domain and not at all to whoever reads one.
 */
export function resolveDomains(): Domain[] {
  const derived = deriveSubsystemDomains();
  const registered = topology.loadConfig().domains;
  return [...derived, ...registered];
}
