import { ComponentSpec, MethodSignature } from '../../models/index.js';
import { RuleContext, SddRule } from './types.js';
import { methodKey, walkNarrativeGraph, WalkSeed } from './graph.js';

// ---------------------------------------------------------------------------
// Semantic-edge rules: the validator checks not just that referenced things
// exist, but that semantically-required EDGES exist. Four historic blind
// spots close here:
//   1. generic-portal dispatch was invisible to the static walker,
//   2. persistence had no round-trip (write with no boot read-back),
//   3. lifecycle/boot wiring was inexpressible (blanket lint-allows),
//   4. bare-Json seams crossed subsystem boundaries untyped.
// Plus the prose-claim tripwire: durability claims that live only in prose.
// ---------------------------------------------------------------------------

/** Data-layer stereotypes — where persistence/registration claims are structurally realized. */
const DATA_STEREOTYPES = new Set(['Store', 'Registry', 'Index', 'Adapter', 'Repository']);

function interfaceMethodsOf(ctx: RuleContext, compId: string): MethodSignature[] {
  const out: MethodSignature[] = [];
  for (const intf of ctx.interfacesByComponent.get(compId) ?? []) {
    out.push(...intf.methods);
  }
  return out;
}

function componentOfImpl(ctx: RuleContext, implContract: string): ComponentSpec | undefined {
  const contract = ctx.interfaceMap.get(implContract);
  return contract ? ctx.componentMap.get(contract.component) : undefined;
}

// ---------------------------------------------------------------------------
// Dispatch tables — machine-readable capability → component.method maps on
// generic-dispatch Portals, and the dispatch narrative step routed through
// them. Both sides are contract-checked so a capability can no longer exist
// only in prose while its server silently doesn't.
// ---------------------------------------------------------------------------

export const dispatchRule: SddRule = {
  name: 'dispatch-tables',
  description:
    'Portal dispatch tables must bind every capability to an existing component.method inside the portal\'s own subsystem (the portal dispatches inward), with no duplicate capabilities; dispatch narrative steps must route a declared capability through a Portal that actually serves it.',
  codes: [
    { code: 'DISPATCH_ON_NON_PORTAL', defaultSeverity: 'error', summary: 'Dispatch table declared on a component that is not a Portal' },
    { code: 'DUPLICATE_CAPABILITY', defaultSeverity: 'error', summary: 'Capability bound more than once in one dispatch table' },
    { code: 'UNSERVED_CAPABILITY', defaultSeverity: 'error', summary: 'Capability has no existing server (bad table binding, or dispatch step routing a capability the target Portal does not serve)' },
    { code: 'DISPATCH_CROSS_SUBSYSTEM', defaultSeverity: 'error', summary: 'Dispatch binding targets a component outside the portal\'s subsystem' },
    { code: 'UNDECLARED_DISPATCH_TARGET', defaultSeverity: 'error', summary: 'Dispatch binding targets a component the portal does not depend on or own' },
    { code: 'MALFORMED_DISPATCH_STEP', defaultSeverity: 'error', summary: 'Dispatch step missing its capability (targetComponent presence is the contracts rule\'s finding)' },
    { code: 'NARRATIVE_SEMANTIC_UNBACKED', defaultSeverity: 'warning', summary: 'Dispatch step asserts a guarantee the bound capability method does not declare' },
  ],
  check(ctx) {
    // --- table side ---------------------------------------------------------
    for (const comp of ctx.components) {
      if (!comp.dispatch || comp.dispatch.length === 0) continue;
      const isDraftCtx = ctx.isComponentDraft(comp.id);

      if (comp.componentType !== 'Portal') {
        ctx.addIssue(
          'error',
          'DISPATCH_ON_NON_PORTAL',
          `Component "${comp.id}" (${comp.componentType}) declares a dispatch table — capability dispatch is a Portal responsibility (the subsystem's front door routing inward).`,
          comp.id,
          isDraftCtx,
        );
      }

      const seen = new Set<string>();
      for (const b of comp.dispatch) {
        if (seen.has(b.capability)) {
          ctx.addIssue(
            'error',
            'DUPLICATE_CAPABILITY',
            `Dispatch table of "${comp.id}" binds capability "${b.capability}" more than once — runtime routing would be ambiguous.`,
            comp.id,
            isDraftCtx,
          );
        }
        seen.add(b.capability);

        const target = ctx.componentMap.get(b.component);
        if (!target) {
          ctx.addIssue(
            'error',
            'UNSERVED_CAPABILITY',
            `Dispatch table of "${comp.id}" binds capability "${b.capability}" to component "${b.component}", which does not exist — the capability has no server.`,
            comp.id,
            isDraftCtx,
          );
          continue;
        }
        if (!interfaceMethodsOf(ctx, target.id).some(method => method.name === b.method)) {
          ctx.addIssue(
            'error',
            'UNSERVED_CAPABILITY',
            `Dispatch table of "${comp.id}" binds capability "${b.capability}" to "${b.component}.${b.method}", but "${target.id}" declares no such method on any of its interfaces.`,
            comp.id,
            isDraftCtx || ctx.isComponentDraft(target.id),
          );
        }
        if (target.subsystem !== comp.subsystem) {
          ctx.addIssue(
            'error',
            'DISPATCH_CROSS_SUBSYSTEM',
            `Dispatch table of "${comp.id}" (subsystem "${comp.subsystem}") binds capability "${b.capability}" to "${b.component}" in subsystem "${target.subsystem}" — a portal dispatches inward; cross-subsystem hops go local Adapter → remote Portal.`,
            comp.id,
            isDraftCtx || ctx.isComponentDraft(target.id),
          );
        }
        // The table IS a runtime invocation path: declare it, so stereotype
        // and coupling rules see the portal's true fan-out.
        if (target.id !== comp.id && !comp.dependsOn.includes(target.id) && !comp.owns.includes(target.id)) {
          ctx.addIssue(
            'error',
            'UNDECLARED_DISPATCH_TARGET',
            `Dispatch table of "${comp.id}" binds capability "${b.capability}" to "${b.component}", but "${comp.id}" does not list it under dependsOn/owns — the dispatch edge is a real runtime dependency.`,
            comp.id,
            isDraftCtx || ctx.isComponentDraft(target.id),
          );
        }
      }
    }

    // --- step side ----------------------------------------------------------
    for (const impl of ctx.implementations) {
      const isDraftCtx = ctx.isImplementationDraft(impl);

      for (const implMethod of impl.methods) {
        for (const step of implMethod.narrative) {
          if (step.type !== 'dispatch') continue;
          const where = `Method "${implMethod.name}" in implementation "${impl.id}": dispatch step ${step.stepNumber}`;

          if (!step.capability) {
            ctx.addIssue(
              'error',
              'MALFORMED_DISPATCH_STEP',
              `${where} requires "capability" (the routed capability name).`,
              impl.id,
              isDraftCtx,
            );
            continue;
          }
          // Missing/dangling targetComponent is the contracts rule's finding.
          if (!step.targetComponent) continue;
          const portal = ctx.componentMap.get(step.targetComponent);
          if (!portal) continue;

          if (portal.componentType !== 'Portal' || !portal.dispatch || portal.dispatch.length === 0) {
            ctx.addIssue(
              'error',
              'UNSERVED_CAPABILITY',
              `${where} routes capability "${step.capability}" through "${portal.id}", which ${portal.componentType !== 'Portal' ? `is a ${portal.componentType}, not a Portal` : 'declares no dispatch table'} — the capability cannot be resolved to a server.`,
              impl.id,
              isDraftCtx || ctx.isComponentDraft(portal.id),
            );
            continue;
          }

          const binding = portal.dispatch.find(b => b.capability === step.capability);
          if (!binding) {
            ctx.addIssue(
              'error',
              'UNSERVED_CAPABILITY',
              `${where} routes capability "${step.capability}" through "${portal.id}", but that portal's dispatch table does not serve it (declared: ${portal.dispatch.map(b => `"${b.capability}"`).join(', ')}).`,
              impl.id,
              isDraftCtx || ctx.isComponentDraft(portal.id),
            );
            continue;
          }

          // Same consistency check call steps get: a guarantee this step
          // asserts must be declared by the method the capability resolves to.
          if (step.assertsGuarantees?.length) {
            const boundMethod = interfaceMethodsOf(ctx, binding.component).find(m => m.name === binding.method);
            const declared = new Set(boundMethod?.guarantees ?? []);
            for (const g of step.assertsGuarantees) {
              if (!declared.has(g)) {
                ctx.addIssue(
                  'warning',
                  'NARRATIVE_SEMANTIC_UNBACKED',
                  `${where} asserts guarantee "${g}", but capability "${step.capability}" resolves to "${binding.component}.${binding.method}", which does not list "${g}" among its L3 contract guarantees. Declare it there (and ensure its shape can deliver it), or revise the narrative.`,
                  impl.id,
                  isDraftCtx || ctx.isComponentDraft(binding.component),
                );
              }
            }
          }
        }
      }
    }
  },
};

// ---------------------------------------------------------------------------
// Lifecycle entrypoints — declared init/shutdown flow roots. Existence is
// checked here; the reachability and durability rules consume them as roots.
// ---------------------------------------------------------------------------

export const lifecycleRule: SddRule = {
  name: 'lifecycle-entrypoints',
  description:
    'Declared subsystem lifecycle entrypoints (init/shutdown flows) must name an existing component and a method on one of its interfaces — they are reachability roots, so a dangling entrypoint would silently detach every flow rooted in it.',
  codes: [
    { code: 'INVALID_LIFECYCLE_ENTRYPOINT', defaultSeverity: 'error', summary: 'Lifecycle entrypoint names a missing component or method' },
    { code: 'LIFECYCLE_CROSS_SUBSYSTEM', defaultSeverity: 'error', summary: 'Lifecycle entrypoint roots a flow in another subsystem\'s component' },
  ],
  check(ctx) {
    for (const sub of ctx.subsystems) {
      const isDraftCtx = sub.status === 'draft' || sub.status === 'design';
      for (const le of sub.lifecycle ?? []) {
        const comp = ctx.componentMap.get(le.component);
        if (!comp) {
          ctx.addIssue(
            'error',
            'INVALID_LIFECYCLE_ENTRYPOINT',
            `Subsystem "${sub.id}" declares ${le.phase} lifecycle entrypoint "${le.component}.${le.method}", but component "${le.component}" does not exist.`,
            sub.id,
            isDraftCtx,
          );
          continue;
        }
        // A lifecycle flow is the subsystem's own boot/shutdown wiring —
        // rooting it in a sibling's internals crosses the boundary (and would
        // silently dangle when that sibling is externalized/renamed).
        if (comp.subsystem !== sub.id) {
          ctx.addIssue(
            'error',
            'LIFECYCLE_CROSS_SUBSYSTEM',
            `Subsystem "${sub.id}" declares ${le.phase} lifecycle entrypoint "${le.component}.${le.method}", but "${comp.id}" belongs to subsystem "${comp.subsystem}" — declare the entrypoint on the owning subsystem instead.`,
            sub.id,
            isDraftCtx || ctx.isComponentDraft(comp.id),
          );
        }
        if (!interfaceMethodsOf(ctx, comp.id).some(method => method.name === le.method)) {
          ctx.addIssue(
            'error',
            'INVALID_LIFECYCLE_ENTRYPOINT',
            `Subsystem "${sub.id}" declares ${le.phase} lifecycle entrypoint "${le.component}.${le.method}", but "${comp.id}" declares no method "${le.method}" on any of its interfaces.`,
            sub.id,
            isDraftCtx || ctx.isComponentDraft(comp.id),
          );
        }
      }
    }
  },
};

// ---------------------------------------------------------------------------
// Durability round-trip — a durable Store's externally-persisted writes must
// have a hydration read-back reachable from a declared lifecycle init flow.
// Every method was individually valid in the historic bug; the missing thing
// was this EDGE (no boot read-back into the RAM projection).
// ---------------------------------------------------------------------------

/**
 * The INTRINSIC half of the durability family: whether the declaration itself
 * belongs on this component. Both verdicts read one component's own
 * componentType + durability and nothing else, so this is `scope: 'spec'` and
 * also runs at the write boundary — durability on a non-Store is refused when
 * authored rather than persisting as an unclearable validate-time error.
 */
export const durabilityDeclarationRule: SddRule = {
  name: 'durability-declaration',
  scope: 'spec',
  description:
    'Every Store declares its durability (MISSING_DURABILITY) and nothing but a Store may declare one (DURABILITY_ON_NON_STORE). Intrinsic to one component: no tree required. The round-trip consequences of the declaration are enforced by durability-round-trip.',
  codes: [
    { code: 'DURABILITY_ON_NON_STORE', defaultSeverity: 'error', summary: 'durability declared on a component that is not a Store' },
    { code: 'MISSING_DURABILITY', defaultSeverity: 'warning', summary: 'Store with no durability declaration — the round-trip machinery cannot know whether restart-survival is promised' },
  ],
  check(ctx) {
    for (const comp of ctx.components) {
      const isDraftCtx = ctx.isComponentDraft(comp.id);

      if (!comp.durability) {
        // Undeclared durability hollows out the round-trip machinery: on a
        // 12-store tree with 2 declarations the flagship check protects
        // almost nothing. Exemption is by declaration, never by omission.
        if (comp.componentType === 'Store') {
          ctx.addIssue(
            'warning',
            'MISSING_DURABILITY',
            `Store "${comp.id}" declares no durability. Declare one: durable (persisted RAM projection — hydration round-trip enforced), read-through (persisted, no RAM copy — every read is the read-back), ram-projection (rebuilt, not restored), or cache (evictable, loss-safe).`,
            comp.id,
            isDraftCtx,
          );
        }
        continue;
      }

      if (comp.componentType !== 'Store') {
        ctx.addIssue(
          'error',
          'DURABILITY_ON_NON_STORE',
          `Component "${comp.id}" (${comp.componentType}) declares durability "${comp.durability}" — durability is a Store property (state lives in Stores; see the no-persistence-shortcuts rule).`,
          comp.id,
          isDraftCtx,
        );
      }
    }
  },
};

export const durabilityRule: SddRule = {
  name: 'durability-round-trip',
  description:
    'A durable Store (persisted RAM projection) must carry effect-tagged contract methods, and its writes require a hydration read-back reachable from a lifecycle init entrypoint. read-through is exempt (every read IS the read-back), as are ram-projection (rebuilt not restored) and cache (evictable, loss-safe). The flagship semantic check is opt-out by declaration, never silently absent — the declaration itself is enforced by durability-declaration.',
  codes: [
    { code: 'MISSING_EFFECT_TAG', defaultSeverity: 'warning', summary: 'Durable Store contract method lacks an effect: read | write tag' },
    { code: 'MISSING_HYDRATION', defaultSeverity: 'error', summary: 'Durable Store is written but no read-back is reachable from any lifecycle init entrypoint' },
  ],
  check(ctx) {
    // Reachability from lifecycle INIT flows only — the boot graph.
    const initSeeds: WalkSeed[] = [];
    for (const sub of ctx.subsystems) {
      for (const le of sub.lifecycle ?? []) {
        if (le.phase === 'init' && ctx.componentMap.has(le.component)) {
          initSeeds.push({ compId: le.component, methodName: le.method });
        }
      }
    }
    // followDispatchTables: false — at boot only edges the init narratives
    // actually TAKE count; a hydrating read merely offered in a reached
    // portal's table is not a boot-time read (explicit dispatch steps in the
    // init flow are still followed). followRegisterEdges: false for the same
    // reason — registering a callback at init hands it to the runtime for
    // LATER; it is not a boot-time execution of the hydrating read.
    const initReach = initSeeds.length ? walkNarrativeGraph(ctx, initSeeds, { followDispatchTables: false, followRegisterEdges: false }) : null;

    for (const comp of ctx.components) {
      const isDraftCtx = ctx.isComponentDraft(comp.id);

      // Misplaced or absent declarations are durability-declaration's verdict.
      // Only `durable` (persisted RAM projection) needs the boot read-back:
      // read-through reads the medium on every call, ram-projection rebuilds,
      // cache loss is behavior-preserving.
      if (comp.componentType !== 'Store') continue;
      if (comp.durability !== 'durable') continue;

      const methods = interfaceMethodsOf(ctx, comp.id);
      const untagged = methods.filter(method => !method.effect);
      if (untagged.length) {
        ctx.addIssue(
          'warning',
          'MISSING_EFFECT_TAG',
          `Durable Store "${comp.id}" has contract methods without an effect tag (${untagged.map(u => `"${u.name}"`).join(', ')}) — the round-trip rule can only pair writes with read-backs over tagged methods.`,
          comp.id,
          isDraftCtx,
        );
      }

      const writes = methods.filter(method => method.effect === 'write');
      const reads = methods.filter(method => method.effect === 'read');
      if (writes.length === 0) continue; // nothing persisted, nothing to hydrate

      const hydrated = initReach !== null
        && reads.some(method => initReach.reachedMethods.has(methodKey(comp.id, method.name)));
      if (!hydrated) {
        const because = initReach === null
          ? 'no subsystem declares a lifecycle init entrypoint at all'
          : reads.length === 0
            ? 'the store declares no read-effect method to hydrate from'
            : `none of its read-effect methods (${reads.map(r => `"${r.name}"`).join(', ')}) are reachable from any declared lifecycle init flow`;
        ctx.addIssue(
          'error',
          'MISSING_HYDRATION',
          `Durable Store "${comp.id}" is written (${writes.map(w => `"${w.name}"`).join(', ')}) but ${because} — persisted state would never be read back after a restart. Wire a hydrate/read-back into a lifecycle init flow.`,
          comp.id,
          isDraftCtx,
        );
      }
    }
  },
};

// ---------------------------------------------------------------------------
// Untyped seams — bare Json/any/unknown crossing a subsystem's public surface.
// The seam is exactly where role-envelope mismatches hide; inside a component
// a loose bag is a style choice, across a boundary it is an unchecked contract.
// ---------------------------------------------------------------------------

const BARE_SEAM_TYPES = new Set(['json', 'any', 'unknown', 'object']);

function unwrapPromise(typeRef: string): string {
  const m = /^promise\s*<(.+)>$/i.exec(typeRef.trim());
  return (m ? m[1] : typeRef).trim();
}

export const untypedSeamRule: SddRule = {
  name: 'untyped-seams',
  description:
    'Methods on a subsystem\'s published components (its public surface) should not take or return bare Json/any/unknown — cross-subsystem contracts are the swap seam and must be typed. Generic-dispatch portals carry per-capability types via their dispatch table instead.',
  codes: [
    { code: 'UNTYPED_SEAM', defaultSeverity: 'warning', summary: 'Bare Json/any/unknown parameter or return crossing a subsystem public surface' },
  ],
  check(ctx) {
    for (const sub of ctx.subsystems) {
      const published = ctx.publicSet.get(sub.id);
      if (!published || published.size === 0) continue;

      for (const compId of published) {
        const comp = ctx.componentMap.get(compId);
        if (!comp) continue;
        // A generic-dispatch portal's untyped envelope is the sanctioned
        // pattern ONCE it carries a dispatch table — the table is where the
        // per-capability typing lives.
        if (comp.componentType === 'Portal' && comp.dispatch && comp.dispatch.length > 0) continue;

        for (const intf of ctx.interfacesByComponent.get(compId) ?? []) {
          const isDraftCtx = ctx.isComponentDraft(compId) || intf.status === 'draft' || intf.status === 'design';
          for (const m of intf.methods) {
            const offenders: string[] = [];
            for (const p of m.params ?? []) {
              if (BARE_SEAM_TYPES.has(unwrapPromise(p.type).toLowerCase())) {
                offenders.push(`param "${p.name}: ${p.type}"`);
              }
            }
            const ret = unwrapPromise(m.returns ?? '');
            if (BARE_SEAM_TYPES.has(ret.toLowerCase())) {
              offenders.push(`return "${m.returns}"`);
            }
            if (offenders.length) {
              ctx.addIssue(
                'warning',
                'UNTYPED_SEAM',
                `Method "${m.name}" on published component "${compId}" (public surface of subsystem "${sub.id}") crosses the boundary untyped: ${offenders.join(', ')}. Type the seam — or, for a generic-dispatch portal, carry per-capability types in the dispatch table.`,
                intf.id,
                isDraftCtx,
              );
            }
          }
        }
      }
    }
  },
};

// ---------------------------------------------------------------------------
// Prose-claim linter — durability/side-effect phrases whose step graph has no
// matching edge. A heuristic tripwire, deliberately conservative: the durable
// fix is dispatch tables + durability tags making the claims structural.
// ---------------------------------------------------------------------------

const CLAIM_PHRASES = /\b(persist(s|ed|ent)?|survives?\s+(a\s+)?restart|writ(es?|ten)\s+to\s+disk|registered\s+into|durabl[ey])\b/i;

export const proseClaimRule: SddRule = {
  name: 'prose-claims',
  description:
    'Flags durability/side-effect claims that exist only in prose: a local step description or an intent paragraph claiming persistence ("persisted", "survives restart", "registered into") on a logic component whose narrative has no call/dispatch edge to any data-layer component (Store/Registry/Index/Adapter/Repository). Data-layer components are exempt — they ARE the persistence.',
  codes: [
    { code: 'UNREALIZED_CLAIM', defaultSeverity: 'warning', summary: 'Durability/side-effect claim in prose with no matching structural edge' },
  ],
  check(ctx) {
    for (const impl of ctx.implementations) {
      const comp = componentOfImpl(ctx, impl.contract);
      if (!comp) continue;
      // The persistence layer legitimately talks about persisting.
      if (DATA_STEREOTYPES.has(comp.componentType)) continue;

      const isDraftCtx = ctx.isImplementationDraft(impl);

      for (const implMethod of impl.methods) {
        // Cheap regex gate first: almost no methods carry claims, so the
        // graph probing below only runs on actual hits.
        const stepClaims = implMethod.narrative
          .filter(step => step.type === 'local')
          .map(step => ({ step, claim: CLAIM_PHRASES.exec(step.description) }))
          .filter((c): c is { step: (typeof implMethod.narrative)[number]; claim: RegExpExecArray } => c.claim !== null);
        const intentClaim = implMethod.intent ? CLAIM_PHRASES.exec(implMethod.intent) : null;
        if (!stepClaims.length && !intentClaim) continue;

        const hasDataEdge = implMethod.narrative.some(step => {
          if (step.type !== 'call' && step.type !== 'dispatch') return false;
          if (!step.targetComponent) return false;
          const target = ctx.componentMap.get(step.targetComponent);
          if (target && DATA_STEREOTYPES.has(target.componentType)) return true;
          // A dispatch resolves to its bound server.
          const binding = target?.dispatch?.find(b => b.capability === step.capability);
          const server = binding ? ctx.componentMap.get(binding.component) : undefined;
          return server ? DATA_STEREOTYPES.has(server.componentType) : false;
        });

        // Steps: a LOCAL step claiming persistence in a narrative with no
        // data-layer edge realizes nothing. (call/dispatch steps carry their
        // own edge and are exempt.)
        for (const { step, claim } of stepClaims) {
          if (!hasDataEdge) {
            ctx.addIssue(
              'warning',
              'UNREALIZED_CLAIM',
              `Step ${step.stepNumber} of "${implMethod.name}" in implementation "${impl.id}" claims "${claim[0]}" but no call/dispatch edge in this narrative reaches a Store/Registry/Index/Adapter — realize the claim as a structural edge (and durability tags), or reword the prose.`,
              impl.id,
              isDraftCtx,
            );
          }
        }

        // Intent prose: no steps to inspect, so fall back to the component's
        // declared collaborators — a persistence claim with no data-layer
        // dependency anywhere cannot be realized.
        if (intentClaim && !hasDataEdge) {
          const dependsOnDataLayer = [...comp.dependsOn, ...comp.owns].some(depId => {
            const dep = ctx.componentMap.get(depId);
            return dep ? DATA_STEREOTYPES.has(dep.componentType) : false;
          });
          if (!dependsOnDataLayer) {
            ctx.addIssue(
              'warning',
              'UNREALIZED_CLAIM',
              `The intent of "${implMethod.name}" in implementation "${impl.id}" claims "${intentClaim[0]}" but component "${comp.id}" neither depends on nor owns any Store/Registry/Index/Adapter — the claim has no structural realization.`,
              impl.id,
              isDraftCtx,
            );
          }
        }
      }
    }
  },
};
