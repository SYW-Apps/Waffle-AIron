import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

// ---------------------------------------------------------------------------
// The skill and agent templates are what an agent designs and implements from,
// so their stereotype vocabulary must match the validator's: Query is a block,
// logic is an Orchestrator with a dependency class, a gateway is a Portal
// variant, and Specialist and Gateway are retired, never advice.
// ---------------------------------------------------------------------------

const TEMPLATES = path.resolve(__dirname, '..', '..', 'src', 'templates');

/** The skill documents and the top-level agent templates, as [file, text] pairs. */
function templates(): [string, string][] {
  const skills = fs.readdirSync(path.join(TEMPLATES, 'skills'))
    .filter((f) => f.endsWith('.md'))
    .map((f) => path.join('skills', f));
  const agents = fs.readdirSync(TEMPLATES).filter((f) => /\.ya?ml$/.test(f));
  return [...skills, ...agents].map((rel) => [rel, fs.readFileSync(path.join(TEMPLATES, rel), 'utf-8')]);
}

describe('template stereotype vocabulary', () => {
  it('finds the templates it judges', () => {
    const files = templates().map(([rel]) => rel.replace(/\\/g, '/'));
    expect(files).toEqual(expect.arrayContaining(['skills/sdd-architect.md', 'skills/sdd-implement.md', 'architect.yaml']));
  });

  it('never teaches Specialist or Gateway as a stereotype to design with', () => {
    for (const [rel, text] of templates()) {
      const live = text.split(/\r?\n/).filter((line) => /\b(Specialist|Gateway)s?\b/.test(line) && !/retired/i.test(line));
      expect(live, rel).toEqual([]);
    }
  });

  it('lists Query in every inline stereotype list', () => {
    for (const [rel, text] of templates()) {
      const lists = text.split(/\r?\n/).filter((line) => /Portal, Orchestrator, Supervisor, Actor/.test(line));
      for (const line of lists) expect(line, rel).toMatch(/\bQuery\b/);
    }
  });

  it('gives sdd-implement a Query role and a pure/read Orchestrator role', () => {
    const implement = fs.readFileSync(path.join(TEMPLATES, 'skills', 'sdd-implement.md'), 'utf-8');
    expect(implement).toMatch(/^\s*- `Query` \(/m);
    expect(implement).toMatch(/^\s*- pure\/read `Orchestrator` \(/m);
  });
});
