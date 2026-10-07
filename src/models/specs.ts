import { z } from 'zod';

// ---------------------------------------------------------------------------
// Common Identifier Schema
// ---------------------------------------------------------------------------
/**
 * The names Windows reserves for devices: `con`, `prn`, `aux`, `nul`,
 * `com0`-`com9` and `lpt0`-`lpt9`, in any case and with any extension-like
 * suffix (`aux.yaml` is the device too). A file or folder of that name cannot
 * be created, checked out or `git add`-ed on Windows, so an id that becomes a
 * path segment must never be one — refused on EVERY platform, because a tree
 * written on Linux is checked out on Windows. (`com0`/`lpt0` are listed by
 * Microsoft's own naming rules beside 1-9.)
 */
export const WINDOWS_RESERVED_NAME_RE = /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i;

/** Whether a path segment is a name Windows reserves for a device (see WINDOWS_RESERVED_NAME_RE). */
export function isWindowsReservedName(name: string): boolean {
  return WINDOWS_RESERVED_NAME_RE.test(name);
}

/**
 * The longest spec id. An id is a folder and a file name under `.wai/specs/`
 * (`<subsystem>/<component>/.implementation.yaml`, a generated agent file),
 * and git for Windows refuses paths over 260 characters by default
 * (core.longpaths off), while NTFS refuses a single segment over 255 — the
 * 270-character id of the round-4 trial died on a raw ENOENT. 64 keeps two
 * nested ids plus the file name near 150 characters, leaving the rest of the
 * 260 for the checkout's own path, and is no real constraint on a name (a
 * DNS label or a Kubernetes name stops at 63).
 */
export const MAX_SPEC_ID_LENGTH = 64;

export const SpecIdSchema = z.string()
  .regex(/^[a-z0-9-_]+$/, 'Identifier must be lowercase alphanumeric with dashes or underscores')
  .max(MAX_SPEC_ID_LENGTH, `Identifier is longer than ${MAX_SPEC_ID_LENGTH} characters: an id becomes a folder and a file name, and a longer one breaks the path limits of a Windows checkout`)
  .regex(/^(?!(?:con|prn|aux|nul|com[0-9]|lpt[0-9])$)/, 'Identifier is a name Windows reserves for a device (con, prn, aux, nul, com0-9, lpt0-9): no Windows checkout could hold its file, and `git add` fails for the whole repository — choose another id (e.g. "aux_store", "console")');

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

/** How the canvas routes its edges. */
export const DiagramLineStyleSchema = z.enum(['bezier', 'straight', 'taxi']);
export type DiagramLineStyle = z.infer<typeof DiagramLineStyleSchema>;

/** Which view the canvas opens on (and the view a share link captures). */
export const DiagramViewSchema = z.enum(['architecture', 'types', 'databases', 'network']);
export type DiagramView = z.infer<typeof DiagramViewSchema>;

export const DiagramConfigSchema = z.object({
  lineStyle: DiagramLineStyleSchema.optional(),
  defaultView: DiagramViewSchema.optional(),
  showDatabases: z.boolean().optional(),
});
export type DiagramConfig = z.infer<typeof DiagramConfigSchema>;

// ---------------------------------------------------------------------------
// Reachability vocabulary: how a Portal's verbs are reached, and from where.
// ---------------------------------------------------------------------------

/**
 * How callers reach a Portal's verbs. ONE vocabulary: the Portal's own
 * `transport` and the endpoint's discriminator. Network transports (HTTP,
 * gRPC, GraphQL, MessageBus, Custom) cross a network, take scoped entries and
 * produce flows; local ones (CLI, NamedPipe, IPC, JSONRPC) stay on one host;
 * InProcess is a library call that binds no endpoint. The retired portalType
 * spelling HTTP_API is read as HTTP for one release (readRetiredReachForms).
 */
export const TransportSchema = z.enum(['HTTP', 'gRPC', 'GraphQL', 'MessageBus', 'CLI', 'NamedPipe', 'IPC', 'JSONRPC', 'InProcess', 'Custom']);
export type Transport = z.infer<typeof TransportSchema>;

/** What crossing a transport makes: only network transports take scopes, fall under the gateway rule and produce flows. */
export const TransportKindSchema = z.enum(['network', 'local', 'in-process']);
export type TransportKind = z.infer<typeof TransportKindSchema>;

/**
 * transport.kind — network for HTTP, gRPC, GraphQL, MessageBus and Custom;
 * local for CLI, NamedPipe, IPC and JSONRPC; in-process for InProcess. Pure.
 */
export function transportKind(transport: Transport): TransportKind {
  switch (transport) {
    case 'CLI':
    case 'NamedPipe':
    case 'IPC':
    case 'JSONRPC':
      return 'local';
    case 'InProcess':
      return 'in-process';
    default:
      return 'network';
  }
}

/**
 * transport.requiresEndpoint — whether each verb of a Portal on this transport
 * needs an endpoint binding: every transport except InProcess (the verb is the
 * contract method itself) and Custom (the free-form escape hatch). Pure.
 */
export function transportRequiresEndpoint(transport: Transport): boolean {
  return transport !== 'InProcess' && transport !== 'Custom';
}

/** The derived export kinds an entry is shown as (the legacy authored `type`). */
export const PublicInterfaceTypeSchema = z.enum(['REST', 'GraphQL', 'MessageBus', 'RPC', 'Custom']);
export type PublicInterfaceType = z.infer<typeof PublicInterfaceTypeSchema>;

/**
 * transport.exportKind — the export kind a published entry backed by a Portal
 * on this transport is shown as, derived instead of authored: HTTP is REST,
 * gRPC and JSONRPC are RPC, GraphQL and MessageBus are themselves, and
 * InProcess, CLI, IPC, NamedPipe and Custom are Custom. Pure.
 */
export function transportExportKind(transport: Transport): PublicInterfaceType {
  switch (transport) {
    case 'HTTP': return 'REST';
    case 'gRPC':
    case 'JSONRPC': return 'RPC';
    case 'GraphQL': return 'GraphQL';
    case 'MessageBus': return 'MessageBus';
    default: return 'Custom';
  }
}

/**
 * The retired portalType spellings and the transport each is read as. Only
 * HTTP was spelled differently; the others keep their names.
 */
export const RETIRED_PORTAL_TYPE_SPELLINGS: Readonly<Record<string, Transport>> = { HTTP_API: 'HTTP' };

/**
 * Where the callers of an entry come from, relative to the component: outside
 * the innermost declared network around it (the default), or inside it.
 */
export const EntryScopeSchema = z.enum(['outside', 'network']);
export type EntryScope = z.infer<typeof EntryScopeSchema>;

/** What consumers do with an exported contract: call it (the default) or implement it (an extension point). */
export const ExportRoleSchema = z.enum(['call', 'implement']);
export type ExportRole = z.infer<typeof ExportRoleSchema>;

/**
 * Who invokes a method from outside the modelled narrative graph: `entry`
 * (callers outside the design reach a Portal verb over its transport) or
 * `runtime` (the process's own runtime: a composition root, scheduler, signal
 * or framework callback). The retired kinds `external` and `sibling-subsystem`
 * are read compatibly for one release (readRetiredReachForms) and never
 * authored.
 */
export const InvocationKindSchema = z.enum(['entry', 'runtime']);
export type InvocationKind = z.infer<typeof InvocationKindSchema>;

/** The invokedBy kinds the reachability model retired, read compatibly for one release. */
export const RETIRED_INVOCATION_KINDS: ReadonlySet<string> = new Set(['external', 'sibling-subsystem']);

/**
 * A declared invocation from outside the modelled narrative graph, on an L3
 * contract method or on a Portal component (the entry every verb inherits; a
 * verb may override only its scope). Seeds unused-detection. The caller prose
 * is checked by INVOKED_BY_UNDESCRIBED, so a missing one parses and is
 * reported rather than refused.
 */
export const DeclaredInvocationSchema = z.object({
  kind: InvocationKindSchema,
  caller: z.string().optional(),
  /** Entry on a network transport only: outside (the default) or network. */
  scope: EntryScopeSchema.optional(),
});
export type DeclaredInvocation = z.infer<typeof DeclaredInvocationSchema>;

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
  /** Legacy public name, read as `as` when `as` is absent. */
  id: z.string().optional(),
  name: z.string().optional(),
  /** Legacy source subsystem, read as `from` when `from` is absent. */
  subsystem: z.string().optional(),
  /** The component re-exported one to one; without it and without `typeDef`, a wildcard. */
  component: z.string().optional(),
  /** The L3 interface the export narrows to. */
  interface: z.string().optional(),
  /** The source subsystem the entry re-exports from. */
  from: z.string().optional(),
  /** A type exported as is, giving it a public name. */
  typeDef: z.string().optional(),
  /** The public name: defaults to `id`, then `interface`, then `component` or `typeDef`. */
  as: z.string().optional(),
  /**
   * LEGACY, no longer authored: the export kind is derived from the backing
   * Portal's transport (transportExportKind). Read compatibly for one release
   * and recorded as a retired reach fact; doctor --fix drops or reports it.
   */
  type: z.string().optional(),
  details: z.string().optional(),
  /** Exposure ceiling (see SurfaceAudienceSchema). Defaults to 'instance' at projection time. */
  audience: z.string().optional(),
  authPolicy: z.string().optional(),
  version: z.string().optional(),
  stability: z.string().optional(),
  /** What consumers do with the entry: call it (the default) or implement it (an extension point). */
  role: ExportRoleSchema.optional(),
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
/**
 * One entry of a subsystem's export table. An OWN item binds details to a
 * component (or a type) the subsystem owns; a RE-EXPORT names another
 * subsystem of the project in `from` and one component, interface narrowing or
 * type from that subsystem's table, optionally renamed with `as` — `from` alone
 * re-exports everything it exports. A re-export inherits its target's details,
 * so only an own component item must state them. The export kind is derived
 * from the backing Portal's transport; an authored `type` is legacy.
 */
export const PublicInterfaceSchema = z.object({
  /**
   * LEGACY, no longer authored: derived from the backing Portal's transport
   * (transportExportKind). Read compatibly for one release and recorded as a
   * retired reach fact.
   */
  type: PublicInterfaceTypeSchema.optional(),
  /** Consumer-facing description of an own item; a re-export inherits its target's. */
  details: z.string().optional(),
  /** For an own item, the L2 component that realizes it; for a re-export, the component re-exported from `from`. */
  component: SpecIdSchema.optional(),
  /** Optional L3 interface the entry narrows to. */
  interface: SpecIdSchema.optional(),
  /** Re-export source: another subsystem of the same project. */
  from: SpecIdSchema.optional(),
  /** A type exported as is: owned by this subsystem, or re-exported from `from`. */
  typeDef: SpecIdSchema.optional(),
  /** The public name; defaults to the narrowed interface, then the component or type id. */
  as: z.string().optional(),
  /**
   * The subsystems this surface is published to. Absent, anyone may depend on
   * it; present, only these subsystems may — when every entry publishing the
   * component names consumers, the union of those lists is the whole set.
   */
  consumers: z.array(SpecIdSchema).optional(),
  /** What consumers do with the entry: call it (the default) or implement it (an extension point an Adapter may back). */
  role: ExportRoleSchema.optional(),
}).refine(pi => pi.from !== undefined || pi.typeDef !== undefined || pi.details !== undefined, {
  message: 'An own component entry states its `details`; only a re-export (`from`) or a type export (`typeDef`) may leave them out. Its export kind is derived from the backing Portal\'s transport, so `type` is no longer authored.',
  path: ['details'],
});

export type PublicInterface = z.infer<typeof PublicInterfaceSchema>;

/** Whether an L1 entry is an OWN component item — neither a re-export nor a type export. */
export function isOwnComponentEntry(pi: PublicInterface): boolean {
  return pi.from === undefined && pi.typeDef === undefined;
}

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
 * WARNING- and NOTICE-severity findings of the named code on THIS spec only; error
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

/** The flow a declared lifecycle entrypoint roots. */
export const LifecyclePhaseSchema = z.enum(['init', 'shutdown', 'cyclic', 'interrupt', 'scheduled']);
export type LifecyclePhase = z.infer<typeof LifecyclePhaseSchema>;

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
  phase: LifecyclePhaseSchema,
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

/** Where an apiKey scheme's key travels. */
export const ApiKeyLocationSchema = z.enum(['header', 'query', 'cookie']);
export type ApiKeyLocation = z.infer<typeof ApiKeyLocationSchema>;

/** The OAuth2 flow an oauth2 scheme uses. */
export const OAuthFlowSchema = z.enum(['authorizationCode', 'clientCredentials', 'implicit', 'password']);
export type OAuthFlow = z.infer<typeof OAuthFlowSchema>;

export const PortalAuthSchema = z.object({
  scheme: PortalAuthSchemeSchema,
  in: ApiKeyLocationSchema.optional(),
  name: z.string().optional(),
  bearerFormat: z.string().optional(),
  authorizationUrl: z.string().optional(),
  tokenUrl: z.string().optional(),
  refreshUrl: z.string().optional(),
  scopes: z.array(z.object({ name: z.string(), description: z.string() })).optional(),
  flow: OAuthFlowSchema.optional(),
  openIdConnectUrl: z.string().optional(),
  description: z.string().optional(),
  example: z.string().optional(),
});
export type PortalAuth = z.infer<typeof PortalAuthSchema>;

/**
 * A spec's RENAME TRACE: every id it held before, oldest first. Written only by
 * the rename tools (renameComponent, renameType), never by an author, and never
 * rewritten or bound as a reference — it names keys that no longer exist, so it
 * is deliberately absent from the reference-field table. The design export
 * shows it as `formerly`. Another spec of the same kind may not take an id
 * listed here (id-retired at write, RENAME_TRACE_CONFLICT on a hand edit);
 * unsetting it releases those ids.
 */
export const PreviousIdsSchema = z.array(z.string().min(1));

/**
 * A contract method's rename trace: every key it held before, oldest first,
 * each `<interface id>.<method name>` — a rename keeps the interface and
 * changes the name, a move changes the interface. Written only by renameMethod
 * and moveMethods; like PreviousIdsSchema never rewritten or bound.
 */
export const PreviousNamesSchema = z.array(z.string().min(1));

/** The holders spec_index.retiredBy reads: each kind's specs with their rename traces. */
export interface RenameTraceHolders {
  components: ReadonlyArray<{ id: string; previousIds?: string[] }>;
  interfaces: ReadonlyArray<{ id: string; previousIds?: string[] }>;
  implementations: ReadonlyArray<{ id: string; previousIds?: string[] }>;
  types: ReadonlyArray<{ id: string; subsystem?: string; previousIds?: string[] }>;
}

/**
 * spec_index.retiredBy — the spec of this kind whose rename trace
 * (previousIds) lists `id`, or none: the holder that retired it, named by its
 * key (a subsystem-owned type by `subsystem::id`). A trace entry is read
 * within its holder's own namespace — a type's within its owner, a member's
 * spec within its member — so a bare entry is qualified as the holder's own id
 * is. The writer and the rename tools ask it before giving an id to a new
 * spec, and refuse with id-retired naming the holder. Pure, so every
 * subsystem that holds an index asks it the same way.
 */
export function specIndexRetiredBy(index: RenameTraceHolders, kind: string, id: string): string | undefined {
  const holders: ReadonlyArray<{ id: string; subsystem?: string; previousIds?: string[] }> =
    kind === 'component' ? index.components
      : kind === 'interface' ? index.interfaces
        : kind === 'implementation' ? index.implementations
          : kind === 'type' ? index.types
            : [];
  for (const holder of holders) {
    if (!holder.previousIds?.length) continue;
    const key = kind === 'type' && holder.subsystem && !holder.id.startsWith(`${holder.subsystem}::`)
      ? `${holder.subsystem}::${holder.id}`
      : holder.id;
    const cut = key.lastIndexOf('::');
    const namespace = cut >= 0 ? key.slice(0, cut + 2) : '';
    for (const previous of holder.previousIds) {
      const previousKey = previous.includes('::') ? previous : namespace + previous;
      if (previousKey === id) return key;
    }
  }
  return undefined;
}

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
  /**
   * On a Portal (and expected on every Portal): how callers reach its verbs
   * (see TransportSchema). Replaces the retired portalType, which the loader
   * reads compatibly for one release (HTTP_API as HTTP). Which process serves
   * which Portal is implementation: there are no listener mounts. On an
   * Adapter, optional: the transport it calls its target Portal over —
   * inferred from the target when absent, and ADAPTER_TRANSPORT_MISMATCH when
   * stated and different from the target's. On no other block.
   */
  transport: TransportSchema.optional(),
  /**
   * Portal-only, InProcess only: how a foreign language links this library
   * verb set — `c` (a C-ABI shared library, DLL or FFI) or `wasm` (a
   * WebAssembly component). Absent means a native API in the project's
   * targetLanguage.
   */
  abi: z.string().optional(),
  /**
   * Portal-only: the entry every verb inherits (kind entry, with a scope on a
   * network transport); a verb's own invokedBy overrides only the scope. Never
   * defaulted by a tool and never invented by a migration.
   */
  invokedBy: DeclaredInvocationSchema.optional(),
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
  /** The rename trace (see PreviousIdsSchema). */
  previousIds: PreviousIdsSchema.optional(),
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

// A method's concrete wire endpoint — ONE generic field, discriminated by `transport`
// (the Portal's own transport, see TransportSchema), so HTTP / gRPC / GraphQL /
// MessageBus / NamedPipe / IPC / CLI / JSONRPC / Custom all bind
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
  z.object({ transport: z.literal('JSONRPC'), method: z.string() }),
  z.object({ transport: z.literal('Custom'), address: z.string() }),
]);
/** The transports a verb can bind an endpoint for: every transport but InProcess, whose verb is the contract method itself. */
export type EndpointTransport = Endpoint['transport'];
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
   * A type expression in the neutral type grammar (src/models/type-grammar.ts):
   * a primitive, a named type (`billing.Invoice`, `alias::name`), `list<T>`,
   * `set<T>`, `map<K, V>`, `T?`, a union of named types. Stored canonical; an
   * alias (`Invoice[]`, `Invoice | null`, `boolean`) is normalised on write.
   */
  type: z.string(),
  description: z.string().optional(),
  optional: z.boolean().optional(),
  /**
   * The parameter's rename trace: every name it held before, oldest first —
   * written by the rename-param tool, shown as `formerly` in the design export.
   */
  previousNames: z.array(z.string().min(1)).optional(),
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
  /** The default before project severity overrides and draft-context downgrades; a notice is reported but never fails the gate. */
  severity: z.enum(['error', 'warning', 'notice']),
  /** One line saying what the finding means. */
  summary: z.string().min(1, 'Finding summary must say what the finding means'),
});
export type FindingDeclaration = z.infer<typeof FindingDeclarationSchema>;

/**
 * What a contract method does to its component's held state, and whether it
 * reaches outside the process: `none` computes over its arguments only, `read`
 * observes held state, `write` modifies it, `lifecycle` creates or destroys an
 * entity's existence, `io` reaches files, the network, the clock or randomness.
 */
export const MethodEffectSchema = z.enum(['none', 'read', 'write', 'lifecycle', 'io']);
export type MethodEffect = z.infer<typeof MethodEffectSchema>;

/**
 * One contract method as a spec file STORES it (method_signature). The shape
 * on disk differs from the resolved shape every consumer types against
 * (MethodSignature below):
 *
 * - `signature` is DERIVED from name, params and returns whenever params are
 *   present (deriveMethodSignature), so it is optional on disk then, and absent
 *   from the stored form of a method naming a `signatureFrom`;
 * - `returns` is absent from the stored form of a method naming a
 *   `signatureFrom`, whose source supplies it on every load.
 *
 * The per-method requirements left are enforced where a stored method is
 * parsed (StoredMethodSignatureSchema). This object stays a plain ZodObject so
 * its shape can be read field by field (the MCP field-coverage suite does).
 */
export const MethodSignatureSchema = z.object({
  name: z.string().regex(/^[a-zA-Z0-9_]+$/, 'Method name must be alphanumeric'),
  description: z.string(),
  signature: z.string().optional(), // e.g. "save(key: string, data: Buffer): Promise<void>"
  // A type expression in the neutral grammar, at the returns position — the only
  // one `async T` and `void` may stand in: "async void", "Invoice?". Stored
  // canonical; see src/models/type-grammar.ts.
  returns: z.string().optional(),
  /** Structured parameters (authoritative for type checking when present). */
  params: z.array(MethodParamSchema).optional(),
  /**
   * Where this method takes its params and returns from instead of stating
   * them: a signature type (`billing.change_listener`, `alias::name`), or a
   * contract method `component.method` its component reaches along a
   * dependsOn/owns edge. Resolved both ways by the loader (signature_resolver);
   * the writer stores a sourced method with only its source.
   */
  signatureFrom: z.string().min(1).optional(),
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
   * What this method does to its component's held state: `read` observes it, `write`
   * modifies an entity's domain fields, and `lifecycle` creates, destroys, or
   * (un)registers an entity's existence or membership without modifying its fields —
   * closed under composition (a lifecycle method calls only read and lifecycle methods,
   * LIFECYCLE_CALLS_WRITE). Required on a durable Store's contract methods so the
   * durability round-trip rule can pair mutations with hydration read-backs
   * (MISSING_HYDRATION); a Supervisor may call a data component it does not own only
   * through read and lifecycle methods (SUPERVISOR_WRITE_SHORTCUT). Optional elsewhere.
   */
  effect: MethodEffectSchema.optional(),
  /**
   * Typed acknowledgment of a real caller OUTSIDE the modeled narrative graph
   * (see DeclaredInvocationSchema): an `entry` on a Portal verb (overriding the
   * Portal-level entry's scope), or a `runtime` hook. Unused-detection seeds
   * the method as an entrypoint, so reachability PROPAGATES through its
   * narrative — unlike a lint.allow, which only silences the finding. `caller`
   * states WHO invokes it (placeholder-thin prose is INVOKED_BY_UNDESCRIBED;
   * a runtime method the internal walk already reaches is INVOKED_BY_REDUNDANT).
   * Prefer a `register` narrative step when the wiring is internal — the
   * registration itself is then a modeled, checkable edge.
   */
  invokedBy: DeclaredInvocationSchema.optional(),
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
  /** The method's rename trace (see PreviousNamesSchema). */
  previousNames: PreviousNamesSchema.optional(),
  /** Opaque pack/tool extension data (see ExtDataSchema) — preserved verbatim. */
  ext: ExtDataSchema.optional(),
});

/** A method as a spec file holds it: what the writer writes and the loader parses. */
export type StoredMethodSignature = z.infer<typeof MethodSignatureSchema>;

/**
 * The stored method's own requirements: a method naming no signatureFrom states
 * its returns, and a prose signature unless params derive one. A method naming
 * a signatureFrom needs nothing more — and one that ALSO states params or
 * returns still parses, because the source wins at load and the validator
 * reports the restatement (only an authored write is refused for it).
 */
function requireStoredSignature(
  method: { signatureFrom?: string; params?: unknown; signature?: string; returns?: string },
  ctx: z.RefinementCtx,
): void {
  if (method.signatureFrom !== undefined) return;
  if (method.returns === undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['returns'], message: 'Required: a method without a signatureFrom states its returns' });
  }
  if (method.params === undefined && method.signature === undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['signature'], message: 'Required: a method without params or a signatureFrom states a prose signature' });
  }
}

/** The stored method with its per-method requirements — what an interface's methods list parses through. */
export const StoredMethodSignatureSchema = MethodSignatureSchema.superRefine(requireStoredSignature);

/**
 * The RESOLVED method every consumer reads: the loader always fills the
 * signature (derived from params, or the prose) and the returns (the method's
 * own, or its source's).
 */
export const ResolvedMethodSignatureSchema = MethodSignatureSchema.extend({
  signature: z.string(),
  returns: z.string(),
});
export type MethodSignature = z.infer<typeof ResolvedMethodSignatureSchema>;

/** The text one param shows in a derived signature: `name: type`, `name?: type` when optional. */
function paramText(p: Pick<MethodParam, 'name' | 'type' | 'optional'>): string {
  return `${p.name}${p.optional ? '?' : ''}: ${p.type}`;
}

/** The generic parameter list a stored text opens with (`find<T>(` gives `<T>`), angle brackets balanced; '' when none. */
function leadingGenericList(name: string, stored: string | undefined): string {
  if (!stored) return '';
  const text = stored.trimStart();
  if (!text.startsWith(name)) return '';
  let i = name.length;
  while (text[i] === ' ') i++;
  if (text[i] !== '<') return '';
  let depth = 0;
  for (let j = i; j < text.length; j++) {
    if (text[j] === '<') depth++;
    else if (text[j] === '>') depth--;
    if (depth === 0) {
      const rest = text.slice(j + 1).trimStart();
      return rest.startsWith('(') ? text.slice(i, j + 1) : '';
    }
  }
  return '';
}

/**
 * method_signature.derivedSignature (and type_method.derivedSignature) — the
 * signature text structured params determine: `name(a: T, b?: U): R`, each
 * param `name: type` in declared order with `?` after an optional one's name,
 * the types exactly as the params write them, then the returns. A generic list
 * the stored text opens with (`find<T>(`) is carried over, since nothing
 * structured declares it yet. Undefined for a method without params, whose
 * prose is its signature.
 */
export function deriveMethodSignature(
  method: { name: string; params?: ReadonlyArray<Pick<MethodParam, 'name' | 'type' | 'optional'>>; returns?: string; signature?: string },
): string | undefined {
  if (!method.params) return undefined;
  const generics = leadingGenericList(method.name, method.signature);
  return `${method.name}${generics}(${method.params.map(paramText).join(', ')}): ${method.returns ?? 'unknown'}`;
}

/**
 * method_signature.storedForm — the method as a spec file holds it: a method
 * naming a signatureFrom keeps the source and drops params, returns and
 * signature, which the source supplies on every load; a method with params has
 * its signature replaced by derivedSignature(); a prose method is returned as
 * it is. What every save writes, whoever saves.
 */
export function storedMethodSignature<M extends StoredMethodSignature>(method: M): StoredMethodSignature {
  if (method.signatureFrom !== undefined) {
    const { params: _params, returns: _returns, signature: _signature, ...rest } = method;
    return rest;
  }
  const derived = deriveMethodSignature(method);
  return derived === undefined ? method : { ...method, signature: derived };
}

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
  methods: z.array(StoredMethodSignatureSchema).default([]),
  /** The rename trace (see PreviousIdsSchema). */
  previousIds: PreviousIdsSchema.optional(),
  /** Per-spec lint suppressions (see LintConfigSchema). */
  lint: LintConfigSchema.optional(),
  /** Opaque pack/tool extension data (see ExtDataSchema) — preserved verbatim. */
  ext: ExtDataSchema.optional(),
  /**
   * The exported extension point this contract realizes, as alias::name:
   * another project's export entry with role implement. Every method of the
   * extension point is declared here with the same signature
   * (IMPLEMENTS_MISMATCH), and the methods count as reached, because the
   * producer calls them.
   */
  implements: z.string().min(1).optional(),
  status: SpecStatusSchema.optional().default('complete'),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

/** An interface as a spec file holds it: each method in its stored form. */
export type StoredInterfaceSpec = z.infer<typeof InterfaceSpecSchema>;
/**
 * An interface as the loader answers it: every method resolved
 * (MethodSignature). A schema of its own so the shape is one this file writes
 * out — and the type-shape check reads — rather than an Omit-and-intersect.
 */
export const ResolvedInterfaceSpecSchema = InterfaceSpecSchema.extend({
  methods: z.array(ResolvedMethodSignatureSchema).default([]),
});
export type InterfaceSpec = z.infer<typeof ResolvedInterfaceSpecSchema>;

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
   * The calls this method makes, when its narrative does not show them.
   *
   * The mirror of the contract's `invokedBy`: that declares the caller
   * OUTSIDE the modeled graph, this declares the callees INSIDE it. It lives
   * here and not on the L3 method because what a method CALLS is a property
   * of the realization — the detail dial that hides the steps is here, and two
   * implementations of one contract may reach different collaborators —
   * whereas an external caller is a fact about the contract's role that must
   * hold for every realization.
   *
   * Each entry names one target the way the debt register and a lint allow
   * name a unit: `<component>.<method>` (a `covers` entry is the same
   * spelling with the step number a declaration has no equivalent of). A
   * third vocabulary for "which method" would be the worse outcome.
   *
   * The narrative graph walk takes exactly these edges for a method with no
   * narrative, and NOTHING else: an undeclared collaborator is not reached,
   * so a lower detail dial no longer vouches for everything the component
   * declares. Each entry gets the same target validation a `call` step gets
   * (the component resolves, the caller declares it, the method is on its
   * contract) AND the same code↔spec reading (call-conformance, both
   * directions): an entry asserts the same call a step does, minus the
   * position in the flow that check never reads, so it can no more buy
   * reachability without the code than a step can. Refused beside a non-empty
   * narrative, where the steps already say what is called and a second
   * spelling could only disagree.
   */
  calls: z.array(z.string().min(1)).optional(),
  /**
   * The code-level name realizing this contract method in the sourcePath
   * file, when it legitimately differs from the intent-language contract
   * name — e.g. a store's `put` realized by `saveSnapshot`.
   */
  symbol: z.string().optional(),
  /**
   * The exported binding a consumer imports to REACH this method, when the
   * realization is published as a value that COMPOSES it rather than exported
   * in its own right — a rule module publishes `callConformanceRule`, and the
   * method is the `check` inside it.
   *
   * `symbol` cannot say this: it names the code-level name REALIZING the
   * contract method — the function itself — so a file whose whole published
   * surface is the composing value publishes a name no contract mentions, and
   * the surface check reads an unpromised export where the design has a
   * promised one. Naming the handle here is what closes that gap.
   *
   * A declaration, never a waiver: a handle the method's own source file
   * does not actually export is reported (UNREALIZED_EXPORT_HANDLE) and
   * allows nothing, so the field can never become a free-text suppression.
   */
  exportedVia: z.string().optional(),
  /** Opaque pack/tool extension data (see ExtDataSchema) — preserved verbatim. */
  ext: ExtDataSchema.optional(),
});

export type MethodImplementation = z.infer<typeof MethodImplementationSchema>;

/**
 * One `calls` entry read apart (declared_call): the component the reference
 * names and the method on it. Spelled `<component>.<method>` — the spelling
 * the conformance debt register and a lint allow name a unit with.
 */
export interface DeclaredCall {
  compId: string;
  methodName: string;
}

/**
 * method_implementation.parseCall — one `calls` entry split into the component
 * it names and the method on it, or null when it is not `<component>.<method>`.
 * Split at the LAST dot: a component id may be namespaced with `::` but never
 * holds a dot, and a method name is alphanumeric.
 */
export function parseDeclaredCall(ref: string): DeclaredCall | null {
  const at = ref.lastIndexOf('.');
  if (at <= 0 || at === ref.length - 1) return null;
  return { compId: ref.slice(0, at), methodName: ref.slice(at + 1) };
}

/**
 * technology — one entry of an implementation's `technologies`: a bare name
 * (`mysql`), which is also the token the technology-boundaries rule matches,
 * or `{ name, matches }` when the name is no usable marker of the technology.
 * The `yaml` package is named after the file format the whole tree talks
 * about, so its bare name reported every mention of the format as leaked
 * vendor text; `matches` names the tokens that DO mark it (a package phrase,
 * an API name), and only those are policed. The name stays the label.
 */
export const TechnologySchema = z.union([
  z.string().min(1),
  z.object({
    name: z.string().min(1),
    matches: z.array(z.string().min(1)).min(1),
  }).strict(),
]);
export type Technology = z.infer<typeof TechnologySchema>;

/** technology.label — the technology's name, whichever form the entry is written in. */
export function technologyName(tech: Technology): string {
  return typeof tech === 'string' ? tech : tech.name;
}

/** technology.tokens — what the technology-boundaries rule matches: the declared `matches`, else the name. */
export function technologyTokens(tech: Technology): string[] {
  return typeof tech === 'string' ? [tech] : [...tech.matches];
}

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
   * stereotypes should bind tech directly (TECH_ON_LOGIC_COMPONENT). An entry
   * is a bare name or `{ name, matches }` (see TechnologySchema).
   */
  technologies: z.array(TechnologySchema).optional(),
  /**
   * The parameter names THIS realization takes BEFORE the ones its contract
   * declares — a config object, a data root, the transport handles a portal is
   * handed. Supplied by whatever wires the component up, never by the caller
   * the contract describes, which is why they belong to the realization and
   * not to the contract: another realization of the same contract may hold
   * them as fields instead.
   *
   * Declared rather than guessed, because a leading parameter the contract
   * does not name is otherwise indistinguishable from one it named under a
   * different name — `seed(config)` realized as `bootstrapInstance(cfg)` reads
   * as a dropped parameter to anything that infers. A leading parameter this
   * list does not name is a finding (UNDECLARED_PARAM), and only a LEADING run
   * is dropped: one of these names appearing after the contract's own
   * parameters is not wiring, it is an argument in the middle of the caller's
   * list.
   */
  injectedParams: z.array(z.string()).optional(),
  /**
   * Portal-only code linkage: the router entry this Portal's own file exports.
   * Whatever process serves the Portal hands it its requests through this
   * entry, which replaces the retired listener mount's `via`. Route coverage
   * reads the routes out of it, and export conformance holds the file to it.
   * Outside the approval, like every linkage field.
   */
  router: z.string().min(1).optional(),
  methods: z.array(MethodImplementationSchema).default([]).superRefine((methods, ctx) => {
    // `calls` is the NARRATIVE-LESS spelling of a call. A method that has a
    // narrative already says what it calls, in steps the flow rules check; a
    // second spelling beside them could only ever disagree with the first.
    methods.forEach((m, i) => {
      if (!m.calls?.length || m.narrative.length === 0) return;
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [i, 'calls'],
        message: `Method "${m.name}" declares calls AND a narrative — \`calls\` says what a method calls when its narrative does not show it, and this one has ${m.narrative.length} step(s) that already do. Add the call step, or drop the declaration.`,
      });
    });
  }),
  /** Spec-level narrative detail default for all methods (each may override). */
  detail: NarrativeDetailSchema.optional(),
  /** Spec-level conformance tier default (each method may override). */
  conformance: ConformanceTierSchema.optional(),
  /** The rename trace (see PreviousIdsSchema). */
  previousIds: PreviousIdsSchema.optional(),
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
/**
 * entity | value-object (data) | signature (a named function type: params and
 * returns, nothing else) | enum (a closed, ordered set of named values).
 */
export const TypeKindSchema = z.enum(['entity', 'value-object', 'signature', 'enum']);
export type TypeKind = z.infer<typeof TypeKindSchema>;

export const TypeFieldSchema = z.object({
  name: z.string(),
  // A type expression in the neutral grammar (src/models/type-grammar.ts): a
  // primitive, a named type ("billing.Invoice"), list/set/map, `T?`, a union
  // of named types. Stored canonical.
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
  /**
   * The field's rename trace: every name it held before, oldest first.
   * Written only by the rename-field tool, never rewritten; the design export
   * shows it as `formerly`, so a consumer holding the old name can follow it.
   */
  previousNames: PreviousNamesSchema.optional(),
});
export type TypeField = z.infer<typeof TypeFieldSchema>;

/**
 * A pure, self-contained method on an entity (no external collaborators) —
 * type_method. Like a contract method it may carry structured params, which
 * then DERIVE its shown signature (deriveMethodSignature), so the signature is
 * optional on disk when params are present. It takes no signatureFrom: it
 * reaches no component, so it has no edge to take one along.
 */
export const TypeMethodSchema = z.object({
  name: z.string(),
  signature: z.string().optional(),
  /** Structured parameters in the contract method's param shape — authoritative for type checking when present. */
  params: z.array(MethodParamSchema).optional(),
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
/** A type method as a spec file holds it. */
export type StoredTypeMethod = z.infer<typeof TypeMethodSchema>;
/** A type method as the loader answers it: its signature always filled (derived from params, or the prose). */
export const ResolvedTypeMethodSchema = TypeMethodSchema.extend({
  signature: z.string(),
});
export type TypeMethod = z.infer<typeof ResolvedTypeMethodSchema>;

/** The stored type method with its requirement: a prose signature unless params derive one. */
export const StoredTypeMethodSchema = TypeMethodSchema.superRefine((method, ctx) => {
  if (method.params === undefined && method.signature === undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['signature'], message: 'Required: a type method without params states a prose signature' });
  }
});

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

/**
 * enum_value — one value of an enum type: its name, which is also the value as
 * data carries it, and an optional description. Ordered and unique by nameKey
 * within its enum (ENUM_MEMBERS); no ordinal and no separate wire value.
 */
export const EnumValueSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
});
export type EnumValue = z.infer<typeof EnumValueSchema>;

export const TypeSpecSchema = z.object({
  kind: TypeKindSchema, // discriminator — entity | value-object | signature | enum
  id: SpecIdSchema,
  name: z.string(),
  description: z.string().optional(),
  /** Owning subsystem id (entities). Omit for system-level shared value objects. */
  subsystem: z.string().optional(),
  /** Optional logical group ID to organize this type in subfolders. */
  group: z.string().optional(),
  fields: z.array(TypeFieldSchema).default([]),
  /** Pure intrinsic behaviour only — anything needing a collaborator belongs on a component. */
  methods: z.array(StoredTypeMethodSchema).default([]),
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
  /** The rename trace (see PreviousIdsSchema): ids this type held within its owner. */
  previousIds: PreviousIdsSchema.optional(),
  /** Per-spec lint suppressions (see LintConfigSchema). */
  lint: LintConfigSchema.optional(),
  /** Opaque pack/tool extension data (see ExtDataSchema) — preserved verbatim. */
  ext: ExtDataSchema.optional(),
  /**
   * A signature's parameters, in the contract method's param shape; only on
   * kind signature (SIGNATURE_TYPE_MEMBERS otherwise).
   */
  params: z.array(MethodParamSchema).optional(),
  /** A signature's one output type; required on kind signature and only there (SIGNATURE_TYPE_MEMBERS). */
  returns: z.string().optional(),
  /**
   * An enum's values, in declared order (the order is part of the design),
   * unique by nameKey; required and non-empty on kind enum and only there
   * (ENUM_MEMBERS).
   */
  values: z.array(EnumValueSchema).optional(),
  /**
   * A named scalar's one primitive (string, int, float, bool, bytes, date,
   * datetime or duration), in place of fields: a value-object that is a
   * newtype or type alias in every language. Read as a type position (the
   * grammar's `holds` position); only on a value-object and never beside
   * fields (NAMED_SCALAR_MEMBERS).
   */
  holds: z.string().optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
/** A type as a spec file holds it: each method in its stored form. */
export type StoredTypeSpec = z.infer<typeof TypeSpecSchema>;
/** A type as the loader answers it: every method's signature filled. */
export const ResolvedTypeSpecSchema = TypeSpecSchema.extend({
  methods: z.array(ResolvedTypeMethodSchema).default([]),
});
export type TypeSpec = z.infer<typeof ResolvedTypeSpecSchema>;

/**
 * type_spec.derivedSignature — a signature type's shown text, `(a: T, b?: U): R`,
 * derived from its params and returns the way a method's is, without a name;
 * undefined on an entity or a value-object.
 */
export function deriveTypeSignature(type: Pick<StoredTypeSpec, 'kind' | 'params' | 'returns'>): string | undefined {
  if (type.kind !== 'signature') return undefined;
  return `(${(type.params ?? []).map(paramText).join(', ')}): ${type.returns ?? 'unknown'}`;
}

/** A type method's stored form: a method with params stores the text they derive; a prose method as it is. */
export function storedTypeMethod<M extends StoredTypeMethod>(method: M): StoredTypeMethod {
  const derived = deriveMethodSignature(method);
  return derived === undefined ? method : { ...method, signature: derived };
}

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
// The design view — a spec as the approval sees it
//
// Code linkage says WHERE or HOW a design is realized in code, never WHAT the
// design is: pointing a spec at the file that realizes it must not reopen the
// human approval. Readiness — a spec's `status`, draft, design or complete —
// says how far AUTHORING is, never what the design says either: promoting a
// spec to complete must not reopen it. One table names every field of the
// kinds that carry either, in or out, and the projections below drop exactly
// the `linkage` and `readiness` halves (with the volatile timestamps). Both
// the gate identity (state_hash.ownDesign) and the per-spec approval digests
// read it, so the two can never disagree about what is design.
//
// A test classifies EVERY schema field against this table, so a new field
// cannot slip into (or out of) the approval silently: it must be placed.
// ---------------------------------------------------------------------------

/** Each schema's fields, split into the design (approved), the code linkage and the readiness (neither approved). */
export const DESIGN_VIEW_FIELDS = {
  implementation: {
    linkage: ['sourcePath', 'simPath', 'router', 'injectedParams', 'conformance', 'createdAt', 'updatedAt'],
    readiness: ['status'],
    design: ['id', 'name', 'description', 'contract', 'technologies', 'methods', 'detail', 'previousIds', 'lint', 'ext'],
  },
  implementationMethod: {
    linkage: ['sourcePath', 'symbol', 'exportedVia', 'conformance'],
    readiness: [],
    design: ['name', 'narrative', 'detail', 'intent', 'calls', 'ext'],
  },
  type: {
    linkage: ['sourcePath', 'symbol', 'createdAt', 'updatedAt'],
    readiness: [],
    design: [
      'kind', 'id', 'name', 'description', 'subsystem', 'group', 'fields', 'methods', 'componentClass', 'invariants',
      'database', 'table', 'linkedEntity', 'previousIds', 'lint', 'ext', 'params', 'returns', 'values', 'holds',
    ],
  },
  typeMethod: {
    linkage: ['sourcePath', 'symbol'],
    readiness: [],
    design: ['name', 'signature', 'params', 'returns', 'description'],
  },
  component: {
    linkage: ['externalLinks', 'createdAt', 'updatedAt'],
    readiness: ['status'],
    design: [
      'id', 'name', 'description', 'subsystem', 'componentType', 'owns', 'dependsOn', 'transport', 'abi', 'invokedBy',
      'basePath', 'auth', 'dispatch', 'durability', 'dependencyClass', 'emits', 'subscribesTo', 'patterns', 'variant',
      'previousIds', 'lint', 'ext',
    ],
  },
  subsystem: {
    linkage: ['createdAt', 'updatedAt'],
    readiness: ['status'],
    design: [
      'id', 'name', 'description', 'parentSystem', 'publicInterfaces', 'lifecycle', 'profile', 'projectPath',
      'targetLanguage', 'trustedLinks', 'designDepth', 'lint', 'ext',
    ],
  },
  interface: {
    linkage: ['createdAt', 'updatedAt'],
    readiness: ['status'],
    design: ['id', 'name', 'description', 'component', 'methods', 'previousIds', 'lint', 'ext', 'implements'],
  },
  /**
   * A retired listener mount as a stored file may still hold it until doctor
   * --fix migrates it: its `via` was linkage (the router entry, now the
   * Portal implementation's `router`), so a raw file still digests as it did.
   */
  retiredMount: {
    linkage: ['via'],
    readiness: [],
    design: ['portal', 'prefixes'],
  },
} as const;

/** What the approval leaves out of one kind's top level: its linkage and its readiness. */
function outOfApproval(kind: keyof typeof DESIGN_VIEW_FIELDS): readonly string[] {
  return [...DESIGN_VIEW_FIELDS[kind].linkage, ...DESIGN_VIEW_FIELDS[kind].readiness];
}

/** A copy of an object without the named keys; anything that is not a plain object passes through. */
function withoutFields<T>(value: T, fields: readonly string[]): T {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(value as Record<string, unknown>)) {
    if (!fields.includes(key)) out[key] = field;
  }
  return out as T;
}

/** Each element of an array field projected; an absent or malformed field stays as it is. */
function eachOf<T>(items: T, project: (item: unknown) => unknown): T {
  return (Array.isArray(items) ? items.map(project) : items) as T;
}

/**
 * implementation_spec.designView — this implementation as the approval sees it:
 * its own sourcePath, simPath, injectedParams and conformance tier, each
 * method's sourcePath, symbol, exportedVia and conformance tier, and the
 * readiness (status) and the timestamps left out. Everything else — the
 * contract, technologies, the detail dial, each method's narrative, intent and
 * calls, the rename trace, lint, ext — stays. Pure: a sourcePath added, moved
 * or removed, or a status promoted, never changes it. Reads a stored (raw)
 * spec as readily as a loaded one.
 */
export function implementationDesignView<T extends object>(impl: T): T {
  const view = withoutFields(impl, outOfApproval('implementation')) as Record<string, unknown>;
  if ('methods' in view) view.methods = eachOf(view.methods, (m) => withoutFields(m, DESIGN_VIEW_FIELDS.implementationMethod.linkage));
  return view as T;
}

/**
 * type_spec.designView — this type as the approval sees it: its own sourcePath
 * and symbol, each method's sourcePath and symbol, and the timestamps left
 * out; its fields, methods' signatures and descriptions, invariants, values,
 * holds, rename trace, lint and ext stay. Pure.
 */
export function typeDesignView<T extends object>(type: T): T {
  const view = withoutFields(type, outOfApproval('type')) as Record<string, unknown>;
  if ('methods' in view) view.methods = eachOf(view.methods, (m) => withoutFields(m, DESIGN_VIEW_FIELDS.typeMethod.linkage));
  return view as T;
}

/**
 * component_spec.designView — this component as the approval sees it: its
 * externalLinks, its readiness (status) and the timestamps left out; every
 * other field stays,
 * including transport, abi and invokedBy. Pure. It reads a stored (raw) file
 * as readily as a loaded spec, so a file still holding a retired listener
 * mount (until doctor --fix migrates it) keeps that mount's `via` out, as the
 * approval always did: an unmigrated file digests as it did when it was locked.
 */
export function componentDesignView<T extends object>(component: T): T {
  const view = withoutFields(component, outOfApproval('component')) as Record<string, unknown>;
  if ('mounts' in view) view.mounts = eachOf(view.mounts, (m) => withoutFields(m, DESIGN_VIEW_FIELDS.retiredMount.linkage));
  return view as T;
}

/**
 * subsystem_spec.designView — this subsystem as the approval sees it: its
 * readiness (status) and the timestamps left out; every other field stays.
 * Pure, and reads a stored (raw) spec as readily as a loaded one.
 */
export function subsystemDesignView<T extends object>(subsystem: T): T {
  return withoutFields(subsystem, outOfApproval('subsystem'));
}

/**
 * `raw` without the keys `parsed` (its schema's reading) no longer carries —
 * exactly the keys unknownKeysIn names, followed the same way. Builds a copy;
 * `raw` is untouched.
 */
function withoutUnknownKeys(raw: unknown, parsed: unknown): unknown {
  if (Array.isArray(raw)) {
    if (!Array.isArray(parsed) || parsed.length !== raw.length) return raw;
    return raw.map((item, i) => withoutUnknownKeys(item, parsed[i]));
  }
  if (!raw || typeof raw !== 'object' || !parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return raw;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (key in (parsed as Record<string, unknown>)) out[key] = withoutUnknownKeys(value, (parsed as Record<string, unknown>)[key]);
  }
  return out;
}

/** The schema each spec kind with a design view is read with. */
const SCHEMA_OF_KIND = {
  implementation: ImplementationSpecSchema,
  type: TypeSpecSchema,
  component: ComponentSpecSchema,
  subsystem: SubsystemSpecSchema,
  interface: InterfaceSpecSchema,
} as const;

/**
 * A stored spec document as the loader reads it: every key its kind's schema
 * reads, and none it drops. A dropped key (UNKNOWN_SPEC_KEY, or a tolerated
 * one like schemaVersion) means nothing to the loaded tree, so the gate
 * identity, which digests the loaded specs, never sees it — and the per-spec
 * approval digests, which read the stored file, must not either, or `status`
 * and `lock-check` disagree over an edit that changed no design. A component's
 * retired `mounts` stays (it is read compatibly, and its design view keeps
 * it). Nothing is added — no schema default — so a document holding only known
 * keys comes back as it is. A document its schema refuses comes back as it is.
 */
export function asSchemaReads(kind: keyof typeof SCHEMA_OF_KIND, doc: Record<string, unknown>): Record<string, unknown> {
  const parsed = SCHEMA_OF_KIND[kind].safeParse(doc);
  if (!parsed.success) return doc;
  const kept = withoutUnknownKeys(doc, parsed.data) as Record<string, unknown>;
  if (kind === 'component' && 'mounts' in doc) kept.mounts = doc.mounts;
  return kept;
}

/**
 * interface_spec.designView — this contract as the approval sees it: its
 * readiness (status) and the timestamps left out; every other field stays,
 * the methods, endpoints and findings included. Pure, and reads a stored
 * (raw) spec as readily as a loaded one.
 */
export function interfaceDesignView<T extends object>(contract: T): T {
  return withoutFields(contract, outOfApproval('interface'));
}

/**
 * component_spec.entryFor — the entry a verb of this Portal has: the verb's
 * own invokedBy when it declares one, else the component's, with the verb's
 * scope taking precedence over the component's. None for a non-Portal. Pure.
 */
export function componentEntryFor(
  component: Pick<ComponentSpec, 'componentType' | 'invokedBy'>,
  method?: DeclaredInvocation,
): DeclaredInvocation | undefined {
  if (component.componentType !== 'Portal') return undefined;
  const own = component.invokedBy;
  if (method) {
    if (method.kind === 'entry' && own?.kind === 'entry') {
      const scope = method.scope ?? own.scope;
      return { ...own, ...method, ...(scope !== undefined ? { scope } : {}) };
    }
    return method;
  }
  return own;
}

// ---------------------------------------------------------------------------
// Retired reachability forms — read compatibly for one release
// ---------------------------------------------------------------------------

/**
 * A form the reachability model retired, as the scan met it in a stored spec.
 * `retired-allow` (a lint allow of a retired code) is never recorded by the
 * scan: the reachability migration reads the allows itself and names its
 * rewrites with it.
 */
export const RetiredReachFormSchema = z.enum(['portal-type', 'listener-mounts', 'invoked-by-kind', 'export-type', 'in-process-endpoint', 'retired-allow']);
export type RetiredReachForm = z.infer<typeof RetiredReachFormSchema>;

/**
 * One retired reachability form the current scan met, with what the stored
 * spec held, so the migration can rewrite it and the doctor report can explain
 * it without reading files again. Nothing the loader reads compatibly is
 * dropped: the stored value lives on here.
 */
export interface RetiredReachFact {
  /** Which retired form. */
  form: RetiredReachForm;
  /** The key of the spec holding it (`system` for an L0). */
  specId: string;
  /** Where in the spec: a method name, an export entry's public name, a mounted portal's id. */
  at?: string;
  /** What the stored spec held there, exactly as read. */
  stored: unknown;
}

/** The spec kinds that can hold a retired reachability form. */
export type RetiredReachHolder = 'system' | 'subsystem' | 'component' | 'interface';

/**
 * Whether a Custom endpoint's address names an in-process call rather than a
 * wire: `in-process …`, or a `<package>#<function>` library symbol.
 */
export function isInProcessAddress(address: string): boolean {
  const text = address.trim();
  return /^in-process\b/i.test(text) || /^[^\s#]+#[A-Za-z_$][\w$]*$/.test(text);
}

/** An export entry's public name, as far as a stored entry spells it. */
function storedExportName(entry: Record<string, unknown>): string | undefined {
  for (const key of ['as', 'id', 'interface', 'component', 'typeDef', 'from'] as const) {
    const value = entry[key];
    if (typeof value === 'string' && value !== '') return value;
  }
  return undefined;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

/**
 * Read one stored spec document's retired reachability forms compatibly, IN
 * PLACE, and answer what it held. Pure over the document; the caller parses it
 * afterwards with the current schema, which no longer carries the retired
 * forms.
 *
 * - A component's `portalType` becomes `transport` (HTTP_API as HTTP) unless
 *   the document already states a transport; the stored value is a fact.
 * - A component's listener `mounts` are kept as facts, one per mounted portal
 *   (or one holding the stored value for a listener that mounted nothing). The
 *   schema no longer types them, so the parse drops them; the caller keeps
 *   them READ but untyped on the loaded spec (attachRetiredMounts) for the
 *   rules that still judge them until the reachability rules replace them, and
 *   the writer carries them back onto the file (carryRetiredReachForms), so
 *   nothing is silently dropped before the migration rewrites them.
 * - An interface method's invokedBy of a retired kind is read as `runtime`
 *   (`isPortalContract` true reads `external` as `entry`); the stored kind is a
 *   fact. Without the contract's component at hand the caller re-reads
 *   `external` once it knows (the scan does, after every spec is keyed).
 * - A Custom endpoint naming an in-process call is a fact; it still parses.
 * - An authored `type` on an L1 or L0 export entry is a fact; it still parses
 *   as the legacy value.
 */
export function readRetiredReachForms(
  holder: RetiredReachHolder,
  doc: Record<string, unknown>,
  isPortalContract?: boolean,
): RetiredReachFact[] {
  const facts: RetiredReachFact[] = [];
  const specId = holder === 'system' ? 'system' : String(doc.id ?? '');
  if (holder === 'component') {
    if ('portalType' in doc) {
      const stored = doc.portalType;
      facts.push({ form: 'portal-type', specId, stored });
      if (doc.transport === undefined && typeof stored === 'string') {
        doc.transport = RETIRED_PORTAL_TYPE_SPELLINGS[stored] ?? stored;
      }
      delete doc.portalType;
    }
    if ('mounts' in doc) {
      const stored = doc.mounts;
      if (Array.isArray(stored) && stored.length > 0) {
        for (const mount of stored) {
          const portal = isRecord(mount) && typeof mount.portal === 'string' ? mount.portal : undefined;
          facts.push({ form: 'listener-mounts', specId, ...(portal !== undefined ? { at: portal } : {}), stored: mount });
        }
      } else {
        facts.push({ form: 'listener-mounts', specId, stored });
      }
    }
    return facts;
  }
  if (holder === 'interface') {
    for (const method of Array.isArray(doc.methods) ? doc.methods : []) {
      if (!isRecord(method)) continue;
      const name = typeof method.name === 'string' ? method.name : undefined;
      const invokedBy = method.invokedBy;
      if (isRecord(invokedBy) && typeof invokedBy.kind === 'string' && RETIRED_INVOCATION_KINDS.has(invokedBy.kind)) {
        facts.push({ form: 'invoked-by-kind', specId, ...(name !== undefined ? { at: name } : {}), stored: invokedBy.kind });
        method.invokedBy = { ...invokedBy, kind: retiredInvocationReadAs(invokedBy.kind, isPortalContract === true) };
      }
      const endpoint = method.endpoint;
      if (isRecord(endpoint) && endpoint.transport === 'Custom' && typeof endpoint.address === 'string' && isInProcessAddress(endpoint.address)) {
        facts.push({ form: 'in-process-endpoint', specId, ...(name !== undefined ? { at: name } : {}), stored: { ...endpoint } });
      }
    }
    return facts;
  }
  for (const entry of Array.isArray(doc.publicInterfaces) ? doc.publicInterfaces : []) {
    if (!isRecord(entry) || entry.type === undefined) continue;
    const at = storedExportName(entry);
    facts.push({ form: 'export-type', specId, ...(at !== undefined ? { at } : {}), stored: entry.type });
  }
  return facts;
}

/**
 * A retired listener mount as a stored file may still hold it: the portal a
 * listener served, under which path prefixes, through which router entry.
 * Read, never typed on ComponentSpec, and never authored.
 */
export interface RetiredMount {
  portal: string;
  prefixes: string[];
  via?: string;
}

/**
 * Keep a stored component's retired listener `mounts` READ on the parsed spec,
 * untyped: the schema drops them, and until the reachability rules replace
 * the ones that judge them (and doctor --fix rewrites them) they stay where
 * the loader's reference binding, the rules and the writer's carry can see
 * them. Answers the parsed spec.
 */
export function attachRetiredMounts<T extends object>(parsed: T, doc: Record<string, unknown>): T {
  if (Array.isArray(doc.mounts)) (parsed as Record<string, unknown>).mounts = doc.mounts;
  return parsed;
}

/**
 * A loaded component's retired listener mounts, as far as each is well formed
 * (a portal id, its prefixes, its router entry); none when it declares none.
 * `declared` says whether the field is present at all — even empty, it marked
 * a listener.
 */
export function retiredMountsOf(component: object): { declared: boolean; mounts: RetiredMount[] } {
  const raw = (component as Record<string, unknown>).mounts;
  if (!Array.isArray(raw)) return { declared: raw !== undefined, mounts: [] };
  const mounts: RetiredMount[] = [];
  for (const entry of raw) {
    if (!isRecord(entry) || typeof entry.portal !== 'string') continue;
    const prefixes = Array.isArray(entry.prefixes) ? entry.prefixes.filter((p): p is string => typeof p === 'string') : [];
    mounts.push({ portal: entry.portal, prefixes, ...(typeof entry.via === 'string' ? { via: entry.via } : {}) });
  }
  return { declared: true, mounts };
}

/**
 * The kind a retired invokedBy kind is read as: `external` is an entry on a
 * Portal's contract and a runtime hook elsewhere; `sibling-subsystem` is a
 * runtime hook (its caller is in the same tree, so the call should be
 * modelled — INVOKED_BY_RETIRED_KIND says so).
 */
export function retiredInvocationReadAs(kind: string, isPortalContract: boolean): InvocationKind {
  return kind === 'external' && isPortalContract ? 'entry' : 'runtime';
}

/**
 * The retired forms a stored component or interface file holds that the
 * document about to be written over it would erase without anyone deciding
 * to: a Portal's listener `mounts`, and an interface method's retired
 * invokedBy kind when the written method still declares the kind it was read
 * as. Carried onto `out` IN PLACE, so a write through any tool keeps them until
 * the reachability migration rewrites them. A deliberate change (the method's
 * invokedBy rewritten or removed, the component no longer a Portal) is the
 * author's, and is not undone. Pure.
 */
export function carryRetiredReachForms(
  holder: 'component' | 'interface',
  stored: Record<string, unknown> | null | undefined,
  out: Record<string, unknown>,
): void {
  if (!isRecord(stored)) return;
  if (holder === 'component') {
    if ('mounts' in stored && !('mounts' in out) && out.componentType === 'Portal') out.mounts = stored.mounts;
    return;
  }
  const storedMethods = new Map<string, Record<string, unknown>>();
  for (const method of Array.isArray(stored.methods) ? stored.methods : []) {
    if (isRecord(method) && typeof method.name === 'string') storedMethods.set(method.name, method);
  }
  for (const method of Array.isArray(out.methods) ? out.methods : []) {
    if (!isRecord(method) || typeof method.name !== 'string') continue;
    const before = storedMethods.get(method.name)?.invokedBy;
    const now = method.invokedBy;
    if (!isRecord(before) || !isRecord(now) || typeof before.kind !== 'string' || !RETIRED_INVOCATION_KINDS.has(before.kind)) continue;
    const readAs = before.kind === 'external' ? ['entry', 'runtime'] : ['runtime'];
    const sameCaller = now.caller === before.caller;
    if (typeof now.kind === 'string' && readAs.includes(now.kind) && sameCaller && now.scope === undefined) {
      method.invokedBy = { ...now, kind: before.kind };
    }
  }
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
  /** A signature's parameters (name, type, optional, description) in declared order; only on kind signature. */
  params: z.array(z.object({
    name: z.string(),
    type: z.string(),
    description: z.string().optional(),
    optional: z.boolean().optional(),
  })).optional(),
  /** A signature's one output type; only on kind signature. */
  returns: z.string().optional(),
  /** An enum's values in declared order; only on kind enum. */
  values: z.array(EnumValueSchema).optional(),
  /** A named scalar's one primitive, in place of fields; only on a value-object that declares it. */
  holds: z.string().optional(),
  /**
   * The type's own methods (its checked constructors, its pure operations),
   * each with its signature, params and returns, so a binding written against
   * the pin knows them. Carried, never digested: a pin taken before they were
   * carried lacks them and reads as stale (re-pin), never as incompatible.
   */
  methods: z.array(z.object({
    name: z.string(),
    signature: z.string(),
    params: z.array(z.object({ name: z.string(), type: z.string(), description: z.string().optional(), optional: z.boolean().optional() })).optional(),
    returns: z.string(),
    description: z.string().optional(),
  })).optional(),
  /**
   * The type's rename trace as the producer recorded it (previousIds), so a
   * consumer pinned to a former name reads a rename rather than a removal.
   * Provenance, never signature: it enters no digest. Absent when never renamed.
   */
  formerly: z.array(z.string()).optional(),
});
export type SurfaceTypeDef = z.infer<typeof SurfaceTypeDefSchema>;

/** A type the producer exports by name (a typeDef export); its definition is in the type closure. */
export const SurfaceTypeExportSchema = z.object({
  /** The type's public name in the producer's export table. */
  id: z.string(),
  /** The id of the type's definition in the snapshot's type closure. */
  type: z.string(),
  /** Exposure level from the L0 entry. */
  audience: z.string().default('instance'),
});
export type SurfaceTypeExport = z.infer<typeof SurfaceTypeExportSchema>;

/** One exported interface at CONTRACT grade — full methods + dispatch table. */
export const SurfaceContractEntrySchema = z.object({
  id: z.string(),
  name: z.string(),
  /** Exposure level of the L0 entry (see SurfaceAudienceSchema). */
  audience: z.string().default('instance'),
  /** Export kind: REST, GraphQL, MessageBus, RPC, or Custom — derived from the backing Portal's transport. */
  type: z.string().default('Custom'),
  /** Local name of the backing Portal in the producing project. */
  component: z.string(),
  /**
   * Full contract methods (params, returns, guarantees, effect, endpoint),
   * resolved: a snapshot names no producer-internal source. A renamed method
   * carries its former names as `formerly` (provenance, outside every digest).
   */
  methods: z.array(ResolvedMethodSignatureSchema.extend({ formerly: z.array(z.string()).optional() })).default([]),
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
  /** Stereotype of the backing component; absent on snapshots written before exports carried it. */
  componentType: z.string().optional(),
  /** The L3 interface the export narrows to, when it narrows. */
  interface: z.string().optional(),
  /**
   * The rename trace behind the entry's public name: the former public names
   * the producer's rename trace (the narrowed interface's, else the backing
   * component's previousIds) records. Carried into the pin snapshot and the
   * surface export so a consumer can follow a rename instead of reading a
   * delete plus an add. Provenance, never signature: it enters neither
   * memberDigest nor contentDigest. Absent when never renamed.
   */
  formerly: z.array(z.string()).optional(),
  /**
   * The backing Portal's transport: a consumer tells a library (InProcess,
   * called directly) from a network or local surface by it. Absent on
   * snapshots written before it was carried, read then as the derived kind.
   */
  transport: z.string().optional(),
  /** The backing InProcess Portal's abi, when it declares one. */
  abi: z.string().optional(),
  /** The entry's export role, call (the default) or implement. */
  role: z.string().optional(),
});
export type SurfaceContractEntry = z.infer<typeof SurfaceContractEntrySchema>;

/**
 * surface_unresolved_export — a public name the producer's L0 still declares
 * but no longer resolves, carried so a consumer that used it is told why it is
 * gone and where the source's rename trace leads. Provenance, never contract.
 */
export const SurfaceUnresolvedExportSchema = z.object({
  /** The public name the entry declares. */
  id: z.string(),
  /** Where it re-exports from: the `from` the entry names. */
  source: z.string(),
  /** The name the source's rename trace carries the item to, when it records one. */
  renamedTo: z.string().optional(),
});
export type SurfaceUnresolvedExport = z.infer<typeof SurfaceUnresolvedExportSchema>;

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
  /** Transitive type closure of every exported signature and exported type — self-contained. */
  types: z.array(SurfaceTypeDefSchema).default([]),
  /** The producing project's effective id, beside the display-oriented projectName. */
  projectId: z.string().optional(),
  /** The types the producer exports by name, listed apart from the contract entries. */
  exportedTypes: z.array(SurfaceTypeExportSchema).optional(),
  /**
   * The audience ceiling the producer's export table was filtered to: project
   * for a snapshot pinned from the family, instance for one pinned through
   * source.path; absent on surfaces written before externals and on imports.
   */
  audience: z.string().optional(),
  /**
   * The producer's targetLanguage (L0), lowercased: what a consumer in another
   * language judges a native-ABI library call against. Absent when the
   * producer declares none, or on snapshots written before it was carried.
   */
  targetLanguage: z.string().optional(),
  /**
   * The public names the producer's L0 declares that no longer resolve (a
   * named re-export whose source dropped or renamed the item), with the
   * source's rename trace when it has one. Provenance, outside every digest;
   * absent when every entry resolves.
   */
  unresolvedExports: z.array(SurfaceUnresolvedExportSchema).optional(),
});
export type SurfaceSnapshot = z.infer<typeof SurfaceSnapshotSchema>;

// ---------------------------------------------------------------------------
// Pinned externals (.wai/externals.lock.yaml + .wai/externals/<alias>.yaml)
// ---------------------------------------------------------------------------

/**
 * external_lock_entry — what `wairon externals pin` recorded for one alias:
 * the producer, the snapshot, its content digest, and the digest of every
 * member the consumer's references use (public name → member → sha256:…).
 */
export const ExternalLockEntrySchema = z.object({
  project: z.string(),
  snapshot: z.string(),
  digest: z.string(),
  used: z.record(z.record(z.string())).default({}),
  /** The producer's commit at pin time (stage 8): provenance, never compared by a verdict. */
  commit: z.string().optional(),
  /** external | member | parent (stage 8); absent reads as external. */
  role: z.string().optional(),
});
export type ExternalLockEntry = z.infer<typeof ExternalLockEntrySchema>;

/**
 * externals_lock — the content of .wai/externals.lock.yaml: one entry per
 * pinned producer, and — in a non-contained part's lock (stage 8) — its
 * parent, whose snapshot is a ParentExcerpt.
 */
export const ExternalsLockSchema = z.object({
  externals: z.record(ExternalLockEntrySchema).default({}),
  parent: ExternalLockEntrySchema.optional(),
});
export type ExternalsLock = z.infer<typeof ExternalsLockSchema>;

/**
 * parent_excerpt — the pinned slice of a parent that a part opened alone is
 * judged against (stage 8): the parent's specs the part's files reference,
 * verbatim and canonical, closed over what judging them needs, plus the
 * governing configuration the parent judges its parts under. Stored in the
 * part's .wai/externals/<parent id>.yaml and named by its lock's `parent`.
 */
export const ParentExcerptSchema = z.object({
  /** The parent's project id at pin time; must equal the part's PartOf.project. */
  project: z.string(),
  /** The commit of the work tree holding the parent at pin time — provenance only. */
  commit: z.string().optional(),
  /** The parent's governing projectType. */
  projectType: z.string().optional(),
  /** The parent's rule configuration, as its configuration records it. */
  rules: z.record(z.unknown()).default({}),
  /** The parent's pack selections as its configuration records them. */
  packs: z.array(z.union([z.string(), z.record(z.unknown())])).default([]),
  /** The parent's spec documents the part references, and the closure judging them needs (its L0 included). */
  specs: z.array(z.record(z.unknown())).default([]),
  /** sha256:… over the canonical excerpt without its commit. */
  digest: z.string(),
});
export type ParentExcerpt = z.infer<typeof ParentExcerptSchema>;

/**
 * pinned_parent — a part's parent as the part's own gate judges against it
 * (stage 8): the lock's parent entry and the excerpt it names, read from the
 * part's own files and nothing else.
 */
export interface PinnedParent {
  /** The parent's id: the part's PartOf.project. */
  project: string;
  /** The lock's parent entry; absent when the part was never pinned. */
  entry?: ExternalLockEntry;
  /** The excerpt the entry names; absent when unpinned, or the file is missing or malformed. */
  excerpt?: ParentExcerpt;
  /** Why there is nothing to judge against. */
  problem?: string;
}

/**
 * pinned_external — one declared external as the owner's gate judges against
 * it: its lock entry and the snapshot that entry names, read from the bound
 * project's own .wai/externals.lock.yaml and .wai/externals/ and nothing else.
 * The producer is never read.
 */
export interface PinnedExternal {
  /** The alias the project declares in project.yaml externals. */
  alias: string;
  /** The producer's project id the lock recorded (the declaration's, when never pinned). */
  project: string;
  /** The lock's entry for the alias; absent when it was declared but never pinned. */
  entry?: ExternalLockEntry;
  /** The pinned snapshot the entry names; absent when unpinned, or the file is missing or malformed. */
  snapshot?: SurfaceSnapshot;
  /** Why the alias has nothing to judge against; absent when the entry and the snapshot are both present. */
  problem?: string;
}

/** What pinning did for one alias. */
export type ExternalPinOutcome = 'pinned' | 'unchanged' | 'unresolved' | 'unreachable';

/** external_pin — what pinning did for one alias. */
export interface ExternalPin {
  alias: string;
  outcome: ExternalPinOutcome;
  project?: string;
  snapshot?: string;
  digest?: string;
  /** How many public names the lock records as used. */
  usedNames: number;
  /** The consumer's references into the producer that land on no public name it may see. */
  unexported: import('./project-family.js').CrossProjectReference[];
  /** Why an alias was unresolved or unreachable, or which used members could not be pinned. */
  detail?: string;
}

/**
 * external_request — what `wairon externals add` and sdd_add_external ask for:
 * one external to declare in the bound project's `.wai/project.yaml`, written
 * exactly as a person would say it.
 */
export interface ExternalRequest {
  /** The alias the project's specs will reference it by (`alias::name`). */
  alias: string;
  /** Where the producer is, in the one location grammar; omitted when the family provides it. */
  source?: string;
  /** The producer's project id when it differs from the alias. */
  project?: string;
  /** git only: the branch, tag or full commit the pin follows. */
  ref?: string;
  /** git only: the producer's root inside the repository. */
  dir?: string;
  /** Public names to import bare (`*` for all). */
  use?: string[];
  /** What the producer is to this project. */
  description?: string;
  /** Pin it right after declaring it (default true). */
  pin?: boolean;
  /** Answer what would be declared, writing nothing. */
  dryRun?: boolean;
}

/**
 * external_addition — the answer to declaring one external: what was written
 * (or would be, on a dry run), the producer it reached and the pin — or why
 * nothing was written, as one sentence naming the accepted form.
 */
export interface ExternalAddition {
  alias: string;
  /** Whether `.wai/project.yaml` now carries the declaration (false on a refusal and on a dry run). */
  written: boolean;
  /** The declaration as written (object form, normalized); null on a refusal. */
  declaration: import('./project.js').ExternalDeclaration | null;
  /** The producer's project id as the producer answered to it. */
  project?: string;
  /** The pin taken right after, when asked. */
  pin?: ExternalPin | null;
  /** Why nothing was written, in one sentence naming the accepted form. */
  refusal?: string;
  /** Set when the declaration was written but its producer could not be read: why, and that nothing was pinned. */
  unreachable?: string;
}

/**
 * external_removal — the answer to removing one external: whether its
 * declaration and its pin (lock entry and snapshot) went, or why nothing was
 * removed, in one sentence.
 */
export interface ExternalRemoval {
  alias: string;
  /** Whether this call took the declaration out of `.wai/project.yaml` (false on a refusal, a dry run, and an orphaned pin). */
  removed: boolean;
  /** Whether the alias's lock entry and pinned snapshot were removed (or would be, on a dry run). */
  unpinned: boolean;
  /** Why nothing was removed: the alias is neither declared nor pinned. */
  refusal?: string;
}

/**
 * external_use_request — what `wairon externals use` and sdd_update_external
 * ask for: names to add to and remove from one declared external's `use`.
 */
export interface ExternalUseRequest {
  alias: string;
  /** Public names to import bare (`*` for all). */
  add?: string[];
  /** Names to stop importing. */
  remove?: string[];
  /** Answer what the `use` would become, writing nothing. */
  dryRun?: boolean;
}

/**
 * external_use_change — the answer to changing one external's `use`: the
 * list after the change, what was added and removed, or the refusal.
 */
export interface ExternalUseChange {
  alias: string;
  /** Whether `.wai/project.yaml` now carries the changed `use` (false on a refusal, a dry run and when nothing changed). */
  written: boolean;
  /** The `use` list after the change, in order. */
  use: string[];
  /** The names this change imports that were not imported before. */
  added: string[];
  /** The names this change stops importing. */
  removed: string[];
  /** Why nothing was written, in one sentence. */
  refusal?: string;
}

/** The verdict on one used member of a pinned external. */
export type ExternalUseState = 'unchanged' | 'changed' | 'removed' | 'unlocked' | 'unavailable' | 'renamed';

/** external_use_status — the verdict on one used member of one pinned external. */
export interface ExternalUseStatus {
  publicName?: string;
  member?: string;
  state: ExternalUseState;
  /** EXTERNAL_CHECK_UNAVAILABLE on an unavailable entry — never a pass. */
  code?: string;
  detail?: string;
  /**
   * On a renamed use: the public name (and member, as `name.member`) the live
   * producer's rename trace carries the used name forward to — what the
   * consumer's references should now name.
   */
  renamedTo?: string;
}

/** external_status — the status of one declared external. */
export interface ExternalStatus {
  alias: string;
  project: string;
  sourceKind: import('./project-family.js').ExternalSourceKind;
  pinned: boolean;
  reachable: boolean;
  stale: boolean;
  drifted?: boolean;
  uses: ExternalUseStatus[];
  detail?: string;
  /**
   * True when the producer's root lies outside the request's reach and was
   * therefore not read: a family run that narrowed the reach to its selection
   * counts it in its hint rather than as a comparison that failed.
   */
  outOfReach?: boolean;
  /** The content digest the lock recorded for this producer; provenance only, never compared here. */
  pinnedDigest?: string;
  /** The producer's commit as the lock recorded it (another repository only); provenance only. */
  pinnedCommit?: string;
  /**
   * The carried facts the pinned snapshot no longer matches in the live
   * producer (an abi, a transport, a role, the targetLanguage, a rename
   * trace): the snapshot is stale and a re-pin refreshes it. Absent when the
   * producer was not read or nothing carried moved.
   */
  staleFacts?: string[];
}

/** ok | drifted | incompatible | unavailable — a relation's health in one word. */
export type RelationHealth = 'ok' | 'drifted' | 'incompatible' | 'unavailable';

/**
 * external_status.health — the relation's health in one word, the same on the
 * canvas's edges and on the hosted Relations tab. A known break outranks the
 * unknown, and the unknown outranks a benign change, so nothing that could not
 * be checked ever reads as ok. Pure: over the status's own fields.
 */
export function relationHealth(status: ExternalStatus): RelationHealth {
  if (status.uses.some((u) => u.state === 'changed' || u.state === 'removed' || u.state === 'renamed')) return 'incompatible';
  if (!status.reachable || status.outOfReach || status.uses.some((u) => u.state === 'unavailable' || u.state === 'unlocked')) return 'unavailable';
  if (status.drifted || (status.staleFacts?.length ?? 0) > 0) return 'drifted';
  return 'ok';
}

/**
 * project_relations — one project of a family with its externals status, read
 * at its own root: what the canvas colours its consumption edges from.
 */
export interface ProjectRelations {
  /** The consuming project's key in the bound family ('' for the bound root). */
  project: string;
  /** Its externals status, per use — and one per contained project member it references. */
  externals: ExternalStatus[];
  /** ISO-8601 time the statuses were read. */
  comparedAt: string;
  /** Why the project's statuses could not be read at all; then externals is empty. */
  detail?: string;
}

/** external_listing — one row of `wairon externals list`. */
export interface ExternalListing {
  alias: string;
  project: string;
  sourceKind: import('./project-family.js').ExternalSourceKind;
  relation?: import('./project-family.js').ExternalRelation;
  directory?: string;
  audience: string;
  lock?: ExternalLockEntry;
  problem?: string;
}

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
