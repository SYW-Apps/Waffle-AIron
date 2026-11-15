import { describe, it, expect } from 'vitest';
import { ProjectConfigSchema, TargetConfigSchema, pluginTargetTypes } from '../../src/models/project.js';

// ---------------------------------------------------------------------------
// target_config.via and project_config.pluginTargetTypes: a target may say
// `via: plugin` only where its tool has a wairon plugin; copilot and a custom
// target have none, and naming it there is a configuration error.
// ---------------------------------------------------------------------------

const now = '2026-11-15T10:00:00Z';

const config = (targets: unknown[]) => ProjectConfigSchema.parse({
  schemaVersion: '1.0.0', name: 'p', targets, rules: {}, createdAt: now, updatedAt: now,
});

describe('target_config.via', () => {
  it.each(['claude', 'codex', 'cursor', 'agy', 'gemini'])('accepts via: plugin on %s', (type) => {
    const parsed = TargetConfigSchema.safeParse({ type, outputDir: '.x', via: 'plugin' });
    expect(parsed.success).toBe(true);
  });

  it('accepts via: project and no via at all', () => {
    expect(TargetConfigSchema.safeParse({ type: 'claude', outputDir: '.x', via: 'project' }).success).toBe(true);
    expect(TargetConfigSchema.safeParse({ type: 'claude', outputDir: '.x' }).success).toBe(true);
  });

  it('refuses via: plugin on copilot', () => {
    const parsed = TargetConfigSchema.safeParse({ type: 'copilot', outputDir: '.x', via: 'plugin' });
    expect(parsed.success).toBe(false);
  });

  it('refuses via: plugin on a custom target', () => {
    const parsed = TargetConfigSchema.safeParse({ type: 'custom', label: 'Mine', outputDir: '.x', via: 'plugin' });
    expect(parsed.success).toBe(false);
  });

  it('refuses a via that is neither project nor plugin', () => {
    expect(TargetConfigSchema.safeParse({ type: 'claude', outputDir: '.x', via: 'marketplace' }).success).toBe(false);
  });

  it('refuses a configuration that names the plugin on copilot', () => {
    expect(() => config([{ type: 'copilot', outputDir: '.x', via: 'plugin' }])).toThrow();
  });
});

describe('project_config.pluginTargetTypes', () => {
  it('lists the enabled plugin targets in declaration order', () => {
    const c = config([
      { type: 'codex', outputDir: '.a', via: 'plugin' },
      { type: 'claude', outputDir: '.b' },
      { type: 'agy', outputDir: '.c', via: 'plugin' },
    ]);
    expect(pluginTargetTypes(c)).toEqual(['codex', 'agy']);
  });

  it('leaves out a disabled plugin target', () => {
    const c = config([{ type: 'claude', outputDir: '.a', via: 'plugin', enabled: false }]);
    expect(pluginTargetTypes(c)).toEqual([]);
  });

  it('is empty when no target names the plugin', () => {
    expect(pluginTargetTypes(config([{ type: 'claude', outputDir: '.a' }]))).toEqual([]);
  });
});
