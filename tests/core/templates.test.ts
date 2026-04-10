import { describe, it, expect } from 'vitest';
import { parseTemplate, renderTemplateInstructions } from '../../src/core/templates.js';

const SAMPLE_TEMPLATE_YAML = `
id: test-template
name: Test Template
version: 1.0.0
description: A template for testing.
requiresOwnedPaths: true
defaultTags:
  - test

instructions: |
  You are the **{{agentName}}** agent.
  You own: {{ownedPaths}}
  Tags: {{tags}}
  Unknown: {{unknownVar}}
`;

describe('parseTemplate', () => {
  it('parses a valid template YAML string', () => {
    const template = parseTemplate(SAMPLE_TEMPLATE_YAML);
    expect(template.id).toBe('test-template');
    expect(template.name).toBe('Test Template');
    expect(template.requiresOwnedPaths).toBe(true);
    expect(template.defaultTags).toEqual(['test']);
  });
});

describe('renderTemplateInstructions', () => {
  it('substitutes known variables', () => {
    const template = parseTemplate(SAMPLE_TEMPLATE_YAML);
    const rendered = renderTemplateInstructions(template, {
      agentName: 'My Agent',
      ownedPaths: 'src/**',
      tags: 'owner, service',
    });

    expect(rendered).toContain('**My Agent**');
    expect(rendered).toContain('src/**');
    expect(rendered).toContain('owner, service');
  });

  it('leaves unknown variables as-is', () => {
    const template = parseTemplate(SAMPLE_TEMPLATE_YAML);
    const rendered = renderTemplateInstructions(template, {
      agentName: 'X',
      ownedPaths: '',
      tags: '',
    });

    expect(rendered).toContain('{{unknownVar}}');
  });
});
