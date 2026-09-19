import { z } from 'zod';

// ---------------------------------------------------------------------------
// Common Identifier Schema
// ---------------------------------------------------------------------------
export const SpecIdSchema = z.string().regex(/^[a-z0-9-_]+$/, 'Identifier must be lowercase alphanumeric with dashes or underscores');

/**
 * Split a qualified id at its last `::` into the namespace prefix and the local
 * id. An unqualified id has an empty prefix and is its own local id.
 */
export function splitNamespace(qualifiedId: string): { prefix: string; localId: string } {
  if (!qualifiedId.includes('::')) {
    return { prefix: '', localId: qualifiedId };
  }
  const parts = qualifiedId.split('::');
  const localId = parts.pop()!;
  return { prefix: parts.join('::'), localId };
}

export const SpecStatusSchema = z.enum(['draft', 'design', 'complete']).default('complete');
export type SpecStatus = z.infer<typeof SpecStatusSchema>;


export const BoundaryItemSchema = z.union([
  z.string(),
  z.object({
    name: z.string(),
    description: z.string().optional(),
  }),
]);
export type BoundaryItem = z.infer<typeof BoundaryItemSchema>;

export const RequirementItemSchema = z.union([
  z.string(),
  z.object({
    description: z.string(),
  }),
]);
export type RequirementItem = z.infer<typeof RequirementItemSchema>;

export const DatabaseSpecSchema = z.object({
  id: SpecIdSchema,
  name: z.string(),
  engine: z.string(), // e.g. "postgresql", "mysql", "sqlite", "redis"
  description: z.string().optional(),
  tables: z.array(SpecIdSchema).optional(),
});
export type DatabaseSpec = z.infer<typeof DatabaseSpecSchema>;

export const DiagramConfigSchema = z.object({
  lineStyle: z.enum(['bezier', 'straight', 'taxi']).optional(),
  defaultView: z.enum(['architecture', 'types', 'databases']).optional(),
  showDatabases: z.boolean().optional(),
});
export type DiagramConfig = z.infer<typeof DiagramConfigSchema>;

/**
 * Ascending audience reach for L0 gateway entries. An entry travels only as
 * far as its audience allows: project (family-internal — exported only into
 * own chained children), department (owning org-unit subtree), instance
 * (whole hosted instance), partner (grant-gated cross-tenant), external
 * (publicly consumable / 3rd-party-facing).
 */
export const SURFACE_AUDIENCES = ['project', 'department', 'instance', 'partner', 'external'] as const;
export const SurfaceAudienceSchema = z.enum(SURFACE_AUDIENCES);
export type SurfaceAudience = z.infer<typeof SurfaceAudienceSchema>;

/**
 * One entry of the project's L0 gateway surface — the ONLY thing another
 * project may consume. Fields are lenient (existing trees authored this
 * un-schema'd); the surface projector applies defaults where sensible.
 */
export const SystemPublicInterfaceSchema = z.object({
  /** Stable public interface id within the system. */
  id: z.string().optional(),
  name: z.string().optional(),
  /** Subsystem publishing the backing L1 public interface. */
  subsystem: z.string().optional(),
  /** Portal (or compatible published component) backing this entry. */
  component: z.string().optional(),
  /** Optional L3 interface id backing the surface. */
  interface: z.string().optional(),
  /** Surface kind: REST, GraphQL, MessageBus, RPC, or Custom. */
  type: z.string().optional(),
  details: z.string().optional(),
  /** Exposure ceiling (see SurfaceAudienceSchema). Defaults to 'instance' at projection time. */
  audience: z.string().optional(),
  authPolicy: z.string().optional(),
  version: z.string().optional(),
  stability: z.string().optional(),
});
export type SystemPublicInterface = z.infer<typeof SystemPublicInterfaceSchema>;

export const SystemSpecSchema = z.object({
  schemaVersion: z.string().default('1.0.0'),
  name: z.string(),
  vision: z.string(),
  boundaries: z.array(BoundaryItemSchema).default([]),
  globalRequirements: z.array(RequirementItemSchema).default([]),
  /**
   * The project's gateway surface: entries intentionally exported beyond the
   * project, each backed by a subsystem-published Portal and carrying an
   * audience ceiling. Cross-PROJECT consumption may only target these.
   */
  publicInterfaces: z.array(SystemPublicInterfaceSchema).optional(),
  /**
   * System-level databases. Enables database table mapping, PK/FK views,
   * and isolated ERD schemas.
   */
  databases: z.array(DatabaseSpecSchema).default([]),
  /** Optional defaults for the interactive diagram canvas. */
  diagram: DiagramConfigSchema.optional(),
  /**
   * Default implementation language for the whole system (e.g. "typescript",
   * "rust", "python"). Subsystems may override. Drives language-aware
   * validation (builtin-type vocabulary, language rule packs); free-form but
   * normalized to lowercase by the validator.
   */
  targetLanguage: z.string().optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export type SystemSpec = z.infer<typeof SystemSpecSchema>;

// ---------------------------------------------------------------------------
// Level 1: Subsystem / Service Spec (subsystems/*.yaml)
// ---------------------------------------------------------------------------
export const PublicInterfaceTypeSchema = z.enum(['REST', 'GraphQL', 'MessageBus', 'RPC', 'Custom']);
export type PublicInterfaceType = z.infer<typeof PublicInterfaceTypeSchema>;

export const PublicInterfaceSchema = z.object({
  type: PublicInterfaceTypeSchema,
  details: z.string(),
  /** The L2 component that realizes this public interface (the subsystem's published surface). */
  component: SpecIdSchema.optional(),
  /** Optional L3 interface on that component backing this entry. */
  interface: SpecIdSchema.optional(),
});

export type PublicInterface = z.infer<typeof PublicInterfaceSchema>;

/**
 * An explicitly sanctioned tight coupling with a peer subsystem — e.g. a
 * latency "fast lane" where a trusted sibling calls directly instead of going
 * over the message bus. Mutual subsystem dependencies are flagged unless one
 * side declares the link, turning the exception into reviewable spec instead
 * of tribal knowledge. Declared on the SOURCE subsystem, the link licenses
 * direct in-process edges into the peer WITHOUT the client-Adapter shim; the
 * target must still be published (the peer's Portal in publicInterfaces) — a
 * trusted link never licenses reaching internals, and a target-side
 * declaration waives nothing for callers.
 */
export const TrustedLinkSchema = z.object({
  /** The peer subsystem id this link sanctions tight coupling with. */
  subsystem: SpecIdSchema,
  /** Why this coupling is sanctioned (e.g. "runtime dispatch latency — bus round-trip too slow"). */
  reason: z.string(),
});
export type TrustedLink = z.infer<typeof TrustedLinkSchema>;

/**
 * Per-spec lint suppression — wairon's #[allow(...)]. An allow silences
 * WARNING-severity findings of the named code on THIS spec only; error
 * findings are architecture violations and are never locally suppressible
 * (a human can still re-tune codes globally via rules.sddRuleSeverity in
 * project.yaml). Same philosophy as trustedLinks: the exception becomes
 * reviewable spec — reason required, stale allows are flagged.
 *
 * An allow covers EXACTLY the finding it names, and `at`/`covers` are how it
 * names one. They are the conformance debt register's vocabulary on purpose —
 * the same words (FindingParts: the site inside the spec, and the units an
 * aggregating finding wears one message for) for the same idea, because a
 * second vocabulary for "which occurrence" would be the worse outcome. A rule
 * that reports a site fires once PER SITE, and one coarse allow used to
 * silence every one of them: measured on wairon's own tree, 32 allows
 * suppressed 46 findings, so 14 occurrences — 30% — were invisible even to the
 * allow that named them.
 */
export const LintAllowSchema = z.object({
  /** The issue code being allowed (see `wairon rules list`). */
  code: z.string(),
  /**
   * The SITE inside this spec the allow covers, named exactly as the finding
   * names it (a contract method, an import edge "from -> to", a declared edge
   * "component -> target"). A finding that names a site is covered ONLY by an
   * allow naming that same site; a finding that names none is covered only by
   * an allow that names none either.
   */
  at: z.string().min(1).optional(),
  /**
   * The units of an AGGREGATING finding this allow covers — the steps of one
   * CALL_STEP_UNREALIZED, the crossings of one UNDECLARED_COLOCATED_CALL —
   * each named the way the finding's own message names it. The allow silences
   * the finding only when it lists EVERY unit reported, so a unit nobody
   * decided on surfaces on the day it appears instead of inheriting a decision
   * taken about its neighbours. Meaningless without `at`, and refused there.
   */
  covers: z.array(z.string()).optional(),
  /** Why this finding is acceptable here (e.g. "dispatcher — fan-out is the point"). */
  reason: z.string().min(1),
}).refine(a => !a.covers?.length || !!a.at, {
  message: '`covers` names the units of ONE finding, so it needs the `at` that says which finding — add the site, or drop covers.',
  path: ['covers'],
});
export type LintAllow = z.infer<typeof LintAllowSchema>;

export const LintConfigSchema = z.object({
  allow: z.array(LintAllowSchema).default([]),
});
export type LintConfig = z.infer<typeof LintConfigSchema>;

/**
 * Open, namespaced extension-data channel: an opaque map packs and tools may
 * attach structured domain data to (ISR priorities, topic names, memory
 * budgets, …). Never validated, relativized, or interpreted by the core —
 * preserved verbatim through load/save so pack rules have something to read.
 * Key discipline (e.g. "mypack:priority") is the pack's concern.
 */
export const ExtDataSchema = z.record(z.unknown());
export type ExtData = z.infer<typeof ExtDataSchema>;

/**
 * A declared lifecycle flow root: a component.method the runtime invokes at a
 * lifecycle phase. Reachability analysis (unused-detection, durability
 * round-trip) treats these as entrypoints alongside Portals, Observers, and
 * published components — boot-time wiring like hydration and environment
 * provisioning becomes statically checkable instead of a blanket lint-allow
 * ("called at startup, invisible to the walker"). Beyond init/shutdown, the
 * execution-model roots open the walker to non-request/response systems:
 * `cyclic` (invoked every scan/tick — the PLC/game-loop model), `interrupt`
 * (invoked by a hardware/OS interrupt), `scheduled` (invoked by a
 * timer/cron). Only `init` flows feed the durable-Store hydration check.
 */
export const LifecycleEntrypointSchema = z.object({
  /** Which lifecycle/execution flow this roots. */
  phase: z.enum(['init', 'shutdown', 'cyclic', 'interrupt', 'scheduled']),
  /** Component id whose method the runtime invokes at this phase. */
  component: z.string(),
  /** Method name on that component's interface. */
  method: z.string(),
  /** What this lifecycle flow establishes or tears down. */
  description: z.string().optional(),
});
export type LifecycleEntrypoint = z.infer<typeof LifecycleEntrypointSchema>;

export const SubsystemSpecSchema = z.object({
  id: SpecIdSchema,
  name: z.string(),
  description: z.string(),
  parentSystem: z.string(), // References L0 System Name or file
  publicInterfaces: z.array(PublicInterfaceSchema).default([]),
  /** Declared init/shutdown flow roots (see LifecycleEntrypointSchema). */
  lifecycle: z.array(LifecycleEntrypointSchema).optional(),
  /**
   * Optional subsystem profile override (e.g. for fullstack systems). Open
   * string: built-ins are backend, frontend-reactive, frontend-controller,
   * lowlevel-os, game-ecs, realtime-embedded, plc-cyclic; extension packs
   * may register more. Unknown names get UNKNOWN_PROFILE.
   */
  profile: z.string().optional(),
  projectPath: z.string().optional(), // Relative path to external project root for subsystem chaining
  /** Optional override of the system-level targetLanguage for this subsystem. */
  targetLanguage: z.string().optional(),
  /** Explicitly sanctioned tight couplings with peer subsystems (see TrustedLinkSchema). */
  trustedLinks: z.array(TrustedLinkSchema).default([]),
  /**
   * Per-subsystem design-depth override (components | interfaces |
   * implementations | narratives): how deep THIS subsystem commits to
   * designing. Overrides the project rules.designDepth — a black-box or
   * externally-owned subsystem can stop at interfaces while siblings go to
   * L5, or one flagship subsystem can go deeper than the project default.
   * Expectation checks below the depth are gated; soundness of authored
   * content never is.
   */
  designDepth: z.enum(['components', 'interfaces', 'implementations', 'narratives']).optional(),
  /** Per-spec lint suppressions (see LintConfigSchema). */
  lint: LintConfigSchema.optional(),
  /** Opaque pack/tool extension data (see ExtDataSchema) — preserved verbatim. */
  ext: ExtDataSchema.optional(),
  status: SpecStatusSchema.optional().default('complete'),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export type SubsystemSpec = z.infer<typeof SubsystemSpecSchema>;

/** subsystem_spec.isDraft — whether the subsystem's status is draft or design. */
export function isDraftSubsystem(subsystem: Pick<SubsystemSpec, 'status'>): boolean {
  return subsystem.status === 'draft' || subsystem.status === 'design';
}

// ---------------------------------------------------------------------------
// Level 2: Component Spec (components/*.yaml)
// ---------------------------------------------------------------------------
export const ComponentTypeSchema = z.enum([
  // Building blocks
  'Portal',
  'Orchestrator',
  'Supervisor',
  'Actor',
  'Store',
  'Index',
  'Query', // Repository member for computed reads over its Store
  'Registry',
  'Adapter',
  'Observer',
  'View', // Pure presenter/UI component
  // Patterns (compositions of blocks)
  'Repository',
  'FeatureComponent', // Logic Hook + View Presenter pattern
  'RouterComponent',  // Switch/routing component pattern
  // Retired stereotypes: still parsed so a tree using them loads and the
  // rules can report them (STEREOTYPE_RETIRED), never authored new
  'Specialist', // logic is an Orchestrator with a dependencyClass
  'Gateway',    // a gateway is a Portal with the gateway variant
]);
export type ComponentType = z.infer<typeof ComponentTypeSchema>;

/** Component types that are patterns (own member blocks) rather than building blocks. */
export const PATTERN_TYPES: ReadonlySet<ComponentType> = new Set(['Repository', 'FeatureComponent', 'RouterComponent']);

/** Retired component types: a tree still loads them, and STEREOTYPE_RETIRED reports each until it is migrated. */
export const RETIRED_STEREOTYPES: ReadonlySet<ComponentType> = new Set(['Specialist', 'Gateway']);

export const PortalTypeSchema = z.enum(['HTTP_API', 'gRPC', 'GraphQL', 'MessageBus', 'CLI', 'NamedPipe', 'IPC', 'Custom']);
export type PortalType = z.infer<typeof PortalTypeSchema>;

/**
 * One entry of a generic-dispatch Portal's machine-readable dispatch table:
 * maps a runtime capability name to the component.method serving it. Makes
 * dynamic dispatch visible to the static walker — each binding is validated
 * against the serving component's interface (UNSERVED_CAPABILITY) and
 * traversed by unused-detection, so a portal with a table no longer needs
 * "invisible to the static walker" lint-allows (which then go stale and are
 * flagged by the stale-allow audit).
 */
export const DispatchBindingSchema = z.object({
  /** Capability name exactly as dispatched at runtime (e.g. "shadow_module.get"). */
  capability: z.string().min(1),
  /** Component id serving this capability (local, super::-relative, or ::-absolute). */
  component: z.string(),
  /** Method name on the serving component's interface. */
  method: z.string(),
  /** What this capability does. */
  description: z.string().optional(),
});
export type DispatchBinding = z.infer<typeof DispatchBindingSchema>;

/**
 * Store durability declaration — the orthogonal axis to the access shape
 * (bare Store vs Repository). Every Store should declare one
 * (MISSING_DURABILITY otherwise):
 * - `durable`        — persisted RAM projection: survives restart AND holds a
 *                      RAM copy, so the round-trip rule requires a hydration
 *                      read-back reachable from a lifecycle init entrypoint
 *                      (MISSING_HYDRATION otherwise).
 * - `read-through`   — persisted with NO RAM copy: every read hits the
 *                      backing medium, so every read IS the read-back —
 *                      hydration exempt by definition (the file-backed
 *                      config/record store).
 * - `ram-projection` — rebuilt, not restored; exempt from the round-trip.
 * - `cache`          — evictable memo state whose loss is behavior-preserving;
 *                      hydration exempt (the honest home for TTL caches that
 *                      would otherwise hide inside an Orchestrator).
 */
export const DurabilitySchema = z.enum(['ram-projection', 'durable', 'read-through', 'cache']);
export type Durability = z.infer<typeof DurabilitySchema>;

/**
 * Orchestrator dependency-class declaration — what a logic Orchestrator may
 * depend on, enforced as a Store's durability is. Declared only on an
 * Orchestrator (DEPENDENCY_CLASS_ON_NON_ORCHESTRATOR otherwise); a dependency
 * the class does not allow is DEPENDENCY_CLASS_VIOLATION:
 * - `pure` — depends only on pure Orchestrators: a computation over the values
 *            it is handed (an arbiter, a codec).
 * - `read` — also depends on read Orchestrators and on Repositories, Indexes
 *            and Adapters, whose write methods it never calls (judged once
 *            facade methods carry effect tags).
 * Unset, the Orchestrator is a workflow.
 */
export const DependencyClassSchema = z.enum(['pure', 'read']);
export type DependencyClass = z.infer<typeof DependencyClassSchema>;

/** A reference from a component to a pack-declared reusable pattern (resolved against loaded packs' PatternDefs; UNKNOWN_PATTERN_REF when unresolved). */
export const PatternRefSchema = z.object({
  id: z.string(),
  version: z.string().optional(),
});
export type PatternRef = z.infer<typeof PatternRefSchema>;

/**
 * One event edge of the pub/sub topology: a topic this component emits to or
 * consumes from. First-class so the event graph is STATABLE, not prose — the
 * event-topology rule pairs every emitted topic with a subscriber and vice
 * versa (UNCONSUMED_TOPIC / UNSOURCED_SUBSCRIPTION). MessageBus endpoints on
 * Portal methods (direction publish|subscribe) count into the same pairing.
 */
export const EventBindingSchema = z.object({
  /** Topic/channel name exactly as used on the bus. */
  topic: z.string().min(1),
  /** Optional event name within the topic (informational in v1 — pairing is by topic). */
  event: z.string().optional(),
  description: z.string().optional(),
});
export type EventBinding = z.infer<typeof EventBindingSchema>;

/**
 * An opaque external reference on a component — a documented URL wairon does NOT
 * fetch, resolve, or validate. `implementation` marks the external source-of-record
 * (a cloud console, a Make.com scenario, a GitHub file) and stands in for a local
 * sourcePath; `informative` is context only (docs, dashboards).
 */
export const ExternalLinkTypeSchema = z.enum(['implementation', 'informative']);
export type ExternalLinkType = z.infer<typeof ExternalLinkTypeSchema>;

export const ExternalLinkSchema = z.object({
  url: z.string(),
  /** Defaults to 'informative' so an untyped link never silently satisfies the source requirement. */
  type: ExternalLinkTypeSchema.default('informative'),
  label: z.string().optional(),
});
export type ExternalLink = z.infer<typeof ExternalLinkSchema>;

/**
 * A Portal's authentication scheme, OpenAPI-securityScheme-shaped. Drives the
 * generated OpenAPI `securitySchemes`/`security`. `none` (or omitted) ⇒ no
 * security. Fields are per-scheme: apiKey (in+name), bearer (bearerFormat),
 * oauth2 (flow + urls + scopes), openIdConnect (openIdConnectUrl), custom
 * (free-form, carried via description/name). wairon never contacts these URLs.
 */
export const PortalAuthSchemeSchema = z.enum(['none', 'apiKey', 'bearer', 'basic', 'oauth2', 'openIdConnect', 'custom']);
export type PortalAuthScheme = z.infer<typeof PortalAuthSchemeSchema>;

export const PortalAuthSchema = z.object({
  scheme: PortalAuthSchemeSchema,
  in: z.enum(['header', 'query', 'cookie']).optional(),
  name: z.string().optional(),
  bearerFormat: z.string().optional(),
  authorizationUrl: z.string().optional(),
  tokenUrl: z.string().optional(),
  refreshUrl: z.string().optional(),
  scopes: z.array(z.object({ name: z.string(), description: z.string() })).optional(),
  flow: z.enum(['authorizationCode', 'clientCredentials', 'implicit', 'password']).optional(),
  openIdConnectUrl: z.string().optional(),
  description: z.string().optional(),
  example: z.string().optional(),
});
export type PortalAuth = z.infer<typeof PortalAuthSchema>;

export const ComponentSpecSchema = z.object({
  id: SpecIdSchema,
  name: z.string(),
  description: z.string(),
  subsystem: z.string(), // References L1 Subsystem id
  componentType: ComponentTypeSchema,
  /** Member block ids privately owned by this component (patterns only; one hop). */
  owns: z.array(z.string()).default([]),
  /** Other L2 component ids this component collaborates with (facades / standalone blocks). */
  dependsOn: z.array(z.string()).default([]),
  portalType: PortalTypeSchema.optional(),
  basePath: z.string().optional(),
  /** Portal-only: the API's authentication scheme (see PortalAuthSchema) — projected
   *  into the generated OpenAPI's securitySchemes/security. Portals with different auth
   *  must be separate components (one auth per portal ⇒ one OpenAPI spec per portal). */
  auth: PortalAuthSchema.optional(),
  /** Portal-only: capability → component.method dispatch table (see DispatchBindingSchema). */
  dispatch: z.array(DispatchBindingSchema).optional(),
  /** Store-only: whether held state survives restart (see DurabilitySchema). */
  durability: DurabilitySchema.optional(),
  /** Orchestrator-only: what the logic may depend on; unset means a workflow (see DependencyClassSchema). */
  dependencyClass: DependencyClassSchema.optional(),
  /** Topics this component publishes to (see EventBindingSchema). */
  emits: z.array(EventBindingSchema).optional(),
  /** Topics this component consumes (see EventBindingSchema) — typical on Observers. */
  subscribesTo: z.array(EventBindingSchema).optional(),
  /** Pack-declared reusable patterns this component realizes (resolved against loaded packs; UNKNOWN_PATTERN_REF). */
  patterns: z.array(PatternRefSchema).optional(),
  /** Optional component variant — a declared, base-anchored specialization of this component's stereotype (resolved against the variant registry; UNKNOWN_VARIANT / VARIANT_BASE_MISMATCH). */
  variant: z.string().optional(),
  /** Opaque external references (see ExternalLinkSchema) — documented URLs wairon does
   *  not fetch or validate. An `implementation` link is the external source-of-record and
   *  satisfies the source requirement for a source-less implementation (suppresses
   *  MISSING_SOURCE_PATH); `informative` links are context only. */
  externalLinks: z.array(ExternalLinkSchema).optional(),
  /** Per-spec lint suppressions (see LintConfigSchema). */
  lint: LintConfigSchema.optional(),
  /** Opaque pack/tool extension data (see ExtDataSchema) — preserved verbatim. */
  ext: ExtDataSchema.optional(),
  status: SpecStatusSchema.optional().default('complete'),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export type ComponentSpec = z.infer<typeof ComponentSpecSchema>;

/**
 * component_spec.defaultConformanceTier — the conformance tier the component's
 * methods get when neither the method nor its implementation sets one:
 * anchored for a Portal, declared otherwise (and declared when the component
 * does not resolve).
 */
export function defaultConformanceTier(component?: Pick<ComponentSpec, 'componentType'>): ConformanceTier {
  return component?.componentType === 'Portal' ? 'anchored' : 'declared';
}

/**
 * component_spec.defaultNarrativeDetail — the narrative detail the component's
 * methods get when neither the method nor its implementation sets one:
 * calls-only for Portals, Observers and Adapters (boundary pass-throughs);
 * intent for Stores, Indexes, Queries and Registries (a contract paragraph, not
 * choreography); full otherwise, and full when the component does not resolve.
 */
export function defaultNarrativeDetail(component?: Pick<ComponentSpec, 'componentType'>): NarrativeDetail {
  const componentType = component?.componentType;
  if (componentType === 'Portal' || componentType === 'Observer' || componentType === 'Adapter') {
    return 'calls-only';
  }
  if (componentType === 'Store' || componentType === 'Index' || componentType === 'Query' || componentType === 'Registry') {
    return 'intent';
  }
  return 'full';
}

/**
 * component_spec.isPattern — whether the component is a pattern that owns
 * member blocks (Repository, FeatureComponent or RouterComponent) rather than a
 * building block.
 */
export function isPattern(component: Pick<ComponentSpec, 'componentType'>): boolean {
  return PATTERN_TYPES.has(component.componentType);
}

/**
 * component_spec.isLogic — whether the component's methods are flowcharts of
 * the system's logic: an Orchestrator, Supervisor or Actor, or a Specialist
 * until it is retired.
 */
export function isLogic(component: Pick<ComponentSpec, 'componentType'>): boolean {
  const componentType = component.componentType;
  return componentType === 'Orchestrator' || componentType === 'Supervisor' || componentType === 'Actor' || componentType === 'Specialist';
}

/**
 * component_spec.holdsState — whether the component owns domain or runtime
 * state between calls: a Store, Index, Supervisor or Actor.
 */
export function holdsState(component: Pick<ComponentSpec, 'componentType'>): boolean {
  const componentType = component.componentType;
  return componentType === 'Store' || componentType === 'Index' || componentType === 'Supervisor' || componentType === 'Actor';
}

/**
 * component_spec.isRetired — whether the component's type is a retired
 * stereotype (Specialist or Gateway). The rules that judge a stereotype's shape
 * skip it, and retired-stereotypes reports it once, until it is migrated.
 */
export function isRetired(component: Pick<ComponentSpec, 'componentType'>): boolean {
  return RETIRED_STEREOTYPES.has(component.componentType);
}

/**
 * Building-block words a component id's head noun names WHAT the component is
 * (a Store, an Adapter, …), as opposed to what it is about. Used by both
 * headNoun and conceptNoun; kept lowercase since ids are.
 */
const BLOCK_NOUNS: ReadonlySet<string> = new Set([
  'portal', 'orchestrator', 'supervisor', 'actor', 'store', 'index', 'query',
  'registry', 'adapter', 'observer', 'repository', 'view',
]);

/**
 * component_spec.headNoun — the last word of the component's id, which names
 * what the component IS: the head noun of "pack_store_adapter" is "adapter",
 * and of "credential_write_registry" is "registry". Qualifiers before it name
 * what the component works on, so only the head noun says what it IS.
 */
export function headNoun(component: Pick<ComponentSpec, 'id'>): string {
  const words = component.id.split(/[-_]/).filter(Boolean);
  return words[words.length - 1] ?? '';
}

/**
 * component_spec.conceptNoun — the last word of the id that does NOT name a
 * building block: what the component is about, rather than what it is.
 * "pack_store" is about packs, "architecture_diagrams" about diagrams,
 * "cli_packs_adapter" about packs. Empty when every word names a block.
 */
export function conceptNoun(component: Pick<ComponentSpec, 'id'>): string {
  const words = component.id.split(/[-_]/).filter(Boolean);
  for (let i = words.length - 1; i >= 0; i--) {
    if (!BLOCK_NOUNS.has(words[i])) return words[i];
  }
  return '';
}

// ---------------------------------------------------------------------------
// Level 3: Interface / Contract Spec (interfaces/*.yaml)
// ---------------------------------------------------------------------------
export const HttpMethodSchema = z.enum(['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS', 'HEAD']);
export type HttpMethod = z.infer<typeof HttpMethodSchema>;

/** The wire protocols a Portal can expose. Mirrors PortalType (sans the *_API suffix). */
export const TransportSchema = z.enum(['HTTP', 'gRPC', 'GraphQL', 'MessageBus', 'NamedPipe', 'IPC', 'CLI', 'Custom']);
export type Transport = z.infer<typeof TransportSchema>;

// A method's concrete wire endpoint — ONE generic field, discriminated by `transport`,
// so HTTP / gRPC / GraphQL / MessageBus / NamedPipe / IPC / CLI / Custom all bind
// through the same slot (set via the `sdd_set_endpoints` MCP tool). Each transport keeps
// its own precise address fields, so the gate validates exact shape, not just presence.
export const EndpointSchema = z.discriminatedUnion('transport', [
  z.object({ transport: z.literal('HTTP'), method: HttpMethodSchema, path: z.string() }),
  z.object({ transport: z.literal('gRPC'), service: z.string(), method: z.string() }),
  z.object({ transport: z.literal('GraphQL'), operation: z.enum(['query', 'mutation', 'subscription']), field: z.string() }),
  z.object({ transport: z.literal('MessageBus'), topic: z.string(), event: z.string(), queue: z.string().optional(), direction: z.enum(['subscribe', 'publish']).default('subscribe') }),
  z.object({ transport: z.literal('NamedPipe'), pipe: z.string() }),
  z.object({ transport: z.literal('IPC'), channel: z.string() }),
  z.object({ transport: z.literal('CLI'), command: z.string() }),
  z.object({ transport: z.literal('Custom'), address: z.string() }),
]);
export type Endpoint = z.infer<typeof EndpointSchema>;

/**
 * Method-level semantic guarantee tokens. SEMANTIC_GUARANTEES is wairon's BUILTIN
 * vocabulary — the cross-level consistency check (narrative claim ↔ contract guarantee)
 * and the prose-claim linter are data-driven over it (add a builtin here + its narrative
 * keyword in validation.ts). The schema itself is OPEN so extension packs can declare
 * platform vocabularies (`guarantees:` in a pack manifest); a token that is neither
 * builtin nor pack-declared is flagged by the guarantee-token rule (UNKNOWN_GUARANTEE),
 * not rejected at parse time. Still NOT a place for free-form prose — every token must
 * be declared somewhere.
 */
export const SEMANTIC_GUARANTEES = ['idempotent', 'atomic', 'transactional', 'exactly-once'] as const;
export const GuaranteeSchema = z.string().min(1);
export type Guarantee = z.infer<typeof GuaranteeSchema>;

/**
 * A structured method parameter. When a method declares `params`, they are the
 * AUTHORITATIVE source for type-reference validation — the free-form
 * `signature` string becomes display-only and is never tokenized. Strongly
 * preferred over prose signatures: it removes the whole heuristic-parsing
 * class of false positives/negatives.
 */
export const MethodParamSchema = z.object({
  name: z.string(),
  /**
   * A primitive/builtin or a defined type id (qualified across subsystems, e.g.
   * "billing.Invoice"), on its own or inside a generic, an array or a UNION:
   * `Invoice | null`, `Promise<Invoice | null>`, `Invoice[] | null`. Every
   * identifier the string names has to resolve — see the grammar on
   * src/models/type-references.ts.
   */
  type: z.string(),
  description: z.string().optional(),
  optional: z.boolean().optional(),
});
export type MethodParam = z.infer<typeof MethodParamSchema>;

/**
 * One finding code a contract method can report: the unit of a method's
 * `findings` list. The code must be anchored in the method's source file, as a
 * string literal or a property-access name such as Codes.X (UNREALIZED_FINDING);
 * below exact analysis grade any identifier counts. For a validator rule, its
 * findings are its catalog entry.
 */
export const FindingDeclarationSchema = z.object({
  /** UPPER_SNAKE and unique within the method; a pack's codes carry the pack prefix (<PACK>_<CODE>). */
  code: z.string().regex(/^[A-Z][A-Z0-9_]*$/, 'Finding code must be UPPER_SNAKE, e.g. UNREALIZED_FINDING'),
  /** The default before project severity overrides and draft-context downgrades. */
  severity: z.enum(['error', 'warning']),
  /** One line saying what the finding means. */
  summary: z.string().min(1, 'Finding summary must say what the finding means'),
});
export type FindingDeclaration = z.infer<typeof FindingDeclarationSchema>;

export const MethodSignatureSchema = z.object({
  name: z.string().regex(/^[a-zA-Z0-9_]+$/, 'Method name must be alphanumeric'),
  description: z.string(),
  signature: z.string(), // e.g. "save(key: string, data: Buffer): Promise<void>"
  // e.g. "Promise<void>", or a union: "Invoice | null" — the commonest shape in
  // any real tree. See the grammar on src/models/type-references.ts.
  returns: z.string(),
  /** Structured parameters (authoritative for type checking when present). */
  params: z.array(MethodParamSchema).optional(),
  /** Concrete wire binding for this method when its component is a Portal (set via sdd_set_endpoints). */
  endpoint: EndpointSchema.optional(),
  /**
   * First-class semantic guarantees this method's contract promises (combinable). The
   * implementer MUST honour them, and the gate checks *consistency*: a narrative step that
   * asserts a guarantee must call a method that declares it here. Whether the guarantee is
   * actually delivered is implementation correctness (implementer tests), not a static check.
   */
  guarantees: z.array(GuaranteeSchema).optional(),
  /**
   * State-effect direction of this method on its component's held state. Required on a
   * durable Store's contract methods so the durability round-trip rule can pair external
   * writes with hydration read-backs (MISSING_HYDRATION); optional elsewhere.
   */
  effect: z.enum(['read', 'write']).optional(),
  /**
   * Typed acknowledgment of a real caller OUTSIDE the modeled narrative graph
   * (runtime timer/hook, external system, sibling subsystem). Unused-detection
   * seeds the method as an entrypoint, so reachability PROPAGATES through its
   * narrative — unlike a lint.allow, which only silences the finding. `caller`
   * states WHO invokes it (placeholder-thin prose is INVOKED_BY_UNDESCRIBED;
   * a method the internal walk already reaches is INVOKED_BY_REDUNDANT).
   * Prefer a `register` narrative step when the wiring is internal — the
   * registration itself is then a modeled, checkable edge.
   */
  invokedBy: z.object({
    kind: z.enum(['runtime', 'external', 'sibling-subsystem']),
    caller: z.string().optional(),
  }).optional(),
  /**
   * The finding codes this method can report, each with its default severity
   * and summary (see FindingDeclarationSchema). Each declared code must be
   * anchored in the method's source file as a string literal or a
   * property-access name (UNREALIZED_FINDING). A code is declared once per
   * method.
   */
  findings: z.array(FindingDeclarationSchema).superRefine((findings, ctx) => {
    const seen = new Set<string>();
    findings.forEach((finding, i) => {
      if (seen.has(finding.code)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [i, 'code'],
          message: `Finding code "${finding.code}" is declared more than once in this method`,
        });
      }
      seen.add(finding.code);
    });
  }).optional(),
  /** Opaque pack/tool extension data (see ExtDataSchema) — preserved verbatim. */
  ext: ExtDataSchema.optional(),
});

export type MethodSignature = z.infer<typeof MethodSignatureSchema>;

// The intent floor: prose short enough to be a placeholder cannot specify
// behavior an implementer could be held to.
const INTENT_FLOOR_MIN_CHARS = 40;

/**
 * method_signature.passesIntentFloor — whether prose is substantial enough to
 * specify the method: at least 40 characters once trimmed, and not just the
 * method's name (compared ignoring case and punctuation).
 */
export function passesIntentFloor(text: string | undefined, methodName: string): boolean {
  if (!text) return false;
  const t = text.trim();
  if (t.length < INTENT_FLOOR_MIN_CHARS) return false;
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (norm(t) === norm(methodName)) return false;
  return true;
}

export const InterfaceSpecSchema = z.object({
  id: SpecIdSchema.regex(/^i[a-z0-9-_]+$/, 'Interface id must be prefixed with a lowercase "i"'),
  name: z.string(),
  description: z.string(),
  component: z.string(), // References L2 Component id
  methods: z.array(MethodSignatureSchema).default([]),
  /** Per-spec lint suppressions (see LintConfigSchema). */
  lint: LintConfigSchema.optional(),
  /** Opaque pack/tool extension data (see ExtDataSchema) — preserved verbatim. */
  ext: ExtDataSchema.optional(),
  status: SpecStatusSchema.optional().default('complete'),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export type InterfaceSpec = z.infer<typeof InterfaceSpecSchema>;

// ---------------------------------------------------------------------------
// Level 5: Method / Narrative Step (embedded in L4)
//
// Narratives are a FLAT ordered list whose order mimics the code lines. Flow
// structure is expressed by special step types whose config jumps by step
// number ("when false, jump to step 6") — blocks are just skipped regions.
// Syntax variants are config on one type (all four loop forms are `loop` +
// `loopKind`), so renderers/validators handle one shape per concept.
// Structural soundness (jump targets exist, regions well-formed) is enforced
// by the narrative-step-config validation rule, not the schema.
// ---------------------------------------------------------------------------
export const NarrativeStepTypeSchema = z.enum([
  'local',    // in-component work
  'call',     // cross-component call (targetComponent/targetMethod)
  'dispatch', // capability routed through a generic Portal's dispatch table (targetComponent + capability)
  'register', // runtime-callback handoff (targetComponent/targetMethod): reachability edge, never an invocation
  'branch',   // if/else: condition + onTrueStep (default next) / onFalseStep
  'switch',   // multiway dispatch: on + cases[{value, step}] + defaultStep
  'loop',     // header step; body = next..endStep; loopKind picks the form
  'try',      // guarded region: body = next..endStep; catches[{error, step}] + finallyStep
  'parallel', // concurrent fan-out/join: body = next..endStep; branches[{step}] name the arm entries; flow continues after endStep once ALL arms complete
  'jump',     // unconditional goto (break / continue / rejoin-after-catch)
  'return',   // terminator (happy or handled-failure exit)
  'throw',    // error terminator: this path raises/propagates
]);
export type NarrativeStepType = z.infer<typeof NarrativeStepTypeSchema>;

export const LoopKindSchema = z.enum(['forEach', 'for', 'while', 'doWhile']);
export type LoopKind = z.infer<typeof LoopKindSchema>;

export const SwitchCaseSchema = z.object({
  value: z.string(),                        // the matched value/case label
  step: z.number().int().positive(),        // first step of this case's region
});
export type SwitchCase = z.infer<typeof SwitchCaseSchema>;

export const CatchClauseSchema = z.object({
  error: z.string(),                        // error/condition caught (free text; 'any' for catch-all)
  step: z.number().int().positive(),        // first step of the handler region
});
export type CatchClause = z.infer<typeof CatchClauseSchema>;

/**
 * One arm of a parallel fan-out. Arms are contiguous, ordered sub-regions of
 * the parallel body: arm i spans its entry step through the step before arm
 * i+1's entry (the last arm ends at the parallel's endStep). The join is
 * implicit — flow continues after endStep once ALL arms complete; an arm
 * never falls through into its neighbor.
 */
export const ParallelBranchSchema = z.object({
  step: z.number().int().positive(),        // first step of this arm's region
  name: z.string().optional(),              // optional arm label for renderers/readers
});
export type ParallelBranch = z.infer<typeof ParallelBranchSchema>;

export const NarrativeStepSchema = z.object({
  stepNumber: z.number().int().positive(),
  /**
   * Optional symbolic anchor for this step. Authoring surfaces accept *Label
   * twins of every jump-by-number field (toLabel, onTrueLabel, …) resolved
   * against these anchors at WRITE time (updateSpec / sdd_write_narrative) —
   * the stored numeric fields stay the single flow representation. Labels
   * persist so later deltas can reference existing steps symbolically.
   */
  label: z.string().min(1).optional(),
  description: z.string(),
  type: NarrativeStepTypeSchema,
  targetComponent: z.string().optional(), // Required if type is 'call', 'register' or 'dispatch', references L2 Component id
  targetMethod: z.string().optional(),    // Required if type is 'call' or 'register', references Method name on target interface
  capability: z.string().optional(),      // Required if type is 'dispatch': the capability routed through the target Portal's dispatch table
  /**
   * call/dispatch only: the credential this step presents to an authed callee
   * Portal, and WHERE it is loaded from (`from`). Two forms: an OPAQUE source
   * (`env:API_KEY`, a config key, `vault:path`, a free note) — a design note
   * wairon never resolves; or a MODELED reference `component:<id>` pointing at
   * the Adapter/Store that provides the secret — validated to resolve, be an
   * Adapter/Store, and be wired to the presenter (a checked graph edge). The
   * actual secret is never stored here. Absence on a call into a Portal whose
   * `auth ≠ none` warns (PORTAL_AUTH_UNMET), so credential loading is never
   * overlooked.
   */
  auth: z.object({ from: z.string(), note: z.string().optional() }).optional(),
  assertsGuarantees: z.array(GuaranteeSchema).optional(),
  /**
   * Declared entity invariants this step upholds, as "<type-id>.<invariant-id>"
   * references (type id optionally subsystem-qualified). The invariant-backing
   * rule resolves each against the entity's declared invariants
   * (UNKNOWN_INVARIANT_REF) and counts the step as the write-path assertion the
   * entity's write methods must carry (UNASSERTED_INVARIANT otherwise).
   */
  assertsInvariants: z.array(z.string()).optional(),

  // --- flow config (per type; validated by narrative-step-config) -----------
  condition: z.string().optional(),        // branch; loop (while/doWhile)
  onTrueStep: z.number().int().positive().optional(),  // branch (default: next step)
  onFalseStep: z.number().int().positive().optional(), // branch (required)
  on: z.string().optional(),               // switch: the dispatched value
  cases: z.array(SwitchCaseSchema).optional(),          // switch (required)
  defaultStep: z.number().int().positive().optional(),  // switch (default: next step)
  loopKind: LoopKindSchema.optional(),     // loop (default: forEach when `over`, else while)
  over: z.string().optional(),             // loop (forEach/for): iteration source
  endStep: z.number().int().positive().optional(),      // loop/try/parallel: last step of the body region
  catches: z.array(CatchClauseSchema).optional(),        // try
  finallyStep: z.number().int().positive().optional(),   // try: first step of the always-runs region
  branches: z.array(ParallelBranchSchema).optional(),    // parallel (required, >= 2 arms)
  toStep: z.number().int().positive().optional(),        // jump (required)
  /**
   * call/dispatch only: fire-and-forget — the call is issued and this
   * narrative CONTINUES without awaiting the result (no result is consumed
   * by later steps). Language/platform packs may gate it via unsupportedFlow.
   */
  detach: z.boolean().optional(),
  outcome: z.string().optional(),          // return: 'success' / 'not found' / …
  error: z.string().optional(),            // throw: the raised error
});

export type NarrativeStep = z.infer<typeof NarrativeStepSchema>;

// ---------------------------------------------------------------------------
// Level 4: Implementation Spec (implementations/*.yaml)
// ---------------------------------------------------------------------------

/**
 * The narrative detail dial — declared per method (or per spec as a default),
 * IN the implementation spec. Absent = the component stereotype's default
 * (Portal/Observer/Adapter → calls-only, Store/Index/Query/Registry → intent,
 * everything else → full). Levels are floors, not ceilings.
 */
export const NarrativeDetailSchema = z.enum(['full', 'calls-only', 'intent']);
export type NarrativeDetail = z.infer<typeof NarrativeDetailSchema>;

/**
 * The conformance dial — declared per method (or per spec as a
 * default), mirroring the narrative detail dial. Absent = the component
 * stereotype's default (Portal → anchored, everything else → declared).
 * `declared` requires a declaration-tier anchor for each contract method in
 * the sourcePath file; `anchored` also accepts exact string-literal
 * occurrences (tool/route registrations); `off` skips method checks for
 * generated/vendored code (the sourcePath existence check always applies).
 */
export const ConformanceTierSchema = z.enum(['declared', 'anchored', 'off']);
export type ConformanceTier = z.infer<typeof ConformanceTierSchema>;

export const MethodImplementationSchema = z.object({
  name: z.string(), // Must match a method name in the L3 interface contract
  /**
   * The source file realizing THIS method when it is not the implementation's
   * sourcePath, such as a command whose body lives in its own file; the
   * implementation's sourcePath is the default. Relative to the root of the
   * project holding the spec (a chained subproject's own root).
   */
  sourcePath: z.string().optional(),
  narrative: z.array(NarrativeStepSchema).default([]), // Level 5 Narrative
  /** Detail level for THIS method (overrides the spec-level default). */
  detail: NarrativeDetailSchema.optional(),
  /**
   * Behavioral specification as prose — the narrative substitute at
   * detail: intent. Subject to the INTENT_FLOOR check: non-trivial, and
   * failure behavior stated here or in the contract's guarantees.
   */
  intent: z.string().optional(),
  /** Conformance tier for THIS method (overrides the spec-level default). */
  conformance: ConformanceTierSchema.optional(),
  /**
   * The code-level name realizing this contract method in the sourcePath
   * file, when it legitimately differs from the intent-language contract
   * name — e.g. a store's `put` realized by `saveSnapshot`.
   */
  symbol: z.string().optional(),
  /** Opaque pack/tool extension data (see ExtDataSchema) — preserved verbatim. */
  ext: ExtDataSchema.optional(),
});

export type MethodImplementation = z.infer<typeof MethodImplementationSchema>;

export const ImplementationSpecSchema = z.object({
  id: SpecIdSchema,
  name: z.string(),
  description: z.string(),
  contract: z.string(), // References L3 Interface id
  sourcePath: z.string().optional(), // Path to the concrete source code file (e.g. "src/storage/vfs.ts")
  /**
   * The committed integration-sim harness for this implementation (N:1
   * sharing allowed, like sourcePath — one subsystem sim may cover several
   * components). The integration-conformance rule proves the harness EXISTS
   * and its import graph WIRES the real modules (this component's and each
   * direct dependency's); whether it passes is CI's job. Declaring the first
   * simPath in a subsystem activates MISSING_INTEGRATION_SIM for that
   * subsystem's other complete non-leaf implementations.
   */
  simPath: z.string().optional(),
  /**
   * External technologies (vendor, engine, SDK, service) this implementation
   * binds to — e.g. ["mysql"], ["sendgrid"]. Declaring one makes this
   * component's ownership tree the technology's home: references anywhere
   * outside it are flagged (TECH_LEAKAGE), contract identifiers must stay
   * intent-language (VENDOR_NAME_IN_CONTRACT), and only data-layer
   * stereotypes should bind tech directly (TECH_ON_LOGIC_COMPONENT).
   */
  technologies: z.array(z.string()).optional(),
  methods: z.array(MethodImplementationSchema).default([]),
  /** Spec-level narrative detail default for all methods (each may override). */
  detail: NarrativeDetailSchema.optional(),
  /** Spec-level conformance tier default (each method may override). */
  conformance: ConformanceTierSchema.optional(),
  /** Per-spec lint suppressions (see LintConfigSchema). */
  lint: LintConfigSchema.optional(),
  /** Opaque pack/tool extension data (see ExtDataSchema) — preserved verbatim. */
  ext: ExtDataSchema.optional(),
  status: SpecStatusSchema.optional().default('complete'),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export type ImplementationSpec = z.infer<typeof ImplementationSpecSchema>;

/**
 * The file a method is realized in: its own sourcePath, else the
 * implementation's sourcePath passed in, else none
 * (method_implementation.sourceFile).
 */
export function methodSourceFile(
  method: Pick<MethodImplementation, 'sourcePath'>,
  implementationSourcePath?: string,
): string | undefined {
  return method.sourcePath || implementationSourcePath || undefined;
}

/**
 * The narrative detail a method is held to (resolved_detail), and whether the
 * method or its implementation set it rather than it defaulting from the
 * component's type.
 */
export interface ResolvedDetail {
  level: NarrativeDetail;
  /** True when declared on the method or its implementation (as opposed to the component type's default). */
  explicit: boolean;
}

/**
 * method_implementation.effectiveDetail — the narrative detail this method is
 * held to: its own detail, else the implementation's, else the component's
 * default (component_spec.defaultNarrativeDetail); explicit when either of the
 * first two set it.
 */
export function effectiveDetail(
  method: Pick<MethodImplementation, 'detail'>,
  implementation: Pick<ImplementationSpec, 'detail'>,
  component?: Pick<ComponentSpec, 'componentType'>,
): ResolvedDetail {
  if (method.detail) return { level: method.detail, explicit: true };
  if (implementation.detail) return { level: implementation.detail, explicit: true };
  return { level: defaultNarrativeDetail(component), explicit: false };
}

/**
 * method_implementation.cognitiveScore — the cognitive weight of this
 * method's narrative: a branch, switch, loop or parallel step counts one plus
 * its nesting depth; each catch clause of a try counts the same (the try step
 * itself scores nothing on its own); each jump counts one, flat, regardless
 * of nesting. Nesting depth is the number of loop/try/parallel regions
 * (header step through its endStep) that STRICTLY contain the step — a step
 * at n is inside a region [a, b] when n > a and n <= b — so a flat sequence
 * of call and local steps scores zero however long it is.
 */
export function cognitiveScore(method: Pick<MethodImplementation, 'narrative'>): number {
  const steps = method.narrative ?? [];
  const regions = steps
    .filter((s) => (s.type === 'loop' || s.type === 'try' || s.type === 'parallel') && s.endStep !== undefined)
    .map((s) => ({ start: s.stepNumber, end: s.endStep as number }));
  const nestingDepthAt = (stepNumber: number): number =>
    regions.filter((r) => stepNumber > r.start && stepNumber <= r.end).length;

  let score = 0;
  for (const s of steps) {
    switch (s.type) {
      case 'branch':
      case 'switch':
      case 'loop':
      case 'parallel':
        score += 1 + nestingDepthAt(s.stepNumber);
        break;
      case 'try':
        for (const c of s.catches ?? []) score += 1 + nestingDepthAt(c.step);
        break;
      case 'jump':
        score += 1;
        break;
      default:
        break;
    }
  }
  return score;
}

/**
 * method_implementation.complexityLevel — the band its cognitiveScore falls
 * in: linear (0), simple (1-4), moderate (5-9), complex (10-19) or severe (20
 * and above). The band, not the raw score, is what a threshold is configured
 * against.
 */
export function complexityLevel(method: Pick<MethodImplementation, 'narrative'>): string {
  const score = cognitiveScore(method);
  if (score >= 20) return 'severe';
  if (score >= 10) return 'complex';
  if (score >= 5) return 'moderate';
  if (score >= 1) return 'simple';
  return 'linear';
}

/**
 * Every source file an implementation names — its own sourcePath, then each
 * method's — deduplicated, in declaration order
 * (implementation_spec.sourceFiles). The simPath harness is not a source file
 * of the implementation and is never included.
 */
export function implementationSourceFiles(
  impl: Pick<ImplementationSpec, 'sourcePath'> & { methods?: ReadonlyArray<Pick<MethodImplementation, 'sourcePath'>> },
): string[] {
  const files: string[] = [];
  const add = (file: string | undefined): void => {
    if (file && !files.includes(file)) files.push(file);
  };
  add(impl.sourcePath);
  for (const method of impl.methods ?? []) add(method.sourcePath);
  return files;
}

// ---------------------------------------------------------------------------
// Types: entities and value objects (the data the components operate on).
// Defined once by their owner; referenced — never redefined — elsewhere.
// ---------------------------------------------------------------------------
export const TypeKindSchema = z.enum(['entity', 'value-object']);
export type TypeKind = z.infer<typeof TypeKindSchema>;

export const TypeFieldSchema = z.object({
  name: z.string(),
  // A primitive, or another type id (qualified across subsystems, e.g.
  // "billing.Invoice") — on its own or inside a generic, an array or a union
  // ("Invoice[] | null"). See the grammar on src/models/type-references.ts.
  type: z.string(),
  description: z.string().optional(),
  optional: z.boolean().default(false),
  /**
   * Identity marker for ERD / database schema derivation:
   * - 'primary' (PK)
   * - 'unique' (UK)
   * - 'foreign' (FK)
   */
  key: z.enum(['primary', 'unique', 'foreign']).optional(),
  /**
   * For foreign keys, the referenced type/table ID (e.g. "billing.Invoice")
   * and optionally field (e.g. "billing.Invoice.id").
   */
  references: z.string().optional(),
});
export type TypeField = z.infer<typeof TypeFieldSchema>;

/** A pure, self-contained method on an entity (no external collaborators). */
export const TypeMethodSchema = z.object({
  name: z.string(),
  signature: z.string(),
  returns: z.string(),
  description: z.string().optional(),
  /**
   * Source file realizing this method when it is not the type's own
   * sourcePath. A type's pure methods routinely live apart from its
   * declaration: the declaration is a struct or an interface, the methods are
   * free functions, and a language without methods-on-data has nowhere else
   * to put them.
   */
  sourcePath: z.string().optional(),
  /**
   * The code-level name realizing this method, when it legitimately differs
   * from the method name — e.g. `narrative_step.foreignFields` realized by
   * `narrativeStepForeignFields`, the free-function form a pure type method
   * takes in a language whose data carries no methods.
   */
  symbol: z.string().optional(),
});
export type TypeMethod = z.infer<typeof TypeMethodSchema>;

/**
 * A declared domain invariant on an entity — a property every write path must
 * uphold (e.g. "slug unique among siblings"). A DECLARATION, not a proof: the
 * invariant-backing rule checks that each write-effect method of the entity's
 * componentClass carries a narrative step asserting it (assertsInvariants) —
 * it never verifies the narrative actually enforces the property. It catches
 * "nobody considered this here", not incorrectness.
 */
export const InvariantSchema = z.object({
  /** Stable invariant id, unique within the entity (referenced as "<type-id>.<invariant-id>"). */
  id: SpecIdSchema,
  /** The property that must hold, stated precisely enough to test against. */
  description: z.string().min(1),
});
export type Invariant = z.infer<typeof InvariantSchema>;

export const TypeSpecSchema = z.object({
  kind: TypeKindSchema, // discriminator — entity | value-object
  id: SpecIdSchema,
  name: z.string(),
  description: z.string().optional(),
  /** Owning subsystem id (entities). Omit for system-level shared value objects. */
  subsystem: z.string().optional(),
  /** Optional logical group ID to organize this type in subfolders. */
  group: z.string().optional(),
  fields: z.array(TypeFieldSchema).default([]),
  /** Pure intrinsic behaviour only — anything needing a collaborator belongs on a component. */
  methods: z.array(TypeMethodSchema).default([]),
  /**
   * Linked Component ID if this system entity is implemented as a class Component
   * (e.g., a Store or Registry that owns this entity's lifecycle and methods).
   */
  componentClass: z.string().optional(),
  /**
   * Declared domain invariants on this entity (see InvariantSchema). Anchored
   * through componentClass: its write-effect contract methods must each carry
   * a narrative step asserting every declared invariant.
   */
  invariants: z.array(InvariantSchema).optional(),
  /**
   * The database ID this schema belongs to (marks it as a database table schema).
   */
  database: z.string().optional(),
  /**
   * The database table name for this schema (e.g., "users").
   */
  table: z.string().optional(),
  /**
   * If this type is a database table schema, the ID of the corresponding
   * logical system entity type it maps to.
   */
  linkedEntity: z.string().optional(),
  /**
   * The source file holding this type's declaration, and the default for
   * every method that names no sourcePath of its own. Relative to the root of
   * the project that holds the spec.
   *
   * Naming one turns the type into a CLAIM on code, judged exactly as an
   * implementation's sourcePath is: the file must resolve, and the
   * declaration must be anchored in it (UNREALIZED_TYPE). A type that names
   * none claims nothing and is never reported.
   */
  sourcePath: z.string().optional(),
  /**
   * The code-level name realizing this type's declaration, when it
   * legitimately differs from `name` — a type named "Invoice Line" declared
   * as `InvoiceLine`.
   */
  symbol: z.string().optional(),
  /** Per-spec lint suppressions (see LintConfigSchema). */
  lint: LintConfigSchema.optional(),
  /** Opaque pack/tool extension data (see ExtDataSchema) — preserved verbatim. */
  ext: ExtDataSchema.optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type TypeSpec = z.infer<typeof TypeSpecSchema>;

/**
 * Every source file a type names — its own sourcePath, then each method's —
 * deduplicated, in declaration order (type_spec.sourceFiles).
 */
export function typeSourceFiles(
  type: Pick<TypeSpec, 'sourcePath'> & { methods?: ReadonlyArray<Pick<TypeMethod, 'sourcePath'>> },
): string[] {
  const files: string[] = [];
  const add = (file: string | undefined): void => {
    if (file && !files.includes(file)) files.push(file);
  };
  add(type.sourcePath);
  for (const method of type.methods ?? []) add(method.sourcePath);
  return files;
}

// ---------------------------------------------------------------------------
// Surface snapshots — the portable, contract-grade public-surface artifact
// (Public Surface Exchange). One format, three origins: generated (own
// parent/child family), exchanged (another wairon project), authored (an
// external 3rd-party system, hand-declared or imported from OpenAPI).
// ---------------------------------------------------------------------------

export const SurfaceOriginSchema = z.enum(['generated', 'exchanged', 'authored']);
export type SurfaceOrigin = z.infer<typeof SurfaceOriginSchema>;

/** A self-contained type definition embedded in a snapshot (closure member). */
export const SurfaceTypeDefSchema = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.string().default('value-object'),
  fields: z.array(z.object({
    name: z.string(),
    type: z.string(),
    description: z.string().optional(),
    optional: z.boolean().optional(),
  })).default([]),
});
export type SurfaceTypeDef = z.infer<typeof SurfaceTypeDefSchema>;

/** One exported interface at CONTRACT grade — full methods + dispatch table. */
export const SurfaceContractEntrySchema = z.object({
  id: z.string(),
  name: z.string(),
  /** Exposure level of the L0 entry (see SurfaceAudienceSchema). */
  audience: z.string().default('instance'),
  /** Transport kind: REST, GraphQL, MessageBus, RPC, or Custom. */
  type: z.string().default('Custom'),
  /** Local name of the backing Portal in the producing project. */
  component: z.string(),
  /** Full contract methods (params, returns, guarantees, effect, endpoint). */
  methods: z.array(MethodSignatureSchema).default([]),
  /** The backing portal's capability dispatch table, when generic-dispatch. */
  dispatch: z.array(DispatchBindingSchema).optional(),
  details: z.string().default(''),
  version: z.string().optional(),
  stability: z.string().optional(),
  /** Projected copy of the backing Portal's auth (see PortalAuthSchema) — the codec
   *  emits it as OpenAPI securitySchemes/security. */
  auth: PortalAuthSchema.optional(),
  /** The backing Portal's basePath — becomes the per-portal OpenAPI `servers` url. */
  basePath: z.string().optional(),
});
export type SurfaceContractEntry = z.infer<typeof SurfaceContractEntrySchema>;

export const SurfaceSnapshotSchema = z.object({
  /** Producing project/system name — the snapshot's resolution identity. */
  projectName: z.string(),
  origin: SurfaceOriginSchema,
  /** Producing spec tree's StateId at generation time (wairon-produced snapshots). */
  stateId: z.string().optional(),
  /** Contract version for authored/3rd-party surfaces without a StateId. */
  version: z.string().optional(),
  generatedAt: z.string(),
  interfaces: z.array(SurfaceContractEntrySchema).default([]),
  /** Transitive type closure of every exported signature — self-contained. */
  types: z.array(SurfaceTypeDefSchema).default([]),
});
export type SurfaceSnapshot = z.infer<typeof SurfaceSnapshotSchema>;

/** One rendered per-portal OpenAPI document (see the codec's toOpenApiSet). */
export const NamedOpenApiSpecSchema = z.object({
  portalId: z.string(),
  name: z.string(),
  document: z.string(),
});
export type NamedOpenApiSpec = z.infer<typeof NamedOpenApiSpecSchema>;

export const GroupSpecSchema = z.object({
  kind: z.literal('group'),
  id: SpecIdSchema,
  name: z.string(),
  description: z.string().optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type GroupSpec = z.infer<typeof GroupSpecSchema>;
