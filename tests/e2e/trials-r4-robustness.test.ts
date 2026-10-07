import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { createScratchProject, callTool, type ScratchProject } from './helpers';
import {
  createTrialSandbox, transcript, writeFile, readFile, gitInit,
  type TrialSandbox, type CliResult,
} from './trials-helpers';
import type { FixtureTree } from '../rules-matrix/harness';

// ---------------------------------------------------------------------------
// Round-4 user trials (dev.108) — robustness journeys.
//
// The tinkerer persona stress-tested the edges: ids Windows cannot store, a
// hand-edited project.yaml with a duplicated key, the OpenAPI export of a
// templated path, and bad input that ended in a raw Node stack trace. Each
// journey replays the probe against the BUILT CLI / MCP server and asserts
// what a fixed build answers: one `✖` line, a non-zero exit, nothing written.
// ---------------------------------------------------------------------------

const OUTSIDE_CALLER = 'Dashboards and scripts outside the cluster, over HTTP';

/** A raw Node stack trace: `    at fn (file:line:col)` frames, or Node's own banner. */
function hasStackTrace(r: CliResult): boolean {
  return /^\s+at .+:\d+:\d+\)?$/m.test(r.all) || /Node\.js v\d+/.test(r.all);
}

/** One refusal as the CLI must print it: exit non-zero, a `✖` line, no stack. */
function expectOneLineRefusal(r: CliResult, pattern: RegExp): void {
  expect(r.code, transcript(r)).not.toBe(0);
  expect(hasStackTrace(r), transcript(r)).toBe(false);
  expect(r.all, transcript(r)).toMatch(/✖/);
  expect(r.all, transcript(r)).toMatch(pattern);
}

/** linkshort's analytics side: a public stats Portal with a templated GET path. */
function statsTree(): FixtureTree {
  return {
    system: {
      name: 'Linkshort', vision: 'A link shortener with an analytics service behind it.',
      publicInterfaces: [{ from: 'analytics', audience: 'external' }],
    },
    subsystems: [{ id: 'analytics', publicInterfaces: [{ component: 'reporting_portal', details: 'The public stats API.' }] }],
    components: [
      { id: 'reporting_portal', subsystem: 'analytics', componentType: 'Portal', transport: 'HTTP', invokedBy: { kind: 'entry', caller: OUTSIDE_CALLER } },
    ],
    interfaces: [{
      id: 'ireporting_portal', component: 'reporting_portal', methods: [
        { name: 'getStats', params: [{ name: 'code', type: 'string' }], returns: 'string', endpoint: { transport: 'HTTP', method: 'GET', path: '/stats/{code}' } },
        { name: 'renameCode', params: [{ name: 'code', type: 'string' }, { name: 'to', type: 'string' }], returns: 'void', endpoint: { transport: 'HTTP', method: 'PUT', path: '/stats/{code}' } },
      ],
    }],
  };
}

function setProjectId(dir: string, id: string): void {
  writeFile(dir, '.wai/project.yaml', `id: ${id}\n${readFile(dir, '.wai/project.yaml')}`);
}

// ── 1. ids Windows cannot store (BLOCKER on Windows) ────────────────────────

describe('journey: ids Windows reserves for devices, and over-long ids, are refused on every platform (tinkerer-r4 BLOCKER)', () => {
  let proj: ScratchProject;
  const specsHold = (id: string): boolean => {
    const walk = (dir: string): boolean => fs.readdirSync(dir, { withFileTypes: true }).some((e) =>
      e.name.split('.')[0].toLowerCase() === id || (e.isDirectory() && walk(path.join(dir, e.name))));
    return walk(path.join(proj.dir, '.wai', 'specs'));
  };

  beforeAll(async () => {
    proj = await createScratchProject('edgelab');
    const init = await callTool(proj.client, 'sdd_initialize_system', { name: 'Edgelab', vision: 'Ids at the edge of what a filesystem holds.', targetLanguage: 'typescript' });
    expect(init.ok, init.text).toBe(true);
    const sub = await callTool(proj.client, 'sdd_add_subsystem', { id: 'core', name: 'Core', description: 'The core.' });
    expect(sub.ok, sub.text).toBe(true);
  }, 120_000);
  afterAll(async () => { await proj?.cleanup(); });

  for (const id of ['aux', 'con', 'nul', 'prn', 'com1', 'lpt9']) {
    it(`sdd_add_component "${id}" is refused with the reason, and nothing is written`, async () => {
      const r = await callTool(proj.client, 'sdd_add_component', { id, name: id, description: 'A plausible id.', subsystem: 'core', componentType: 'Store' });
      expect(r.ok, r.text).toBe(false);
      expect(r.text).toMatch(/reserves for a device/);
      expect(specsHold(id)).toBe(false);
    });
  }

  it('a subsystem and a type named after a device are refused the same way', async () => {
    const sub = await callTool(proj.client, 'sdd_add_subsystem', { id: 'aux', name: 'Aux', description: 'Auxiliary.' });
    expect(sub.ok, sub.text).toBe(false);
    expect(sub.text).toMatch(/reserves for a device/);
    const type = await callTool(proj.client, 'sdd_add_type', { id: 'con', name: 'Con', kind: 'value-object', fields: [{ name: 'x', type: 'string' }] });
    expect(type.ok, type.text).toBe(false);
    expect(type.text).toMatch(/reserves for a device/);
    expect(specsHold('aux')).toBe(false);
    expect(specsHold('con')).toBe(false);
  });

  it('a 270-character id is refused as too long — not a raw ENOENT — and nothing is written', async () => {
    const id = `a_very_long_${'x'.repeat(258)}`;
    const r = await callTool(proj.client, 'sdd_add_component', { id, name: 'Long', description: 'Too long.', subsystem: 'core', componentType: 'Store' });
    expect(r.ok, r.text).toBe(false);
    expect(r.text).toMatch(/longer than 64 characters/);
    expect(r.text).not.toMatch(/ENOENT/);
    expect(specsHold(id)).toBe(false);
  });

  it('a near-miss is still a legal id (aux_store, console, com10)', async () => {
    for (const id of ['aux_store', 'console', 'com10']) {
      const r = await callTool(proj.client, 'sdd_add_component', { id, name: id, description: 'Fine.', subsystem: 'core', componentType: 'Store' });
      expect(r.ok, `${id}: ${r.text}`).toBe(true);
    }
  });
});

describe('journey: an existing tree that already holds a device-named id is reported by validate (tinkerer-r4 BLOCKER)', () => {
  let sb: TrialSandbox;
  let dir: string;
  beforeAll(() => {
    sb = createTrialSandbox('r4-devname');
    dir = sb.materialize('edgelab', statsTree());
    setProjectId(dir, 'edgelab');
    // Written by an older build (on Linux): the file name is safe here, its id is not.
    writeFile(dir, '.wai/specs/components/legacy_aux.yaml', [
      'schemaVersion: 1.0.0', 'id: aux', 'name: Aux', 'description: Written by an older build.',
      'subsystem: analytics', 'componentType: Store', "createdAt: '2026-01-01T00:00:00.000Z'", "updatedAt: '2026-01-01T00:00:00.000Z'", '',
    ].join('\n'));
  });
  afterAll(async () => { await sb?.cleanup(); });

  it('validate fails with one readable error naming the file and the reason (no zod JSON dump)', async () => {
    const r = await sb.run(['validate'], dir);
    expect(r.code, transcript(r)).toBe(1);
    expect(r.all).toMatch(/\[SCHEMA_VALIDATION_ERROR\][^\n]*legacy_aux\.yaml[^\n]*id: Identifier is a name Windows reserves for a device/);
    expect(r.all).not.toMatch(/"code": "invalid_string"/);
    expect(hasStackTrace(r), transcript(r)).toBe(false);
  });
});

// ── 2. a duplicated key in project.yaml ──────────────────────────────────────

describe('journey: a duplicated key in .wai/project.yaml is one ✖ line on every command (tinkerer-r4 MAJOR)', () => {
  let sb: TrialSandbox;
  let dir: string;
  beforeAll(() => {
    sb = createTrialSandbox('r4-dupkey');
    dir = sb.materialize('cfglab', statsTree());
    setProjectId(dir, 'cfglab');
    // The most natural hand edit: append a block the file already has.
    const before = readFile(dir, '.wai/project.yaml');
    expect(before).toMatch(/^rules:/m);
    writeFile(dir, '.wai/project.yaml', `${before.replace(/\s*$/, '\n')}rules:\n  requireOwnedPaths: false\n`);
  });
  afterAll(async () => { await sb?.cleanup(); });

  const line = (): number => readFile(dir, '.wai/project.yaml').split(/\r?\n/).lastIndexOf('rules:') + 1;

  for (const args of [['validate'], ['lock-check'], ['lock-check', '--strict'], ['status'], ['network', 'declare'], ['lock', '--yes'], ['externals', 'list'], ['list'], ['validate', '--silent']]) {
    it(`\`wairon ${args.join(' ')}\` names the file, the line and the key, and exits 1`, async () => {
      const r = await sb.run(args, dir);
      expect(r.code, transcript(r)).toBe(1);
      expect(hasStackTrace(r), transcript(r)).toBe(false);
      expect(r.all).toContain(`.wai/project.yaml:${line()}: duplicated mapping key "rules"`);
      expect(r.all.match(/✖/g)?.length, transcript(r)).toBe(1);
    });
  }

  it('`network declare` wrote nothing into the file it could not read', async () => {
    expect(readFile(dir, '.wai/project.yaml')).not.toMatch(/^network:/m);
  });

  it('doctor diagnoses it in its own words (the same parse error), and exits 1', async () => {
    const r = await sb.run(['doctor'], dir);
    expect(r.code, transcript(r)).toBe(1);
    expect(hasStackTrace(r), transcript(r)).toBe(false);
    expect(r.all).toMatch(/project\.yaml is invalid: [^\n]*duplicated mapping key "rules"/);
  });
});

// ── 3. OpenAPI path parameters ───────────────────────────────────────────────

describe('journey: `surface export --format openapi` declares a templated segment `in: path` (tinkerer-r4 MAJOR)', () => {
  let sb: TrialSandbox;
  let dir: string;
  beforeAll(() => {
    sb = createTrialSandbox('r4-openapi');
    dir = sb.materialize('linkshort', statsTree());
    setProjectId(dir, 'linkshort');
  });
  afterAll(async () => { await sb?.cleanup(); });

  it('GET /stats/{code}: code in: path, required; PUT keeps the rest in its body', async () => {
    const out = path.join(dir, 'stats-openapi.json');
    const r = await sb.run(['surface', 'export', '--format', 'openapi', '--out', out], dir);
    expect(r.code, transcript(r)).toBe(0);
    const doc = JSON.parse(fs.readFileSync(out, 'utf8'));
    const ops = doc.paths['/stats/{code}'];
    expect(ops.get.parameters).toEqual([{ name: 'code', in: 'path', required: true, schema: { type: 'string' } }]);
    expect(ops.put.parameters).toEqual([{ name: 'code', in: 'path', required: true, schema: { type: 'string' } }]);
    expect(Object.keys(ops.put.requestBody.content['application/json'].schema.properties)).toEqual(['to']);
    expect(JSON.stringify(doc)).not.toMatch(/"in":"query"/);
  });
});

// ── 4. bad input never ends in a stack trace ─────────────────────────────────

describe('journey: bad input is one ✖ line, never a Node stack trace (tinkerer-r4, lib-and-app-r4 R4-1, platform-r4)', () => {
  let sb: TrialSandbox;
  let dir: string;
  beforeAll(() => {
    sb = createTrialSandbox('r4-badinput');
    dir = sb.materialize('linkshort', statsTree());
    setProjectId(dir, 'linkshort');
    gitInit(dir);
  });
  afterAll(async () => { await sb?.cleanup(); });

  it('`surface export --portal <unknown>` names the portals it renders', async () => {
    const r = await sb.run(['surface', 'export', '--format', 'openapi', '--portal', 'link_portal'], dir);
    expectOneLineRefusal(r, /Unknown portal "link_portal"/);
  });

  it('`surface diff` with no committed approval says so (lock and commit first)', async () => {
    const r = await sb.run(['surface', 'diff'], dir);
    expectOneLineRefusal(r, /no approval of this project was ever committed/);
  });

  it('`project rename` with an invalid id is refused as an invalid id, not an id collision', async () => {
    const r = await sb.run(['project', 'rename', 'Edge Lab', '--yes'], dir);
    expectOneLineRefusal(r, /\[id-invalid\][^\n]*"Edge Lab" is no project id/);
    expect(r.all).not.toContain('[id-collision]');
  });

  it('`member rename-alias` to a malformed alias is alias-invalid, not alias-taken', async () => {
    writeFile(dir, '.wai/project.yaml', `${readFile(dir, '.wai/project.yaml').replace(/\s*$/, '\n')}externals:\n  stats: { project: stats, source: { path: ../stats } }\n`);
    const r = await sb.run(['member', 'rename-alias', 'stats', 'Not An Alias', '--yes'], dir);
    expectOneLineRefusal(r, /\[alias-invalid\]/);
  });

  it('`externals add` under a device name is refused with that reason', async () => {
    const r = await sb.run(['externals', 'add', 'aux', '../elsewhere', '--no-pin'], dir);
    expectOneLineRefusal(r, /reserves for a device/);
  });

  for (const [label, args, pattern] of [
    ['an unknown agent', ['show', 'nope'], /nope/],
    ['an unknown type', ['type', 'rename-field', 'nope', 'a', 'b'], /nope/],
    ['an unknown method', ['method', 'rename-param', 'reporting_portal', 'nope', 'code', 'key'], /nope/],
    ['an unknown subsystem', ['subsystem', 'externalize', 'nope', '--path', 'parts/nope', '--yes'], /nope/],
    ['an unknown member', ['member', 'move', 'nope', 'parts/nope'], /nope/],
    ['an unknown diagram format', ['diagram', '--format', 'bogus'], /bogus/],
    ['an unknown surface action', ['surface', 'frobnicate'], /frobnicate/],
    ['an unknown externals action', ['externals', 'frobnicate'], /frobnicate/],
  ] as [string, string[], RegExp][]) {
    it(`${label} (\`wairon ${args.join(' ')}\`) is a refusal without a stack`, async () => {
      const r = await sb.run(args, dir);
      expect(r.code, transcript(r)).not.toBe(0);
      expect(hasStackTrace(r), transcript(r)).toBe(false);
      expect(r.all, transcript(r)).toMatch(pattern);
    });
  }
});
