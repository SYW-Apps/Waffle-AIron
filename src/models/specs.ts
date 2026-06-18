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

export const SystemSpecSchema = z.object({
  schemaVersion: z.string().default('1.0.0'),
  name: z.string(),
  vision: z.string(),
  boundaries: z.array(BoundaryItemSchema).default([]),
  globalRequirements: z.array(RequirementItemSchema).default([]),
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

export const SubsystemSpecSchema = z.object({
  id: SpecIdSchema,
  name: z.string(),
  description: z.string(),
  parentSystem: z.string(), // References L0 System Name or file
  publicInterfaces: z.array(PublicInterfaceSchema).default([]),
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
  // Patterns (compositions of blocks)
  'Repository',
  'Gateway',
]);
export type ComponentType = z.infer<typeof ComponentTypeSchema>;

/** Component types that are patterns (own member blocks) rather than building blocks. */
export const PATTERN_TYPES: ReadonlySet<ComponentType> = new Set(['Repository', 'Gateway']);

export const PortalTypeSchema = z.enum(['HTTP_API', 'gRPC', 'GraphQL', 'MessageBus', 'CLI', 'NamedPipe', 'IPC', 'Custom']);
export type PortalType = z.infer<typeof PortalTypeSchema>;

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

export const MethodSignatureSchema = z.object({
  name: z.string().regex(/^[a-zA-Z0-9_]+$/, 'Method name must be alphanumeric'),
  description: z.string(),
  signature: z.string(), // e.g. "save(key: string, data: Buffer): Promise<void>"
  returns: z.string(),   // e.g. "Promise<void>"
  /** Concrete wire binding for this method when its component is a Portal (set via sdd_set_endpoints). */
  endpoint: EndpointSchema.optional(),
});

export type MethodSignature = z.infer<typeof MethodSignatureSchema>;

export const InterfaceSpecSchema = z.object({
  id: SpecIdSchema.regex(/^i[a-z0-9-_]+$/, 'Interface id must be prefixed with a lowercase "i"'),
  name: z.string(),
  description: z.string(),
  component: z.string(), // References L2 Component id
  methods: z.array(MethodSignatureSchema).default([]),
  status: SpecStatusSchema.optional().default('complete'),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export type InterfaceSpec = z.infer<typeof InterfaceSpecSchema>;

// ---------------------------------------------------------------------------
// Level 5: Method / Narrative Step (embedded in L4)
// ---------------------------------------------------------------------------
export const NarrativeStepTypeSchema = z.enum(['local', 'call']);
export type NarrativeStepType = z.infer<typeof NarrativeStepTypeSchema>;

export const NarrativeStepSchema = z.object({
  stepNumber: z.number().int().positive(),
  description: z.string(),
  type: NarrativeStepTypeSchema,
  targetComponent: z.string().optional(), // Required if type is 'call', references L2 Component id
  targetMethod: z.string().optional(),    // Required if type is 'call', references Method name on target interface
});

export type NarrativeStep = z.infer<typeof NarrativeStepSchema>;

// ---------------------------------------------------------------------------
// Level 4: Implementation Spec (implementations/*.yaml)
// ---------------------------------------------------------------------------
export const MethodImplementationSchema = z.object({
  name: z.string(), // Must match a method name in the L3 interface contract
  narrative: z.array(NarrativeStepSchema).default([]), // Level 5 Narrative
});

export type MethodImplementation = z.infer<typeof MethodImplementationSchema>;

export const ImplementationSpecSchema = z.object({
  id: SpecIdSchema,
  name: z.string(),
  description: z.string(),
  contract: z.string(), // References L3 Interface id
  sourcePath: z.string().optional(), // Path to the concrete source code file (e.g. "src/storage/vfs.ts")
  methods: z.array(MethodImplementationSchema).default([]),
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

export const TypeSpecSchema = z.object({
  kind: TypeKindSchema, // discriminator — entity | value-object
  id: SpecIdSchema,
  name: z.string(),
  description: z.string().optional(),
  /** Owning subsystem id (entities). Omit for system-level shared value objects. */
  subsystem: z.string().optional(),
  fields: z.array(TypeFieldSchema).default([]),
  /** Pure intrinsic behaviour only — anything needing a collaborator belongs on a component. */
  methods: z.array(TypeMethodSchema).default([]),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type TypeSpec = z.infer<typeof TypeSpecSchema>;
