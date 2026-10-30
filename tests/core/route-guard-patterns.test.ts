import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { setProjectRoot } from '../../src/utils/fs.js';
import { invalidateSpecCache } from '../../src/core/specs.js';
import { validateProject, type ValidationIssue } from '../../src/core/validation.js';
import { materializeFixtureProject, type FixtureTree } from '../rules-matrix/harness.js';
import { routerTree } from '../helpers/conformance-r7-trees.js';

// ---------------------------------------------------------------------------
// A guard router that tests the WHOLE path rather than its split segments: an
// anchored regular expression (`/re/.exec(req.path)`, `.test`, `path.match`),
// held in a const and tested after, or the path compared with a string. The
// 6.1.3 QA gate found an honest `GET /orders/{orderId}` served this way
// reported as UNROUTED_ENDPOINT.
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
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-guardpat-')));
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

const ROUTE_CODES = ['UNROUTED_ENDPOINT', 'UNDECLARED_ROUTE', 'UNREADABLE_ROUTER', 'ROUTES_UNCHECKED'];
const routeFindings = (issues: ValidationIssue[]): ValidationIssue[] => issues.filter(i => ROUTE_CODES.includes(i.code));
const said = (issues: ValidationIssue[]): string => issues.map(i => `${i.code}: ${i.message.slice(0, 400)}`).join('\n');

/** A guard router over `req.path`, its routes written as `guards`. */
const guardRouter = (guards: string[]): string => [
  'export function routeHabitRequest(req: { method: string; path: string }): string | undefined {',
  ...guards.map(guard => `  ${guard}`),
  '  return undefined;',
  '}',
].join('\n');

const HONEST = [
  "if (req.method === 'GET' && req.path === '/habits') return listHabits();",
  "const one = req.method === 'GET' ? /^\\/habits\\/([^/]+)$/.exec(req.path) : null;",
  'if (one) return getHabit();',
  "if (req.method === 'POST' && /^\\/habits\\/([^/]+)\\/archive$/.test(req.path)) return archiveHabit();",
  "if (req.method === 'GET' && req.path.match(/^\\/me$/)) return getMe();",
];

describe('a guard router testing the whole path', () => {
  it('reads a path compared with a string, a regex exec held in a const, .test and .match as routes', () => {
    const issues = run(routerTree(guardRouter(HONEST)));
    expect(routeFindings(issues), said(issues)).toEqual([]);
  });

  it('the QA shape: a GET answered only through a held regex match is routed', () => {
    const endpoints = [
      { name: 'getHabit', method: 'GET', path: '/habits/{habitId}' },
      { name: 'archiveHabit', method: 'POST', path: '/habits/{habitId}/archive' },
    ];
    const guards = [
      "if (req.method === 'POST' && /^\\/habits\\/([^/]+)\\/archive$/.test(req.path)) return archiveHabit();",
      "const m = req.method === 'GET' ? /^\\/habits\\/([^/]+)$/.exec(req.path) : null;",
      'if (m) return getHabit();',
    ];
    const issues = run(routerTree(guardRouter(guards), endpoints));
    expect(issues.filter(i => i.code === 'UNROUTED_ENDPOINT'), said(issues)).toEqual([]);
  });

  it('still reports the endpoint no guard answers, and the guard no endpoint declares', () => {
    const guards = [
      ...HONEST.slice(0, 4),
      "if (req.method === 'DELETE' && /^\\/habits\\/([^/]+)$/.test(req.path)) return archiveHabit();",
    ];
    const issues = run(routerTree(guardRouter(guards)));
    const unrouted = issues.filter(i => i.code === 'UNROUTED_ENDPOINT');
    expect(unrouted, said(issues)).toHaveLength(1);
    expect(unrouted[0].message).toContain('GET /v1/me');
    const undeclared = issues.filter(i => i.code === 'UNDECLARED_ROUTE');
    expect(undeclared, said(issues)).toHaveLength(1);
    expect(undeclared[0].message).toContain('DELETE');
    expect(unrouted[0].message).toContain('anchored regular expression');
  });
});

describe('a router named through a module that only re-exports it', () => {
  const through = (reexport: string, router: string, guards = HONEST): FixtureTree => {
    const tree = routerTree(guardRouter(guards));
    tree.files!['src/index.ts'] = reexport;
    tree.implementations![0].router = router;
    return { ...tree, rules: { conformance: { sourceRoots: ['src'] } } };
  };

  it('is silent for an honest router re-exported by name', () => {
    const issues = run(through("export { routeHabitRequest } from './habit-portal';\n", 'src/index.ts#routeHabitRequest'));
    expect(routeFindings(issues), said(issues)).toEqual([]);
  });

  it('reports a route no endpoint declares through a re-export, and through an aliased one', () => {
    const guards = [...HONEST, "if (req.method === 'DELETE' && req.path === '/habits') return listHabits();"];
    for (const [reexport, router] of [
      ["export { routeHabitRequest } from './habit-portal';\n", 'src/index.ts#routeHabitRequest'],
      ["export { routeHabitRequest as handle } from './habit-portal';\n", 'src/index.ts#handle'],
    ]) {
      const issues = run(through(reexport, router, guards));
      const undeclared = issues.filter(i => i.code === 'UNDECLARED_ROUTE');
      expect(undeclared, said(issues)).toHaveLength(1);
      expect(undeclared[0].message).toContain('DELETE');
    }
  });

  it('reports a re-export cycle as an unread router', () => {
    const tree = through("export { routeHabitRequest } from './other';\n", 'src/index.ts#routeHabitRequest');
    tree.files!['src/other.ts'] = "export { routeHabitRequest } from './index';\n";
    const issues = run(tree);
    expect(routeFindings(issues).map(i => i.code), said(issues)).toEqual(['UNREADABLE_ROUTER']);
  });
});
