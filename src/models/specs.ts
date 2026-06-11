import { z } from 'zod';

// ---------------------------------------------------------------------------
// Common Identifier Schema
// ---------------------------------------------------------------------------
export const SpecIdSchema = z.string().regex(/^[a-z0-9-_]+$/, 'Identifier must be lowercase alphanumeric with dashes or underscores');

// ---------------------------------------------------------------------------
// Level 0: System Spec (system.yaml)
// ---------------------------------------------------------------------------
export const SystemSpecSchema = z.object({
  schemaVersion: z.string().default('1.0.0'),
  name: z.string(),
  vision: z.string(),
  boundaries: z.array(z.string()).default([]),
  globalRequirements: z.array(z.string()).default([]),
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
});

export type PublicInterface = z.infer<typeof PublicInterfaceSchema>;

export const SubsystemSpecSchema = z.object({
  id: SpecIdSchema,
  name: z.string(),
  description: z.string(),
  parentSystem: z.string(), // References L0 System Name or file
  publicInterfaces: z.array(PublicInterfaceSchema).default([]),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export type SubsystemSpec = z.infer<typeof SubsystemSpecSchema>;

// ---------------------------------------------------------------------------
// Level 2: Component Spec (components/*.yaml)
// ---------------------------------------------------------------------------
export const ComponentTypeSchema = z.enum([
  'Orchestrator',
  'Store',
  'Adapter',
  'Repository',
  'Resolver',
  'Supervisor',
  'Registry',
  'Portal'
]);
export type ComponentType = z.infer<typeof ComponentTypeSchema>;

export const PortalTypeSchema = z.enum(['HTTP_API', 'CLI', 'GraphQL', 'MessageBus', 'Custom']);
export type PortalType = z.infer<typeof PortalTypeSchema>;

export const ComponentSpecSchema = z.object({
  id: SpecIdSchema,
  name: z.string(),
  description: z.string(),
  subsystem: z.string(), // References L1 Subsystem id
  componentType: ComponentTypeSchema,
  dependencies: z.array(z.string()).default([]), // References other L2 Component ids
  portalType: PortalTypeSchema.optional(),
  basePath: z.string().optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export type ComponentSpec = z.infer<typeof ComponentSpecSchema>;

// ---------------------------------------------------------------------------
// Level 3: Interface / Contract Spec (interfaces/*.yaml)
// ---------------------------------------------------------------------------
export const HttpEndpointSchema = z.object({
  method: z.enum(['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS', 'HEAD']),
  path: z.string(),
});
export type HttpEndpoint = z.infer<typeof HttpEndpointSchema>;

export const MethodSignatureSchema = z.object({
  name: z.string().regex(/^[a-zA-Z0-9_]+$/, 'Method name must be alphanumeric'),
  description: z.string(),
  signature: z.string(), // e.g. "save(key: string, data: Buffer): Promise<void>"
  returns: z.string(),   // e.g. "Promise<void>"
  httpEndpoint: HttpEndpointSchema.optional(),
});

export type MethodSignature = z.infer<typeof MethodSignatureSchema>;

export const InterfaceSpecSchema = z.object({
  id: SpecIdSchema.regex(/^i[a-z0-9-_]+$/, 'Interface id must be prefixed with a lowercase "i"'),
  name: z.string(),
  description: z.string(),
  component: z.string(), // References L2 Component id
  methods: z.array(MethodSignatureSchema).default([]),
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
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export type ImplementationSpec = z.infer<typeof ImplementationSpecSchema>;
