// ---------------------------------------------------------------------------
// Domain scaffolding — shared logic used by `init` and `scaffold-domains`
//
// Expands a bundle into AgentRecord objects for a given domain.
// The agents are given domainRoot so the generator places them inside the
// domain directory and creates project-root reference copies per propagation.
// ---------------------------------------------------------------------------

import { Domain } from '../models/domain.js';
import { AgentRecord, createAgentRecord } from '../models/agent.js';
import { loadBundle } from './bundles.js';

/**
 * Expand a bundle into agent records scoped to the given domain.
 *
 * @param domain         The domain these agents will belong to.
 * @param bundleId       Which bundle to expand.
 * @param targets        Output targets (e.g. ['claude', 'gemini']).
 * @returns              Array of unsaved AgentRecord objects.
 */
export function expandBundleForDomain(
  domain: Domain,
  bundleId: string,
  targets: string[],
): AgentRecord[] {
  const bundle = loadBundle(bundleId);
  const scope = domain.id;
  const scopeDir = domain.path;

  return bundle.agents.map((spec) => {
    const agentId = `${scope}-${spec.idSuffix}`;
    const name = spec.namePattern.replace(/\{\{scope\}\}/g, scope);
    const description = spec.descriptionPattern.replace(/\{\{scope\}\}/g, scope);
    const ownedPaths = spec.ownedPathPatterns.map((p) =>
      p.replace(/\{\{scopeDir\}\}/g, scopeDir),
    );

    return createAgentRecord({
      id: agentId,
      name,
      description,
      creationReason: `Scaffolded by wairon (bundle: ${bundleId}, domain: ${scope}).`,
      template: spec.template,
      ownedPaths,
      tags: [...spec.tags],
      targets: targets as AgentRecord['targets'],
      bundleOrigin: bundleId,
      domainRoot: domain.id,
    });
  });
}
