import * as fs from 'fs';
import { runWithProjectRoot } from '../utils/fs.js';
import {
  EXTERNAL_ALIAS_RE,
  PROJECT_ID_RE,
  USE_ENTRY_RE,
  effectiveProjectId,
  readExternalSource,
  type ExternalDeclaration,
  type ExternalSource,
  type ProjectConfig,
} from '../models/project.js';
import { SURFACE_AUDIENCES, type ExternalAddition, type ExternalBinding, type ExternalPin, type ExternalRequest } from '../models/index.js';
// surfaces_core_adapter: every name this workflow takes from sdd_core lands on
// the adapter's own module — the configuration it writes into, the externals
// it resolves, and a producer's configuration and export table.
import {
  loadProjectConfig,
  declareExternal as writeDeclaration,
  removeExternal,
  resolveExternals,
  resolveProjectExports,
} from './adapters/surfaces-core.js';
// surface_orchestrator: the pin a declaration is followed by.
import { pinExternals } from './surfaces.js';

/** Ascending reach rank of an audience level; an unknown level ranks as 'instance'. */
function audienceRank(audience: string | undefined): number {
  const levels = SURFACE_AUDIENCES as readonly string[];
  const idx = levels.indexOf(audience ?? 'instance');
  return idx === -1 ? levels.indexOf('instance') : idx;
}

// ---------------------------------------------------------------------------
// external_declarations — declares one external of the bound project the way
// `wairon member add` declares a member: `wairon externals add` and the MCP
// tool sdd_add_external, instead of a hand-edited `.wai/project.yaml`.
//
// It reads the request's location in the one location grammar members use,
// refuses what cannot be declared with one sentence naming the accepted form
// (never a schema dump), writes the normalized declaration through the core's
// configuration portal, checks it against the producer it reaches, takes it
// back out when the producer contradicts it, and pins it when asked — so the
// reproducible gate exists from the first validate. It holds no state and
// never touches the spec tree.
// ---------------------------------------------------------------------------

/** The accepted forms of a request's location, as a refusal names them. */
const LOCATION_FORMS = '`../sibling`, `hosted:<id>`, `<git url>` or `<git url>#<commit>`';

/** A refusal: nothing written, one sentence. */
function refused(alias: string, why: string): ExternalAddition {
  return { alias, written: false, declaration: null, refusal: `The external "${alias}" was not declared: ${why}.` };
}

/** The request's own problems, before anything is written; null when it can be declared. */
function requestProblem(request: ExternalRequest, config: ProjectConfig | null, source: ExternalSource | undefined, sourceProblem: string | undefined): string | null {
  const { alias } = request;
  if (!EXTERNAL_ALIAS_RE.test(alias)) return `an alias is [a-z0-9-_]+, and "${alias}" is not — choose one specs can write as \`${alias.toLowerCase().replace(/[^a-z0-9_-]/g, '-')}::name\``;
  if (config?.members?.[alias] !== undefined) return `"${alias}" is already declared under \`members\` — one alias names one project, so choose another alias`;
  if (config?.externals?.[alias] !== undefined) return `"${alias}" is already declared under \`externals\` — choose another alias, or edit that declaration`;
  if (sourceProblem) return `${sourceProblem.replace(/^its /, 'the ')} (accepted: ${LOCATION_FORMS})`;
  const git = source?.git !== undefined;
  if (!git && (request.ref !== undefined || request.dir !== undefined)) {
    return `\`ref\` and \`dir\` apply to a git source only — write the source as ${'`<git url>`'} or ${'`<git url>#<commit>`'}`;
  }
  if (git && request.ref !== undefined && source?.ref !== undefined && request.ref !== source.ref) {
    return `the source fixes the ref at "${source.ref}" (its \`#<commit>\`), but \`ref\` says "${request.ref}" — give one of them`;
  }
  if (request.project !== undefined && !PROJECT_ID_RE.test(request.project)) return `the producer id "${request.project}" breaks the project-id grammar ([a-z0-9] with . _ - inside)`;
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

/** What the producer answered with its root bound: the id it answers to and the names it exports to this project. */
interface ProducerRead {
  id: string | null;
  exported: string[];
}

/** Steps 9-10: the producer's configuration and export table, its root bound read-only — or why it cannot be read. */
function readProducer(binding: ExternalBinding): { read: ProducerRead } | { why: string } {
  const { external } = binding;
  const directory = external.directory;
  if (external.sourceKind === 'unresolved' || directory === undefined) return { why: external.problem ?? 'it does not resolve' };
  if (!fs.existsSync(directory)) return { why: `its root ${directory} does not exist` };
  try {
    return runWithProjectRoot(directory, () => {
      // Step 9: the id it answers to.
      const config = loadProjectConfig();
      if (!config) return { why: `${directory} holds no wairon project` };
      // Step 10: the public names it exports at this project's audience.
      const floor = audienceRank(external.audience);
      const exported = resolveProjectExports().entries
        .filter((e) => audienceRank(e.audience ?? 'instance') >= floor)
        .map((e) => e.publicName);
      return { read: { id: effectiveProjectId(config), exported: [...new Set(exported)] } };
    });
  } catch (e) {
    return { why: e instanceof Error ? e.message : String(e) };
  }
}

/** Step 11: what the producer contradicts in the declaration, as the refusal's reason; null when nothing. */
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
  if (missing.length > 0) {
    return missing
      .map((u) => `the producer does not export "${u}" to this project${read.exported.length ? ` (closest: ${closest(u, read.exported).map((n) => `"${n}"`).join(', ')})` : ' (it exports nothing to this project)'}`)
      .join('; ');
  }
  return null;
}

/**
 * iexternal_declarations.declare — declare one external of the bound project:
 * refuse, writing nothing, what cannot be declared (each in one sentence
 * naming the accepted form); otherwise write the normalized declaration,
 * check it against the producer it reaches — a contradiction takes it back
 * out and refuses — and pin it when asked and the producer was read. A dry
 * run answers the same verdict and writes nothing.
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
  const declaration = declarationOf(request, read.source);
  const declared = request.project ?? alias;
  // Steps 5-6: a dry run stops before the write, so no producer is consulted.
  if (request.dryRun) return { alias, written: false, declaration, project: declared };
  // Step 7: the write, through the core's configuration portal.
  try {
    writeDeclaration(alias, declaration);
  } catch (e) {
    return refused(alias, (e instanceof Error ? e.message : String(e)).replace(/\.$/, ''));
  }
  // Step 8: the new alias's binding.
  const binding = resolveExternals().find((b) => b.external.alias === alias);
  // Steps 9-10: what the producer answers, when it can be read.
  const answered = binding ? readProducer(binding) : { why: 'it is not among the resolved externals' };
  const producer = 'read' in answered ? answered.read : null;
  // Steps 11-13: a contradiction takes the declaration back out.
  const contradicted = contradiction(request, binding, producer);
  if (contradicted) {
    removeExternal(alias);
    return refused(alias, contradicted);
  }
  // Steps 14-15: pin it when asked and the producer was read.
  let pin: ExternalPin | undefined;
  if (request.pin !== false && producer) pin = pinExternals([alias])[0];
  // Step 16: the addition.
  const unreachable = producer
    ? undefined
    : `its producer could not be read (${'why' in answered ? answered.why : 'unknown'}), so nothing was pinned — it reads as unavailable, never a pass, until \`wairon externals pin ${alias}\` succeeds`;
  return {
    alias,
    written: true,
    declaration,
    project: producer?.id ?? declared,
    ...(pin ? { pin } : {}),
    ...(unreachable ? { unreachable } : {}),
  };
}
