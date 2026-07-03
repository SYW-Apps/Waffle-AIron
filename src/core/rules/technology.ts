import { SddRule } from './types.js';
import type { MethodSignature } from '../../models/index.js';

/**
 * Technology-boundary rules: an L4 that declares `technologies` (e.g.
 * ["mysql"]) makes its component's ownership tree the technology's home.
 * The rest of the system may only know the boundary's intent interface —
 * that is what makes the implementation swappable (mysql → postgresql)
 * without contract change. No hardcoded vendor lists: only declared tokens
 * are policed, so the rule never fires on a tree that doesn't opt in.
 */

/** Stereotypes that may legitimately bind a technology directly. */
const DATA_LAYER = new Set(['Adapter', 'Store', 'Registry', 'Index']);

/** "js-yaml" → "jsyaml". Tokens shorter than 3 chars are too noisy to police. */
function normalizeTech(tech: string): string {
  return tech.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).join('');
}

/**
 * Identifier-aware containment: the text splits into alphanumeric words and
 * a word containing the token is a hit — so "MySqlCustomerStore" hits
 * "mysql" but "my sql notes" does not.
 */
function hits(text: string | undefined | null, token: string): boolean {
  if (!text) return false;
  return text.toLowerCase().split(/[^a-z0-9]+/).some(w => w.length > 0 && w.includes(token));
}

/** The identifier surfaces of a contract method (prose descriptions excluded). */
function contractIdentifiers(m: MethodSignature): string {
  const parts: string[] = [m.name, m.signature, m.returns];
  for (const p of m.params ?? []) parts.push(p.name, p.type);
  if (m.endpoint) parts.push(Object.values(m.endpoint).map(String).join(' '));
  return parts.join(' ');
}

export const technologyRule: SddRule = {
  name: 'technology-boundaries',
  description:
    'Technology stays behind its owning boundary: an L4 that declares `technologies` (e.g. [mysql]) makes its component\'s ownership tree the technology\'s home. References outside that tree are leakage, L3 contract identifiers must stay intent-language (the contract is the swap seam), and only data-layer stereotypes (Adapter/Store/Registry/Index) should bind a technology directly.',
  codes: [
    { code: 'TECH_LEAKAGE', defaultSeverity: 'warning', summary: 'Technology referenced outside its owning boundary' },
    { code: 'VENDOR_NAME_IN_CONTRACT', defaultSeverity: 'warning', summary: 'Technology name in L3 contract identifiers' },
    { code: 'TECH_ON_LOGIC_COMPONENT', defaultSeverity: 'warning', summary: 'Technology bound by a non-data-layer stereotype' },
  ],
  check(ctx) {
    // -- ownership helpers ----------------------------------------------------
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

    // -- collect declarations → per-token owning scopes ------------------------
    interface TechHome { label: string; ownerComponents: Set<string>; scope: Set<string> }
    const homes = new Map<string, TechHome>();

    for (const impl of ctx.implementations) {
      if (!impl.technologies?.length) continue;
      const intf = ctx.interfaceMap.get(impl.contract);
      const comp = intf ? ctx.componentMap.get(intf.component) : undefined;
      if (!comp) continue; // dangling contract — the hierarchy rule reports it

      if (!DATA_LAYER.has(comp.componentType)) {
        ctx.addIssue(
          'warning',
          'TECH_ON_LOGIC_COMPONENT',
          `Implementation "${impl.id}" binds technology (${impl.technologies.join(', ')}) on component "${comp.id}" (${comp.componentType}). Technology belongs behind a data-layer seam — extract an Adapter (or Store/Registry/Index) behind an intent interface and let this component depend on that.`,
          impl.id,
          ctx.isComponentDraft(comp.id),
        );
      }

      // The owning scope: the whole ownership tree containing the declaring
      // component (pattern root + members), those components' contracts and
      // implementations, and the ancestor subsystem chain.
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

      for (const tech of impl.technologies) {
        const token = normalizeTech(tech);
        if (token.length < 3) continue; // unpoliceable without drowning in noise
        const home = homes.get(token) ?? { label: tech, ownerComponents: new Set<string>(), scope: new Set<string>() };
        home.ownerComponents.add(comp.id);
        for (const id of scope) home.scope.add(id);
        homes.set(token, home);
      }
    }
    if (homes.size === 0) return;

    const ownersDesc = (h: TechHome): string => [...h.ownerComponents].map(c => `"${c}"`).join(', ');

    for (const [token, home] of homes) {
      // L3 identifier surfaces — ALL interfaces, including the owning
      // component's own: the contract is the swap seam, so the vendor name
      // is wrong even there. (Prose descriptions inside the owning scope may
      // name the tech — that is honest documentation, not coupling.)
      for (const intf of ctx.interfaces) {
        const offending = intf.methods.filter(m => hits(contractIdentifiers(m), token)).map(m => m.name);
        if (offending.length) {
          ctx.addIssue(
            'warning',
            'VENDOR_NAME_IN_CONTRACT',
            `Interface "${intf.id}" exposes technology "${home.label}" in contract identifiers (method${offending.length > 1 ? 's' : ''}: ${offending.join(', ')}). Name the intent, not the vendor — the technology is owned by component ${ownersDesc(home)} and must stay swappable behind this contract.`,
            intf.id,
            ctx.isComponentDraft(intf.component),
          );
        }
      }

      // Leakage — every spec outside the owning scope, all text surfaces.
      for (const comp of ctx.components) {
        if (home.scope.has(comp.id)) continue;
        const surfaces: [string, string | undefined][] = [
          ['id/name', `${comp.id} ${comp.name}`],
          ['description', comp.description],
          ['dependsOn', comp.dependsOn.join(' ')],
          ['owns', comp.owns.join(' ')],
          ['basePath', comp.basePath],
        ];
        const found = surfaces.filter(([, t]) => hits(t, token)).map(([s]) => s);
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
        if (hits(`${sub.id} ${sub.name} ${sub.description}`, token)) {
          ctx.addIssue(
            'warning',
            'TECH_LEAKAGE',
            `Subsystem "${sub.id}" references "${home.label}" outside the technology's owning boundary (component ${ownersDesc(home)}).`,
            sub.id,
          );
        }
      }

      for (const intf of ctx.interfaces) {
        if (home.scope.has(intf.id)) continue;
        const prose = [intf.description, ...intf.methods.map(m => m.description)].join(' ');
        if (hits(prose, token)) {
          ctx.addIssue(
            'warning',
            'TECH_LEAKAGE',
            `Interface "${intf.id}" describes "${home.label}" outside its owning boundary (component ${ownersDesc(home)}) — consumers must not know backend specifics.`,
            intf.id,
            ctx.isComponentDraft(intf.component),
          );
        }
      }

      for (const impl of ctx.implementations) {
        if (home.scope.has(impl.id)) continue;
        const parts: (string | undefined)[] = [impl.description, impl.sourcePath];
        for (const m of impl.methods) {
          parts.push(m.intent);
          for (const s of m.narrative ?? []) {
            parts.push(s.description, s.targetComponent, s.targetMethod, s.condition, s.over, s.on, s.outcome, s.error);
            for (const c of s.cases ?? []) parts.push(c.value);
            for (const c of s.catches ?? []) parts.push(c.error);
          }
        }
        if (hits(parts.filter(Boolean).join(' '), token)) {
          ctx.addIssue(
            'warning',
            'TECH_LEAKAGE',
            `Implementation "${impl.id}" references "${home.label}" outside its owning boundary — call the intent interface of component ${ownersDesc(home)} instead of naming its technology.`,
            impl.id,
          );
        }
      }

      // Types are shared data space — vendor-specific shapes don't belong in
      // it at all, so every type is scanned (there is no owning exemption).
      for (const t of ctx.types) {
        const parts: string[] = [t.id, t.name, t.description ?? ''];
        for (const f of t.fields ?? []) parts.push(f.name, f.type);
        for (const m of t.methods ?? []) parts.push(m.name, m.signature, m.returns);
        if (hits(parts.join(' '), token)) {
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
