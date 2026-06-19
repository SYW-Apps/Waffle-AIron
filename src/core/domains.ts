import * as path from 'path';
import { Domain } from '../models/domain.js';
import { loadTopologyConfig, saveTopologyConfig } from '../config/loader.js';
import {
  loadSubsystemSpecs,
  loadComponentSpecs,
  getSubsystemPath,
  getComponentPath,
} from './specs.js';
import { WaironError } from '../utils/errors.js';

// ---------------------------------------------------------------------------
// Domain resolution
//
// A domain is a unit of agent ownership. Domains come from two sources:
//   - Spec-backed:  derived 1:1 from L1 subsystems (boundTo = subsystem id).
//   - Free-standing: declared in .wai/topology.yaml for cross-cutting scopes.
//
// resolveDomains() returns both. Only free-standing domains are mutable.
// ---------------------------------------------------------------------------

function rel(p: string): string {
  return path.relative(process.cwd(), p).replace(/\\/g, '/');
}

/** Domains derived from L1 subsystems (spec-backed). */
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

/** Free-standing domains declared in .wai/topology.yaml. */
export function listFreeStandingDomains(): Domain[] {
  return loadTopologyConfig().domains;
}

/** All domains: spec-backed (derived) + free-standing. */
export function resolveDomains(): Domain[] {
  return [...deriveSubsystemDomains(), ...listFreeStandingDomains()];
}

export function findDomain(id: string): Domain | undefined {
  return resolveDomains().find((d) => d.id === id);
}

// ---------------------------------------------------------------------------
// Free-standing domain mutation (the only authored part of the topology)
// ---------------------------------------------------------------------------

export function addFreeStandingDomain(domain: Domain): void {
  const config = loadTopologyConfig();
  if (config.domains.some((d) => d.id === domain.id)) {
    throw new WaironError(`A free-standing domain "${domain.id}" already exists in .wai/topology.yaml.`);
  }
  if (deriveSubsystemDomains().some((d) => d.id === domain.id)) {
    throw new WaironError(`Domain id "${domain.id}" collides with a subsystem-derived domain.`);
  }
  config.domains.push(domain);
  saveTopologyConfig(config);
}

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
