import * as path from 'path';
import { scanAllSpecs, projectFamily, diffAgainstApproval } from '../adapters/validator-core.js';
import { current } from './code-model-loader.js';
import { getProjectRoot } from '../../utils/fs.js';
import { factsFor, pathKey, type CodeModel } from '../../models/code-model.js';
import type { AnalysisGradeLabel } from '../../models/lock.js';
import type {
  LookupApproval,
  LookupElementKind,
  LookupEvidence,
  LookupMatch,
  LookupPlace,
  LookupSearchResult,
  LookupSnapshot,
} from '../../models/lookup.js';

/** The answer length when the caller names no limit. */
const DEFAULT_LIMIT = 10;

const SOURCE_EXTENSION = /\.(?:[cm]?[jt]sx?|py|rs|go|java|kt|cs|rb|php|swift|c|cc|cpp|h|hpp)$/i;
const ENDPOINT_FORM = /^(?:get|post|put|patch|delete|head|options)\s+\S/i;

/** Strongest first. */
const EVIDENCE_RANK: Record<LookupEvidence, number> = { id: 0, declared: 1, resolved: 2, syntactic: 3, text: 4, unresolved: 5 };

/** How narrow a kind's place is; the narrower ranks first among equal evidence. */
const NARROWNESS: Record<LookupElementKind, number> = {
  method: 6, field: 6, endpoint: 6, implementation: 4, interface: 4, type: 4,
  component: 3, group: 3, subsystem: 2, project: 1, file: 0,
};

/** For a path query, the element that owns the file comes before the pieces it holds. */
const FILE_FIRST: Record<LookupElementKind, number> = {
  implementation: 0, type: 1, method: 2, field: 2, endpoint: 2, interface: 3, component: 3, group: 3, subsystem: 3, project: 3, file: 0,
};

/** One element of the spec tree as the search reads it. */
interface Entry {
  id: string;
  kind: LookupElementKind;
  name: string;
  place: LookupPlace;
  /** The spec file the element is stored in, absolute. */
  specFile?: string;
  /** The files the element's specs name for it: what a path or symbol query is matched against. */
  links: string[];
  symbols: string[];
  /** Where the element is realized, for display and the planned mark. */
  realizes: string[];
  endpoints: string[];
  briefId?: string;
}

interface Hit {
  evidence: LookupEvidence;
  matchedOn: string;
}

function squash(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function endpointTexts(endpoint: unknown): string[] {
  const e = endpoint as Record<string, unknown> | undefined;
  if (!e || typeof e.transport !== 'string') return [];
  const text = (v: unknown): string => (typeof v === 'string' ? v : '');
  switch (e.transport) {
    case 'HTTP': return [`${text(e.method)} ${text(e.path)}`.trim().toUpperCase(), text(e.path)];
    case 'gRPC': return [`${text(e.service)}/${text(e.method)}`, text(e.method)];
    case 'GraphQL': return [text(e.field)];
    case 'MessageBus': return [`${text(e.topic)}/${text(e.event)}`, text(e.event)];
    case 'NamedPipe': return [text(e.pipe)];
    case 'IPC': return [text(e.channel)];
    case 'CLI': return [text(e.command)];
    case 'JSONRPC': return [text(e.method)];
    case 'Custom': return [text(e.address)];
    default: return [];
  }
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

/**
 * spec_search.find — the spec index first, the code model second, so a
 * declared link always outranks a guess.
 */
export function find(query: string, limit?: number): LookupSearchResult {
  // Step 1: the spec index of the bound project and the members in its reach.
  const index = scanAllSpecs();
  // Step 2: the family — each member's alias, form and whether it is in reach.
  const family = projectFamily();
  const root = getProjectRoot();
  const own = family.nodes.find((n) => n.namespace === '') ?? family.nodes[0];
  const project = own?.id ?? own?.name ?? path.basename(root);

  // Step 3: the query's form — a ranking hint, never a filter.
  const q = query.trim();
  const ql = q.toLowerCase();
  const qs = squash(q);
  const endpointForm = ENDPOINT_FORM.test(q);
  const pathForm = !endpointForm && (/[\\/]/.test(q) || SOURCE_EXTENSION.test(q));
  const pq = pathKey(q);
  const endpointQuery = ql.replace(/\s+/g, ' ');

  // Step 4: match the spec index.
  const projectOf = (key: string): string => { const node = family.nodes.find((n) => n.namespace === key); return node?.id ?? node?.name ?? key; };
  const entries = specEntries(index, project, projectOf);
  const matches = new Map<string, LookupMatch & { specFile?: string }>();
  const keep = (entry: Entry, hit: Hit, kind: LookupElementKind = entry.kind): void => {
    const key = `${kind === 'endpoint' ? 'method' : kind}:${entry.id}`;
    const held = matches.get(key);
    if (held && EVIDENCE_RANK[held.evidence] <= EVIDENCE_RANK[hit.evidence]) return;
    matches.set(key, {
      id: entry.id,
      kind,
      name: entry.name,
      place: entry.place,
      evidence: hit.evidence,
      matchedOn: hit.matchedOn,
      approval: 'not-applicable',
      ...(entry.realizes[0] !== undefined ? { sourcePath: entry.realizes[0] } : {}),
      planned: false,
      ...(entry.briefId !== undefined ? { briefId: entry.briefId } : {}),
      specFile: entry.specFile,
    });
  };
  const textHit = (value: string, label: string, exactOnly = false): Hit | null => {
    const v = value.toLowerCase();
    if (v === ql) return { evidence: 'id', matchedOn: label };
    // Spelled another way (`local_approver` for `localApprover`) is no exact name: it ranks with the partial matches.
    if (qs.length >= 3 && squash(value) === qs) return { evidence: 'text', matchedOn: `${label} spelled another way` };
    if (!exactOnly && !pathForm && !endpointForm && qs.length >= 2 && squash(value).includes(qs)) return { evidence: 'text', matchedOn: `part of ${label}` };
    return null;
  };
  for (const entry of entries) {
    const byId = textHit(entry.id, 'id', (entry.kind === 'method' || entry.kind === 'field') && !ql.includes('.'));
    const byName = entry.name !== entry.id ? textHit(entry.name, 'name') : null;
    const best = byId && byName ? (EVIDENCE_RANK[byId.evidence] <= EVIDENCE_RANK[byName.evidence] ? byId : byName) : (byId ?? byName);
    if (best) keep(entry, best);
    for (const text of entry.endpoints) {
      const t = text.toLowerCase().replace(/\s+/g, ' ');
      if (t === endpointQuery) keep(entry, { evidence: 'id', matchedOn: `endpoint ${text}` }, 'endpoint');
      else if (endpointForm && t.includes(endpointQuery)) keep(entry, { evidence: 'text', matchedOn: `part of endpoint ${text}` }, 'endpoint');
    }
    for (const link of entry.links) {
      const k = pathKey(link);
      if (pathForm && (k === pq || k.endsWith(`/${pq}`))) keep(entry, { evidence: 'declared', matchedOn: `sourcePath ${link}` });
    }
    if (q.length > 0 && entry.symbols.includes(q)) keep(entry, { evidence: 'declared', matchedOn: `symbol ${q}` });
  }

  // Step 5: the code model, current for the files on disk.
  const cached = current();
  const model = cached.model;

  // Step 6: the declarations and walked files no spec already claimed.
  const claimedBy = new Map<string, Entry[]>();
  for (const entry of entries) {
    for (const link of entry.links) {
      const k = pathKey(link);
      claimedBy.set(k, [...(claimedBy.get(k) ?? []), entry]);
    }
  }
  for (const claim of claimedPaths(index)) if (!claimedBy.has(claim)) claimedBy.set(claim, []);
  for (const facts of model.files) {
    const p = pathKey(facts.path);
    const pathHit = pathForm && (p === pq || p.endsWith(`/${pq}`));
    const declHit = facts.status === 'analyzed' && q.length > 0 && facts.declaredNames.includes(q);
    if (!pathHit && !declHit) continue;
    const owners = claimedBy.get(p) ?? [];
    if (owners.length === 0) {
      matches.set(`file:${p}`, {
        id: p, kind: 'file', name: path.posix.basename(p), place: { project },
        evidence: 'syntactic', matchedOn: declHit && !pathHit ? `declares ${q}` : 'file path',
        approval: 'not-applicable', sourcePath: p, planned: false,
      });
    } else if (declHit) {
      const exact = owners.filter((e) => e.kind === 'method' || e.kind === 'type');
      const chosen = exact.filter((e) => e.symbols.includes(q) || e.name === q);
      const targets = chosen.length > 0 ? chosen : owners.filter((e) => e.kind === 'implementation');
      for (const entry of targets) keep(entry, { evidence: 'resolved', matchedOn: `declaration ${q} in ${p}` });
    }
  }
  for (const m of matches.values()) {
    const realized = entries.find((e) => e.id === m.id && e.kind === m.kind)?.realizes ?? (m.kind === 'file' ? [m.id] : []);
    m.planned = realized.length > 0 && realized.every((r) => factsFor(model, r)?.status === 'missing');
  }

  // Step 7: what changed since the lock.
  const diff = diffAgainstApproval();

  // Step 8: approval, rank, limit, snapshot.
  const rel = (abs: string | undefined): string | undefined => (abs === undefined ? undefined : path.relative(root, abs).split(path.sep).join('/'));
  const added = new Set(diff?.added ?? []);
  const changed = new Set(diff?.changed ?? []);
  const settled = new Set(diff?.unchangedPaths ?? []);
  const all = [...matches.values()].map(({ specFile, ...match }): LookupMatch => {
    const key = rel(specFile);
    let approval: LookupApproval = 'not-applicable';
    if (key !== undefined && !key.startsWith('..')) {
      if (diff === null) approval = match.id.includes('::') ? 'not-applicable' : 'unlocked';
      else if (added.has(key)) approval = 'added';
      else if (changed.has(key)) approval = 'changed';
      else if (settled.has(key)) approval = 'approved';
    }
    return { ...match, approval };
  });
  all.sort((a, b) =>
    EVIDENCE_RANK[a.evidence] - EVIDENCE_RANK[b.evidence]
    || (pathForm ? FILE_FIRST[a.kind] - FILE_FIRST[b.kind] : 0)
    || NARROWNESS[b.kind] - NARROWNESS[a.kind]
    || a.id.localeCompare(b.id));
  const cut = Math.max(0, limit ?? DEFAULT_LIMIT);
  return {
    matches: all.slice(0, cut),
    total: all.length,
    snapshot: snapshotOf(cached.fingerprint, cached.builtAt, model, family.nodes.map((n) => n.id ?? n.name ?? n.namespace), family.problems.map((p) => p.detail)),
  };
}

function snapshotOf(fingerprint: string, builtAt: string, model: CodeModel, members: string[], problems: string[]): LookupSnapshot {
  const order: AnalysisGradeLabel[] = ['exact', 'pattern', 'generic'];
  let weakest = -1;
  for (const f of model.files) {
    if (f.status !== 'analyzed' || !f.analysisGrade) continue;
    weakest = Math.max(weakest, order.indexOf(f.analysisGrade));
  }
  return {
    codeFingerprint: fingerprint,
    codeGrade: weakest < 0 ? 'none' : order[weakest],
    builtAt,
    searched: [
      'spec tree: specs, methods, fields, types, groups and endpoints of the bound project',
      `projects in reach: ${members.join(', ')}`,
      `source files walked: ${model.files.length}`,
    ],
    notSearched: [
      ...problems.map((p) => `member not read: ${p}`),
      'files outside the declared source roots',
      'prose outside the repository',
    ],
  };
}

/** Every file a spec names for any reason; a walked file in none of these is unclaimed. */
function claimedPaths(index: ReturnType<typeof scanAllSpecs>): Set<string> {
  const out = new Set<string>();
  const add = (p: string | undefined): void => { if (p) out.add(pathKey(p)); };
  for (const impl of index.implementations) {
    add(impl.sourcePath);
    add(impl.simPath);
    for (const m of impl.methods) add(m.sourcePath);
  }
  for (const type of index.types) {
    add(type.sourcePath);
    for (const m of type.methods ?? []) add(m.sourcePath);
  }
  return out;
}

/** Flatten the index into the elements a query is matched against. */
function specEntries(index: ReturnType<typeof scanAllSpecs>, project: string, projectOf: (key: string) => string): Entry[] {
  const out: Entry[] = [];
  // A member project's spec sits in that project, under the member key it is reached by.
  const at = (id: string): { project: string; member?: string } => {
    if (!id.includes('::')) return { project };
    const member = id.slice(0, id.indexOf('::'));
    return { project: projectOf(member), member };
  };
  const subsystemOf = new Map(index.components.map((c) => [c.id, c.subsystem]));
  const implsOf = (contractId: string) => index.implementations.filter((i) => i.contract === contractId);
  const componentOfContract = new Map(index.interfaces.map((i) => [i.id, i.component]));

  for (const s of index.subsystems) {
    out.push({ id: s.id, kind: 'subsystem', name: s.name, place: { ...at(s.id), subsystem: s.id }, specFile: index.paths.subsystem[s.id], links: [], symbols: [], realizes: [], endpoints: [] });
  }
  for (const c of index.components) {
    const realizes = unique(index.interfaces.filter((i) => i.component === c.id).flatMap((i) => implsOf(i.id)).map((i) => i.sourcePath).filter((p): p is string => !!p));
    out.push({ id: c.id, kind: 'component', name: c.name, place: { ...at(c.id), subsystem: c.subsystem, component: c.id }, specFile: index.paths.component[c.id], links: [], symbols: [], realizes, endpoints: [], briefId: c.id });
  }
  for (const i of index.interfaces) {
    const impls = implsOf(i.id);
    const place: LookupPlace = { ...at(i.id), subsystem: subsystemOf.get(i.component), component: i.component };
    out.push({ id: i.id, kind: 'interface', name: i.name, place, specFile: index.paths.interface[i.id], links: [], symbols: [], realizes: unique(impls.map((m) => m.sourcePath).filter((p): p is string => !!p)), endpoints: [], briefId: i.component });
    for (const m of i.methods) {
      const own = impls.flatMap((impl) => impl.methods.filter((im) => im.name === m.name).map((im) => ({ own: im.sourcePath, file: im.sourcePath ?? impl.sourcePath, symbol: im.symbol })));
      out.push({
        id: `${i.component}.${m.name}`, kind: 'method', name: m.name, place: { ...place, container: i.id }, specFile: index.paths.interface[i.id],
        links: unique(own.map((o) => o.own).filter((p): p is string => !!p)),
        symbols: unique(own.map((o) => o.symbol).filter((s): s is string => !!s)),
        realizes: unique(own.map((o) => o.file).filter((p): p is string => !!p)),
        endpoints: endpointTexts(m.endpoint), briefId: i.component,
      });
    }
  }
  for (const impl of index.implementations) {
    const comp = componentOfContract.get(impl.contract);
    out.push({
      id: impl.id, kind: 'implementation', name: impl.name,
      place: { ...at(impl.id), subsystem: comp ? subsystemOf.get(comp) : undefined, component: comp, container: impl.contract },
      specFile: index.paths.implementation[impl.id],
      links: impl.sourcePath ? [impl.sourcePath] : [], symbols: [],
      realizes: impl.sourcePath ? [impl.sourcePath] : [], endpoints: [], briefId: comp,
    });
  }
  for (const t of index.types) {
    const place: LookupPlace = { ...at(t.id), subsystem: t.subsystem, container: t.group };
    const sp = t.sourcePath ? [t.sourcePath] : [];
    out.push({ id: t.id, kind: 'type', name: t.name, place, specFile: index.paths.type[t.id], links: sp, symbols: t.symbol ? [t.symbol] : [], realizes: sp, endpoints: [] });
    for (const f of t.fields ?? []) {
      out.push({ id: `${t.id}.${f.name}`, kind: 'field', name: f.name, place: { ...place, container: t.id }, specFile: index.paths.type[t.id], links: [], symbols: [], realizes: sp, endpoints: [] });
    }
    for (const m of t.methods ?? []) {
      const own = m.sourcePath ? [m.sourcePath] : [];
      out.push({ id: `${t.id}.${m.name}`, kind: 'method', name: m.name, place: { ...place, container: t.id }, specFile: index.paths.type[t.id], links: own, symbols: m.symbol ? [m.symbol] : [], realizes: own.length ? own : sp, endpoints: [] });
    }
  }
  for (const g of index.groups) {
    out.push({ id: g.id, kind: 'group', name: g.name, place: { ...at(g.id), subsystem: g.subsystem }, specFile: index.paths.group[g.id], links: [], symbols: [], realizes: [], endpoints: [] });
  }
  return out;
}
