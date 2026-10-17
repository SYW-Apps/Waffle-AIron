import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { injectGuide } from '../../src/utils/ai-guide.js';

// ---------------------------------------------------------------------------
// The injected project guide is the vocabulary an agent designs with before it
// reads any skill, so it must name the blocks and patterns the validator
// accepts: Query is a block, Repository the one pattern, a gateway a Portal
// variant, and the retired Specialist and Gateway nothing to design with.
// ---------------------------------------------------------------------------

function injectedLocalGuide(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-guide-test-'));
  try {
    const file = path.join(dir, 'CLAUDE.md');
    injectGuide(file, 'local');
    return fs.readFileSync(file, 'utf-8');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Lines naming Specialist or Gateway as a stereotype without saying it is retired. */
function liveRetiredMentions(text: string): string[] {
  return text.split(/\r?\n/).filter((line) => /\b(Specialist|Gateway)s?\b/.test(line) && !/retired/i.test(line));
}

describe('the injected local guide', () => {
  it('lists the ten blocks, Query among them', () => {
    expect(injectedLocalGuide()).toContain(
      '* **Blocks**: Portal, Orchestrator, Supervisor, Actor, Store, Index, Query, Registry, Adapter, Observer.',
    );
  });

  it('names Repository as the pattern and the gateway as a Portal variant', () => {
    const guide = injectedLocalGuide();
    expect(guide).toMatch(/^\* \*\*Patterns\*\*: Repository\b/m);
    expect(guide).toMatch(/^\* \*\*Variants\*\*: .*`gateway`.*Portal/m);
    expect(guide).toContain('`dependencyClass: pure | read`');
  });

  it('keeps held state out of Orchestrators without teaching a retired stereotype', () => {
    const guide = injectedLocalGuide();
    expect(guide).toContain('never as fields inside an Orchestrator.');
    expect(liveRetiredMentions(guide)).toEqual([]);
  });
});
