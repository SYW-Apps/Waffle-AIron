import * as path from 'path';
import { getHostedLookup, getProjectRoot, getRequestParentReach, runWithProjectRoot } from '../utils/fs.js';
import type { ExternalBinding, ProjectFamily, ProjectNode, ResolvedExternal } from '../models/index.js';
// core_orchestrator.resolveChainingParent (the reach-gated detection) and the
// spec repository's graph and export usage, all on the one core module.
import { exportUsage, graph, resolveChainingParent } from './specs.js';

// ---------------------------------------------------------------------------
// external_producers — the producers of the bound project's declared externals.
//
// A family producer (parent, sibling, member) is visible only from the
// family's top root, so the workflow climbs the mount chain hop by hop through
// the core workflow's reach-gated chaining detection — the caller must gate on
// reach itself, and a hop that is out of reach ends the climb — binds the
// highest reachable root read-only, reads the project graph there, finds the
// bound project's node by its directory, and answers its externals, each bound
// to its producer, with the consumer's references into each family producer
// mapped onto that producer's public names. Every binding is scoped with
// runWithProjectRoot, so the caller's binding is restored on every path. It
// holds no state: the graph belongs to the spec repository.
//
// A source.hosted external (stage 7) names a producer by its hosted record id,
// in another isolated root no path reaches: it is resolved through the
// request binding's hosted record lookup, which answers only a record the
// request may read. Outside a hosted server there is no lookup, and the
// external is unavailable — never a pass: the consumer's own gate still judges
// it against its pin.
// ---------------------------------------------------------------------------

/** The reason a source.hosted external cannot be read outside a hosted server. */
export function hostedOnlyProducer(id: string): string {
  return `hosted-only producer \`${id}\`: available only through the hosted server`;
}

/** Step 10: a source.hosted external bound to the root the hosting server's record lookup answers, or unresolved. */
function resolveHosted(external: ResolvedExternal): ResolvedExternal {
  if (external.sourceKind !== 'hosted' || external.hosted === undefined) return external;
  const lookup = getHostedLookup();
  const unresolved = (problem: string): ResolvedExternal => ({ ...external, sourceKind: 'unresolved', problem });
  if (!lookup) return unresolved(hostedOnlyProducer(external.hosted));
  const root = lookup(external.hosted);
  return root === null
    ? unresolved(`the hosted producer \`${external.hosted}\` is unknown or outside this request's reach`)
    : { ...external, directory: path.resolve(root) };
}

/** A directory as a comparable key: resolved, and case-folded where the filesystem folds case. */
function dirKey(dir: string): string {
  const resolved = path.resolve(dir);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/** Climb to the highest root in reach; whether the family could be read whole. */
function climb(bound: string): { top: string; whole: boolean } {
  let top = bound;
  // Steps 2-4: one hop at a time, through the reach-gated detection.
  for (;;) {
    const parent = runWithProjectRoot(top, () => resolveChainingParent());
    if (!parent) break;
    top = path.resolve(parent.parentRoot);
  }
  // A request narrowed to its own root reads nothing above it: the family
  // above the bound root could not be looked at. Neither could it when the
  // caller narrowed the ceiling itself (a family run without --family) and the
  // climb stopped at that ceiling.
  const reach = getRequestParentReach();
  const stoppedAtNarrowedCeiling = !!reach?.narrowed && reach.topRoot !== undefined && dirKey(top) === dirKey(reach.topRoot);
  return { top, whole: !(reach && !reach.parentReach) && !stoppedAtNarrowedCeiling };
}

/** The consumer's node: the one whose directory is the bound root. */
function consumerNode(family: ProjectFamily, bound: string): ProjectNode | undefined {
  return family.nodes.find((n) => dirKey(n.directory) === dirKey(bound));
}

/** iexternal_producers.resolveDeclared — every declared external of the bound project, bound to its producer. */
export function resolveDeclared(): ExternalBinding[] {
  // Step 1: the consumer is the bound root.
  const bound = path.resolve(getProjectRoot());
  const { top, whole } = climb(bound);
  // Steps 5-12: read the graph at the highest root reached; the bound root's
  // own graph when the consumer is not in it (a mount that could not load).
  const answer = (root: string): ExternalBinding[] | null => runWithProjectRoot(root, () => {
    const family = graph();
    const node = consumerNode(family, bound);
    if (!node) return null;
    return node.externals.map((declared): ExternalBinding => {
      // Step 10: a hosted producer through the record lookup.
      const external = resolveHosted(declared);
      return {
        external,
        ...(external.sourceKind === 'family' && external.producer !== undefined
          ? { usage: exportUsage(node.namespace, external.producer) }
          : {}),
        reachable: whole,
      };
    });
  });
  return answer(top) ?? answer(bound) ?? [];
}
