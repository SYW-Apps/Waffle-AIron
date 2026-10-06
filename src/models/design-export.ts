// ---------------------------------------------------------------------------
// The design export's format types (`design_*`, owned by sdd_surfaces).
//
// The design export is one JSON document per project holding the whole design,
// resolved (docs/design/generic-design-model/stage-4-5-export.md). Its zod
// schemas live here; the JSON Schema shipped with the package
// (schemas/design-export-<major>.json) is generated from DesignExportSchema at build
// time (scripts/gen-design-schema.mjs), and a test fails when the two drift.
//
// Every object is `passthrough`: the compatibility promise is that a MINOR
// format version only adds, and a consumer ignores what it does not know, so a
// document written by a newer minor still validates against an older schema.
// Closed sets the format may grow (a stereotype, a status, a transport) are
// strings here for the same reason.
// ---------------------------------------------------------------------------

import { z } from 'zod';
import {
  DispatchBindingSchema,
  EnumValueSchema,
  EventBindingSchema,
  ExternalLinkSchema,
  PatternRefSchema,
  DeclaredInvocationSchema as StoredDeclaredInvocationSchema,
  InvariantSchema,
  LifecycleEntrypointSchema,
  NarrativeStepSchema,
  PortalAuthSchema,
} from './specs.js';
import type { TypeExpression } from './type-grammar.js';

/** The document's `format` marker. */
export const DESIGN_FORMAT = 'wairon-design';

/**
 * The format version this wairon emits: `MAJOR.MINOR`. A minor only adds; a
 * major removes, renames or changes a meaning and is named in the CHANGELOG.
 * One major is emitted at a time, and a design change is never a format change.
 * 2.0 is the reachability model's: listener mounts and portalType removed,
 * transport, abi and the Portal-level invokedBy added, invokedBy kinds
 * narrowed to entry and runtime with a scope.
 */
export const DESIGN_FORMAT_VERSION = '2.0';

/**
 * design_approval — the approval state a design export is stamped with: the
 * lock-check verdict the caller decided against the gate identity, handed down
 * from the CLI to the exporter, or `unjudged` when no verdict was handed in
 * (an in-process caller that did not obtain one), which claims nothing either
 * way. Declared order is the spec's.
 */
export const DESIGN_APPROVALS = ['locked', 'stale', 'unlocked', 'unjudged'] as const;
export const DesignApprovalSchema = z.enum(DESIGN_APPROVALS);
export type DesignApproval = z.infer<typeof DesignApprovalSchema>;

/** design_dependency_role — how the exported project relates to a project it depends on. */
export const DESIGN_DEPENDENCY_ROLES = ['member', 'external'] as const;
export const DesignDependencyRoleSchema = z.enum(DESIGN_DEPENDENCY_ROLES);
export type DesignDependencyRole = z.infer<typeof DesignDependencyRoleSchema>;

/** A pack's extension data, passed through untouched under each pack's key. */
const ExtSchema = z.record(z.unknown());

/**
 * type_expression, as the export carries it: a parsed type position whose named
 * members carry the resolved KEY of the type they name.
 */
export const TypeExpressionSchema: z.ZodType<TypeExpression> = z.lazy(() =>
  z.object({
    form: z.enum(['primitive', 'named', 'list', 'set', 'map', 'optional', 'union', 'async', 'applied', 'result']),
    name: z.string().optional(),
    args: z.array(TypeExpressionSchema),
  }).passthrough(),
);

/** design_type_ref — one type position: its canonical text and, when the grammar reads it, its parse with keys resolved. */
export const DesignTypeRefSchema = z.object({
  text: z.string(),
  expression: TypeExpressionSchema.optional(),
}).passthrough();
export type DesignTypeRef = z.infer<typeof DesignTypeRefSchema>;

/** design_param — one parameter of a method or a signature type, in declared order. */
export const DesignParamSchema = z.object({
  name: z.string(),
  type: DesignTypeRefSchema,
  optional: z.boolean(),
  description: z.string().optional(),
}).passthrough();
export type DesignParam = z.infer<typeof DesignParamSchema>;

/** design_field — one field of an entity or value-object, in declared order. */
export const DesignFieldSchema = z.object({
  name: z.string(),
  type: DesignTypeRefSchema,
  optional: z.boolean(),
  description: z.string().optional(),
  key: z.string().optional(),
  references: z.string().optional(),
}).passthrough();
export type DesignField = z.infer<typeof DesignFieldSchema>;

/** declared_invocation — a caller outside the modelled graph, as the contract or the Portal declares it. */
const DeclaredInvocationSchema = StoredDeclaredInvocationSchema.passthrough();

/** design_method — a contract method, or a type's pure method, with its signature resolved. */
export const DesignMethodSchema = z.object({
  key: z.string(),
  name: z.string(),
  description: z.string().optional(),
  params: z.array(DesignParamSchema),
  returns: DesignTypeRefSchema,
  signature: z.string(),
  signatureType: z.string().optional(),
  effect: z.string().optional(),
  guarantees: z.array(z.string()),
  invokedBy: DeclaredInvocationSchema.optional(),
  endpoint: z.record(z.string()).optional(),
  formerly: z.array(z.string()),
  ext: ExtSchema.optional(),
}).passthrough();
export type DesignMethod = z.infer<typeof DesignMethodSchema>;

/** design_export_entry — one row of a resolved export table: a public name bound to its canonical target's key. */
export const DesignExportEntrySchema = z.object({
  publicName: z.string(),
  targetKind: z.string(),
  target: z.string(),
  audience: z.string().optional(),
  version: z.string().optional(),
  stability: z.string().optional(),
}).passthrough();
export type DesignExportEntry = z.infer<typeof DesignExportEntrySchema>;

/** design_dependency — a project the exported one references: named, never inlined. */
export const DesignDependencySchema = z.object({
  alias: z.string(),
  projectId: z.string(),
  role: DesignDependencyRoleSchema,
  digest: z.string().optional(),
  uses: z.array(z.string()),
}).passthrough();
export type DesignDependency = z.infer<typeof DesignDependencySchema>;

/** design_source — which tree the export was projected from, and the approval verdict over it. */
export const DesignSourceSchema = z.object({
  projectId: z.string(),
  stateId: z.string(),
  approved: z.boolean(),
  approval: DesignApprovalSchema,
}).passthrough();
export type DesignSource = z.infer<typeof DesignSourceSchema>;

/** design_project — the exported project's L0, with its resolved export table. No program-or-library kind: a consumer reads the facts. */
export const DesignProjectSchema = z.object({
  name: z.string(),
  vision: z.string(),
  boundaries: z.array(z.string()),
  requirements: z.array(z.string()),
  targetLanguage: z.string().optional(),
  exports: z.array(DesignExportEntrySchema),
}).passthrough();
export type DesignProject = z.infer<typeof DesignProjectSchema>;

/** design_subsystem — one subsystem, with its lifecycle roots and its resolved L1 export table. */
export const DesignSubsystemSchema = z.object({
  key: z.string(),
  name: z.string(),
  description: z.string(),
  status: z.string(),
  profile: z.string().optional(),
  targetLanguage: z.string().optional(),
  lifecycle: z.array(LifecycleEntrypointSchema.passthrough()),
  exports: z.array(DesignExportEntrySchema),
  trustedLinks: z.array(z.string()),
  ext: ExtSchema.optional(),
}).passthrough();
export type DesignSubsystem = z.infer<typeof DesignSubsystemSchema>;

/** design_component — one component with its stereotype and edges, every reference a key. */
export const DesignComponentSchema = z.object({
  key: z.string(),
  name: z.string(),
  description: z.string(),
  status: z.string(),
  subsystem: z.string(),
  stereotype: z.string(),
  variant: z.string().optional(),
  dependencyClass: z.string().optional(),
  durability: z.string().optional(),
  /** On a Portal: its transport (format 2.0 replaces portalType and its HTTP_API spelling). */
  transport: z.string().optional(),
  /** On an InProcess Portal that declares one: how a foreign language links it. */
  abi: z.string().optional(),
  /** On a Portal that declares one: the entry its verbs inherit (format 2.0 replaces the listener mounts). */
  invokedBy: DeclaredInvocationSchema.optional(),
  owns: z.array(z.string()),
  dependsOn: z.array(z.string()),
  emits: z.array(EventBindingSchema.passthrough()),
  subscribesTo: z.array(EventBindingSchema.passthrough()),
  auth: PortalAuthSchema.passthrough().optional(),
  basePath: z.string().optional(),
  dispatch: z.array(DispatchBindingSchema.passthrough()),
  /** The pack-declared patterns the component realizes, as declared. */
  patterns: z.array(PatternRefSchema.passthrough()),
  /** The opaque external references the component documents, as declared. */
  externalLinks: z.array(ExternalLinkSchema.passthrough()),
  formerly: z.array(z.string()),
  ext: ExtSchema.optional(),
}).passthrough();
export type DesignComponent = z.infer<typeof DesignComponentSchema>;

/** design_interface — one contract with its methods resolved. */
export const DesignInterfaceSchema = z.object({
  key: z.string(),
  component: z.string(),
  name: z.string(),
  description: z.string(),
  status: z.string(),
  methods: z.array(DesignMethodSchema),
  formerly: z.array(z.string()),
  ext: ExtSchema.optional(),
}).passthrough();
export type DesignInterface = z.infer<typeof DesignInterfaceSchema>;

/** design_method_body — one method's body: a flat numbered step list, or an intent paragraph. */
export const DesignMethodBodySchema = z.object({
  method: z.string(),
  detail: z.string(),
  intent: z.string().optional(),
  calls: z.array(z.string()),
  narrative: z.array(NarrativeStepSchema.passthrough()),
}).passthrough();
export type DesignMethodBody = z.infer<typeof DesignMethodBodySchema>;

/** design_implementation — one L4 realization of a contract, with its method bodies. */
export const DesignImplementationSchema = z.object({
  key: z.string(),
  contract: z.string(),
  component: z.string(),
  name: z.string(),
  description: z.string(),
  status: z.string(),
  technologies: z.array(z.string()),
  sourcePath: z.string().optional(),
  methods: z.array(DesignMethodBodySchema),
  formerly: z.array(z.string()),
  ext: ExtSchema.optional(),
}).passthrough();
export type DesignImplementation = z.infer<typeof DesignImplementationSchema>;

/** design_type — one type, every type position canonical and parsed. */
export const DesignTypeSchema = z.object({
  key: z.string(),
  kind: z.string(),
  name: z.string(),
  description: z.string().optional(),
  status: z.string().optional(),
  fields: z.array(DesignFieldSchema),
  methods: z.array(DesignMethodSchema),
  params: z.array(DesignParamSchema),
  returns: DesignTypeRefSchema.optional(),
  values: z.array(EnumValueSchema.passthrough()),
  holds: z.string().optional(),
  invariants: z.array(InvariantSchema.passthrough()),
  componentClass: z.string().optional(),
  database: z.string().optional(),
  table: z.string().optional(),
  linkedEntity: z.string().optional(),
  formerly: z.array(z.string()),
  ext: ExtSchema.optional(),
}).passthrough();
export type DesignType = z.infer<typeof DesignTypeSchema>;

/** design_export — one project's whole design, resolved: the one documented integration point. */
export const DesignExportSchema = z.object({
  format: z.literal(DESIGN_FORMAT),
  formatVersion: z.string().regex(/^\d+\.\d+$/),
  generator: z.string(),
  source: DesignSourceSchema,
  project: DesignProjectSchema,
  dependencies: z.array(DesignDependencySchema),
  subsystems: z.array(DesignSubsystemSchema),
  components: z.array(DesignComponentSchema),
  interfaces: z.array(DesignInterfaceSchema),
  implementations: z.array(DesignImplementationSchema),
  types: z.array(DesignTypeSchema),
}).passthrough();
export type DesignExport = z.infer<typeof DesignExportSchema>;
