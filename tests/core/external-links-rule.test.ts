import { describe, it, expect } from 'vitest';
import { buildRuleContext } from '../../src/core/rules/index.js';
import { externalLinksRule } from '../../src/core/rules/integrity/external-links.js';
import type { ValidationIssue } from '../../src/core/validation.js';

const stamp = { createdAt: '2026-09-15T10:00:00Z', updatedAt: '2026-09-15T10:00:00Z' };

function run(links: { url: string; label?: string }[]): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const sub = { id: 'billing', name: 'billing', description: 'd', parentSystem: 'LedgerSystem', publicInterfaces: [], trustedLinks: [], status: 'complete', ...stamp };
  const comp = {
    id: 'poster', name: 'Poster', description: 'd', componentType: 'Orchestrator', subsystem: 'billing',
    dependsOn: [], owns: [], status: 'complete', externalLinks: links.map(l => ({ type: 'informative', ...l })), ...stamp,
  };
  const ctx = buildRuleContext({
    system: { schemaVersion: '1.0.0', name: 'LedgerSystem', vision: 'v', ...stamp } as never,
    subsystems: [sub] as never,
    components: [comp] as never,
    interfaces: [],
    implementations: [],
    types: [],
    projectType: 'backend',
    roundTripIssues: [],
    knownIssueCodes: new Set<string>(),
    issues,
  });
  externalLinksRule.check(ctx);
  return issues.filter(i => i.code === 'EXTERNAL_LINK_UNSAFE');
}

describe('external-links rule', () => {
  it('accepts https, and http only for localhost / 127.0.0.1', () => {
    expect(run([{ url: 'https://example.com/a?b=1' }, { url: 'http://localhost:3000/x' }, { url: 'http://127.0.0.1/x' }])).toEqual([]);
  });

  it.each([
    ['javascript:alert(1)', /scheme "javascript"/],
    ['data:text/html,x', /scheme "data"/],
    ['file:///etc/passwd', /scheme "file"/],
    ['http://example.com/', /scheme "http"/],
    ['/relative/path', /not an absolute URL/],
    ['https://user:secret@example.com/', /credentials/],
  ])('refuses %s', (url, why) => {
    const found = run([{ url }]);
    expect(found).toHaveLength(1);
    expect(found[0].severity).toBe('error');
    expect(found[0].specId).toBe('poster');
    expect(found[0].message).toMatch(why);
  });

  it('names the label when there is one, else the url', () => {
    expect(run([{ url: 'nope', label: 'Runbook' }])[0].message).toContain('"Runbook"');
    expect(run([{ url: 'nope' }])[0].message).toContain('"nope"');
  });
});
