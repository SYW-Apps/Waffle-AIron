import { z } from 'zod';

// ---------------------------------------------------------------------------
// Common Identifier Schema
// ---------------------------------------------------------------------------
export const SpecIdSchema = z.string().regex(/^[a-z0-9-_]+$/, 'Identifier must be lowercase alphanumeric with dashes or underscores');

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
 * of tribal knowledge. The cross-subsystem shape (client Adapter → published
 * Portal) still applies; a trusted link never licenses reaching internals.
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
 */
export const LintAllowSchema = z.object({
  /** The issue code being allowed (see `wairon rules list`). */
  code: z.string(),
  /** Why this finding is acceptable here (e.g. "dispatcher — fan-out is the point"). */
  reason: z.string().min(1),
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
  'Registry',
  'Adapter',
  'Observer',
  'Specialist',
  'View', // Pure presenter/UI component
  // Patterns (compositions of blocks)
  'Repository',
  'Gateway',
  'FeatureComponent', // Logic Hook + View Presenter pattern
  'RouterComponent',  // Switch/routing component pattern
]);
export type ComponentType = z.infer<typeof ComponentTypeSchema>;

/** Component types that are patterns (own member blocks) rather than building blocks. */
export const PATTERN_TYPES: ReadonlySet<ComponentType> = new Set(['Repository', 'Gateway', 'FeatureComponent', 'RouterComponent']);

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
 *                      would otherwise hide inside a Specialist).
 */
export const DurabilitySchema = z.enum(['ram-projection', 'durable', 'read-through', 'cache']);
export type Durability = z.infer<typeof DurabilitySchema>;

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
  /** Portal-only: capability → component.method dispatch table (see DispatchBindingSchema). */
  dispatch: z.array(DispatchBindingSchema).optional(),
  /** Store-only: whether held state survives restart (see DurabilitySchema). */
  durability: DurabilitySchema.optional(),
  /** Topics this component publishes to (see EventBindingSchema). */
  emits: z.array(EventBindingSchema).optional(),
  /** Topics this component consumes (see EventBindingSchema) — typical on Observers. */
  subscribesTo: z.array(EventBindingSchema).optional(),
  /** Pack-declared reusable patterns this component realizes (resolved against loaded packs; UNKNOWN_PATTERN_REF). */
  patterns: z.array(PatternRefSchema).optional(),
  /** Optional component variant — a declared, base-anchored specialization of this component's stereotype (resolved against the variant registry; UNKNOWN_VARIANT / VARIANT_BASE_MISMATCH). */
  variant: z.string().optional(),
  /** Per-spec lint suppressions (see LintConfigSchema). */
  lint: LintConfigSchema.optional(),
  /** Opaque pack/tool extension data (see ExtDataSchema) — preserved verbatim. */
  ext: ExtDataSchema.optional(),
  status: SpecStatusSchema.optional().default('complete'),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export type ComponentSpec = z.infer<typeof ComponentSpecSchema>;

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
  /** A primitive/builtin or a defined type id (qualified across subsystems, e.g. "billing.Invoice"). */
  type: z.string(),
  description: z.string().optional(),
  optional: z.boolean().optional(),
});
export type MethodParam = z.infer<typeof MethodParamSchema>;

export const MethodSignatureSchema = z.object({
  name: z.string().regex(/^[a-zA-Z0-9_]+$/, 'Method name must be alphanumeric'),
  description: z.string(),
  signature: z.string(), // e.g. "save(key: string, data: Buffer): Promise<void>"
  returns: z.string(),   // e.g. "Promise<void>"
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
  /** Opaque pack/tool extension data (see ExtDataSchema) — preserved verbatim. */
  ext: ExtDataSchema.optional(),
});

export type MethodSignature = z.infer<typeof MethodSignatureSchema>;

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
// by the narrative-flow validation rule, not the schema.
// ---------------------------------------------------------------------------
export const NarrativeStepTypeSchema = z.enum([
  'local',    // in-component work
  'call',     // cross-component call (targetComponent/targetMethod)
  'dispatch', // capability routed through a generic Portal's dispatch table (targetComponent + capability)
  'branch',   // if/else: condition + onTrueStep (default next) / onFalseStep
  'switch',   // multiway dispatch: on + cases[{value, step}] + defaultStep
  'loop',     // header step; body = next..endStep; loopKind picks the form
  'try',      // guarded region: body = next..endStep; catches[{error, step}] + finallyStep
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

export const NarrativeStepSchema = z.object({
  stepNumber: z.number().int().positive(),
  description: z.string(),
  type: NarrativeStepTypeSchema,
  targetComponent: z.string().optional(), // Required if type is 'call' or 'dispatch', references L2 Component id
  targetMethod: z.string().optional(),    // Required if type is 'call', references Method name on target interface
  capability: z.string().optional(),      // Required if type is 'dispatch': the capability routed through the target Portal's dispatch table
  assertsGuarantees: z.array(GuaranteeSchema).optional(),
  /**
   * Declared entity invariants this step upholds, as "<type-id>.<invariant-id>"
   * references (type id optionally subsystem-qualified). The invariant-backing
   * rule resolves each against the entity's declared invariants
   * (UNKNOWN_INVARIANT_REF) and counts the step as the write-path assertion the
   * entity's write methods must carry (UNASSERTED_INVARIANT otherwise).
   */
  assertsInvariants: z.array(z.string()).optional(),

  // --- flow config (per type; validated by the narrative-flow rule) ---------
  condition: z.string().optional(),        // branch; loop (while/doWhile)
  onTrueStep: z.number().int().positive().optional(),  // branch (default: next step)
  onFalseStep: z.number().int().positive().optional(), // branch (required)
  on: z.string().optional(),               // switch: the dispatched value
  cases: z.array(SwitchCaseSchema).optional(),          // switch (required)
  defaultStep: z.number().int().positive().optional(),  // switch (default: next step)
  loopKind: LoopKindSchema.optional(),     // loop (default: forEach when `over`, else while)
  over: z.string().optional(),             // loop (forEach/for): iteration source
  endStep: z.number().int().positive().optional(),      // loop/try: last step of the body region
  catches: z.array(CatchClauseSchema).optional(),        // try
  finallyStep: z.number().int().positive().optional(),   // try: first step of the always-runs region
  toStep: z.number().int().positive().optional(),        // jump (required)
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
 * (Portal/Observer/Adapter → calls-only, Store/Index/Registry → intent,
 * everything else → full). Levels are floors, not ceilings.
 */
export const NarrativeDetailSchema = z.enum(['full', 'calls-only', 'intent']);
export type NarrativeDetail = z.infer<typeof NarrativeDetailSchema>;

/**
 * The structural-conformance dial — declared per method (or per spec as a
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
  /** Spec-level structural-conformance tier default (each method may override). */
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

// ---------------------------------------------------------------------------
// Types: entities and value objects (the data the components operate on).
// Defined once by their owner; referenced — never redefined — elsewhere.
// ---------------------------------------------------------------------------
export const TypeKindSchema = z.enum(['entity', 'value-object']);
export type TypeKind = z.infer<typeof TypeKindSchema>;

export const TypeFieldSchema = z.object({
  name: z.string(),
  type: z.string(), // a primitive, or another type id (qualified across subsystems, e.g. "billing.Invoice")
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
  /** Per-spec lint suppressions (see LintConfigSchema). */
  lint: LintConfigSchema.optional(),
  /** Opaque pack/tool extension data (see ExtDataSchema) — preserved verbatim. */
  ext: ExtDataSchema.optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type TypeSpec = z.infer<typeof TypeSpecSchema>;

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

export const GroupSpecSchema = z.object({
  kind: z.literal('group'),
  id: SpecIdSchema,
  name: z.string(),
  description: z.string().optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type GroupSpec = z.infer<typeof GroupSpecSchema>;
