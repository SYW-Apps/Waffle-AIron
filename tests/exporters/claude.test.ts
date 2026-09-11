import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as path from 'path';
import { ClaudeExporter } from '../../src/exporters/claude.js';
import { createAgentRecord } from '../../src/models/agent.js';
import { parseTemplate } from '../../src/core/templates.js';

// Mock the fs write so we don't touch the disk in unit tests
vi.mock('../../src/utils/fs.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/utils/fs.js')>();
  return {
    ...actual,
    writeFile: vi.fn(),
    writeFileIfChanged: vi.fn(() => true),
  };
});

const MINIMAL_TEMPLATE_YAML = `
id: domain-owner
name: Domain Owner
version: 1.0.0
description: A domain owner.
requiresOwnedPaths: true
defaultTags: []
instructions: |
  You are **{{agentName}}**.
  Owns: {{ownedPaths}}
`;

describe('ClaudeExporter', () => {
  const exporter = new ClaudeExporter({ emitBudget: true });

  const agent = createAgentRecord({
    id: 'core-service-owner',
    name: 'Core Service Owner',
    description: 'Owns the core service.',
    template: 'domain-owner',
    creationReason: 'test',
    ownedPaths: ['services/core/**'],
    targets: ['claude'],
  });

  const template = parseTemplate(MINIMAL_TEMPLATE_YAML);
  const projectRoot = '/project';
  const target = { type: 'claude' as const, outputDir: '.claude/agents', enabled: true };

  it('produces the correct output path', () => {
    const filePath = exporter.outputPath({ agent, template, projectRoot, target });
    expect(filePath).toBe(path.resolve('/project/.claude/agents/core-service-owner.md'));
  });

  it('generates content with YAML front-matter and instructions', () => {
    const result = exporter.export({
      agent,
      template,
      renderedInstructions: 'You are **Core Service Owner**.\nOwns: services/core/**',
      projectRoot,
      target,
    });

    expect(result.content).toContain('---');
    expect(result.content).toContain('name: Core Service Owner');
    expect(result.content).toContain('description: Owns the core service.');
    expect(result.content).toContain('You are **Core Service Owner**.');
    expect(result.content).toContain('services/core/**');
  });

  // -------------------------------------------------------------------------
  // Execution budget → Claude front-matter
  //
  // This is the per-tool encoding half of the resource axis: capability tiers
  // in, real Claude Code front-matter out.
  // -------------------------------------------------------------------------

  const exportWith = (budget?: Parameters<typeof exporter.export>[0]['budget']) =>
    exporter.export({
      agent,
      template,
      renderedInstructions: 'body',
      projectRoot,
      target,
      budget,
    }).content;

  it('emits no budget front-matter when the project has budgets off', () => {
    const content = exportWith(undefined);
    expect(content).not.toContain('model:');
    expect(content).not.toContain('tools:');
    expect(content).not.toContain('maxTurns:');
    expect(content).not.toContain('mcpServers:');
  });

  it('maps capability tiers onto model aliases rather than pinned ids', () => {
    const content = exportWith({
      modelTier: 'small',
      toolClass: 'implement',
      allowNestedDelegation: false,
      mcp: 'none',
    });
    expect(content).toContain('model: haiku');
    // Aliases keep the generated file valid across model releases.
    expect(content).not.toMatch(/model:.*-\d/);
  });

  it('omits model entirely when the policy expressed no choice', () => {
    const content = exportWith({
      toolClass: 'implement',
      allowNestedDelegation: false,
      mcp: 'all',
    });
    expect(content).not.toContain('model:');
    expect(content).toContain('tools:');
  });

  it('gives a manager orchestration tools and withholds bulk-content tools', () => {
    const content = exportWith({
      modelTier: 'large',
      toolClass: 'orchestrate',
      allowNestedDelegation: true,
      mcp: 'project',
    });
    expect(content).toContain('tools: Agent, SendMessage, TodoWrite');
    expect(content).not.toContain('Read');
    expect(content).not.toContain('Bash');
  });

  it('withholds the delegation tool from a worker', () => {
    const content = exportWith({
      modelTier: 'small',
      toolClass: 'implement',
      allowNestedDelegation: false,
      mcp: 'none',
    });
    expect(content).toMatch(/tools: .*Read/);
    expect(content).not.toMatch(/tools: .*Agent/);
  });

  it('emits an empty mcpServers list only when access is none', () => {
    expect(
      exportWith({ toolClass: 'implement', allowNestedDelegation: false, mcp: 'none' }),
    ).toContain('mcpServers: []');
    expect(
      exportWith({ toolClass: 'implement', allowNestedDelegation: false, mcp: 'project' }),
    ).not.toContain('mcpServers:');
  });

  it('emits effort and turn ceilings when the budget carries them', () => {
    const content = exportWith({
      modelTier: 'small',
      effort: 'low',
      maxTurns: 25,
      toolClass: 'implement',
      allowNestedDelegation: false,
      mcp: 'none',
    });
    expect(content).toContain('effort: low');
    expect(content).toContain('maxTurns: 25');
  });

  it('keeps the front-matter block well-formed with every field present', () => {
    const content = exportWith({
      modelTier: 'frontier',
      effort: 'xhigh',
      maxTurns: 60,
      toolClass: 'read-only',
      allowNestedDelegation: false,
      mcp: 'none',
    });
    const [, frontmatter] = content.split('---');
    for (const line of frontmatter.trim().split('\n')) {
      expect(line).toMatch(/^[a-zA-Z]+: .+$/);
    }
  });

  it('does not emit budget front-matter for targets that only reuse the markdown shape', () => {
    // cursor/copilot/codex share ClaudeExporter for the file shape, but the
    // budget fields are Claude Code's subagent contract. An unhonoured budget
    // is worse than none — it reads as enforced when nothing enforces it.
    const shapeOnly = new ClaudeExporter();
    const content = shapeOnly.export({
      agent,
      template,
      renderedInstructions: 'body',
      projectRoot,
      target: { type: 'cursor' as const, outputDir: '.cursor/agents', enabled: true },
      budget: {
        modelTier: 'small',
        maxTurns: 25,
        toolClass: 'implement',
        allowNestedDelegation: false,
        mcp: 'none',
      },
    }).content;
    expect(content).toContain('name: Core Service Owner');
    expect(content).not.toContain('model:');
    expect(content).not.toContain('maxTurns:');
    expect(content).not.toContain('mcpServers:');
  });
});
