import { z } from 'zod';

// ---------------------------------------------------------------------------
// Bundle definition — a group of related agents created together for a scope
//
// When you run `waffagent create-bundle --bundle service-default --scope core-service`,
// the bundle definition drives which agents get created, with which templates,
// and what paths they own.
// ---------------------------------------------------------------------------

export const BundleAgentSpecSchema = z.object({
  /**
   * Suffix appended to the scope to produce the agent id.
   * e.g. scope "core-service" + suffix "owner" => id "core-service-owner"
   */
  idSuffix: z.string(),

  /** Template to use for this agent in the bundle */
  template: z.string(),

  /** Display name pattern. Use {{scope}} as placeholder. */
  namePattern: z.string(),

  /** Description pattern. Use {{scope}} as placeholder. */
  descriptionPattern: z.string(),

  /**
   * Path patterns for ownedPaths. Use {{scopeDir}} as placeholder.
   * e.g. "{{scopeDir}}/**" expands to the scope's directory glob.
   */
  ownedPathPatterns: z.array(z.string()).default([]),

  /** Additional tags specific to this bundle member */
  tags: z.array(z.string()).default([]),
});

export type BundleAgentSpec = z.infer<typeof BundleAgentSpecSchema>;

export const BundleSchema = z.object({
  /** Unique bundle identifier, e.g. "service-default" */
  id: z.string(),

  /** Display name */
  name: z.string(),

  /** Short description of when to use this bundle */
  description: z.string(),

  /**
   * The agents this bundle creates.
   * Order matters: dependencies should come before dependents.
   */
  agents: z.array(BundleAgentSpecSchema),

  /** Version of this bundle definition */
  version: z.string().default('1.0.0'),
});

export type Bundle = z.infer<typeof BundleSchema>;
