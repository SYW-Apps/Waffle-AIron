import { AgentRecord } from '../models/agent.js';
import {
  ExecutionProfile,
  ReasoningDepth,
  WorkBreadth,
} from '../models/execution.js';

// ---------------------------------------------------------------------------
// Execution profile derivation
//
// Reads the resource shape of an agent's work off the topology wairon already
// resolves. No spec authoring is required for this to work: every input here
// is something resolveAgentTopology() already puts on an AgentRecord.
//
// This file is tool-agnostic on purpose. It never names a model, a tool, or a
// host CLI — it answers "what is this work like", and the policy layer decides
// what that earns.
// ---------------------------------------------------------------------------

/**
 * Component stereotypes whose work is fully described by their L3 contract and
 * L5 narrative — plumbing, with the decisions already made upstream.
 */
const MECHANICAL_STEREOTYPES = new Set(['store', 'index', 'registry', 'adapter']);

/**
 * Stereotypes that carry the decision logic. These are where getting it wrong
 * is expensive, so they keep the capable tier even under an aggressive policy.
 */
const DEEP_STEREOTYPES = new Set(['orchestrator', 'supervisor', 'specialist']);

/** Templates whose whole job is routing work to other agents. */
const MANAGER_TEMPLATES = new Set(['architect', 'domain-owner']);

/** Templates that survey rather than change things. */
const READ_ONLY_TEMPLATES = new Set(['reviewer', 'guardian']);

/** Owned-path count above which an agent is surveying rather than focused. */
const WIDE_PATH_COUNT = 12;
const MODERATE_PATH_COUNT = 4;

/** A path glob that reaches most of the tree. */
function isSweeping(p: string): boolean {
  return p === '**' || p === '**/*' || p.startsWith('**/');
}

function deriveBreadth(agent: AgentRecord): WorkBreadth {
  // An agent that may read everything is surveying by construction, whatever
  // its owned-path count says.
  if (agent.readPaths.some(isSweeping)) {
    return MANAGER_TEMPLATES.has(agent.template) || READ_ONLY_TEMPLATES.has(agent.template)
      ? 'wide'
      : 'moderate';
  }
  const owned = agent.ownedPaths.length;
  if (owned >= WIDE_PATH_COUNT) return 'wide';
  if (owned >= MODERATE_PATH_COUNT) return 'moderate';
  return 'narrow';
}

function deriveReasoningDepth(agent: AgentRecord): ReasoningDepth {
  // Component implementers carry their stereotype as a tag — the vocabulary
  // already encodes how much judgment the role holds, so use it rather than
  // inventing a second classification.
  for (const tag of agent.tags) {
    if (DEEP_STEREOTYPES.has(tag)) return 'deep';
    if (MECHANICAL_STEREOTYPES.has(tag)) return 'mechanical';
  }
  if (MANAGER_TEMPLATES.has(agent.template)) return 'deep';
  if (agent.template === 'reviewer') return 'deep';
  if (agent.template === 'tester') return 'standard';
  return 'standard';
}

/**
 * Whether the agent modifies files. This is a property of the ROLE, not of how
 * many paths happened to resolve: an implementer whose source path could not
 * be inferred is a topology gap to fix, not a read-only agent. Deriving this
 * from owned-path count silently produced implementers that could not
 * implement, which is worse than being wrong loudly.
 */
function deriveWrites(agent: AgentRecord): boolean {
  return !READ_ONLY_TEMPLATES.has(agent.template);
}

/**
 * Derive the execution profile for an agent from the topology alone.
 *
 * Pure and total: it never reads the filesystem and never throws, so it is
 * safe to call from generate, from the MCP brief composer, and from analyze.
 */
export function deriveExecutionProfile(agent: AgentRecord): ExecutionProfile {
  const breadth = deriveBreadth(agent);
  const reasoningDepth = deriveReasoningDepth(agent);
  const writes = deriveWrites(agent);
  const delegates = MANAGER_TEMPLATES.has(agent.template);

  const because: string[] = [];

  if (delegates) {
    because.push(`${agent.template} routes work rather than performing it`);
  }

  const stereotype = agent.tags.find(
    (t) => MECHANICAL_STEREOTYPES.has(t) || DEEP_STEREOTYPES.has(t),
  );
  if (stereotype) {
    because.push(
      MECHANICAL_STEREOTYPES.has(stereotype)
        ? `${stereotype} work is specified by its contract and narrative`
        : `${stereotype} carries decision logic`,
    );
  }

  because.push(
    breadth === 'wide'
      ? 'reads broadly across the tree'
      : breadth === 'moderate'
        ? `spans ${agent.ownedPaths.length} owned path(s)`
        : 'scoped to a small owned set',
  );

  if (!writes) because.push('read-only');

  return {
    breadth,
    writes,
    reasoningDepth,
    delegates,
    rationale: because.join('; '),
  };
}
