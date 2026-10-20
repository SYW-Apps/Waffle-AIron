import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { setProjectRoot } from '../../src/utils/fs.js';
import { invalidateSpecCache } from '../../src/core/specs.js';
import { validateProject, type ValidationIssue } from '../../src/core/validation.js';
import { materializeFixtureProject, type FixtureTree } from '../rules-matrix/harness.js';
import { HABIT_ENDPOINTS, routerTree, tableRouter } from '../helpers/conformance-r7-trees.js';

// ---------------------------------------------------------------------------
// A Portal's endpoint paths are written UNDER its basePath. Two ways the
// design and the code drift apart on the prefix, and one display defect:
//
//   1. the design repeats the basePath in the endpoint path (basePath /v1 with
//      /v1/habits), so the joined route is /v1/v1/habits;
//   2. route coverage then names the routes as the server serves them, with
//      the basePath joined in, and says the difference is the repeated prefix;
//   3. a route that pins no segment is never printed with a doubled slash.
// ---------------------------------------------------------------------------

const roots: string[] = [];
afterEach(() => {
  setProjectRoot(null);
  invalidateSpecCache();
  for (const dir of roots.splice(0)) {
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* windows locks */ }
  }
});

function run(tree: FixtureTree): ValidationIssue[] {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-basepath-')));
  roots.push(dir);
  materializeFixtureProject(dir, tree);
  for (const [rel, text] of Object.entries(tree.files ?? {})) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  }
  setProjectRoot(dir);
  invalidateSpecCache();
  return validateProject().issues;
}

const byCode = (issues: ValidationIssue[], code: string): ValidationIssue[] => issues.filter(i => i.code === code);
const said = (issues: ValidationIssue[]): string => issues.map(i => `${i.code}: ${i.message.slice(0, 400)}`).join('\n');
const messages = (issues: ValidationIssue[], code: string): string => byCode(issues, code).map(i => i.message).join('\n');

/** The Habitly endpoints with the basePath (`/v1`) repeated in front of each path. */
const DOUBLED_ENDPOINTS = HABIT_ENDPOINTS.map(endpoint => ({ ...endpoint, path: `/v1${endpoint.path}` }));

/** A router answering a table keyed `VERB /path`, every key stating the whole path under `prefix`. */
const keyedRouter = (prefix: string): string => [
  'const TABLE = {',
  `  ['GET ${prefix}/habits']: listHabits,`,
  `  ['GET ${prefix}/habits/:habitId']: getHabit,`,
  `  ['POST ${prefix}/habits/:habitId/archive']: archiveHabit,`,
  `  ['GET ${prefix}/me']: getMe,`,
  '};',
  'export function routeHabitRequest(req: HabitRequest): string | undefined {',
  "  const handler = (TABLE as Record<string, () => string>)[`${req.method ?? 'GET'} ${req.url ?? '/'}`];",
  '  return handler ? handler() : undefined;',
  '}',
].join('\n');

/** The router of an honest server: it serves /v1/habits and the like. */
const HONEST_ROUTER = keyedRouter('/v1');

describe('1. the design repeats the basePath in an endpoint path', () => {
  it('basePath /v1 with /v1/habits → ENDPOINT_BASEPATH_REPEATED naming the joined route and both fixes', () => {
    const issues = run(routerTree(HONEST_ROUTER, DOUBLED_ENDPOINTS));
    const found = byCode(issues, 'ENDPOINT_BASEPATH_REPEATED');
    // One finding per method whose path repeats the prefix.
    expect(found, said(issues)).toHaveLength(4);
    expect(found[0].severity).toBe('warning');
    const text = found[0].message;
    expect(text).toContain('/v1/v1/habits');
    expect(text).toContain('Drop the prefix from the endpoint');
    expect(text).toContain("or from the Portal's basePath");
  });

  it('control: the endpoint paths written under the basePath → nothing', () => {
    const issues = run(routerTree(HONEST_ROUTER));
    expect(byCode(issues, 'ENDPOINT_BASEPATH_REPEATED'), said(issues)).toEqual([]);
  });
});

describe('2. route coverage names the whole served path and the repeated prefix', () => {
  it('code serving /v1/habits against endpoints declared /v1/habits under /v1 → both directions in full paths, saying why', () => {
    const issues = run(routerTree(HONEST_ROUTER, DOUBLED_ENDPOINTS));
    const undeclared = messages(issues, 'UNDECLARED_ROUTE');
    expect(undeclared, said(issues)).toContain('"GET /v1/habits"');
    expect(undeclared).toContain('"GET /v1/habits/*"');
    expect(undeclared).toContain('The code serves GET /v1/habits; the design declares GET /v1/v1/habits because basePath /v1 is joined in front of an endpoint that repeats it');
    const unrouted = messages(issues, 'UNROUTED_ENDPOINT');
    expect(unrouted).toContain('"GET /v1/v1/habits"');
    expect(unrouted).toContain('The code serves GET /v1/habits; the design declares GET /v1/v1/habits because basePath /v1 is joined in front of an endpoint that repeats it');
  });

  it('the reverse: the code repeats the basePath the contract joins once → says so', () => {
    const issues = run(routerTree(keyedRouter('/v1/v1')));
    const text = messages(issues, 'UNDECLARED_ROUTE') + messages(issues, 'UNROUTED_ENDPOINT');
    expect(text, said(issues)).toContain('"GET /v1/v1/habits"');
    expect(text).toContain('the code repeats basePath /v1');
  });

  it('control: code and contract agree under the basePath → no route finding', () => {
    const issues = run(routerTree(HONEST_ROUTER));
    for (const code of ['UNDECLARED_ROUTE', 'UNROUTED_ENDPOINT']) expect(byCode(issues, code), said(issues)).toEqual([]);
  });

  it('an unrouted endpoint is named with its basePath joined in', () => {
    const issues = run(routerTree(tableRouter(["{ method: 'GET', path: '/habits', verb: 'listHabits' }"])));
    const text = messages(issues, 'UNROUTED_ENDPOINT');
    expect(text, said(issues)).toContain('"GET /v1/me"');
    expect(text).not.toContain('"GET /me"');
  });
});

describe('3. a route that pins no segment is never printed with a doubled slash', () => {
  it('a guard on the verb alone (`req.method === "DELETE"`) → "DELETE /v1/…", never "//"', () => {
    const router = [
      'export function routeHabitRequest(req: HabitRequest): string | undefined {',
      "  if (req.method === 'DELETE') return archiveHabit();",
      '  return undefined;',
      '}',
    ].join('\n');
    const issues = run(routerTree(router));
    const text = messages(issues, 'UNDECLARED_ROUTE');
    expect(text, said(issues)).toContain('"DELETE /v1/…"');
    expect(text).not.toContain('//');
  });
});
