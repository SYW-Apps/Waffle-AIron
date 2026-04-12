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
  const exporter = new ClaudeExporter();

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
});
