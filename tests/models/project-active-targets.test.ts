import { describe, it, expect } from 'vitest';
import { activeTargetTypes } from '../../src/models/project.js';
import type { ProjectConfig } from '../../src/models/project.js';

// ---------------------------------------------------------------------------
// project_config.activeTargetTypes — the pure type method behind skills export,
// guide re-injection and `wairon init`: every target not explicitly disabled,
// mapped to its type.
// ---------------------------------------------------------------------------

const config = (targets: unknown[]): ProjectConfig =>
  ({ name: 'p', targets, rules: {} } as unknown as ProjectConfig);

describe('project_config.activeTargetTypes', () => {
  it('returns the type of every enabled target, in declaration order', () => {
    expect(activeTargetTypes(config([
      { type: 'claude', outputDir: '.claude/agents', enabled: true },
      { type: 'cursor', outputDir: '.cursor/rules', enabled: false },
      { type: 'agy', outputDir: '.gemini/agents', enabled: true },
    ]))).toEqual(['claude', 'agy']);
  });

  it('counts a target without an enabled flag as enabled (only an explicit false disables)', () => {
    expect(activeTargetTypes(config([{ type: 'codex', outputDir: '.codex/agents' }]))).toEqual(['codex']);
  });

  it('maps a custom target to its type', () => {
    expect(activeTargetTypes(config([
      { type: 'custom', label: 'Tool', outputDir: '.ai-agents', enabled: true },
    ]))).toEqual(['custom']);
  });

  it('keeps a legacy string target as its own type', () => {
    expect(activeTargetTypes(config(['claude', { type: 'agy', outputDir: '.gemini/agents', enabled: true }])))
      .toEqual(['claude', 'agy']);
  });

  it('is empty when no target is enabled', () => {
    expect(activeTargetTypes(config([]))).toEqual([]);
    expect(activeTargetTypes(config([{ type: 'claude', outputDir: '.claude/agents', enabled: false }]))).toEqual([]);
  });
});
