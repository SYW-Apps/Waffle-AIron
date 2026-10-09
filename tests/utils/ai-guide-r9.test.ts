import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { guideBody } from '../../src/utils/ai-guide.js';
import { buildServerInstructions } from '../../src/core/instructions.js';

// ---------------------------------------------------------------------------
// Round 9: what the assistant may READ must name the human's commands (it
// could not tell the human how to produce a Portal's OpenAPI document), state
// the --ci verdict rule plainly (it hedged on whether warnings fail it), say
// injectedParams are set by the implementer once the code exists (the
// architect skill guessed seven on a fresh design), and say plain JavaScript
// is checked through JSDoc.
// ---------------------------------------------------------------------------

const templates = path.join(__dirname, '..', '..', 'src', 'templates', 'skills');

describe.each(['local', 'global'] as const)('the %s guide', (scope) => {
  const body = guideBody(scope);

  it('names the human commands the assistant recommends, as the human\'s to run', () => {
    expect(body).toContain('What the human runs — recommend these, never run them');
    for (const command of [
      'wairon surface export --format openapi --portal <portal-id> --out <file>',
      'wairon lock',
      'wairon lock-check',
      'wairon externals pin <alias>',
      'wairon network declare',
      'wairon member add',
      'wairon doctor --fix',
      'wairon agent customize <id>',
    ]) expect(body).toContain(command);
  });

  it('states the --ci rule plainly: errors and warnings fail it, draft-related warnings and notices never do', () => {
    expect(body).toContain('`wairon validate --ci` — the CI gate. It FAILS on any error and on any warning, except the draft-related ones');
    expect(body).toContain('notices never fail it');
  });

  it('says injectedParams are code linkage the implementer sets once the code exists, never at design time', () => {
    expect(body).toContain('`injectedParams` are set when the code exists, by the implementer');
    expect(body).toContain('never declare them at design time');
    expect(body).toContain('UNUSED_INJECTED_PARAM');
  });

  it('says plain JavaScript shapes are checked through a JSDoc @typedef', () => {
    expect(body).toContain('JSDoc `@typedef`');
  });
});

describe('the MCP server instructions and the skills, round 9', () => {
  it('the pushed instructions name the human commands, the --ci rule and when injectedParams are set', () => {
    const text = buildServerInstructions();
    expect(text).toContain('## Facts to state, not guess');
    expect(text).toContain('`wairon surface export\n--format openapi --portal <id>`');
    expect(text).toContain('(fails on errors and non-draft warnings, never on notices)');
    expect(text).toContain('`injectedParams` are never set at design time');
  });

  it('the architect skill keeps injectedParams out of the design and plans type files per owner', () => {
    const architect = fs.readFileSync(path.join(templates, 'sdd-architect.md'), 'utf8');
    expect(architect).toContain('**`injectedParams` are NOT design-time**');
    expect(architect).toContain('Plan type files per owner, not one file for all');
    expect(architect).toContain('never a new Orchestrator whose only job is to forward one call');
  });

  it('the implement skill says when and how the implementer sets injectedParams, and that guesses are removed', () => {
    const implement = fs.readFileSync(path.join(templates, 'sdd-implement.md'), 'utf8');
    expect(implement).toContain('`injectedParams` are yours to set, when the code exists');
    expect(implement).toContain('{"injectedParams": [{"value": "db", "action": "delete"}]}');
  });
});
