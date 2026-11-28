import { files } from '../io/index.js';
import path from 'node:path';
import { runWithProjectRoot, getProjectRoot } from '../utils/fs.js';
import {
  EXTERNAL_ALIAS_RE,
  aliasGrammarProblem,
  PROJECT_ID_RE,
  USE_ENTRY_RE,
  effectiveProjectId,
  readExternalSource,
  type ExternalDeclaration,
  type ExternalSource,
  type ProjectConfig,
} from '../models/project.js';
import { identifierProblem } from '../models/identifiers.js';
import {
  SURFACE_AUDIENCES,
  type ExternalAddition,
  type ExternalBinding,
  type ExternalPin,
  type ExternalRemoval,
  type ExternalRequest,
  type ExternalUseChange,
  type ExternalUseRequest,
} from '../models/index.js';
// surfaces_core_adapter: every name this workflow takes from sdd_core lands on
// the adapter's own module — the configuration it writes into, the externals
// it resolves, a candidate declaration bound before it is written, and a
// producer's configuration and export table.
import {
  loadProjectConfig,
  declareExternal as writeDeclaration,
  removeExternal,
  importNames,
  resolveExternals,
  resolveExternalCandidate,
  resolveProjectExports,
  projectFamily,
  resolveChainingParent,
} from './adapters/surfaces-core.js';
// surface_orchestrator: the pin a declaration is followed by, the externals
// listing a removal reads, and the unpin it is followed by.
import { listExternals, pinExternals } from './surfaces.js';
import { unpin } from './externals.js';
import { ownGet } from '../utils/own.js';

/** Ascending reach rank of an audience level; an unknown level ranks as 'instance'. */
function audienceRank(audience: string | undefined): number {
  const levels = SURFACE_AUDIENCES as readonly string[];
  const idx = levels.indexOf(audience ?? 'instance');
  return idx === -1 ? levels.indexOf('instance') : idx;
}

/** The audience ranking, narrowest first, as a refusal spells it. */
const AUDIENCE_RANKING = (SURFACE_AUDIENCES as readonly string[]).join(' < ');

// ---------------------------------------------------------------------------
// external_declarations — declares, removes and re-imports one external of the
// bound project the way `wairon member add` declares a member: `wairon
// externals add | remove | use` and the MCP tools sdd_add_external,
// sdd_remove_external and sdd_update_external, instead of a hand-edited
// `.wai/project.yaml`.
//
// It reads the request's location in the one location grammar members use,
// refuses what cannot be declared with one sentence naming the accepted form
// (never a schema dump), binds the declaration to its producer BEFORE writing
// it — the core's candidate binding is the binding the written declaration
// will get, so a dry run checks the producer too — refuses what the producer
// contradicts, writes the normalized declaration through the core's
// configuration portal, and pins it when asked, so the reproducible gate
// exists from the first validate. A removal takes the declaration and its pin
// out together. It holds no state and never touches the spec tree.
// ---------------------------------------------------------------------------

/** The accepted forms of a request's location, as a refusal names them. */
const LOCATION_FORMS = '`../sibling`, `hosted:<id>`, `<git url>` or `<git url>#<commit>`';

/** Text that is no location at all: braces, brackets, quotes, whitespace, or a YAML/JSON object pasted as a string. */
const NOT_A_LOCATION = /[\s{}[\]"'`<>|*?]/;

/** A refusal: nothing written, one sentence. */
function refused(alias: string, why: string): ExternalAddition {
  return { alias, written: false, declaration: null, refusal: `The external "${alias}" was not declared: ${why}.` };
}

/** The request's own problems, before anything is read or written; null when it can be declared. */
function requestProblem(request: ExternalRequest, config: ProjectConfig | null, source: ExternalSource | undefined, sourceProblem: string | undefined): string | null {
  const { alias } = request;
  if (!EXTERNAL_ALIAS_RE.test(alias) && /^[a-z0-9_-]+$/.test(alias)) return `${aliasGrammarProblem(alias)}${/Windows/.test(aliasGrammarProblem(alias)) ? ': it would be the name of its pin file' : ''}`;
  if (!EXTERNAL_ALIAS_RE.test(alias)) return `an alias is [a-z0-9-_]+, and "${alias}" is not — choose one specs can write as \`${alias.toLowerCase().replace(/[^a-z0-9_-]/g, '-')}::name\``;
  if (ownGet(config?.members, alias) !== undefined) return `"${alias}" is already declared under \`members\` — one alias names one project, so choose another alias`;
  if (ownGet(config?.externals, alias) !== undefined) return `"${alias}" is already declared under \`externals\` — choose another alias, change its imports with \`wairon externals use ${alias} --add <names>\` (sdd_update_external), or remove it first with \`wairon externals remove ${alias}\``;
  if (request.source !== undefined && NOT_A_LOCATION.test(request.source.trim())) {
    return `the source "${request.source}" is not a location (accepted: ${LOCATION_FORMS})`;
  }
  if (sourceProblem) return `${sourceProblem.replace(/^its /, 'the ')} (accepted: ${LOCATION_FORMS})`;
  const git = source?.git !== undefined;
  if (!git && (request.ref !== undefined || request.dir !== undefined)) {
    return '`ref` and `dir` apply to a git source only — write the source as `<git url>` or `<git url>#<commit>`';
  }
  if (git && request.ref !== undefined && source?.ref !== undefined && request.ref !== source.ref) {
    return `the source fixes the ref at "${source.ref}" (its \`#<commit>\`), but \`ref\` says "${request.ref}" — give one of them`;
  }
  if (request.project !== undefined && !PROJECT_ID_RE.test(request.project)) return `the producer id "${request.project}" breaks the project-id grammar — ${identifierProblem(request.project, 'project-id')}`;
  const bad = (request.use ?? []).find((u) => !USE_ENTRY_RE.test(u));
  if (bad !== undefined) return `the \`use\` entry "${bad}" is neither \`*\` nor a public name ([a-z0-9-_]+)`;
  return null;
}

/** The normalized declaration in object form: only what the request says, the producer id only when it is not the alias. */
function declarationOf(request: ExternalRequest, source: ExternalSource | undefined): ExternalDeclaration {
  const ref = source?.ref ?? request.ref;
  const normalized: ExternalSource | undefined = source === undefined
    ? undefined
    : source.git !== undefined
      ? { git: source.git, ...(ref !== undefined ? { ref } : {}), ...(request.dir !== undefined ? { dir: request.dir } : {}) }
      : source.hosted !== undefined ? { hosted: source.hosted } : { path: source.path! };
  const use = [...new Set(request.use ?? [])];
  return {
    ...(request.project !== undefined && request.project !== request.alias ? { project: request.project } : {}),
    ...(normalized ? { source: normalized } : {}),
    ...(use.length ? { use } : {}),
    ...(request.description !== undefined ? { description: request.description } : {}),
  };
}

/** The edit distance between two names: the closest exported names are named in a refusal. */
function distance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const next = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = row[j];
      row[j] = next;
    }
  }
  return row[b.length];
}

/** Up to three exported names closest to one the producer does not export. */
function closest(name: string, exported: string[]): string[] {
  return [...exported].sort((x, y) => distance(name, x) - distance(name, y) || (x < y ? -1 : 1)).slice(0, 3);
}

/** What the producer answered with its root bound: the id it answers to, the names it exports to this project, and every name's audience. */
interface ProducerRead {
  id: string | null;
  exported: string[];
  /** Every public name the producer exports, with its widest audience: a name kept from this project by its audience is told apart from one that does not exist. */
  audiences: Map<string, string>;
  /** The audience this project is read at (project for a family producer, instance for one outside the family). */
  audience: string;
}

/** Steps 13-14: the producer's configuration and export table, its root bound read-only — or why it cannot be read. */
function readProducer(binding: ExternalBinding): { read: ProducerRead } | { why: string } {
  const { external } = binding;
  const directory = external.directory;
  if (external.sourceKind === 'unresolved' || directory === undefined) return { why: external.problem ?? 'it does not resolve' };
  if (!files.exists(directory)) return { why: `its root ${directory} does not exist` };
  try {
    return runWithProjectRoot(directory, () => {
      // Step 13: the id it answers to.
      const config = loadProjectConfig();
      if (!config) return { why: `${directory} holds no wairon project` };
      // Step 14: the public names it exports at this project's audience, and every name's own audience.
      const floor = audienceRank(external.audience);
      const entries = resolveProjectExports().entries;
      const exported = entries.filter((e) => audienceRank(e.audience ?? 'instance') >= floor).map((e) => e.publicName);
      const audiences = new Map<string, string>();
      for (const e of entries) {
        const audience = e.audience ?? 'instance';
        const held = audiences.get(e.publicName);
        if (held === undefined || audienceRank(audience) > audienceRank(held)) audiences.set(e.publicName, audience);
      }
      return { read: { id: effectiveProjectId(config), exported: [...new Set(exported)], audiences, audience: external.audience } };
    });
  } catch (e) {
    return { why: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Why the producer does not export one name to this project: kept from it by
 * its audience (naming that audience, this project's and the ranking), or not
 * exported at all (naming the closest names it does export).
 */
function unexportedReason(name: string, read: ProducerRead): string {
  const narrower = read.audiences.get(name);
  if (narrower !== undefined) {
    const who = read.audience === 'project' ? 'a project of its family' : 'a path, git or hosted consumer outside its family';
    return `the producer exports "${name}" to \`${narrower}\` only, and this project is outside it — it reads the producer at \`${read.audience}\` (${who}); audiences, narrowest first: ${AUDIENCE_RANKING} — widen the export's audience in the producer's L0, or consume it from inside its family`;
  }
  return `the producer does not export "${name}" to this project${read.exported.length ? ` (closest: ${closest(name, read.exported).map((n) => `"${n}"`).join(', ')})` : ' (it exports nothing to this project)'}`;
}

/** Step 15: what the producer contradicts in the declaration, as the refusal's reason; null when nothing. */
function contradiction(request: ExternalRequest, binding: ExternalBinding | undefined, read: ProducerRead | null): string | null {
  const declared = request.project ?? request.alias;
  // The family's own resolution already compared the id it found at the source.
  const problem = binding?.external.problem;
  if (binding?.external.sourceKind === 'unresolved' && problem && /answers to/.test(problem)) {
    return `${problem} — declare its id with \`project\`, or point the source at the producer you meant`;
  }
  if (!read) return null;
  if (read.id !== null && read.id !== declared) {
    return `the producer there answers to "${read.id}", not "${declared}" — declare \`project: ${read.id}\`, or use "${read.id}" as the alias`;
  }
  const missing = (request.use ?? []).filter((u) => u !== '*' && !read.exported.includes(u));
  return missing.length > 0 ? missing.map((u) => unexportedReason(u, read)).join('; ') : null;
}

/** The ids the family's projects answer to, best effort: the graph the bound root reads. */
function familyIds(): string[] {
  try {
    // The graph is read at the highest root the family reaches, as the candidate binding reads it.
    let top = path.resolve(getProjectRoot());
    for (;;) {
      const parent = runWithProjectRoot(top, () => resolveChainingParent());
      if (!parent) break;
      top = path.resolve(parent.parentRoot);
    }
    return runWithProjectRoot(top, () => [...new Set(projectFamily().nodes.map((n) => n.id).filter((id): id is string => id !== undefined))]);
  } catch {
    return [];
  }
}

/** Steps 10-12: why no family project on disk answers to the producer id. */
function noFamilyProject(declared: string, problem: string | undefined, config: ProjectConfig | null): string {
  const ids = familyIds();
  const member = ownGet(config?.members, declared);
  const memberAt = typeof member === 'string' ? member : member && typeof member === 'object' ? (member as { source?: unknown }).source : undefined;
  const located = typeof memberAt === 'string' && /^(hosted:|git@|https?:|ssh:)|\.git(#|$)/.test(memberAt)
    ? ` — a member answers to it at \`${memberAt}\`, give that as the source`
    : '';
  const answers = ids.length ? ids.map((i) => `"${i}"`).join(', ') : 'no id';
  return `no family project on disk answers to "${declared}", so \`source\` must say where it is (accepted: ${LOCATION_FORMS}); the family's projects answer to ${answers}${located}${problem ? ` (${problem})` : ''}`;
}

/**
 * iexternal_declarations.declare— declare one external of the bound project:
 * refuse, writing nothing, what cannot be declared (each in one sentence
 * naming the accepted form); otherwise bind the declaration to its producer
 * BEFORE writing it, refuse what the producer contradicts, and — unless this
 * is a dry run, which answers the same verdict — write the normalized
 * declaration and pin it when asked and the producer was read.
 */
export function declare(request: ExternalRequest): ExternalAddition {
  const { alias } = request;
  // Step 1: the configuration, for the aliases `members` and `externals` already hold.
  const config = loadProjectConfig();
  // Step 2: the request read through the one location grammar.
  const read = request.source !== undefined ? readExternalSource(request.source) : {};
  const problem = requestProblem(request, config, read.source, read.problem);
  // Steps 3-4: a refusal writes nothing.
  if (problem) return refused(alias, problem);
  const requested = declarationOf(request, read.source);
  const declared = request.project ?? alias;
  // Step 5: the binding the written declaration will get, before anything is written.
  let binding: ExternalBinding | undefined;
  let bindProblem = 'it could not be bound';
  try {
    binding = resolveExternalCandidate(alias, requested);
  } catch (e) {
    bindProblem = e instanceof Error ? e.message : String(e);
  }
  // Steps 6-12: a request with no source is filled in from the family.
  let declaration = requested;
  if (request.source === undefined) {
    const external = binding?.external;
    if (external?.sourceKind === 'family' && external.directory !== undefined) {
      // Steps 7-9: the relative path from this project's root to that project's root.
      const relative = path.relative(path.resolve(getProjectRoot()), external.directory).split(path.sep).join('/');
      declaration = { ...requested, source: { path: relative } };
    } else {
      // Steps 10-12: no family project on disk answers to the producer id.
      return refused(alias, noFamilyProject(declared, external?.problem ?? (binding ? undefined : bindProblem), config));
    }
  }
  // Steps 13-14: what the producer answers, when it can be read.
  const answered = binding ? readProducer(binding) : { why: bindProblem };
  const producer = 'read' in answered ? answered.read : null;
  // Steps 15-16: a contradiction refuses, writing nothing.
  const contradicted = contradiction(request, binding, producer);
  if (contradicted) return refused(alias, contradicted);
  const why = 'why' in answered ? answered.why : 'unknown';
  // Steps 17-18: a dry run answers the same verdict and writes nothing.
  if (request.dryRun) {
    return {
      alias, written: false, declaration, project: producer?.id ?? declared,
      ...(producer ? {} : { unreachable: `its producer could not be read (${why}), so nothing would be pinned` }),
    };
  }
  // Step 19: the write, through the core's configuration portal.
  try {
    writeDeclaration(alias, declaration);
  } catch (e) {
    return refused(alias, (e instanceof Error ? e.message : String(e)).replace(/\.$/, ''));
  }
  // Steps 20-21: pin it when asked and the producer was read.
  let pin: ExternalPin | undefined;
  if (request.pin !== false && producer) pin = pinExternals([alias])[0];
  // Step 22: the addition.
  const unreachable = producer
    ? undefined
    : `its producer could not be read (${why}), so nothing was pinned — it reads as unavailable, never a pass, until \`wairon externals pin ${alias}\` succeeds`;
  return {
    alias,
    written: true,
    declaration,
    project: producer?.id ?? declared,
    ...(pin ? { pin } : {}),
    ...(unreachable ? { unreachable } : {}),
  };
}

/**
 * iexternal_declarations.remove — remove one external of the bound project:
 * its declaration and its pin (lock entry and snapshot) together, so no
 * orphaned pin is left; an orphaned pin alone is removed too. Refused, writing
 * nothing, when the alias is neither declared nor pinned.
 */
export function remove(alias: string, dryRun?: boolean): ExternalRemoval {
  // Step 1: the configuration's externals.
  const config = loadProjectConfig();
  const declared = ownGet(config?.externals, alias) !== undefined;
  // Step 2: the externals with their lock entries, orphaned pins included —
  // read only when the answer depends on it (an undeclared alias, a dry run),
  // since listing binds every declared producer.
  const rows = !declared || dryRun ? listExternals() : [];
  const pinned = rows.some((r) => r.alias === alias && r.lock !== undefined);
  // Steps 3-4: neither declared nor pinned.
  if (!declared && !pinned) {
    const known = rows.map((r) => `"${r.alias}"`);
    return {
      alias, removed: false, unpinned: false,
      refusal: `The external "${alias}" was not removed: it is neither declared nor pinned here — ${known.length ? `this project's externals are ${known.join(', ')}` : 'this project declares no externals'}.`,
    };
  }
  // Steps 5-6: a dry run writes nothing, and says so: nothing was removed,
  // and what the real run would take out is answered apart, never as if done.
  if (dryRun) return { alias, removed: false, unpinned: false, dryRun: true, wouldRemove: { declaration: declared, pin: pinned } };
  // Step 7: the declaration, when declared.
  const removed = declared ? removeExternal(alias) : false;
  // Step 8: the pin with it.
  const unpinned = unpin(alias);
  // Step 9.
  return { alias, removed, unpinned };
}

/** The current `use` of one declared external, as written. */
function currentUse(declaration: unknown): string[] {
  const use = typeof declaration === 'object' && declaration !== null ? (declaration as { use?: unknown }).use : undefined;
  return Array.isArray(use) ? use.filter((u): u is string => typeof u === 'string') : [];
}

/** A `use` refusal: nothing written, one sentence. */
function useRefused(alias: string, use: string[], why: string): ExternalUseChange {
  return { alias, written: false, use, added: [], removed: [], refusal: `The \`use\` of "${alias}" was not changed: ${why}.` };
}

/** The object form of a declaration's source, whichever form it was written in. */
function sourceObject(source: ExternalDeclaration['source']): ExternalSource | undefined {
  return typeof source === 'string' ? readExternalSource(source).source : source;
}

/** The location a declaration names, as a comparable string; empty when it names none. */
function locationKey(source: ExternalSource | undefined): string {
  if (!source) return '';
  return JSON.stringify([source.git ?? null, source.ref ?? null, source.dir ?? null, source.hosted ?? null, source.path ?? null]);
}

/**
 * iexternal_declarations.update — change one declared external: add and
 * remove `use` imports and/or give it a new location. Refused, writing
 * nothing, for an undeclared alias, a malformed entry or location, an added
 * name the readable producer does not export to this project, or a producer at
 * the new location answering to another id. A dry run, or a change that
 * changes nothing, writes nothing. A new location is followed by the pin:
 * a path producer's earlier pin is dropped (read live), a git or hosted one is
 * pinned anew.
 */
export function update(request: ExternalUseRequest): ExternalUseChange {
  const { alias } = request;
  // Step 1: the configuration, for the declaration and its current `use`.
  const config = loadProjectConfig();
  const existing = ownGet(config?.externals, alias);
  const current = currentUse(existing);
  // Steps 2-4: the request's own problems.
  if (existing === undefined) {
    const declared = Object.keys(config?.externals ?? {});
    return useRefused(alias, current, `"${alias}" is not a declared external — ${declared.length ? `this project declares ${declared.map((a) => `"${a}"`).join(', ')}` : 'this project declares no externals'} (declare it with \`wairon externals add\`)`);
  }
  const original = (typeof existing === 'object' && existing !== null ? existing : {}) as ExternalDeclaration;
  const add = [...new Set(request.add ?? [])];
  const drop = [...new Set(request.remove ?? [])];
  const bad = [...add, ...drop].find((u) => !USE_ENTRY_RE.test(u));
  if (bad !== undefined) return useRefused(alias, current, `the entry "${bad}" is neither \`*\` nor a public name ([a-z0-9-_]+)`);
  // A new location, read through the one location grammar as declare reads it.
  let newSource: ExternalSource | undefined;
  if (request.source !== undefined) {
    const read = readExternalSource(request.source);
    if (NOT_A_LOCATION.test(request.source.trim())) return useRefused(alias, current, `the source "${request.source}" is not a location (accepted: ${LOCATION_FORMS})`);
    if (read.problem) return useRefused(alias, current, `${read.problem.replace(/^its /, 'the ')} (accepted: ${LOCATION_FORMS})`);
    if (read.source !== undefined) {
      newSource = sourceObject(declarationOf({ alias, source: request.source, ...(sourceObject(original.source)?.dir !== undefined && read.source.git !== undefined ? { dir: sourceObject(original.source)!.dir } : {}) }, read.source).source);
    }
  }
  const locationChanged = newSource !== undefined && locationKey(newSource) !== locationKey(sourceObject(original.source));
  if (add.length === 0 && drop.length === 0 && !locationChanged) {
    if (request.source !== undefined) return { alias, written: false, use: current, added: [], removed: [], source: request.source };
    return useRefused(alias, current, 'name at least one public name to add or to remove, or a new location');
  }
  const kept = current.filter((u) => !drop.includes(u));
  const appended = kept.includes('*') ? [] : add.filter((u) => !kept.includes(u));
  const next = [...kept, ...appended];
  const removedNames = current.filter((u) => drop.includes(u));
  // Steps 5-8: an added name the readable producer does not export to this project.
  const named = appended.filter((u) => u !== '*');
  if (named.length > 0 && !locationChanged) {
    const binding = resolveExternals(true).find((b) => b.external.alias === alias);
    const answered = binding ? readProducer(binding) : null;
    if (answered && 'read' in answered) {
      const missing = named.filter((u) => !answered.read.exported.includes(u));
      if (missing.length) return useRefused(alias, current, missing.map((u) => unexportedReason(u, answered.read)).join('; '));
    }
  }
  // The resulting declaration: the new location in place of the old, every other field kept.
  const { use: _old, ...rest } = original;
  const restated: ExternalDeclaration = { ...rest, ...(locationChanged ? { source: newSource } : {}), ...(next.length ? { use: next } : {}) };
  // Steps 9-13: a new location is checked against the producer it reaches before anything is written.
  if (locationChanged) {
    const declared = original.project ?? alias;
    let binding: ExternalBinding | undefined;
    try {
      binding = resolveExternalCandidate(alias, restated);
    } catch {
      binding = undefined;
    }
    const problem = binding?.external.problem;
    if (binding?.external.sourceKind === 'unresolved' && problem && /answers to/.test(problem)) {
      return useRefused(alias, current, `${problem} — the producer at that location is not "${declared}"`);
    }
    const answered = binding ? readProducer(binding) : null;
    if (answered && 'read' in answered) {
      if (answered.read.id !== null && answered.read.id !== declared) {
        return useRefused(alias, current, `the producer at that location answers to "${answered.read.id}", not "${declared}" — point the source at "${declared}", or declare \`project: ${answered.read.id}\``);
      }
      const missing = named.filter((u) => !answered.read.exported.includes(u));
      if (missing.length) return useRefused(alias, current, missing.map((u) => unexportedReason(u, answered.read)).join('; '));
    }
  }
  // Steps 14-15: a dry run, or nothing to change.
  const same = !locationChanged && next.length === current.length && next.every((u, i) => u === current[i]);
  const sourceAnswer = locationChanged ? { source: request.source } : {};
  if (request.dryRun || same) return { alias, written: false, use: next, added: appended, removed: removedNames, ...sourceAnswer };
  // Steps 16-18: a removal or a new location restates the declaration (the portal only appends imports).
  if (removedNames.length > 0 || locationChanged) {
    removeExternal(alias);
    try {
      writeDeclaration(alias, restated);
    } catch (e) {
      // Never lose the declaration: put the original back and refuse.
      writeDeclaration(alias, original);
      return useRefused(alias, current, (e instanceof Error ? e.message : String(e)).replace(/\.$/, ''));
    }
  } else {
    // Step 19: the added names, append-only.
    importNames(alias, appended);
  }
  // Steps 20-21: the pin follows the location.
  let pin: string | undefined;
  if (locationChanged) {
    const taken = pinExternals([alias])[0];
    pin = taken && (taken.outcome === 'pinned') ? 're-taken' : taken && taken.outcome === 'unchanged' ? 'dropped' : taken ? `not re-taken (${taken.outcome})` : 'dropped';
  }
  // Step 22.
  return { alias, written: true, use: next, added: appended, removed: removedNames, ...sourceAnswer, ...(pin ? { pin } : {}) };
}
