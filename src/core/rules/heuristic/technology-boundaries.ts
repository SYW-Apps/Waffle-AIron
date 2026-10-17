import { SddRule } from '../types.js';
import {
  implementationSourceFiles, isDraftSubsystem, technologyName, technologyTokens,
  type ComponentSpec, type ImplementationSpec, type MethodSignature,
} from '../../../models/index.js';

/**
 * Technology-boundary rules: an L4 that declares `technologies` (e.g.
 * ["mysql"]) makes its component's ownership tree the technology's home.
 * The rest of the system may only know the boundary's intent interface —
 * that is what makes the implementation swappable (mysql → postgresql)
 * without contract change. No hardcoded vendor lists: only declared tokens
 * are policed, so the rule never fires on a tree that doesn't opt in. WHICH
 * stereotype may bind one at all is technology-binding's question.
 *
 * A technology is matched by its name, unless it declares `matches`: a
 * package named after an ordinary word of the tree (the `yaml` package and
 * the YAML format every spec names) would otherwise report every mention of
 * that word as leaked vendor text. Its declared tokens are then the only ones
 * policed, and the name is only the label findings carry.
 */

/**
 * Identifier-aware matcher for one technology token. The token normalizes to
 * its fused alphanumeric form ("js-yaml" → "jsyaml"); text splits into
 * alphanumeric words. Single-part tokens hit when a word contains them
 * ("MySqlCustomerStore" hits "mysql"; "my sql notes" does not). Multi-part
 * tokens additionally hit when that many CONSECUTIVE words fuse to contain
 * them, so prose "Google Sheets" / "google-sheets" hits token
 * "google-sheets". Returns null for tokens under 3 chars — too noisy to
 * police.
 */
function makeMatcher(tech: string): ((text: string | undefined | null) => boolean) | null {
  const parts = tech.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const joined = parts.join('');
  if (joined.length < 3) return null;
  const n = parts.length;
  return (text) => {
    if (!text) return false;
    const words = text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
    if (words.some(w => w.includes(joined))) return true;
    if (n < 2) return false;
    for (let i = 0; i + n <= words.length; i++) {
      if (words.slice(i, i + n).join('').includes(joined)) return true;
    }
    return false;
  };
}

/** An empty home for one technology: it matches a text when any matcher added to it later does. */
function newHome(label: string): TechHome {
  const home: TechHome = {
    label,
    matchers: [],
    match: (text) => home.matchers.some((m) => m(text)),
    ownerComponents: new Set<string>(),
    scope: new Set<string>(),
  };
  return home;
}

/** The identifier surfaces of a contract method (prose descriptions excluded). */
function contractIdentifiers(m: MethodSignature): string {
  const parts: string[] = [m.name, m.signature, m.returns];
  for (const p of m.params ?? []) parts.push(p.name, p.type);
  if (m.endpoint) parts.push(Object.values(m.endpoint).map(String).join(' '));
  return parts.join(' ');
}

/**
 * The stereotypes that may bind a technology at all (technology-binding's
 * DATA_LAYER). Their PROSE naming a technology describes their own
 * realization — "in memory now, Redis later" — which is no binding and no
 * leak; their identifiers still are.
 */
const SEAMS = new Set(['Adapter', 'Store', 'Registry', 'Index', 'Observer']);

/** One technology an implementation declares — its name and the tokens it is matched by — with the declaring component. */
interface TechDeclaration {
  comp: ComponentSpec;
  name: string;
  tokens: string[];
}

/** The scope one technology is at home in, the matchers of its tokens, and who declared it. */
interface TechHome {
  label: string;
  matchers: ((text: string | undefined | null) => boolean)[];
  match: (text: string | undefined | null) => boolean;
  ownerComponents: Set<string>;
  scope: Set<string>;
}

export const technologyRule: SddRule = {
  name: 'technology-boundaries',
  judges: 'design',
  description:
    "Technology stays behind its owning boundary: an L4 that declares `technologies` (e.g. [mysql]) makes its component's ownership tree the technology's home. References outside that tree are leakage, and L3 contract identifiers must stay intent-language — the contract is the swap seam, so the vendor name is wrong even on the owning component's own interface. A word in prose is not a binding: the PROSE of a technology seam (an Adapter, Store, Registry or Index, or an Observer subscribing to a messaging technology — the stereotypes that may bind a technology at all) — its component description, its contract's descriptions and its implementations' descriptions, intents and step prose — names the technology about its own realization (\"in memory now, Redis later\"), so it is not leakage; its identifiers (id, name, dependsOn, owns, basePath, a step's call target, a source file) still are, and every surface of any other stereotype still is. A technology is matched by its name, or — when it declares `matches` because its name is also an ordinary word of the tree (a package named after the file format it reads) — by those tokens alone. Two declarations of one technology are one home whichever notation each is written in: a component binding it as a bare name and one binding it as `{name, matches}` are both inside it, even when one form's tokens police nothing.",
  codes: [
    { code: 'TECH_LEAKAGE', defaultSeverity: 'warning', summary: 'Technology referenced outside its owning boundary' },
    { code: 'VENDOR_NAME_IN_CONTRACT', defaultSeverity: 'warning', summary: 'Technology name in L3 contract identifiers' },
  ],
  check(ctx) {
    // -- ownership helpers ----------------------------------------------------
    // A PLAIN owner map: every `owns` claim, last claimant winning, including
    // the ones pattern-membership reports as illegal. ctx.ownershipIndex()
    // reads only LEGAL claims, and swapping this for it would widen a home's
    // scope on a tree that already carries an ownership error — turning one
    // finding into two. That is a doctrine decision, not a refactor.
    const ownerOf = new Map<string, string>();
    for (const c of ctx.components) for (const m of c.owns) ownerOf.set(m, c.id);

    const ownershipRoot = (id: string): string => {
      const seen = new Set<string>();
      let cur = id;
      while (ownerOf.has(cur) && !seen.has(cur)) {
        seen.add(cur);
        cur = ownerOf.get(cur)!;
      }
      return cur;
    };

    const ownsClosure = (rootId: string): Set<string> => {
      const out = new Set<string>([rootId]);
      const queue = [rootId];
      while (queue.length) {
        const c = ctx.componentMap.get(queue.shift()!);
        for (const m of c?.owns ?? []) {
          if (!out.has(m)) { out.add(m); queue.push(m); }
        }
      }
      return out;
    };

    // -- collect declarations → per-technology owning scopes -------------------
    // Every declared technology, paired with the component that declares it: a
    // dangling contract declares nothing (the hierarchy rule reports it).
    const declarations: TechDeclaration[] = [];
    for (const impl of ctx.implementations) {
      if (!impl.technologies?.length) continue;
      const intf = ctx.interfaceMap.get(impl.contract);
      const comp = intf ? ctx.componentMap.get(intf.component) : undefined;
      if (!comp) continue;
      for (const tech of impl.technologies) {
        declarations.push({ comp, name: technologyName(tech), tokens: technologyTokens(tech) });
      }
    }

    // The owning scope of a declaring component: the whole ownership tree
    // containing it (pattern root + members), those components' contracts and
    // implementations, and the ancestor subsystem chain. Memoized, because a
    // component that declares several tokens has one scope.
    const scopes = new Map<string, Set<string>>();
    const scopeOf = (comp: ComponentSpec): Set<string> => {
      const cached = scopes.get(comp.id);
      if (cached) return cached;
      const compSet = ownsClosure(ownershipRoot(comp.id));
      const scope = new Set<string>(compSet);
      for (const i of ctx.interfaces) if (compSet.has(i.component)) scope.add(i.id);
      for (const im of ctx.implementations) {
        const owner = ctx.interfaceMap.get(im.contract)?.component;
        if (owner && compSet.has(owner)) scope.add(im.id);
      }
      for (const cid of compSet) {
        const subId = ctx.componentMap.get(cid)?.subsystem;
        if (!subId) continue;
        for (const s of ctx.subsystems) {
          if (subId === s.id || subId.startsWith(`${s.id}::`)) scope.add(s.id);
        }
      }
      scopes.set(comp.id, scope);
      return scope;
    };

    // Keyed by the technology's NAME, so two declarations of one technology
    // share a home whichever tokens each declares; a home matches a text when
    // any of its tokens does.
    const homes = new Map<string, TechHome>();
    for (const { comp, name, tokens } of declarations) {
      // A declaration whose tokens police nothing (a 2-letter package name)
      // still puts its component INSIDE the technology's home: a bare name and
      // `{name, matches}` are one technology whichever form each is written in.
      const matchers = tokens.map(makeMatcher).filter((m): m is NonNullable<typeof m> => m !== null);
      const key = name.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).join('');
      const home = homes.get(key) ?? newHome(name);
      home.matchers.push(...matchers);
      home.ownerComponents.add(comp.id);
      for (const id of scopeOf(comp)) home.scope.add(id);
      homes.set(key, home);
    }
    // A home none of whose declarations brought a policeable token cannot be
    // matched without drowning in noise.
    for (const [key, home] of homes) if (home.matchers.length === 0) homes.delete(key);
    if (homes.size === 0) return;

    const ownersDesc = (h: TechHome): string => [...h.ownerComponents].map(c => `"${c}"`).join(', ');
    // A word in a seam's prose is not a binding (see SEAMS).
    const isSeam = (componentId: string | undefined): boolean =>
      componentId !== undefined && SEAMS.has(ctx.componentMap.get(componentId)?.componentType ?? '');

    for (const home of homes.values()) {
      // L3 identifier surfaces — ALL interfaces, including the owning
      // component's own: the contract is the swap seam, so the vendor name
      // is wrong even there. (Prose descriptions inside the owning scope may
      // name the tech — that is honest documentation, not coupling.)
      for (const intf of ctx.interfaces) {
        const offending = intf.methods.filter(m => home.match(contractIdentifiers(m))).map(m => m.name);
        if (offending.length) {
          ctx.addIssue(
            'warning',
            'VENDOR_NAME_IN_CONTRACT',
            `Interface "${intf.id}" exposes technology "${home.label}" in contract identifiers (method${offending.length > 1 ? 's' : ''}: ${offending.join(', ')}). Name the intent, not the vendor — the technology is owned by component ${ownersDesc(home)} and must stay swappable behind this contract.`,
            intf.id,
            ctx.isComponentDraft(intf.component) || intf.status === 'draft' || intf.status === 'design',
          );
        }
      }

      // Leakage — every spec outside the owning scope, all text surfaces.
      for (const comp of ctx.components) {
        if (home.scope.has(comp.id)) continue;
        const surfaces: [string, string | undefined][] = [
          ['id/name', `${comp.id} ${comp.name}`],
          ['description', isSeam(comp.id) ? undefined : comp.description],
          ['dependsOn', comp.dependsOn.join(' ')],
          ['owns', comp.owns.join(' ')],
          ['basePath', comp.basePath],
        ];
        const found = surfaces.filter(([, t]) => home.match(t)).map(([s]) => s);
        if (found.length) {
          ctx.addIssue(
            'warning',
            'TECH_LEAKAGE',
            `Component "${comp.id}" references "${home.label}" (${found.join(', ')}) outside its owning boundary — the technology lives behind component ${ownersDesc(home)}. Route through that boundary's intent interface.`,
            comp.id,
            ctx.isComponentDraft(comp.id),
          );
        }
      }

      for (const sub of ctx.subsystems) {
        if (home.scope.has(sub.id)) continue;
        if (home.match(`${sub.id} ${sub.name} ${sub.description}`)) {
          ctx.addIssue(
            'warning',
            'TECH_LEAKAGE',
            `Subsystem "${sub.id}" references "${home.label}" outside the technology's owning boundary (component ${ownersDesc(home)}).`,
            sub.id,
            isDraftSubsystem(sub),
          );
        }
      }

      for (const intf of ctx.interfaces) {
        if (home.scope.has(intf.id) || isSeam(intf.component)) continue;
        const prose = [intf.description, ...intf.methods.map(m => m.description)].join(' ');
        if (home.match(prose)) {
          ctx.addIssue(
            'warning',
            'TECH_LEAKAGE',
            `Interface "${intf.id}" describes "${home.label}" outside its owning boundary (component ${ownersDesc(home)}) — consumers must not know backend specifics.`,
            intf.id,
            ctx.isComponentDraft(intf.component) || intf.status === 'draft' || intf.status === 'design',
          );
        }
      }

      for (const impl of ctx.implementations) {
        if (home.scope.has(impl.id)) continue;
        if (home.match(implementationText(impl, !isSeam(ctx.interfaceMap.get(impl.contract)?.component)))) {
          ctx.addIssue(
            'warning',
            'TECH_LEAKAGE',
            `Implementation "${impl.id}" references "${home.label}" outside its owning boundary — call the intent interface of component ${ownersDesc(home)} instead of naming its technology.`,
            impl.id,
            ctx.isImplementationDraft(impl),
          );
        }
      }

      // Types are shared data space — vendor-specific shapes don't belong in
      // it at all, so every type is scanned (there is no owning exemption).
      for (const t of ctx.types) {
        const parts: string[] = [t.id, t.name, t.description ?? ''];
        for (const f of t.fields ?? []) parts.push(f.name, f.type);
        for (const m of t.methods ?? []) parts.push(m.name, m.signature, m.returns);
        if (home.match(parts.join(' '))) {
          ctx.addIssue(
            'warning',
            'TECH_LEAKAGE',
            `Type "${t.id}" carries technology "${home.label}" in the shared type space — vendor-specific shapes belong inside the owning boundary (component ${ownersDesc(home)}), or the type should be renamed to its intent.`,
            t.id,
          );
        }
      }
    }
  },
};

/**
 * The text surfaces of an implementation: its files and every narrative step's
 * call target, and — with `prose` — its own description, its methods' intents
 * and every step's prose fields (a seam's implementation passes false).
 */
function implementationText(impl: ImplementationSpec, prose: boolean): string {
  const parts: (string | undefined)[] = [...implementationSourceFiles(impl)];
  if (prose) parts.push(impl.description);
  for (const m of impl.methods) {
    if (prose) parts.push(m.intent);
    for (const s of m.narrative ?? []) {
      parts.push(s.targetComponent, s.targetMethod);
      if (!prose) continue;
      parts.push(s.description, s.condition, s.over, s.on, s.outcome, s.error);
      for (const c of s.cases ?? []) parts.push(c.value);
      for (const c of s.catches ?? []) parts.push(c.error);
    }
  }
  return parts.filter(Boolean).join(' ');
}
