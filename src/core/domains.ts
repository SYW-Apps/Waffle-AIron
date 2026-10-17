// ---------------------------------------------------------------------------
// The free-standing domains a project registers — `domain_registry`, and
// nothing but the writes.
//
// Every write is read-modify-write through the store: load the configuration,
// change the domains array, save it back. Nothing is cached between calls, so
// two commands in one process cannot disagree about what is registered.
//
// It guards the integrity of the set it OWNS — no two registered domains may
// answer to one id — and nothing beyond it. A domain that binds to a subsystem
// is DERIVED from the spec tree and is not registry business at all: refusing
// an id the spec tree already answers to needs both sources at once, which is
// workflow, and `domain_curator` does it before it calls here. That is why this
// file no longer names ./specs.js — a Registry reaches its own Store, a backend
// Adapter or pure logic, and the spec tree is none of the three.
//
// The reads moved out with it, to `domain_projector`. What is left here is only
// what changes the file.
// ---------------------------------------------------------------------------

import { Domain } from '../models/domain.js';
import { loadTopologyConfig, saveTopologyConfig } from '../config/loader.js';
import { WaironError } from '../utils/errors.js';

/**
 * Register a domain the spec tree does not imply, and persist it. Refuses an id
 * the registered set already holds — two registered domains answering to one id
 * makes every later lookup ambiguous. A collision with a subsystem-derived
 * domain is caught above, because seeing it needs the spec tree too.
 */
export function addFreeStandingDomain(domain: Domain): void {
  const config = loadTopologyConfig();
  if (config.domains.some((d) => d.id === domain.id)) {
    throw new WaironError(`A free-standing domain "${domain.id}" already exists in .wai/topology.yaml.`);
  }
  config.domains.push(domain);
  saveTopologyConfig(config);
}

/**
 * Unregister a free-standing domain and persist the removal. A derived domain
 * is not in the registered set, and answering "removed" for one would be a lie
 * the caller could not detect — so the message says where to change it instead.
 */
export function removeFreeStandingDomain(id: string): void {
  const config = loadTopologyConfig();
  const idx = config.domains.findIndex((d) => d.id === id);
  if (idx === -1) {
    throw new WaironError(
      `"${id}" is not a free-standing domain. Subsystem-backed domains are derived from the spec tree and cannot be removed here.`,
    );
  }
  config.domains.splice(idx, 1);
  saveTopologyConfig(config);
}
