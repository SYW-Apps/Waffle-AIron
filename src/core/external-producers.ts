import * as fs from 'fs';
import * as path from 'path';
import { getHostedLookup, getProjectRoot, getRequestParentReach, runWithProjectRoot } from '../utils/fs.js';
import { bindDeclaredExternal, declaredExternals, declaredMembers, effectiveProjectId, FULL_COMMIT_RE, type ExternalBinding, type ExternalConsumer, type ExternalDeclaration, type ProjectConfig, type ProjectFamily, type ProjectNode, type ResolvedExternal } from '../models/index.js';
// core_orchestrator.resolveChainingParent (the reach-gated detection) and the
// spec repository's graph, export usage and pinned usage, all on the one core module.
import { exportUsage, graph, listProjectRoots, pinnedUsage, resolveChainingParent } from './specs.js';
// git_source_adapter (stage 8): a git producer's ref resolved and its commit materialized in the fetch cache.
import * as gitSource from './adapters/git-source.js';

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

/** Where a git producer lives, as the consumer declares it: its URL, the ref an external follows, its commit and its root inside the repository. */
interface GitDeclaration {
  url: string;
  ref?: string;
  commit?: string;
  dir?: string;
}

/** A git producer's declaration in the consumer's configuration, as an external or as a referenced member. */
function gitDeclarationOf(config: ProjectConfig | null, external: ResolvedExternal): GitDeclaration | null {
  if (!config) return null;
  if (external.role === 'member') {
    const member = declaredMembers(config).find((m) => m.alias === external.alias);
    return member?.source.git ? { url: member.source.git, commit: member.source.commit, ref: member.source.ref, dir: member.source.dir } : null;
  }
  const declared = declaredExternals(config).find((e) => e.alias === external.alias);
  return declared?.sourceGit ? { url: declared.sourceGit, ref: declared.sourceRef, dir: declared.sourceDir } : null;
}

/**
 * Steps 13-14: a git producer bound to the cache directory of one commit — an
 * external's ref head resolved now (the live producer a status compares the
 * pin against), a referenced member's declared commit (the family is made of
 * the pinned revision). A remote that cannot be reached, or a commit that
 * cannot be fetched, leaves the binding without a directory and with the
 * problem: unavailable, never a pass.
 */
function resolveGit(external: ResolvedExternal, config: ProjectConfig | null, offline: boolean): ResolvedExternal {
  if (external.sourceKind !== 'git') return external;
  const declared = gitDeclarationOf(config, external);
  if (!declared) return { ...external, problem: 'git producer unavailable: its declaration names no repository' };
  // Steps 13-15: offline, an external's live producer is not read — bound
  // without a directory, never a pass; `externals status` fetches it. A
  // referenced member keeps its pinned commit, which the cache may already hold.
  if (offline && external.role !== 'member') {
    const { directory: _none, ...rest } = external;
    return { ...rest, problem: NOT_COMPARED_OFFLINE };
  }
  try {
    // Step 16: an external follows its ref — a ref that is a full commit
    // (`<url>#<commit>`) fixes it, with no remote to ask; a member keeps its
    // declared commit.
    const fixed = declared.ref !== undefined && FULL_COMMIT_RE.test(declared.ref) ? declared.ref : undefined;
    const commit = external.role === 'member' && declared.commit ? declared.commit : fixed ?? gitSource.resolve(declared.url, declared.ref);
    // Step 14: that commit materialized (served from the cache offline when it is there).
    const directory = gitSource.fetch(declared.url, commit, declared.dir);
    return { ...external, directory: path.resolve(directory), commit, problem: undefined };
  } catch (e) {
    const { directory: _gone, ...rest } = external;
    return { ...rest, problem: `git producer unavailable: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/** Why an offline read leaves a git external uncompared, naming the command that compares it. */
export const NOT_COMPARED_OFFLINE = 'not compared offline — `wairon externals status` fetches it';

/** The consumer's configuration, as the scan the graph came from read it. */
function consumerConfig(bound: string): ProjectConfig | null {
  return listProjectRoots().find((r) => dirKey(r.directory) === dirKey(bound))?.config ?? null;
}

/**
 * iexternal_producers.resolveDeclared — every declared external of the bound
 * project, and every referenced project member it declares (stage 8), bound to
 * its producer, each with the project's usage of it by public name. Offline,
 * nothing touches the network: a git external is bound unreachable with the
 * reason that `wairon externals status` fetches it.
 */
export function resolveDeclared(offline?: boolean): ExternalBinding[] {
  // Step 1: the consumer is the bound root.
  const bound = path.resolve(getProjectRoot());
  // Steps 2-4: climb to the highest root in reach.
  const { top, whole } = climb(bound);
  // Steps 5-17: read the graph at the highest root reached; the bound root's
  // own graph when the consumer is not in it (a mount that could not load).
  const answer = (root: string): ExternalBinding[] | null => runWithProjectRoot(root, () => {
    // Step 5.
    const family = graph();
    // Step 6.
    const node = consumerNode(family, bound);
    if (!node) return null;
    const config = consumerConfig(bound);
    // Step 7: each external, then each referenced project member.
    return node.externals.map((declared) => bindProducer(node, declared, config, whole, offline === true));
  });
  // Steps 19-20: the caller's binding is restored; the bindings in declaration order.
  return answer(top) ?? answer(bound) ?? [];
}

/** Steps 8-18 for one producer: the usage, and — outside the family — where its live table is. */
function bindProducer(node: ProjectNode, declared: ResolvedExternal, config: ProjectConfig | null, whole: boolean, offline: boolean): ExternalBinding {
  // Steps 8-10: a family producer, its usage mapped onto its live table.
  if (declared.sourceKind === 'family' && declared.producer !== undefined) {
    return { external: declared, usage: exportUsage(node.namespace, declared.producer), reachable: whole };
  }
  if (declared.sourceKind === 'unresolved') return { external: declared, reachable: whole };
  // Step 11: any other producer, its usage counted by the public name it spells.
  const usage = pinnedUsage(node.namespace, declared.alias);
  // Steps 12-16: git through the fetch cache; hosted through the record lookup.
  const external = declared.sourceKind === 'git' ? resolveGit(declared, config, offline) : headAcross(node.directory, resolveHosted(declared));
  // Step 21.
  return { external, usage, reachable: whole };
}

/** A directory as git roots compare: resolved, and case-folded where the filesystem folds case. */
const repoKey = (dir: string): string => (process.platform === 'win32' ? path.resolve(dir).toLowerCase() : path.resolve(dir));

/**
 * Step 17: a `../` sibling or path producer records the head of the work tree
 * holding it only when that is another git repository than the consumer's —
 * a same-repository producer records no commit (a monorepo re-pin never
 * churns the lock) and runs no git process.
 */
function headAcross(consumerDir: string, external: ResolvedExternal): ResolvedExternal {
  if (external.directory === undefined || external.sourceKind === 'git') return external;
  const theirs = gitSource.repositoryRoot(external.directory);
  const ours = gitSource.repositoryRoot(consumerDir);
  if (theirs === null || (ours !== null && repoKey(ours) === repoKey(theirs))) {
    const { commit: _same, ...rest } = external;
    return rest;
  }
  if (external.commit !== undefined) return external;
  const head = gitSource.head(external.directory);
  return head ? { ...external, commit: head } : external;
}

/**
 * iexternal_producers.resolveCandidate — one external declaration the bound
 * project does NOT hold yet, bound to its producer exactly as the written one
 * will be: the graph read at the highest root in reach, the declaration read
 * through the configuration's own reading and bound with
 * project_family.bindExternal, then git through the fetch cache and hosted
 * through the record lookup. No usage: nothing references the alias yet.
 * Read-only; the caller's binding is restored.
 */
export function resolveCandidate(alias: string, declaration: ExternalDeclaration): ExternalBinding {
  // Step 1: the would-be consumer is the bound root.
  const bound = path.resolve(getProjectRoot());
  // Step 2: climb to the highest root in reach.
  const { top, whole } = climb(bound);
  const config = consumerConfig(bound);
  // Steps 3-8: the graph there, the declaration bound over its nodes.
  const answer = (root: string): ExternalBinding | null => runWithProjectRoot(root, () => {
    const family = graph();
    const node = consumerNode(family, bound);
    if (!node) return null;
    const [declared] = declaredExternals({ externals: { [alias]: declaration }, ...(config?.members ? { members: config.members } : {}) });
    const candidate = bindDeclaredExternal(declared, node, family.nodes);
    // Git through the fetch cache (the candidate's declaration, not the configuration's), hosted through the lookup.
    const external = candidate.sourceKind === 'git'
      ? resolveGit(candidate, { externals: { [alias]: declaration } } as ProjectConfig, false)
      : headAcross(node.directory, resolveHosted(candidate));
    return { external, reachable: whole };
  });
  // Step 9: the caller's binding is restored.
  return answer(top) ?? answer(bound) ?? {
    external: { alias, project: declaration.project ?? alias, sourceKind: 'unresolved', audience: 'instance', role: 'external', problem: 'the bound project is not in the family graph its root reads' },
    reachable: whole,
  };
}

/**
 * iexternal_producers.listConsumers — the family projects that consume the
 * bound project, from its own root: the graph read at the highest root the
 * reach-gated climb reaches, and for every other project in it that declares
 * the bound project — as an external bound to it, or as a member — its id,
 * key, root, alias, section and the public names its specs use. Read-only and
 * within reach: a consumer outside the family read is never listed.
 */
export function listConsumers(search?: string[]): ExternalConsumer[] {
  // Step 1: the producer is the bound root.
  const bound = path.resolve(getProjectRoot());
  // Step 2: climb to the highest root in reach.
  const { top } = climb(bound);
  // Steps 3-10: the graph there, each project that declares the producer.
  const family = familyConsumers(bound, top);
  // Steps 11-14: each project root under the searched folders that declares it.
  const seen = new Set(family.map((c) => dirKey(c.directory)));
  const found = searchedConsumers(bound, search ?? []).filter((c) => !seen.has(dirKey(c.directory)));
  return [...family, ...found];
}

/** Steps 3-10 of listConsumers: the family read at the top root in reach. */
function familyConsumers(bound: string, top: string): ExternalConsumer[] {
  return runWithProjectRoot(top, () => {
    const family = graph();
    const producer = consumerNode(family, bound);
    if (!producer) return [];
    const consumers: ExternalConsumer[] = [];
    for (const node of family.nodes) {
      if (node === producer) continue;
      const external = node.externals.find((e) => e.sourceKind === 'family' && e.producer === producer.namespace);
      const memberAlias = [...node.aliases.entries()].find(([alias, key]) => key === producer.namespace && !node.externals.some((e) => e.alias === alias))?.[0];
      const alias = external?.alias ?? memberAlias;
      if (alias === undefined) continue;
      const usage = exportUsage(node.namespace, producer.namespace);
      consumers.push({
        project: node.id ?? node.namespace,
        key: node.namespace,
        directory: node.directory,
        alias,
        section: external ? 'externals' : 'members',
        names: usage.used.map((u) => u.publicName).sort(),
        ...brokenNames(usage),
      });
    }
    return consumers.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  });
}

/**
 * The names a consumer still writes that bind to no public name of the
 * producer — the ones a breaking change just broke — so "who breaks" never
 * drops them. Absent when there are none.
 */
function brokenNames(usage: { unexported: { authored: string }[] }): { broken?: string[] } {
  const names = [...new Set(usage.unexported.map((r) => r.authored.split('::').pop() ?? r.authored))].sort();
  return names.length ? { broken: names } : {};
}

/** The project roots a searched folder holds: itself when it is one, else each folder directly under it that is. */
function projectRootsUnder(folder: string): string[] {
  const isRoot = (dir: string): boolean => fs.existsSync(path.join(dir, '.wai', 'project.yaml'));
  const at = path.resolve(folder);
  if (!fs.existsSync(at)) return [];
  if (isRoot(at)) return [at];
  return fs.readdirSync(at, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith('.') && d.name !== 'node_modules')
    .map((d) => path.join(at, d.name))
    .filter(isRoot);
}

/**
 * Steps 11-14 of listConsumers: every project root in (or directly under) a
 * searched folder that declares the bound project as an external — by a path
 * source that resolves to the bound root, or by a git source whose declared
 * project id is the bound project's — each with the alias, and the public
 * names its specs spell through that alias. Read-only; each root is bound in
 * turn and the caller's binding restored.
 */
function searchedConsumers(bound: string, search: string[]): ExternalConsumer[] {
  if (search.length === 0) return [];
  // A hosted request reads its own project's records, never a folder on the server's disk.
  if (getHostedLookup() !== null) throw new Error('searching folders for consumers is a local read: a hosted request reads no folder outside its project');
  const producerId = runWithProjectRoot(bound, () => {
    const config = consumerConfig(bound);
    return config ? effectiveProjectId(config) : null;
  });
  const roots = [...new Set(search.flatMap(projectRootsUnder).map((r) => path.resolve(r)))].filter((r) => dirKey(r) !== dirKey(bound));
  const out: ExternalConsumer[] = [];
  for (const root of roots) {
    const answer = runWithProjectRoot(root, (): ExternalConsumer | null => {
      let config: ProjectConfig | null;
      try {
        config = consumerConfig(root);
      } catch {
        return null;
      }
      if (!config) return null;
      const declared = declaredExternals(config).find((e) => !e.problem && (
        (e.sourcePath !== undefined && dirKey(path.resolve(root, e.sourcePath)) === dirKey(bound))
        || (e.sourceGit !== undefined && producerId !== null && e.project === producerId)));
      if (!declared) return null;
      const node = consumerNode(graph(), root);
      const usage = node ? pinnedUsage(node.namespace, declared.alias) : null;
      return {
        project: effectiveProjectId(config) ?? path.basename(root),
        key: node?.namespace ?? '',
        directory: root,
        alias: declared.alias,
        section: 'externals',
        names: (usage?.used ?? []).map((u) => u.publicName).sort(),
        found: 'search',
      };
    });
    if (answer) out.push(answer);
  }
  return out.sort((a, b) => (a.directory < b.directory ? -1 : a.directory > b.directory ? 1 : 0));
}

/** Where the baseline of a surface comparison was read: the tree at one commit, and how a reader names it. */
export interface ApprovedRevision {
  directory: string;
  commit: string;
  label: string;
}

/**
 * iexternal_producers.approvedRevision — the bound project's tree as it stood
 * at a revision, materialized read-only in the fetch cache: the given ref
 * (a branch, tag or commit), else the commit that last recorded its approval
 * (the last commit to change .wai/lock.json). Throws naming why when the
 * project is in no git work tree, the ref names no commit, or no approval was
 * ever committed. No network: the repository is the local one.
 */
export function approvedRevision(against?: string): ApprovedRevision {
  // Step 1: the bound root and the work tree holding it.
  const bound = path.resolve(getProjectRoot());
  const repo = gitSource.repositoryRoot(bound);
  if (!repo) throw new Error(`${bound} is in no git work tree, so there is no earlier revision to compare with — pass a saved surface snapshot (\`--against <file>\`) instead`);
  // Step 2: the commit — the ref asked for, else the last approval committed.
  const commit = against !== undefined ? gitSource.commitOf(bound, against) : gitSource.lastCommitOf(bound, path.join('.wai', 'lock.json'));
  if (!commit) {
    throw new Error(against !== undefined
      ? `"${against}" names no commit of the repository at ${repo}`
      : 'no approval of this project was ever committed (.wai/lock.json is in no commit) — lock and commit first, or name a revision (`--against <ref>`)');
  }
  // Step 3: that commit's tree of the project, from the fetch cache.
  const relative = path.relative(repo, bound);
  const directory = gitSource.fetch(repo, commit, relative === '' ? undefined : relative);
  // Step 4.
  return { directory, commit, label: against !== undefined ? `${against} (${commit.slice(0, 12)})` : `the last approval, committed at ${commit.slice(0, 12)}` };
}
