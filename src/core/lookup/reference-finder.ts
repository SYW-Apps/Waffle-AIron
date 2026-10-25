import * as path from 'path';
import {
  scanAllSpecs,
  projectFamily,
  exportUsage,
  loadProjectConfig,
  resolveProjectExports,
} from '../adapters/validator-core.js';
import { current } from './code-model-loader.js';
import { find } from './spec-search.js';
import { findTestsReferencing } from '../source-analysis.js';
import { buildCodeIndex } from '../rules/read-model.js';
import { getProjectRoot } from '../../utils/fs.js';
import { factsFor, pathKey, type CodeModel, type ResolvedCallFact, type SourceFileFacts } from '../../models/code-model.js';
import { specIndexReferencesTo, specIndexMethodReferences, type SpecRef, type SpecReference } from '../../models/specs.js';
import type { ResolvedExport } from '../../models/exports.js';
import type {
  LookupAgreement,
  LookupImpact,
  LookupMatch,
  LookupPlace,
  LookupReference,
  LookupReferencesResult,
  LookupWaiver,
} from '../../models/lookup.js';

type Index = ReturnType<typeof scanAllSpecs>;

/** What a target is realized as: the files and symbol the code is searched for, and the specs that speak for it. */
interface Subject {
  refs: SpecRef[];
  method?: { component: string; name: string };
  /** A field's references are its type's: they name the type, not the field. */
  viaType: boolean;
  files: string[];
  symbol?: string;
  /** The code names a call must land on to count; absent for a file, where any call into it does. */
  symbols?: Set<string>;
  searched: { name: string; symbol?: string; sourcePath?: string }[];
  specIds: Set<string>;
  /** Ids the design's prose may name, and the bare names it may use instead. */
  ids: string[];
  names: string[];
  methodName?: string;
}

const LEVEL: Record<Exclude<LookupImpact, 'none' | 'public'>, number> = { component: 0, subsystem: 1, project: 2, family: 3 };

function subjectOf(index: Index, target: LookupMatch): Subject {
  const subject = subjectFor(index, target);
  return target.kind === 'file' ? subject : { ...subject, symbols: subject.symbol !== undefined ? new Set([subject.symbol]) : new Set(subject.searched.map((s) => s.symbol ?? s.name)) };
}

function subjectFor(index: Index, target: LookupMatch): Subject {
  const empty: Subject = { refs: [], viaType: false, files: [], searched: [], specIds: new Set([target.id]), ids: [target.id], names: [target.name] };
  const implsOfComponent = (component: string) =>
    index.implementations.filter((impl) => index.interfaces.some((i) => i.id === impl.contract && i.component === component));
  const searchedOf = (impls: Index['implementations']) =>
    impls.flatMap((impl) => impl.methods.map((m) => ({ name: m.name, symbol: m.symbol, sourcePath: m.sourcePath ?? impl.sourcePath })));
  const filesOf = (impls: Index['implementations']): string[] => [...new Set(impls.flatMap((impl) =>
    [impl.sourcePath, ...impl.methods.map((m) => m.sourcePath)].filter((p): p is string => !!p).map(pathKey)))];

  switch (target.kind) {
    case 'file':
      return { ...empty, files: [pathKey(target.id)], names: [] };
    case 'component': {
      const impls = implsOfComponent(target.id);
      return {
        ...empty, refs: [{ kind: 'component', id: target.id }], files: filesOf(impls), searched: searchedOf(impls),
        specIds: new Set([target.id, ...index.interfaces.filter((i) => i.component === target.id).map((i) => i.id), ...impls.map((i) => i.id)]),
      };
    }
    case 'interface': {
      const impls = index.implementations.filter((i) => i.contract === target.id);
      const component = index.interfaces.find((i) => i.id === target.id)?.component;
      return {
        ...empty, refs: [{ kind: 'interface', id: target.id }], files: filesOf(impls), searched: searchedOf(impls),
        specIds: new Set([target.id, ...(component ? [component] : []), ...impls.map((i) => i.id)]),
      };
    }
    case 'implementation': {
      const impl = index.implementations.find((i) => i.id === target.id);
      return { ...empty, refs: [{ kind: 'implementation', id: target.id }], files: impl ? filesOf([impl]) : [], searched: impl ? searchedOf([impl]) : [] };
    }
    case 'type': {
      const type = index.types.find((t) => t.id === target.id);
      const symbol = type?.symbol ?? type?.name;
      return {
        ...empty, refs: [{ kind: 'type', id: target.id }], files: type?.sourcePath ? [pathKey(type.sourcePath)] : [], symbol,
        searched: type && symbol ? [{ name: type.name, symbol, sourcePath: type.sourcePath }] : [],
      };
    }
    case 'field': {
      const owner = target.id.slice(0, target.id.lastIndexOf('.'));
      return { ...empty, refs: [{ kind: 'type', id: owner }], viaType: true, names: [] };
    }
    case 'group': return { ...empty, refs: [{ kind: 'group', id: target.id }] };
    case 'subsystem': return { ...empty, refs: [{ kind: 'subsystem', id: target.id }] };
    case 'method':
    case 'endpoint': {
      const cut = target.id.lastIndexOf('.');
      const owner = target.id.slice(0, cut);
      const name = target.id.slice(cut + 1);
      const type = index.types.find((t) => t.id === owner);
      if (type) {
        const m = (type.methods ?? []).find((tm) => tm.name === name);
        const file = m?.sourcePath ?? type.sourcePath;
        const symbol = m?.symbol ?? name;
        return {
          ...empty, refs: [{ kind: 'type', id: owner }], viaType: true, files: file ? [pathKey(file)] : [], symbol,
          searched: [{ name, symbol, sourcePath: file }], specIds: new Set([owner]), methodName: name, names: name.length >= 5 ? [name] : [],
        };
      }
      const contracts = index.interfaces.filter((i) => i.component === owner && i.methods.some((m) => m.name === name));
      const impls = index.implementations.filter((impl) => contracts.some((c) => c.id === impl.contract) && impl.methods.some((m) => m.name === name));
      const realized = impls.flatMap((impl) => impl.methods.filter((m) => m.name === name).map((m) => ({ m, file: m.sourcePath ?? impl.sourcePath })));
      return {
        ...empty, refs: [], method: { component: owner, name },
        files: [...new Set(realized.map((r) => r.file).filter((f): f is string => !!f).map(pathKey))],
        symbol: realized.map((r) => r.m.symbol).find((s) => !!s) ?? name,
        searched: realized.map((r) => ({ name, symbol: r.m.symbol, sourcePath: r.file })),
        specIds: new Set([owner, ...contracts.map((c) => c.id), ...impls.map((i) => i.id)]),
        methodName: name, names: name.length >= 5 ? [name] : [],
      };
    }
    default:
      return empty;
  }
}

function placeOfSpec(index: Index, project: string, ref: SpecRef): LookupPlace {
  const member = ref.id.includes('::') ? { member: ref.id.slice(0, ref.id.indexOf('::')) } : {};
  const subsystemOf = (component: string | undefined) => index.components.find((c) => c.id === component)?.subsystem;
  switch (ref.kind) {
    case 'subsystem': return { project, ...member, subsystem: ref.id };
    case 'component': return { project, ...member, subsystem: subsystemOf(ref.id), component: ref.id };
    case 'interface': {
      const component = index.interfaces.find((i) => i.id === ref.id)?.component;
      return { project, ...member, subsystem: subsystemOf(component), component, container: ref.id };
    }
    case 'implementation': {
      const impl = index.implementations.find((i) => i.id === ref.id);
      const component = index.interfaces.find((i) => i.id === impl?.contract)?.component;
      return { project, ...member, subsystem: subsystemOf(component), component, container: ref.id };
    }
    case 'type': return { project, ...member, subsystem: index.types.find((t) => t.id === ref.id)?.subsystem, container: ref.id };
    case 'group': return { project, ...member, subsystem: index.groups.find((g) => g.id === ref.id)?.subsystem, container: ref.id };
    default: return { project };
  }
}

function kindOfPosition(position: string, holder: SpecRef['kind']): LookupReference['kind'] {
  if (/narrative\.step|\.calls$|^dispatch$|^lifecycle$/.test(position)) return 'call-step';
  if (holder === 'type' || /^fields\.|^signature$|^methods\.[^.]+$/.test(position)) return 'type-position';
  return 'depends-on';
}

/** Does `specifier`, written in `from`, name the file `target`? */
function importsFile(model: CodeModel, from: string, specifier: string, target: string): boolean {
  const strip = (p: string): string => p.replace(/\.(?:[cm]?[jt]sx?)$/, '');
  if (specifier.startsWith('.')) {
    const joined = path.posix.normalize(path.posix.join(path.posix.dirname(pathKey(from)), specifier));
    const bare = strip(joined);
    const t = strip(pathKey(target));
    return bare === t || `${bare}/index` === t;
  }
  const packaged = model.packages?.[specifier];
  return packaged !== undefined && pathKey(packaged) === pathKey(target);
}

function mention(text: string | undefined, ids: string[], names: string[]): 'linked' | 'bare' | null {
  if (!text) return null;
  const lower = text.toLowerCase();
  if (ids.some((id) => lower.includes(id.toLowerCase()))) return 'linked';
  for (const name of names) {
    if (name.length < 4) continue;
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(`(?<![A-Za-z0-9_])${escaped}(?![A-Za-z0-9_])`, 'i').test(text)) return 'bare';
  }
  return null;
}

/**
 * reference_finder.collect — resolve the target through the spec search, then
 * gather the design's references, the code's and the tests', join them, and
 * read the waivers and the impact.
 */
export function collect(target: string, includeText?: boolean): LookupReferencesResult {
  // Step 1: search for the target.
  const found = find(target, 10);
  // Step 2: does it name one element?
  const [top, next] = found.matches;
  const single = top !== undefined && (next === undefined || next.evidence !== top.evidence);
  if (!single) {
    // Step 3: the matches as candidates, no references, impact none.
    return { target: null, candidates: found.matches, references: [], waivers: [], impact: 'none', snapshot: found.snapshot };
  }

  // Step 4: the spec index.
  const index = scanAllSpecs();
  // The search placed every match in its project already.
  const project = top.place.project;
  const subject = subjectOf(index, top);

  // Step 5: the design's references through the index's own walk.
  const walked: SpecReference[] = subject.method
    ? specIndexMethodReferences(index, subject.method.component, [subject.method.name])
    : specIndexReferencesTo(index, subject.refs);
  const references: LookupReference[] = [];
  const callerFiles = new Map<LookupReference, string[]>();
  for (const ref of walked) {
    const member = /^methods\.([^.]+)/.exec(ref.position)?.[1];
    const entry: LookupReference = {
      kind: kindOfPosition(ref.position, ref.kind),
      evidence: 'declared',
      agreement: 'unjudged',
      fromSpec: ref.id,
      ...(member ? { fromMember: member } : {}),
      place: placeOfSpec(index, project, ref),
      inTest: false,
      linked: !subject.viaType,
    };
    references.push(entry);
    if (entry.kind === 'call-step' && ref.kind === 'implementation' && member) {
      const impl = index.implementations.find((i) => i.id === ref.id);
      const own = impl?.methods.find((m) => m.name === member)?.sourcePath ?? impl?.sourcePath;
      if (own) callerFiles.set(entry, [pathKey(own)]);
    }
  }

  // Step 6: the L0 export table, for the public names the target is exported under.
  const exported = resolveProjectExports().entries.filter((e) => exportsTarget(index, e, top, subject));
  const publicNames = new Set(exported.map((e) => e.publicName));

  // Step 7: the family, for the projects in reach that consume this one.
  const family = projectFamily();
  const consumers = family.nodes.filter((n) => n.namespace !== '' && (n.parent === '' || n.externals.some((e) => e.producer === '')));
  // Step 8: for each consumer in reach.
  for (const consumer of publicNames.size > 0 ? consumers : []) {
    // Step 9: the exported names it uses, each use of one of the target's public names.
    const usage = exportUsage(consumer.namespace, '');
    for (const use of usage.used) {
      if (!publicNames.has(use.publicName)) continue;
      if (subject.method && !use.members.includes(subject.method.name)) continue;
      const specs = subject.method ? use.memberSpecs?.[subject.method.name] ?? use.specs : use.specs;
      for (const spec of specs ?? [undefined]) {
        references.push({
          kind: 'export-use', evidence: 'declared', agreement: 'unjudged',
          ...(spec ? { fromSpec: spec } : {}),
          place: { project: consumer.id ?? consumer.name ?? consumer.namespace },
          inTest: false, linked: true,
        });
      }
    }
  }

  // Step 10: the project configuration: the test roots, the unclaimed and carried registers.
  const conformance = loadProjectConfig()?.rules?.conformance;
  const testRoots = conformance?.testRoots ?? [];

  // Step 11: the code model, current for the files on disk.
  const model = current().model;

  // Step 12: the code's references to the realizing symbol in its sourcePath.
  const targetFiles = new Set(subject.files);
  const owners = (file: string) => index.implementations.filter((impl) =>
    pathKey(impl.sourcePath ?? '') === file || impl.methods.some((m) => pathKey(m.sourcePath ?? '') === file));
  const codeCalls: LookupReference[] = [];
  const codeCallFiles = new Map<LookupReference, string>();
  /** Calls written inside the target's own files: they confirm a declared caller living there, and are never observed-only news. */
  const ownCalls = new Set<LookupReference>();
  const landings = landingsOf(model, targetFiles, subject.symbols);
  const seenSites = new Set<string>();
  if (targetFiles.size > 0) {
    for (const facts of model.files) {
      const file = pathKey(facts.path);
      if (facts.status !== 'analyzed') continue;
      const own = targetFiles.has(file);
      const holder = owners(file)[0];
      const place = holder ? placeOfSpec(index, project, { kind: 'implementation', id: holder.id }) : { project };
      const memberOf = (enclosing: string | undefined): string | undefined =>
        holder?.methods.find((m) => (m.symbol ?? m.name) === enclosing)?.name;
      const importsTarget = !own && (facts.imports ?? []).some((spec) => [...targetFiles].some((t) => importsFile(model, file, spec, t)));
      for (const rc of facts.resolvedCalls ?? []) {
        // A call lands on the target in its own files, or — through a file that
        // only republishes it (an adapter of identity re-exports) — on what the
        // target forwards to, from a file that imports the target's.
        const resolved = rc.targets.some((t) => {
          const at = pathKey(t.path);
          if (targetFiles.has(at)) return subject.symbols === undefined || subject.symbols.has(t.member);
          return importsTarget && landings.has(`${at}#${t.member}`);
        });
        const unresolved = !resolved && rc.unresolved === true && rc.targets.length === 0 && subject.symbol !== undefined && rc.name === subject.symbol;
        if (!resolved && !unresolved) continue;
        const lines = unresolved ? [] : linesOf(facts, rc);
        for (const line of lines.length > 0 ? lines : [undefined]) {
          // Two resolved calls written alike in one function share their lines: one entry per site.
          const site = `${file}|${line ?? `${rc.enclosing ?? ''}|${rc.written}`}`;
          if (seenSites.has(site)) continue;
          seenSites.add(site);
          const entry: LookupReference = {
            kind: 'code-call', evidence: resolved ? 'resolved' : 'unresolved', agreement: 'unjudged',
            ...(holder ? { fromSpec: holder.id } : {}),
            ...(memberOf(rc.enclosing) ? { fromMember: memberOf(rc.enclosing) } : {}),
            file: facts.path, ...(line !== undefined ? { line } : {}), place, inTest: isTest(facts.path, testRoots), linked: resolved,
          };
          codeCalls.push(entry);
          codeCallFiles.set(entry, file);
          if (own) ownCalls.add(entry);
        }
      }
      if (importsTarget) {
        references.push({
          kind: 'import', evidence: 'syntactic', agreement: 'unjudged',
          ...(holder ? { fromSpec: holder.id } : {}),
          file: facts.path, place, inTest: isTest(facts.path, testRoots), linked: true,
        });
      }
    }
  }

  // Step 13: the tests that import or name the target's methods.
  const tests = subject.searched.length > 0 ? findTestsReferencing(subject.searched, getProjectRoot(), testRoots) : [];
  const testPlace: LookupPlace = { project };
  // A test file the code scan already listed as an import is not listed twice.
  const seenTests = new Set<string>(references.filter((r) => r.kind === 'import' && r.inTest && r.file).map((r) => `i|${pathKey(r.file!)}`));
  for (const t of tests) {
    for (const file of t.imported) if (!seenTests.has(`i|${pathKey(file)}`) && seenTests.add(`i|${pathKey(file)}`)) references.push({ kind: 'import', evidence: 'syntactic', agreement: 'unjudged', file, place: testPlace, inTest: true, linked: true });
    for (const file of t.mentioned) if (!seenTests.has(`m|${file}`) && seenTests.add(`m|${file}`)) references.push({ kind: 'mention', evidence: 'text', agreement: 'unjudged', file, place: testPlace, inTest: true, linked: false });
  }

  // Step 14: were text mentions asked for?
  if (includeText !== false) {
    // Step 15: the mentions in the design's own prose.
    const seen = new Set<string>();
    const note = (spec: SpecRef, member: string | undefined, texts: (string | undefined)[]): void => {
      if (subject.specIds.has(spec.id) && (spec.kind !== 'implementation' || member === subject.methodName || subject.methodName === undefined)) return;
      for (const text of texts) {
        const hit = mention(text, subject.ids, subject.names);
        if (!hit) continue;
        const key = `${spec.id}|${member ?? ''}`;
        if (seen.has(key)) return;
        seen.add(key);
        references.push({
          kind: 'mention', evidence: 'text', agreement: 'unjudged', fromSpec: spec.id, ...(member ? { fromMember: member } : {}),
          place: placeOfSpec(index, project, spec), inTest: false, linked: hit === 'linked',
        });
        return;
      }
    };
    for (const c of index.components) note({ kind: 'component', id: c.id }, undefined, [c.description]);
    for (const i of index.interfaces) {
      note({ kind: 'interface', id: i.id }, undefined, [i.description]);
      for (const m of i.methods) note({ kind: 'interface', id: i.id }, m.name, [m.description]);
    }
    for (const impl of index.implementations) {
      note({ kind: 'implementation', id: impl.id }, undefined, [impl.description]);
      for (const m of impl.methods) {
        note({ kind: 'implementation', id: impl.id }, m.name, [m.intent, ...(m.narrative ?? []).map((s) => s.description)]);
      }
    }
    for (const t of index.types) {
      note({ kind: 'type', id: t.id }, undefined, [t.description]);
    }
  }

  // Step 16: join the design with the code.
  const confirmedFiles = new Set<string>();
  const gradeExact = (file: string): boolean => {
    const facts = factsFor(model, file);
    return facts?.status === 'analyzed' && facts.analysisGrade === 'exact' && facts.resolvedCalls !== undefined;
  };
  const calledFrom = new Set([...codeCallFiles.entries()].filter(([e]) => e.evidence === 'resolved').map(([, f]) => f));
  for (const [ref, files] of callerFiles) {
    let agreement: LookupAgreement = 'unjudged';
    if (files.every(gradeExact)) {
      const confirmed = files.some((f) => calledFrom.has(f));
      agreement = confirmed ? 'confirmed' : 'declared-only';
      if (confirmed) for (const f of files) confirmedFiles.add(f);
    }
    ref.agreement = agreement;
  }
  const declaredFiles = new Set([...callerFiles.values()].flat());
  for (const entry of codeCalls) {
    const file = codeCallFiles.get(entry)!;
    if (ownCalls.has(entry) && !declaredFiles.has(file)) continue;
    // A test is no part of the design, so its calls are never a disagreement with it.
    if (entry.evidence !== 'resolved' || entry.inTest) entry.agreement = 'unjudged';
    else if (declaredFiles.has(file)) entry.agreement = confirmedFiles.has(file) ? 'confirmed' : 'unjudged';
    else entry.agreement = gradeExact(file) ? 'observed-only' : 'unjudged';
    references.push(entry);
  }

  // Step 17: the waivers and the impact.
  const waivers: LookupWaiver[] = [];
  const unclaimed = new Set((conformance?.unclaimed ?? []).map(pathKey));
  for (const file of subject.files) {
    if (unclaimed.has(file)) waivers.push({ kind: 'unclaimed', subject: file, reason: 'listed in rules.conformance.unclaimed: no spec names this file yet' });
  }
  for (const debt of conformance?.carried ?? []) {
    for (const finding of debt.findings) {
      if (!subject.specIds.has(finding.spec)) continue;
      if (subject.methodName !== undefined && finding.at !== subject.methodName) continue;
      waivers.push({ kind: 'carried', subject: `${finding.code} at ${finding.at}`, reason: debt.why });
    }
  }
  const lintHolders: { id: string; allow?: { code: string; at?: string; reason: string }[] }[] = [
    ...index.components, ...index.interfaces, ...index.implementations, ...index.types, ...index.subsystems,
  ].filter((s) => subject.specIds.has(s.id)).map((s) => ({ id: s.id, allow: (s as { lint?: { allow?: { code: string; at?: string; reason: string }[] } }).lint?.allow }));
  for (const holder of lintHolders) {
    for (const allow of holder.allow ?? []) {
      if (subject.methodName !== undefined && allow.at !== undefined && allow.at !== subject.methodName) continue;
      waivers.push({ kind: 'lint-allow', subject: `${allow.code}${allow.at ? ` at ${allow.at}` : ''} in ${holder.id}`, reason: allow.reason });
    }
  }
  // Exported beyond the family, consumers outside it may break whatever the references show.
  const impact = exported.some((e) => e.audience !== 'project') ? 'public' : impactOf(references, top.place);

  return { target: top, candidates: [], references, waivers, impact, snapshot: found.snapshot };
}

/**
 * Every `file#name` a call may land on and still be a call of the target: each
 * name the target's files publish (its symbols, or every export of a file
 * target), followed through the re-exports and export aliases the code writes
 * down — the same forwarding the call conformance rule judges N:1 identity by.
 */
function landingsOf(model: CodeModel, files: ReadonlySet<string>, symbols: ReadonlySet<string> | undefined): Set<string> {
  const out = new Set<string>();
  if (files.size === 0) return out;
  const code = buildCodeIndex(model);
  for (const file of files) {
    const names = symbols ?? new Set(factsFor(model, file)?.exportedNames ?? []);
    for (const name of names) for (const p of code.forwardsOf(file, name)) out.add(`${p.file}#${p.name}`);
  }
  return out;
}

/** Does one entry of the L0 export table publish the target: its component (narrowed to its interface or not), or its type? */
function exportsTarget(index: Index, entry: ResolvedExport, target: LookupMatch, subject: Subject): boolean {
  const componentOf = (contract: string | undefined) => index.interfaces.find((i) => i.id === contract)?.component;
  const narrowsTo = (component: string, contract: string | undefined): boolean =>
    entry.kind === 'component' && entry.component === component && (entry.interface === undefined || contract === undefined || entry.interface === contract);
  switch (target.kind) {
    case 'component': return narrowsTo(target.id, undefined);
    case 'interface': return narrowsTo(componentOf(target.id) ?? '', target.id);
    case 'implementation': {
      const contract = index.implementations.find((i) => i.id === target.id)?.contract;
      return narrowsTo(componentOf(contract) ?? '', contract);
    }
    case 'method':
    case 'endpoint': {
      if (subject.method === undefined) return entry.kind === 'type' && subject.specIds.has(entry.typeDef ?? '');
      const { component, name } = subject.method;
      if (entry.kind !== 'component' || entry.component !== component) return false;
      return entry.interface === undefined || index.interfaces.some((i) => i.id === entry.interface && i.methods.some((m) => m.name === name));
    }
    case 'type':
    case 'field': return entry.kind === 'type' && subject.refs.some((r) => r.kind === 'type' && r.id === entry.typeDef);
    default: return false;
  }
}

function isTest(file: string, testRoots: readonly string[]): boolean {
  const k = pathKey(file);
  return /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(k) || testRoots.some((r) => k.startsWith(`${pathKey(r).replace(/\/$/, '')}/`));
}

/**
 * The lines a resolved call's sites were recorded at (exact grade only): the
 * sites in its function spelled as it is written — a bare call only by bare
 * sites, a member call only by member sites on the same plain receiver — so an
 * `items.find(…)` never lends its line to a call of an imported `find`.
 */
function linesOf(facts: SourceFileFacts, rc: ResolvedCallFact): number[] {
  if (rc.enclosing === undefined) return [];
  const callee = rc.written.split('(')[0].trim();
  const name = /([A-Za-z_$][\w$]*)$/.exec(callee)?.[1] ?? rc.name;
  const member = callee.includes('.');
  const receiver = member ? /^([A-Za-z_$][\w$]*)\.[A-Za-z_$][\w$]*$/.exec(callee)?.[1] : undefined;
  const sites = facts.functionCallSites?.[rc.enclosing] ?? [];
  return [...new Set(sites
    .filter((s) => s.name === name && s.member === member && (receiver === undefined || s.via === undefined || s.via === receiver) && s.line !== undefined)
    .map((s) => s.line as number))].sort((a, b) => a - b);
}

/** The widest place any reference sits relative to the target. */
function impactOf(references: LookupReference[], at: LookupPlace): LookupImpact {
  if (references.length === 0) return 'none';
  let widest: Exclude<LookupImpact, 'none' | 'public'> = 'component';
  for (const ref of references) {
    if (ref.inTest || ref.kind === 'mention') continue;
    let level: Exclude<LookupImpact, 'none' | 'public'>;
    if (ref.place.project !== at.project) level = 'family';
    else if (ref.place.member !== at.member) level = 'family';
    else if (ref.place.subsystem === undefined) level = 'project';
    else if (ref.place.subsystem !== at.subsystem) level = 'project';
    else if (ref.place.component !== at.component) level = 'subsystem';
    else level = 'component';
    if (LEVEL[level] > LEVEL[widest]) widest = level;
  }
  return widest;
}

