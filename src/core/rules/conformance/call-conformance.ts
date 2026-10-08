import {
  bodySitesOf,
  defaultConformanceTier,
  implementationSourceFiles,
  importBindingOf,
  methodSourceFile,
  parseDeclaredCall,
  pathKey,
  resolveImport,
  type CallSiteFact,
  type CallTargetFact,
  type ComponentSpec,
  type MethodImplementation,
  type ResolvedCallFact,
} from '../../../models/index.js';
import { CodeIndex, ForwardedName, RuleContext, SddRule } from '../types.js';

// ---------------------------------------------------------------------------
// Call realization (code↔spec Level 3), both directions.
//
// Levels 1–2 prove the code matches the spec's SHAPE (files, symbols, import
// graph). This rule reads INTENT, over one relation — a call the method CLAIMS
// and the call that realizes it — asked both ways, exactly as Level 2 asks
// about imports both ways.
//
// A method claims a call two ways, and they are ONE subject here. A narrative
// `call` step names a target and where in the flow it is reached; an entry of
// the method's declared `calls` names the same target with no flow to place it
// in, because its narrative shows no steps. This check never reads order, so
// the step number is not part of the claim it judges — it is only how a
// finding POINTS at the claim. Two claims, one question, one verdict: a
// declaration that bought reachability in the graph is worth no more than a
// step that did, and until this rule read them both, one of them was free.
//
//   forward   every claim must be realized by a call that RESOLVES TO
//             the target's own source file. Matching the callee's NAME alone
//             was the old answer, and it let a `save` in an unrelated module
//             satisfy a claim that named the billing store's `save`. When the
//             call is there but a pure model cannot say where it lands, that
//             is CALL_ORIGIN_UNRESOLVED — a different answer from "the call is
//             missing", and keeping them apart is the point: only what
//             resolved may accuse. A `this.store.save()` receiver is followed
//             through the TYPE the class declares that field with, a
//             `new Registry(store).save()` receiver through the module its
//             CLASS NAME came from, and a plain `store.save()` receiver
//             through the type the file ANNOTATES that name with — each says
//             where the callee CAN have been written and never where it was:
//             so those readings accept a claim, and a landing a finding names
//             still comes from what was proven.
//   converse  a call to a modelled method of ANOTHER component that lives in
//             the SAME FILE crosses a component boundary while looking local,
//             so the method must claim it (UNDECLARED_COLOCATED_CALL) — in a
//             narrative step, or in its declared `calls`. The file-level
//             checks structurally cannot see that hop: nothing is imported,
//             and Level 2 judges edges BETWEEN files.
//
// What the forward direction still does not prove: order, arguments and
// conditions stay deliberately unverified — this is reachability of a call
// site, not behavioral equivalence, and the finding text says so. `dispatch`
// steps are skipped: they route through runtime tables, so the bound method's
// name legitimately never appears at the call site. A declared reference that
// is not `<component>.<method>` names no target at all, which is
// MALFORMED_DECLARED_CALL's finding and never a silent acceptance here.
// ---------------------------------------------------------------------------


/**
 * Every call site the function makes, closed transitively over the named
 * helpers it calls (so extract-helper refactors stay clean), each carrying the
 * file its names resolve in. Undefined when the file holds no BODY under `fn`
 * — the answer METHOD_BODY_NOT_FOUND reports, and never confused with an empty
 * list, which is a body that calls nothing.
 *
 * The function is read as the ONE body its anchor means — `container` is the
 * anchor's `exportedVia` handle — and each hop as the one body its call
 * reaches, told apart from same-named neighbours by where each is bound
 * (bodySitesOf). Where the code does not settle which body a name means, the
 * walk reads every body of that name, as it always has.
 *
 * `stopAt` says which callees the walk RECORDS but does not descend into — a
 * modelled method, whose own callees belong to its own narrative, so the
 * converse direction stops there instead of attributing them to the caller. It
 * is asked with the site and the identity of the body the site resolved to.
 */
export function closedCallSites(
  code: CodeIndex,
  file: string,
  fn: string,
  stopAt?: (site: CallSiteFact, bodyKey: string | undefined) => boolean,
  container?: string,
): CallSiteFact[] | undefined {
  const facts = code.factsAt(file);
  const direct = facts && bodySitesOf(facts, fn, container);
  if (!direct) return undefined;
  const here = pathKey(file);
  const out: CallSiteFact[] = [];
  const descended = new Set<string>([`${here}|${direct.key}`]);
  const queue: CallSiteFact[] = direct.sites.map(s => ({ ...s, from: s.from ?? here }));
  while (queue.length) {
    const site = queue.pop()!;
    out.push(site);
    // Descend into the body the scope file holds under that name — a member
    // call's plain-identifier receiver naming the container it may reach: the one
    // the call reaches where the code settles it, every one where it does
    // not. The union is permissive on purpose — a wider callee set can only
    // make the forward direction ACCEPT more, never accuse — so a
    // `this.helper()` hop into a same-file method stays closed over, as it
    // always was.
    const scope = code.factsAt(site.from!);
    const next = scope ? bodySitesOf(scope, site.name, site.via, site.member) : undefined;
    if (stopAt?.(site, next?.key)) continue;
    if (!next) continue;
    const key = `${site.from}|${next.key}`;
    if (descended.has(key)) continue;
    descended.add(key);
    queue.push(...next.sites.map(s => ({ ...s, from: s.from ?? site.from })));
  }
  return out;
}

/** One resolved call or reference a component's code makes, with the unowned functions it was reached through, outermost first. */
export interface ReachedCall {
  call: ResolvedCallFact;
  /** Each unowned function the call sits in, as `name (path)`; empty for a call written in the component's own body. */
  through: string[];
  /**
   * Set when the call lands on a member of the CLASS a workflow component
   * (Orchestrator, Supervisor, Actor) is realized by that is none of its
   * modelled methods — a method of that component's code its contract does
   * not declare, renamed in the code or never designed. It is the
   * component's code, not unowned: the walk stops there.
   */
  into?: { component: string; member: string };
}

/** The components whose code a call into an undeclared member of their class stops at. */
const WORKFLOW_TYPES = new Set(['Orchestrator', 'Supervisor', 'Actor']);

/** How deep a chain of unowned helpers is followed: far past any honest factoring, and a hard stop for a cycle the visited set misses. */
const UNOWNED_DEPTH = 8;

/**
 * Reads UNOWNED code as part of whoever calls it. Code is unowned when it sits
 * in a file no component realizes, or is a function of a realized file that is
 * none of its components' modelled methods — a persistence helper module, a
 * utility exported beside a class. A call resolving to such a function is
 * expanded into the calls that function's body makes, transitively (visited
 * set, depth bound), each kept with the path it was reached through, so a
 * finding reports at the original call site naming the hops. A call landing
 * on a modelled method stops there: what that method calls is its own
 * narrative's. A landing in `origin` itself is left to the caller, whose own
 * body walk already covers its file.
 */
export function unownedReach(ctx: RuleContext): (calls: readonly ResolvedCallFact[], origin: string) => ReachedCall[] {
  const realization = ctx.realizationIndex();
  const model = ctx.codeModel;
  const callsAt = new Map<string, ResolvedCallFact[]>();
  for (const facts of model.files) if (facts.resolvedCalls) callsAt.set(pathKey(facts.path), facts.resolvedCalls);
  for (const [key, calls] of Object.entries(model.reachedCalls ?? {})) if (!callsAt.has(key)) callsAt.set(key, calls);
  const modelledAt = new Map<string, Set<string>>();
  const modelled = (file: string): Set<string> => {
    let names = modelledAt.get(file);
    if (names) return names;
    names = new Set<string>();
    for (const component of realization.componentsAt(file)) {
      for (const m of ctx.interfaceMethodsOf(component.id)) names.add(m.name);
      for (const impl of realization.implementationsOf(component.id)) {
        for (const m of impl.methods) if (m.symbol) names.add(m.symbol);
      }
    }
    modelledAt.set(file, names);
    return names;
  };
  const owned = (target: CallTargetFact): boolean => modelled(target.path).has(target.member);
  const code = ctx.codeIndex();
  /**
   * The workflow component whose realizing CLASS a target is a member of: a
   * class at that file holding one of the component's modelled methods. What
   * the class declares beside them is still that component's code.
   */
  const classOwner = (target: CallTargetFact): ComponentSpec | undefined => {
    if (target.container === undefined) return undefined;
    const bodies = code.factsAt(target.path)?.functionBodies;
    if (!bodies) return undefined;
    for (const component of realization.componentsAt(target.path)) {
      if (!WORKFLOW_TYPES.has(component.componentType)) continue;
      const names = new Set(ctx.interfaceMethodsOf(component.id).map(m => m.name));
      for (const impl of realization.implementationsOf(component.id)) for (const m of impl.methods) if (m.symbol) names.add(m.symbol);
      for (const name of names) {
        if (Object.prototype.hasOwnProperty.call(bodies, name) && bodies[name].some(b => b.container === target.container)) return component;
      }
    }
    return undefined;
  };
  return (calls, origin) => {
    const out: ReachedCall[] = [];
    const visited = new Set<string>();
    const queue: ReachedCall[] = calls.map(call => ({ call, through: [] }));
    while (queue.length) {
      const reached = queue.shift()!;
      out.push(reached);
      if (reached.through.length >= UNOWNED_DEPTH) continue;
      for (const target of reached.call.targets) {
        if (target.path === origin || owned(target)) continue;
        const owner = classOwner(target);
        if (owner && !realization.componentsAt(origin).some(c => c.id === owner.id)) {
          reached.into ??= { component: owner.id, member: target.member };
          continue;
        }
        const id = `${target.path}|${target.container ?? ''}|${target.member}`;
        if (visited.has(id)) continue;
        visited.add(id);
        const body = (callsAt.get(target.path) ?? []).filter(c => c.enclosing === target.member
          && (target.container === undefined ? c.enclosingContainer === undefined : c.enclosingContainer === target.container));
        const hop = `${target.container ? `${target.container}.` : ''}${target.member} (${target.path})`;
        for (const call of body) queue.push({ call, through: [...reached.through, hop] });
      }
    }
    return out;
  };
}

/** A write- or lifecycle-effect contract method of a component, as a fail-closed finding names it. */
export interface WriteCandidate {
  component: string;
  method: string;
}

/**
 * The writes an UNRESOLVED call may be: where the call recorded its
 * receiver's original (pre-cast) type, the write- or lifecycle-effect methods
 * of the components realized by the classes it lands on — the one its name
 * names, or every one when a computed key names none; otherwise, by name, the
 * writes of components in the caller's own subsystem or a subsystem it
 * depends into. `keep` narrows by the callee component (a Portal's data
 * writes are PORTAL_CALL_UNRESOLVED's, everything else the converse
 * direction's).
 */
export function writeCandidates(ctx: RuleContext): (call: ResolvedCallFact, caller: ComponentSpec, keep: (callee: ComponentSpec) => boolean) => WriteCandidate[] {
  const realization = ctx.realizationIndex();
  const writesOf = new Map<string, Array<{ method: string; names: Set<string> }>>();
  const writes = (componentId: string): Array<{ method: string; names: Set<string> }> => {
    let list = writesOf.get(componentId);
    if (list) return list;
    list = [];
    for (const m of ctx.interfaceMethodsOf(componentId)) {
      if (m.effect !== 'write' && m.effect !== 'lifecycle') continue;
      const names = new Set([m.name]);
      for (const impl of realization.implementationsOf(componentId)) {
        const bound = impl.methods.find(x => x.name === m.name)?.symbol;
        if (bound) names.add(bound);
      }
      list.push({ method: m.name, names });
    }
    writesOf.set(componentId, list);
    return list;
  };
  return (call, caller, keep) => {
    const out: WriteCandidate[] = [];
    const seen = new Set<string>();
    const take = (callee: ComponentSpec): void => {
      if (callee.id === caller.id || !keep(callee)) return;
      for (const w of writes(callee.id)) {
        if (call.name !== '' && !w.names.has(call.name)) continue;
        const ref = `${callee.id}.${w.method}`;
        if (!seen.has(ref)) { seen.add(ref); out.push({ component: callee.id, method: w.method }); }
      }
    };
    // Receivers that are components settle it; receivers that are none (a
    // wrapper class no spec names) leave it to the name, as a receiver with
    // no recorded type does.
    const receiving = (call.receivers ?? []).flatMap(r => realization.componentsAt(r.path));
    if (receiving.length > 0) {
      for (const callee of receiving) take(callee);
      return out;
    }
    if (call.name === '') return out;
    const near = new Set([caller.subsystem, ...caller.dependsOn.map(d => ctx.componentMap.get(d)?.subsystem)]);
    for (const callee of ctx.components) if (near.has(callee.subsystem)) take(callee);
    return out;
  };
}

/** How a finding names the unowned hops a call was reached through. */
export const throughText = (through: readonly string[]): string =>
  (through.length ? `, reached through ${through.join(' → ')}` : '');

/**
 * Whether a claim is a link over a transport rather than an in-process call:
 * the caller is an Adapter and the target a Portal declaring any transport but
 * InProcess — the boundary the call crosses is the network (or a process).
 */
function isRemoteLink(caller: Pick<ComponentSpec, 'componentType'>, target: Pick<ComponentSpec, 'componentType' | 'transport'>): boolean {
  return caller.componentType === 'Adapter' && target.componentType === 'Portal'
    && target.transport !== undefined && target.transport !== 'InProcess';
}

/** A modelled method's identity in its file: `<exportedVia>.<symbol>` when it is reached through a handle, else its symbol. */
const anchorKey = (symbol: string, exportedVia: string | undefined): string =>
  (exportedVia !== undefined ? `${exportedVia}.${symbol}` : symbol);

/** A modelled method, as the converse direction names the component it belongs to. */
interface Owner {
  component: string;
  method: string;
}

/** What a claim's target is in code: the names that realize it, and the files they are written in. */
interface CallTarget {
  /** The contract name, plus every per-method `symbol` override a target-side implementation declares. */
  accepted: Set<string>;
  /** The files realizing the target method: each implementation's method sourcePath, else the implementation's own. */
  files: Set<string>;
  /**
   * The ONE body realizing the target in each of those files, as
   * `<file>|<anchor>` — the anchor being the method's symbol, qualified by its
   * exportedVia handle. What N:1 identity is judged on: a caller is the target
   * only when it IS this body, never because it shares its name.
   */
  bodies: Set<string>;
  /** The same bodies as (file, symbol, exportedVia), for following what each one forwards to. */
  anchors: { file: string; symbol: string; exportedVia?: string }[];
}

/** A body's identity across files: the file and the anchor its method names there. */
const bodyKey = (file: string, symbol: string, exportedVia: string | undefined): string =>
  `${file}|${anchorKey(symbol, exportedVia)}`;

function resolveCallTarget(ctx: RuleContext, componentId: string, methodName: string): CallTarget {
  const accepted = new Set<string>([methodName]);
  const files = new Set<string>();
  const bodies = new Set<string>();
  const anchors: CallTarget['anchors'] = [];
  for (const intf of ctx.interfacesByComponent.get(componentId) ?? []) {
    for (const impl of ctx.implementationsByContract.get(intf.id) ?? []) {
      const method = impl.methods.find(m => m.name === methodName);
      if (!method && !intf.methods.some(m => m.name === methodName)) continue;
      if (method?.symbol) accepted.add(method.symbol);
      const file = methodSourceFile(method ?? {}, impl.sourcePath);
      if (!file) continue;
      files.add(pathKey(file));
      bodies.add(bodyKey(pathKey(file), method?.symbol ?? methodName, method?.exportedVia));
      anchors.push({ file: pathKey(file), symbol: method?.symbol ?? methodName, exportedVia: method?.exportedVia });
    }
  }
  return { accepted, files, bodies, anchors };
}

/**
 * Every (file, name) a target's realizing anchor IS, followed through what its
 * file forwards it as: its own republications and export aliases, and — where
 * the file merely BINDS the name from another module, as an orchestrator that
 * hands a store's function straight through does — that module's function
 * and what it in turn forwards to. A name binding a module of the code writes
 * down is proven, never guessed.
 */
function targetForwards(code: CodeIndex, target: CallTarget): Set<string> {
  const out = new Set<string>();
  for (const anchor of target.anchors) {
    for (const p of code.forwardsOf(anchor.file, anchor.symbol, anchor.exportedVia)) out.add(`${p.file}#${p.name}`);
    if (anchor.exportedVia !== undefined) continue;
    const facts = code.factsAt(anchor.file);
    if (!facts || facts.status !== 'analyzed' || facts.analysisGrade !== 'exact') continue;
    const binding = importBindingOf(facts, anchor.symbol);
    if (!binding || binding.namespace) continue;
    const module = resolveImport(anchor.file, binding.from, code.paths, code.packages);
    if (!module) continue;
    for (const p of code.forwardsOf(module, binding.imported ?? anchor.symbol)) out.add(`${p.file}#${p.name}`);
  }
  return out;
}

/**
 * Whether one of these (file, name) pairs IS the target: a file realizing it,
 * under a name it is realized by.
 */
function isTarget(pairs: readonly ForwardedName[], target: CallTarget): boolean {
  return pairs.some(p => target.files.has(p.file) && target.accepted.has(p.name));
}

/**
 * What a call site PROVABLY invokes, as (file, name) pairs followed through
 * every re-export: a bare call on an import binding is the binding's module's
 * export under the name it was imported by, and a member call through a
 * NAMESPACE binding that module's export under the invoked name — each then
 * followed through the module's republications, aliased or not. This is how a
 * call to `b` through a module republishing m's `a` as `b` lands on m.a: the
 * call's spelling is the republished name, and the identity is the module
 * that wrote it. Every other shape, and a file below exact grade, answers
 * nothing — the same proven tier originOf reads.
 */
function invokedAs(code: CodeIndex, site: CallSiteFact, file: string): ForwardedName[] {
  const scope = pathKey(site.from ?? file);
  const facts = code.factsAt(scope);
  if (!facts || facts.status !== 'analyzed' || facts.analysisGrade !== 'exact') return [];
  if (!site.member) {
    const binding = importBindingOf(facts, site.name);
    if (!binding || binding.namespace) return [];
    const module = resolveImport(scope, binding.from, code.paths, code.packages);
    return module ? code.forwardsOf(module, binding.imported ?? site.name) : [];
  }
  if (!site.via) return [];
  const receiver = importBindingOf(facts, site.via);
  if (!receiver?.namespace) return [];
  const module = resolveImport(scope, receiver.from, code.paths, code.packages);
  return module ? code.forwardsOf(module, site.name) : [];
}

/**
 * One call a method CLAIMS it makes: a narrative `call` step, or an entry of
 * its declared `calls`. They assert the same thing — this method calls that
 * component's method — and differ only in that a step also says where in the
 * flow it happens. This check never reads order, so that difference is not
 * part of the claim: it is how a finding POINTS at one, and nothing more.
 */
interface CallClaim {
  /** The narrative step's number; absent on a declared call, which has no step to point at. */
  step?: number;
  component: string;
  method: string;
}

/**
 * Everything a method claims it calls: its narrative `call` steps, then its
 * declared `calls`. A `dispatch` step routes through a runtime table and names
 * a capability rather than a method, so it asserts nothing about a call site
 * and is no claim. A declared reference that is not `<component>.<method>`
 * names no target to check — MALFORMED_DECLARED_CALL reports exactly that, and
 * a second accusation here would say the same thing twice.
 */
function claimsOf(implMethod: MethodImplementation): CallClaim[] {
  const claims: CallClaim[] = [];
  for (const step of implMethod.narrative) {
    if (step.type !== 'call' || !step.targetComponent || !step.targetMethod) continue;
    claims.push({ step: step.stepNumber, component: step.targetComponent, method: step.targetMethod });
  }
  for (const ref of implMethod.calls ?? []) {
    const parsed = parseDeclaredCall(ref);
    if (parsed) claims.push({ component: parsed.compId, method: parsed.methodName });
  }
  return claims;
}

/** Why a claim was not accepted. The three answers are deliberately distinct, and only two of them accuse. */
type Miss =
  | { kind: 'absent' }
  | { kind: 'elsewhere'; landed: string[] }
  /** `shapes`: how the matching sites were WRITTEN — an answer that cannot say where a call went owes the form it could not follow. */
  | { kind: 'unresolved'; shapes: string[] };

interface MissedClaim {
  /** The narrative step's number, absent on a declared call — the whole of what tells the two apart in a finding. */
  step?: number;
  target: string;
  accepted: string[];
  miss: Miss;
  /** The target's component, where a finding names its planned files. */
  component?: string;
  /**
   * What the function calls on the target component's code instead, where it
   * calls a member of that component's class its contract does not declare —
   * the shape a rename made in the code alone leaves behind.
   */
  instead?: { member: string; written: string };
}

/**
 * How a finding names the claim it missed, and how the debt register and a
 * lint allow name that same unit: a step by its number and target, a
 * declaration by its target alone — which is the `calls` entry verbatim.
 */
const unitOf = (m: MissedClaim): string => (m.step === undefined ? m.target : `${m.step}:${m.target}`);

/** What a method's claims ARE, for a finding that counts them. A schema-valid method declares calls or narrates them, never both. */
const claimNoun = (implMethod: MethodImplementation): string =>
  (implMethod.narrative.length ? 'narrative call step(s)' : 'declared call(s)');

/**
 * How a call site was WRITTEN, read off its shape alone — the subject of the
 * unresolved answer. The shape is all this reports: naming the form it could
 * not follow is the honest content of "I cannot say", where advice to write
 * the call differently would be asking working code to suit the analysis.
 */
function describeSite(site: CallSiteFact): string {
  if (!site.member) return `${site.name}(…)`;
  if (site.via) return `${site.via}.${site.name}(…)`;
  if (site.field) return `this.${site.field}.${site.name}(…)`;
  if (site.constructed) return `new ${site.constructed}(…).${site.name}(…)`;
  if (site.returnedBy) return `${site.returnedBy}(…).${site.name}(…)`;
  if (site.receiverPath) return `${site.receiverPath.join('.')}.${site.name}(…)`;
  if (site.enclosingClass) return `this.${site.name}(…)`;
  return `<receiver>.${site.name}(…)`;
}

function describeMiss(m: MissedClaim): string {
  const where = m.step === undefined ? 'declared call' : `step ${m.step}`;
  const head = `${where} → ${m.target} (looked for ${m.accepted.map(a => `"${a}"`).join(' / ')}`;
  if (m.miss.kind === 'elsewhere') return `${head}, called but resolved to ${m.miss.landed.map(p => `"${p}"`).join(', ')})`;
  if (m.miss.kind === 'unresolved') return `${head}, written as ${m.miss.shapes.map(s => `\`${s}\``).join(' / ')})`;
  if (m.instead) {
    return `${head}; the function calls "${m.instead.member}" on ${m.component}'s code instead (\`${m.instead.written}(…)\`), a method its contract does not declare — a rename made in the code only? Follow it in the design (sdd_rename_method) or rename the code back)`;
  }
  return `${head})`;
}

export const callConformanceRule: SddRule = {
  name: 'call-conformance',
  judges: 'code',
  description:
    'Code↔spec Level 3: the CLAIMED call ↔ realized call relation, judged both ways against the method\'s own source file (its sourcePath, else the implementation\'s), at exact analysis grade only. A method claims a call two ways and they face one check: a narrative `call` step, and an entry of the declared `calls` a narrative-less method reaches its collaborators through. They assert the same thing, and the step number is no part of the claim — this check never reads order, so it is only how a finding points at one. Forward: every claim must be realized by a call whose callee RESOLVES TO one of the target method\'s own source files — the target\'s contract name or a per-method `symbol` override, closed transitively over the named helpers the realized function calls, and resolved against every file the call CAN have reached: a `this.<field>.<method>()` receiver followed through the field\'s DECLARED TYPE, a `new Class(...).<method>()` receiver through the module its CLASS NAME came from, a plain `<name>.<method>()` receiver through the type the file ANNOTATES that name with — a parameter\'s, or an annotated variable\'s, which is how a module that wires its collaborators as closures writes every one of its calls — a `fn(...).<method>()` receiver through the type fn RETURNS where the code settles it, and a `this.<method>()` receiver through the class whose own method it sits in, and a receiver CHAIN (`this.<field>.<property>.<method>()`, `<name>.<property>.<method>()`) link by link through each link\'s declared type — a declared type read through a member-preserving utility (Pick, Omit, Partial, Required, Readonly) and one alias hop; a package specifier naming a package of this repository resolves like a relative one, and an export alias (`export { a as b }`, an adapter object property `{ b: a }`) forwards by identity like a re-export. A matching call whose origin a pure model cannot resolve is reported apart as CALL_ORIGIN_UNRESOLVED, which NAMES the shape it could not follow and asks for nothing — a coverage hole in the reader, reported for the reason CONFORMANCE_DEGRADED is: a silently degraded gate is worse than a degraded one. Where that claim\'s target has no code yet — no file any of its implementations names exists, the normal state after the first component of a service is implemented from its brief through a port to a collaborator still planned — the call is planned rather than unresolved (CALL_TARGET_PLANNED, a notice, as SOURCE_FILE_PLANNED is), and it is judged like any other claim once the target\'s realization begins. A finding names a landing only from the PROVEN tier so that widening what a call reached can accept a claim but never accuse one, and a target that names no file of its own falls back to name membership. Where a type checker read the file, a claim is also realized by any call or reference in the bodies the function reaches — and in the unowned code they call — that the checker lands on the target: its file under a name it is realized by, a class realizing the port the call was typed by, or what the target forwards to by identity — whatever the receiver\'s spelling (a type-only or `export *` barrel, a port declared in a shared module, a dependency bag typed inline); a claim it does not land keeps the shape tier\'s answer, since the checker\'s landing on a declaration says what a receiver is TYPED as, never where the call went instead. N:1 identity — a caller that IS the target — is judged on the body, the same anchor in the same file, never on a shared name: a Portal method forwarding to a same-named Orchestrator method elsewhere must make that call. Converse: a call that resolves to a modelled method of ANOTHER component in the SAME file crosses a component boundary while looking local, so the method must claim it — in a step or in `calls` (UNDECLARED_COLOCATED_CALL) — judged on the proven tier alone, and a same-file private helper is no modelled method and is never reported; a function forwarding by identity to a modelled method written in another file IS that method, so what it calls is that method\'s subject. And a call — or a reference the code takes as a value — that the TypeScript type checker resolves into ANOTHER file, onto a write- or lifecycle-effect contract method of another component, or, from a Portal method whose body is its own, onto a verb of an Orchestrator, Supervisor or Actor whose effect is a write — declared (write, lifecycle or io), or, where its contract declares none, read off the verb\'s own narrative transitively: a call step or declared call reaching a method that changes state makes it a write, only reads or none a read, and a verb that settles nothing (no narrative and no declared calls, a dispatch step, a target outside this tree, a non-workflow method declaring no effect) is reported as an unnarrated call whose effect is undeclared, never as a write (a Portal changes state only by dispatching to such a verb, so its narrative is the list of those it may reach), that the method claims nowhere is a mutation the design says the method never makes (UNDECLARED_WRITE_CALL): narrate it, declare it in `calls`, or remove it — judged in the bodies the method\'s function reaches and in the UNOWNED code they call (a function in a file no component realizes, or one that is none of its file\'s components\' modelled methods, read as if inlined at the call site, transitively to a bounded depth, the finding naming the hops — but a member of the CLASS a workflow component (Orchestrator, Supervisor, Actor) is realized by, one of the classes holding its modelled methods, is that component\'s code even where its contract does not declare it, so the walk stops there: a claim the function answers by calling such a member in place of the claimed method is CALL_STEP_UNREALIZED naming the method the code calls instead, the shape a rename made in the code alone leaves, and a Portal\'s call to one no missed claim names is an unnarrated call to a method whose effect no narrative settles, never read through its body as the Portal\'s own write), never for a Portal\'s call into a data component (PORTAL_WRITE_SHORTCUT_IN_CODE\'s subject), and only where a type checker was loaded. A call there the checker cannot follow — its receiver typed any or unknown, cast to either or to an index signature, typed by an index signature naming no member of that name, or its member picked by a computed key — under the name of such a write the method claims nowhere (where the checker recorded the receiver\'s original type — every cast, non-null mark and parenthesis taken off, an `await (x)` written outside an async function read as the x it means, nullability set aside so an optional field is the class it holds, a name bound once by a const read through its initializer, and an interface or shape no class realizes landing on the file declaring it — a write of the component that type lands on, any of its writes when a computed key names none; else a write of that name in the method\'s own subsystem or one its component depends into) fails closed as CALL_ORIGIN_UNRESOLVED: neither proven an unnarrated write nor cleared. A member picked by a key that names no single member, on a receiver that was one of this project\'s classes before any cast, is such a call however the receiver or the key is cast and whether it is invoked on the spot or taken as a value and invoked later (`const f = store[k]; f.call(store, …)`); a key the checker types as one literal names its member by that literal\'s value, never by the variable holding it. A method that claims nothing at all is judged in neither direction: what it leaves unsaid is UNUSED_*\'s subject. Order, arguments and conditions stay unverified, dispatch steps (runtime-table routed) are no claim about a call site, a malformed declared reference is MALFORMED_DECLARED_CALL\'s finding and names no target here, the conformance dial (off) skips, and weaker analysis grades never guess.',
  codes: [
    { code: 'CALL_STEP_UNREALIZED', defaultSeverity: 'warning', summary: 'Narrative call step or declared call realized by no call that resolves to the target method\'s own source file — the call is absent, or it lands in another module', carryable: true },
    { code: 'CALL_ORIGIN_UNRESOLVED', defaultSeverity: 'warning', summary: 'Narrative call step or declared call whose target name IS called, but only from call sites written in a shape this analysis cannot resolve to a file — the claim was not checked, and is neither proven realized nor accused; or, the fail-closed half of UNDECLARED_WRITE_CALL, a call through a receiver the analysis cannot follow (typed any or unknown, cast to either or to an index signature, a computed key) under the name of a write the method claims nowhere. Where a type checker read the file, whatever the checker resolves; without one, what resolves is a name bound to a module of THIS project: a bare or namespaced call through such an import binding, a this.<field> receiver whose declared type names one, a receiver chain (this.<field>.<property>, <name>.<property>) each of whose links the code declares a type for, a new Class(…) receiver whose class does, a receiver name the file annotates with such a type, a fn(…) receiver whose return the code settles, and this inside a class\'s own method — a declared type read through Pick/Omit/Partial/Required/Readonly and one alias hop. What does not: a third-party package import, a value the module assembled, and a receiver the file declares nothing for', carryable: true },
    { code: 'UNDECLARED_COLOCATED_CALL', defaultSeverity: 'warning', summary: 'The realized function calls a modelled method of another component living in the same source file, and neither a narrative step nor a declared call names it', carryable: true },
    { code: 'UNDECLARED_WRITE_CALL', defaultSeverity: 'warning', summary: 'The realized function, or unowned code it calls, calls or takes as a value a write- or lifecycle-effect method of another component in another file — or, from a Portal, a workflow verb whose effect, declared or read off its own narrative, is a write, or that nothing settles (said as an unnarrated call whose effect is undeclared), or a method of a workflow component\'s class its contract does not declare — as the type checker resolves it, and neither a narrative step nor a declared call names it — an unnarrated mutation', carryable: true },
    { code: 'CALL_TARGET_PLANNED', defaultSeverity: 'notice', summary: 'A narrative call step or declared call written by name through a receiver nothing realizes yet, whose target component has no code yet (no file its implementations name exists) — planned, not unresolved; judged like any other claim once the target\'s realization begins' },
  ],
  check(ctx: RuleContext) {
    const code = ctx.codeIndex();

    // ctx.implementationMethods() is the descent — implementation, contract,
    // component, chained-subproject skip, method, source file — resolved once
    // for the whole run. What is done with the file it hands over stays here:
    // the conformance dial and the exact-grade gate are this rule's own
    // honesty stance, and belong where its accusation is read.
    const methods = ctx.implementationMethods();
    const realization = ctx.realizationIndex();
    const reach = unownedReach(ctx);
    const candidatesOf = writeCandidates(ctx);
    /** Every file a component's implementations name. */
    const filesOf = (componentId: string): string[] =>
      realization.implementationsOf(componentId).flatMap(impl => implementationSourceFiles(impl));
    /** Whether a component's realization has BEGUN: some file one of its implementations names exists (code_index.holdsAny). */
    const targetBegun = (componentId: string): boolean => code.holdsAny(filesOf(componentId));
    const plannedFilesOf = (componentId: string): string => {
      const files = [...new Set(filesOf(componentId))];
      return files.length ? files.map(f => `"${f}"`).join(', ') : 'no file yet';
    };
    const DATA_COMPONENTS = new Set(['Repository', 'Index', 'Store', 'Registry']);
    const WORKFLOW_COMPONENTS = new Set(['Orchestrator', 'Supervisor', 'Actor']);
    /** The contract method a code name is, per component: its name, or a per-method symbol. */
    const contractMethodOf = (componentId: string, name: string): { name: string; effect?: string } | undefined => {
      const contract = ctx.interfaceMethodsOf(componentId);
      const direct = contract.find(m => m.name === name);
      if (direct) return direct;
      for (const impl of realization.implementationsOf(componentId)) {
        const bound = impl.methods.find(m => m.symbol === name);
        const signature = bound && contract.find(m => m.name === bound.name);
        if (signature) return signature;
      }
      return undefined;
    };
    /** The fail-closed converse: the writes an unresolved call may be, a Portal's data writes left to PORTAL_CALL_UNRESOLVED. */
    const unresolvedCandidates = (call: ResolvedCallFact, caller: ComponentSpec): string[] =>
      candidatesOf(call, caller, callee => !(caller.componentType === 'Portal' && DATA_COMPONENTS.has(callee.componentType))
        && !isRemoteLink(caller, callee))
        .map(w => `${w.component}.${w.method}`);
    /** The write- or lifecycle-effect contract method a code name is, per component: its name, or a per-method symbol. */
    const writeMethodOf = (componentId: string, name: string): string | undefined => {
      const contract = ctx.interfaceMethodsOf(componentId);
      const isWrite = (m: { effect?: string }): boolean => m.effect === 'write' || m.effect === 'lifecycle';
      const direct = contract.find(m => m.name === name);
      if (direct) return isWrite(direct) ? direct.name : undefined;
      for (const impl of realization.implementationsOf(componentId)) {
        const bound = impl.methods.find(m => m.symbol === name);
        const signature = bound && contract.find(m => m.name === bound.name);
        if (signature) return isWrite(signature) ? signature.name : undefined;
      }
      return undefined;
    };

    /**
     * What a workflow verb does to state where its contract does not say,
     * read off its own narrative, transitively. A declared effect is the
     * answer (write, lifecycle and io change state; read and none do not).
     * An undeclared one is what the verb's claims reach — its narrative call
     * steps or its declared calls: any one reaching a method that changes
     * state makes it a write, and only reads, or nothing at all, a read. What
     * the design leaves unsaid stays unknown, never guessed: a verb with no
     * narrative and no declared calls, a dispatch step (a runtime table names
     * no method), a target outside this tree, or a non-workflow method whose
     * effect is undeclared. A verb already being read on the path (a cycle)
     * adds nothing.
     */
    const verbEffects = new Map<string, 'write' | 'read' | 'unknown'>();
    const verbEffect = (componentId: string, method: string, visiting = new Set<string>()): 'write' | 'read' | 'unknown' => {
      const key = `${componentId}.${method}`;
      const known = verbEffects.get(key);
      if (known) return known;
      if (visiting.has(key)) return 'read';
      const declared = ctx.interfaceMethodsOf(componentId).find(m => m.name === method)?.effect;
      let answer: 'write' | 'read' | 'unknown';
      if (declared !== undefined) {
        answer = declared === 'read' || declared === 'none' ? 'read' : 'write';
      } else if (!WORKFLOW_COMPONENTS.has(ctx.componentMap.get(componentId)?.componentType ?? '')) {
        answer = 'unknown';
      } else {
        const bodies = realization.implementationsOf(componentId)
          .map(impl => impl.methods.find(m => m.name === method))
          .filter((m): m is MethodImplementation => m !== undefined && (m.narrative.length > 0 || (m.calls?.length ?? 0) > 0));
        if (bodies.length === 0) {
          answer = 'unknown';
        } else {
          visiting.add(key);
          let sawWrite = false;
          let sawUnknown = false;
          for (const body of bodies) {
            if (body.narrative.some(step => step.type === 'dispatch')) sawUnknown = true;
            for (const claim of claimsOf(body)) {
              const reached = ctx.componentMap.has(claim.component) ? verbEffect(claim.component, claim.method, visiting) : 'unknown';
              if (reached === 'write') sawWrite = true;
              else if (reached === 'unknown') sawUnknown = true;
            }
          }
          visiting.delete(key);
          answer = sawWrite ? 'write' : sawUnknown ? 'unknown' : 'read';
        }
      }
      // An answer read inside a cycle leaned on the cycle's own head; only
      // an outermost answer is final.
      if (visiting.size === 0) verbEffects.set(key, answer);
      return answer;
    };

    // Which modelled method each realizing symbol IS, per file — the converse
    // direction's whole subject, read off the same descent so a component and
    // its colocated neighbour come from one walk.
    // Keyed two ways: by the body identity an anchor names (its symbol,
    // qualified by its exportedVia handle), which is what a site resolved to
    // one body is matched against; and by bare name, which is what a site
    // whose body the code does not settle falls back to, as it always did.
    const modelledAt = new Map<string, { byKey: Map<string, Owner>; byName: Map<string, Owner> }>();
    for (const entry of methods) {
      if (!entry.sourceFile) continue;
      const file = pathKey(entry.sourceFile);
      const at = modelledAt.get(file) ?? { byKey: new Map<string, Owner>(), byName: new Map<string, Owner>() };
      const symbol = entry.method.symbol ?? entry.method.name;
      const owner: Owner = { component: entry.component.id, method: entry.method.name };
      at.byKey.set(anchorKey(symbol, entry.method.exportedVia), owner);
      at.byName.set(symbol, owner);
      modelledAt.set(file, at);
    }
    // Everything the modelled methods sharing ONE body claim, by that body's
    // identity (file and anchor). N:1 identity makes a facade and its target
    // one function, so a call the target claims is claimed for the facade too.
    const claimsByBody = new Map<string, Set<string>>();
    /** The bodies a modelled method of a component other than a Portal is anchored to. */
    const sharedBodies = new Set<string>();
    for (const entry of methods) {
      if (!entry.sourceFile) continue;
      if (entry.component.componentType !== 'Portal') {
        sharedBodies.add(bodyKey(pathKey(entry.sourceFile), entry.method.symbol ?? entry.method.name, entry.method.exportedVia));
      }
      const key = bodyKey(pathKey(entry.sourceFile), entry.method.symbol ?? entry.method.name, entry.method.exportedVia);
      const refs = claimsByBody.get(key) ?? new Set<string>();
      for (const claim of claimsOf(entry.method)) refs.add(`${claim.component}.${claim.method}`);
      claimsByBody.set(key, refs);
    }

    for (const entry of methods) {
      const { implementation: impl, method: implMethod, component, sourceFile: file } = entry;
      const tier = implMethod.conformance ?? impl.conformance ?? defaultConformanceTier(component);
      if (tier === 'off') continue;
      // A method that claims no call is not this rule's subject in either
      // direction: nothing to prove forward, and nothing it could have failed
      // to declare. What it does NOT say is UNUSED_*'s subject, not this
      // rule's — a method silent about its calls is judged by what its
      // component's collaborators go unreached by, and accusing it here of
      // hiding a colocated call would be this rule judging the detail dial.
      if (!implMethod.narrative.length && !implMethod.calls?.length) continue;

      // The realized function lives in the method's own source file: its
      // sourcePath, else the implementation's. Exact grade only.
      if (!file) continue;
      const facts = code.factsAt(file);
      if (!facts || facts.status !== 'analyzed' || facts.analysisGrade !== 'exact') continue;

      const here = pathKey(file);
      const fnSymbol = implMethod.symbol ?? implMethod.name;
      const colocated = modelledAt.get(here) ?? { byKey: new Map<string, Owner>(), byName: new Map<string, Owner>() };
      // Which modelled method a site reaches: the one anchored to the body it
      // resolved to in THIS file, else, where the code does not settle the
      // body (or the site was read in another file), whichever is anchored
      // under the bare name, as before.
      const ownerOf = (site: CallSiteFact, bodyKey: string | undefined): Owner | undefined => {
        const inHere = pathKey(site.from ?? here) === here;
        if (inHere && bodyKey !== undefined && !bodyKey.startsWith('*')) return colocated.byKey.get(bodyKey);
        return colocated.byName.get(site.name);
      };
      // The two directions close over different walks, and the difference is
      // doctrine rather than reuse. Forward closes over EVERYTHING the
      // function reaches: a wider callee set can only accept more, and a step
      // realized through a neighbour's method is still realized. The converse
      // stops AT a colocated modelled method, because what that method goes on
      // to call belongs to its own narrative, not to this caller's.
      const sites = closedCallSites(code, file, fnSymbol, undefined, implMethod.exportedVia);
      // The realized function has no body here: UNREALIZED_METHOD's find when
      // the name is absent altogether, METHOD_BODY_NOT_FOUND's when it is a
      // bodyless declaration. Either way, not ours.
      if (!sites) continue;

      // What the type checker says the function's bodies reach: its own
      // symbol and the same-file helpers the shape walk follows, every call
      // and reference written in them, and what unowned code they call goes
      // on to call. Where the checker read the file, a claim it lands on is
      // realized whatever the receiver's spelling — a barrel, a port declared
      // in a shared module, a dependency bag typed inline — and the shape
      // tier is left only to accept what it can on its own.
      const resolvedCalls = facts.resolvedCalls;
      const forwardBodies = new Set<string>([fnSymbol]);
      for (const site of sites) {
        if (pathKey(site.from ?? here) === here && (!site.member || site.enclosingClass)) forwardBodies.add(site.name);
      }
      // The function's own body is the ONE its anchor means, told apart from
      // a same-named neighbour (a class member beside the module function)
      // exactly as bodySitesOf tells them apart; a helper is read by name.
      const ownKey = bodySitesOf(facts, fnSymbol, implMethod.exportedVia)?.key;
      const inOwnBody = (c: ResolvedCallFact): boolean => {
        if (ownKey === undefined || ownKey.startsWith('*')) return true;
        if (ownKey === fnSymbol) return c.enclosingContainer === undefined;
        return c.enclosingContainer === ownKey.slice(0, ownKey.length - fnSymbol.length - 1);
      };
      const forwardReach = resolvedCalls
        ? reach(resolvedCalls.filter(c => c.enclosing !== undefined
          && (c.enclosing === fnSymbol ? inOwnBody(c) : forwardBodies.has(c.enclosing))), here)
        : [];

      // ---- forward: every claimed call realized by a resolving call -------
      const missed: MissedClaim[] = [];
      const plannedClaims: MissedClaim[] = [];
      /** The undeclared members of a component's class a missed claim already names. */
      const hinted = new Set<string>();
      for (const claim of claimsOf(implMethod)) {
        // A target this tree does not contain is cross-tree-references'
        // finding (and surface-reference-backing's once it resolves).
        if (!ctx.componentMap.has(claim.component)) continue;
        // An Adapter's call on a verb of a Portal reached over an out-of-process
        // transport (HTTP, gRPC, a database, a bus, a CLI…) is the LINK the
        // design models: what realizes it is the transport client the Adapter
        // drives, never a call into the remote Portal's source file — so it is
        // never resolved to that file, and never reported. The caller's own
        // call to the Adapter stays checked like any other.
        if (isRemoteLink(component, ctx.componentMap.get(claim.component)!)) continue;

        const target = resolveCallTarget(ctx, claim.component, claim.method);

        // N:1 identity forwarding: when the caller's realized function IS the
        // target's — the same body in the same file — facade and target
        // collapse onto one function and the claim is realized by identity,
        // exactly as Level 1's N:1 sharing blesses. A shared NAME is not
        // identity: a Portal's `checkIn` forwarding to an Orchestrator's
        // `checkIn` in another file is two functions, and accepting the
        // caller's own name as the target's realization is how deleting that
        // forwarding call once passed without a word. So the call is judged
        // like any other, and a target naming no file of its own can prove
        // no identity at all. A declaration earns this exemption on the same
        // terms a step does: the reason is the shape of the CODE, which does
        // not know which way the claim was written.
        if (target.bodies.has(bodyKey(here, fnSymbol, implMethod.exportedVia))) continue;
        // The same identity reached from both ends: the caller and the target
        // each FORWARD to one function written elsewhere — a Portal barrel and
        // the Orchestrator both handing a store's function straight through.
        // One body under several names, each forward a binding the code writes
        // down; a shared NAME with no shared forward is never this.
        const sharedBody = targetForwards(code, target);
        if (code.forwardsOf(file, fnSymbol, implMethod.exportedVia)
          .some(p => p.file !== here && sharedBody.has(`${p.file}#${p.name}`))) continue;
        // The same identity, written as a republication under another name:
        // `export { a as b } from 'm'` makes this file's `b` m's `a`, exactly
        // as the unaliased `export { a } from 'm'` makes its `a` m's `a`. When
        // the realized symbol forwards that way to the target's own file under
        // a name the target is realized by, facade and target are one
        // function and the claim is realized by identity.
        if (isTarget(code.forwardsOf(file, fnSymbol, implMethod.exportedVia), target)) continue;

        const matching = sites.filter(s => target.accepted.has(s.name));
        const ref = `${claim.component}.${claim.method}`;

        // The target names no file of its own (MISSING_SOURCE_PATH reports
        // exactly that), so there is nothing to resolve AGAINST: the claim
        // falls back to the name membership this check has always had.
        if (target.files.size === 0) {
          if (matching.length === 0) {
            missed.push({ step: claim.step, target: ref, accepted: [...target.accepted], miss: { kind: 'absent' } });
          }
          continue;
        }

        // Two tiers, and the difference is the whole of the honesty here.
        // ACCEPTANCE reads everything a call can have reached: `this.store`
        // followed through the type the class declares the field with, and
        // `new Registry(...)` through the module its class name came from. A
        // LANDING a finding may name comes from the proven tier alone — a
        // declared type says what a collaborator is, not which class ships the
        // body, and a constructed class says where the class was written, not
        // where a method it inherits was — so widening what a call reached can
        // only ever accept a claim: it must never turn "I cannot say" into an
        // accusation.
        // A call spelled with a republished name — `b()` imported from a module
        // that republishes m's `a` as `b` — lands where m.a lives. It is
        // realized on the proven tier: an import binding and a chain of
        // re-exports the code writes down.
        if (sites.some(s => !target.accepted.has(s.name) && isTarget(invokedAs(code, s, file), target))) continue;

        // The type checker's landing: the target's own (file, name), an
        // implementor of the port the call was typed by, or what the target
        // forwards to by identity — the checker resolves past a re-export to
        // the module that wrote the function.
        const forwards = targetForwards(code, target);
        const lands = (t: CallTargetFact): boolean =>
          (target.files.has(t.path) && target.accepted.has(t.member)) || forwards.has(`${t.path}#${t.member}`);
        if (forwardReach.some(r => r.call.targets.some(lands))) continue;

        const landed = new Set<string>();
        let realized = false;
        for (const site of matching) {
          for (const origin of code.originOf(site, file)) landed.add(origin);
          for (const origin of code.possibleOriginsOf(site, file)) {
            if (target.files.has(origin)) realized = true;
          }
        }
        if (realized) continue;
        // A claim the checker did not land on its target keeps the shape
        // tier's answer: the checker's landing on a declaration says what a
        // receiver is TYPED as (a type literal, an interface no class
        // realizes), never where the call went instead, so it accuses nothing.
        const miss: Miss = matching.length === 0
          ? { kind: 'absent' }
          : landed.size === 0
            ? { kind: 'unresolved', shapes: [...new Set(matching.map(describeSite))].sort() }
            : { kind: 'elsewhere', landed: [...landed].sort() };
        // The call is there by name, through a receiver nothing in the code
        // can land yet, because the target's code is not written: no file
        // any of its implementations names exists. That is the normal state
        // after the first component of a service is implemented from its
        // brief, typed by a port to the collaborator still planned — planned
        // code, said as SOURCE_FILE_PLANNED says it, and judged like any
        // other claim the day the target's realization begins.
        if (miss.kind === 'unresolved' && !targetBegun(claim.component)) {
          plannedClaims.push({ step: claim.step, target: ref, accepted: [...target.accepted], miss, component: claim.component });
          continue;
        }
        // A miss the function answers with a call into the target
        // component's class under a name its contract lacks is said as what
        // it is — the claimed call no longer lands, the component lacks the
        // method — never read through that method's body as the caller's.
        const instead = miss.kind === 'unresolved' ? undefined : forwardReach.find(r => r.into?.component === claim.component)?.call;
        if (instead) hinted.add(`${claim.component}.${instead.name}`);
        missed.push({
          step: claim.step, target: ref, accepted: [...target.accepted], miss,
          ...(instead ? { component: claim.component, instead: { member: instead.name, written: instead.written } } : {}),
        });
      }

      if (plannedClaims.length) {
        ctx.addIssue(
          'notice',
          'CALL_TARGET_PLANNED',
          `Method "${implMethod.name}" in implementation "${impl.id}": ${plannedClaims.length} ${claimNoun(implMethod)} reach a component whose code is not written yet — ${plannedClaims.map(m => `${describeMiss(m)}; ${m.component} plans ${plannedFilesOf(m.component!)}`).join('; ')}. The call is in "${fnSymbol}" in "${file}" by name, through a receiver nothing written yet realizes (a port to the planned collaborator): planned, not missing. It is judged like any other claim once the target's realization begins.`,
          impl.id,
          entry.draftContext,
          undefined,
          { at: implMethod.name, covers: plannedClaims.map(unitOf) },
        );
      }
      const unrealized = missed.filter(m => m.miss.kind !== 'unresolved');
      const unresolved = missed.filter(m => m.miss.kind === 'unresolved');
      if (unrealized.length) {
        ctx.addIssue(
          'warning',
          'CALL_STEP_UNREALIZED',
          `Method "${implMethod.name}" in implementation "${impl.id}": ${unrealized.length} ${claimNoun(implMethod)} are realized by no call of the function "${fnSymbol}" in "${file}" that resolves to the target's own source file — ${unrealized.map(describeMiss).join('; ')}. Callees are closed over the named helpers the function calls, and each call site is resolved through this file's import bindings (order, arguments and conditions are not checked). Realize the calls, fix what the method claims, or map code names via per-method symbols on the targets.`,
          impl.id,
          entry.draftContext,
          undefined,
          // One claim, named the way the register names a unit: a step by its
          // number and target, a declaration by its target alone. What the
          // register carries is ONE unrealized claim, never "this method's
          // calls".
          { at: implMethod.name, covers: unrealized.map(unitOf) },
        );
      }
      if (unresolved.length) {
        ctx.addIssue(
          'warning',
          'CALL_ORIGIN_UNRESOLVED',
          // The sites, and what the answer means — once. Which receiver
          // forms resolve is the code's summary and the rule's description
          // (`wairon rules list`), not prose every finding repeats.
          `Method "${implMethod.name}" in implementation "${impl.id}": ${unresolved.length} ${claimNoun(implMethod)} not checked — called by name inside "${fnSymbol}" in "${file}", but only through receivers this analysis cannot resolve to a file: ${unresolved.map(describeMiss).join('; ')}. Neither proven realized nor accused; the receiver forms that do resolve are listed under CALL_ORIGIN_UNRESOLVED in \`wairon rules list\`.`,
          impl.id,
          entry.draftContext,
          undefined,
          { at: implMethod.name, covers: unresolved.map(unitOf) },
        );
      }

      // ---- converse: colocated calls the method never claimed -------------
      // Every way the method names a target counts as claiming it: a call,
      // dispatch or register step, and an entry of its declared `calls`. A
      // dispatch or register step is no claim about a CALL SITE — nothing
      // forward asks of it — but it does name the target out loud, and the
      // converse direction's whole question is whether the boundary hop is
      // written down somewhere a reader will find it.
      const declared = new Set<string>();
      for (const step of implMethod.narrative) {
        if (step.targetComponent && step.targetMethod) declared.add(`${step.targetComponent}.${step.targetMethod}`);
      }
      for (const ref of implMethod.calls ?? []) {
        const parsed = parseDeclaredCall(ref);
        if (parsed) declared.add(`${parsed.compId}.${parsed.methodName}`);
      }
      const crossings = new Map<string, string>();
      const reached = new Map<CallSiteFact, Owner | undefined>();
      const stopAtModelled = (site: CallSiteFact, bodyKey: string | undefined): boolean => {
        const owner = ownerOf(site, bodyKey);
        reached.set(site, owner);
        return owner !== undefined;
      };
      // A function that forwards by identity to a modelled method written in
      // ANOTHER file is that method: the body read here was carried across
      // the forwarding, and what it calls is that method's narrative's
      // subject, exactly as the walk stops AT a colocated modelled method.
      const forwardsToModelled = code.forwardsOf(file, fnSymbol, implMethod.exportedVia)
        .some(p => p.file !== here && modelledAt.get(p.file)?.byName.has(p.name));
      const conversed = forwardsToModelled ? [] : closedCallSites(code, file, fnSymbol, stopAtModelled, implMethod.exportedVia) ?? [];
      for (const site of conversed) {
        const owner = reached.get(site);
        if (!owner || owner.component === component.id) continue;
        const ref = `${owner.component}.${owner.method}`;
        if (declared.has(ref) || crossings.has(ref)) continue;
        // Only a call this analysis RESOLVES to this very file is a colocated
        // crossing. A same-named function reached through a value or through
        // an import is somebody else's, and a private helper is no modelled
        // method at all — so a rule's internal factoring is never a finding.
        if (!code.originOf(site, file).has(here)) continue;
        crossings.set(ref, site.name);
      }
      if (crossings.size) {
        const detail = [...crossings].map(([ref, name]) => `"${name}" (${ref})`).join('; ');
        ctx.addIssue(
          'warning',
          'UNDECLARED_COLOCATED_CALL',
          `Method "${implMethod.name}" in implementation "${impl.id}": the function "${fnSymbol}" in "${file}" calls ${crossings.size} modelled method(s) of OTHER components living in that same file, and neither a narrative step nor a declared call names it — ${detail}. Sharing a file does not make the hop internal: it crosses a component boundary nothing imports, so no file-level check can see it. Narrate the call, declare it in \`calls\`, or move the code so the boundary is real.`,
          impl.id,
          entry.draftContext,
          undefined,
          // The crossings themselves. Keyed by method alone, a 24th crossing
          // would ride into a register entry written for 23 - so each one is
          // named, and one nobody carried fires on the day it appears.
          { at: implMethod.name, covers: [...crossings.keys()] },
        );
      }

      // ---- converse, across files: writes the method never claimed --------
      // A mutation reached in another file is visible to Level 2 only as a
      // declared edge, which says nothing about WHICH methods change state.
      // Only the type checker's answer is read here: an accusation needs the
      // call's landing proven, not a receiver followed by its spelling.
      if (resolvedCalls && !forwardsToModelled) {
        // The bodies this method's function reaches in its own file, stopping
        // AT a colocated modelled method exactly as the colocated direction
        // does: what that method goes on to call is its own narrative's.
        const bodies = new Set<string>([fnSymbol]);
        for (const site of conversed) {
          if (reached.get(site) !== undefined) continue;
          if (pathKey(site.from ?? here) === here && (!site.member || site.enclosingClass)) bodies.add(site.name);
        }
        // What the method's claims land on in code: each claimed target's own
        // (file, name), and what it forwards to by identity — an Adapter that
        // re-exports its provider's function is called under the Adapter's
        // claim, while the checker resolves the call past it to the provider.
        const claimed = new Set<string>();
        const sameBody = claimsByBody.get(bodyKey(here, fnSymbol, implMethod.exportedVia)) ?? new Set<string>();
        for (const ref of new Set([...declared, ...sameBody])) {
          const parsed = parseDeclaredCall(ref);
          if (!parsed || !ctx.componentMap.has(parsed.compId)) continue;
          const target = resolveCallTarget(ctx, parsed.compId, parsed.methodName);
          for (const file of target.files) for (const name of target.accepted) claimed.add(`${file}#${name}`);
          for (const forwarded of targetForwards(code, target)) claimed.add(forwarded);
        }
        const unclaimed = (ref: string): boolean => !declared.has(ref) && !sameBody.has(ref);
        // A Portal method realized by the SAME body as another component's
        // modelled method (N:1 identity) is that component's code: what it
        // dispatches to answers to that component's narrative.
        const portalOwnBody = component.componentType === 'Portal'
          && !sharedBodies.has(bodyKey(here, fnSymbol, implMethod.exportedVia));
        /**
         * What a call into a component settles state through: a write- or
         * lifecycle-effect contract method of any component; and, from a
         * Portal, a verb of a workflow component (Orchestrator, Supervisor,
         * Actor) whose effect is not declared read or none — a Portal changes
         * state only by dispatching to such a verb, so its narrative is the
         * list of the ones it may reach.
         */
        const mutatorOf = (callee: ComponentSpec, member: string): { method: string; effect: 'write' | 'unknown' } | undefined => {
          const written = writeMethodOf(callee.id, member);
          if (written) return { method: written, effect: 'write' };
          if (!portalOwnBody || !WORKFLOW_COMPONENTS.has(callee.componentType)) return undefined;
          const verb = contractMethodOf(callee.id, member);
          if (!verb) return undefined;
          const effect = verbEffect(callee.id, verb.name);
          return effect === 'read' ? undefined : { method: verb.name, effect };
        };
        const writes = new Map<string, string>();
        /** Portal calls to workflow verbs whose effect neither the contract nor the verb's narrative settles. */
        const undecided = new Map<string, string>();
        const unresolvedWrites = new Map<string, string>();
        /** Portal calls to members of a workflow component's class that its contract does not declare. */
        const undeclaredMembers = new Map<string, string>();
        const own = resolvedCalls.filter(call => call.enclosing !== undefined && bodies.has(call.enclosing));
        for (const { call, through, into } of reach(own, here)) {
          if (call.targets.some(t => claimed.has(`${t.path}#${t.member}`))) continue;
          // A Portal calling a member of a workflow component's class that
          // its contract does not declare: the component's code, under a name
          // the design never gave it — said as that, never read through its
          // body as the Portal's own write. A rename a missed claim already
          // names is that finding's.
          if (into && portalOwnBody) {
            const ref = `${into.component}.${into.member}`;
            if (!hinted.has(ref) && unclaimed(ref) && !undeclaredMembers.has(ref)) {
              undeclaredMembers.set(ref, `${call.reference ? `\`${call.written}\` (taken as a value)` : `\`${call.written}(…)\``}${throughText(through)}`);
            }
          }
          for (const target of call.targets) {
            // A same-file target is the colocated direction's subject.
            if (target.path === here) continue;
            for (const callee of realization.componentsAt(target.path)) {
              if (callee.id === component.id) continue;
              if (component.componentType === 'Portal' && DATA_COMPONENTS.has(callee.componentType)) continue;
              if (isRemoteLink(component, callee)) continue;
              const mutator = mutatorOf(callee, target.member);
              if (!mutator) continue;
              const written = mutator.method;
              // A MODULE function (no container) is never a method the callee
              // reaches through an exportedVia handle: in a shared file the
              // same-named object member is another body.
              if (target.container === undefined && realization.implementationsOf(callee.id)
                .some(impl => impl.methods.find(m => m.name === written)?.exportedVia !== undefined)) continue;
              const ref = `${callee.id}.${written}`;
              if (!unclaimed(ref) || writes.has(ref) || undecided.has(ref)) continue;
              const as = `${call.reference ? `\`${call.written}\` (taken as a value)` : `\`${call.written}(…)\``}${throughText(through)}`;
              (mutator.effect === 'unknown' ? undecided : writes).set(ref, as);
            }
          }
          // The fail-closed half: a call the checker could not follow, under
          // the name of a write another component's contract carries, that
          // this method claims nowhere. Neither proven nor cleared.
          if (call.unresolved) {
            for (const ref of unresolvedCandidates(call, component)) {
              if (!unclaimed(ref) || unresolvedWrites.has(ref)) continue;
              unresolvedWrites.set(ref, `\`${call.written}(…)\`${throughText(through)}`);
            }
          }
        }
        if (writes.size || undecided.size || undeclaredMembers.size) {
          // A change of state the design settles (a declared effect, or one
          // the verb's own narrative reaches) is said as one; a workflow verb
          // whose effect nothing settles is said as exactly that — an
          // unnarrated call — never presumed a write.
          const parts: string[] = [];
          if (writes.size) {
            parts.push(`calls ${writes.size} method(s) of other components that change state — a write- or lifecycle-effect method, or from a Portal a workflow verb whose effect, declared or read off its own narrative, is a write — and neither a narrative step nor a declared call names it — ${[...writes].map(([ref, written]) => `${ref} (${written})`).join('; ')}. The code changes state the design says this method never touches`);
          }
          if (undecided.size) {
            parts.push(`${writes.size ? 'and it makes' : 'makes'} ${undecided.size} unnarrated call(s) to a workflow verb whose effect is undeclared and that no narrative of its own settles — ${[...undecided].map(([ref, written]) => `unnarrated call to ${ref} (effect undeclared) (${written})`).join('; ')}. Declare the verb's effect (read or none when it changes nothing), or narrate it`);
          }
          if (undeclaredMembers.size) {
            parts.push(`${writes.size || undecided.size ? 'and it calls' : 'calls'} ${undeclaredMembers.size} method(s) of a workflow component's code that its contract does not declare — ${[...undeclaredMembers].map(([ref, written]) => `${ref} (${written})`).join('; ')}. What such a method does is no narrative's subject, so its effect is unknown: declare it on the component's contract and narrate the call, or call a method the contract declares`);
          }
          ctx.addIssue(
            'warning',
            'UNDECLARED_WRITE_CALL',
            `Method "${implMethod.name}" in implementation "${impl.id}": the function "${fnSymbol}" in "${file}" ${parts.join('; ')}. Narrate the call, declare it in \`calls\`, or remove it.`,
            impl.id,
            entry.draftContext,
            undefined,
            { at: implMethod.name, covers: [...writes.keys(), ...undecided.keys(), ...undeclaredMembers.keys()] },
          );
        }
        if (unresolvedWrites.size) {
          const detail = [...unresolvedWrites].map(([ref, written]) => `${ref} (${written})`).join('; ');
          ctx.addIssue(
            'warning',
            'CALL_ORIGIN_UNRESOLVED',
            `Method "${implMethod.name}" in implementation "${impl.id}": the function "${fnSymbol}" in "${file}" makes ${unresolvedWrites.size} call(s) through a receiver this analysis cannot follow (typed any or unknown, cast to either or to an index signature, or a computed key), under the name of a write no narrative step or declared call of the method names — ${detail}. Neither proven an unnarrated write nor cleared, so it fails closed: give the receiver its declared type so the call can be judged.`,
            impl.id,
            entry.draftContext,
            undefined,
            { at: implMethod.name, covers: [...unresolvedWrites.keys()] },
          );
        }
      }
    }
  },
};
