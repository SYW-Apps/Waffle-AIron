import { z } from 'zod';

// ---------------------------------------------------------------------------
// Template definition — a reusable agent shape
//
// Templates live both as built-in files shipped with the CLI (src/templates/)
// and as project-local overrides (.wai/templates/).
//
// Project-local templates take precedence over built-ins.
// ---------------------------------------------------------------------------

export const TemplateSchema = z.object({
  /** Unique template identifier, e.g. "domain-owner" */
  id: z.string(),

  /** Display name */
  name: z.string(),

  /** Short description of this template's purpose */
  description: z.string(),

  /**
   * Markdown instruction body for the agent.
   * Supports simple variable interpolation: {{agentName}}, {{ownedPaths}}, etc.
   */
  instructions: z.string(),

  /** Default tags applied to agents created from this template */
  defaultTags: z.array(z.string()).default([]),

  /** Whether agents from this template must have ownedPaths defined */
  requiresOwnedPaths: z.boolean().default(true),

  /**
   * Optional YAML front-matter fields to include in generated output.
   * These are passed through to the exporter as-is.
   */
  frontmatter: z.record(z.unknown()).optional(),

  /** Version of this template definition */
  version: z.string().default('1.0.0'),
});

export type Template = z.infer<typeof TemplateSchema>;
