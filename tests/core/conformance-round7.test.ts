import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { setProjectRoot } from '../../src/utils/fs.js';
import { invalidateSpecCache } from '../../src/core/specs.js';
import { validateProject, type ValidationIssue } from '../../src/core/validation.js';
import { materializeFixtureProject, type FixtureTree } from '../rules-matrix/harness.js';
import { habitly, NO_FIELD, orchestratorFile, portalFile, type HabitlyOptions } from '../helpers/conformance-r6-trees.js';
import {
  CLOSURE_STORE_FILE,
  HABIT_ENDPOINTS,
  HABIT_TABLE,
  PREFIX_ROUTER,
  TABLE_CONSTANTS,
  crossProjectPlatform,
  routerTree,
  tableRouter,
  classPortal,
  routePortalTree,
  type RoutePortalOptions,
} from '../helpers/conformance-r7-trees.js';

// ---------------------------------------------------------------------------
// The code<->spec gaps the seventh round of user trials found:
//
//   1. Parameter conformance: an underscore-prefixed parameter was never
//      undeclared, used or not (a one-character bypass for a credential); the
//      pairing ran front-first while the rule said tail-first; a same-position
//      parameter of a different KIND was paired silently; and the honest
//      node:http handler shape had no green path the finding named.
//   2. Fail-closed `any` on CLASS code: `await (this.store as any).x()` in a
//      method that is not async, an optional Store field, and a Store typed by
//      an interface a factory realizes all hid the receiver's original type.
//   3. A Portal's unnarrated write through a port to a Store whose file is not
//      written drew nothing.
//   4. A code-only rename of an Orchestrator verb on class code read as a
//      Portal write shortcut.
//   5. The route reader: a stripped prefix (BASE = '/v1/habits') and route
//      tables.
//   6. An import from another project's source that resolves to nothing.
// ---------------------------------------------------------------------------

const roots: string[] = [];
afterEach(() => {
  setProjectRoot(null);
  invalidateSpecCache();
  for (const dir of roots.splice(0)) {
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* windows locks */ }
  }
});

function tempDir(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-round7-')));
  roots.push(dir);
  return dir;
}

function materialize(dir: string, tree: FixtureTree): void {
  materializeFixtureProject(dir, tree);
  for (const [rel, text] of Object.entries(tree.files ?? {})) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  }
}

function run(tree: FixtureTree, at?: (dir: string) => string): ValidationIssue[] {
  const dir = tempDir();
  materialize(dir, tree);
  setProjectRoot(at ? at(dir) : dir);
  invalidateSpecCache();
  return validateProject().issues;
}

const habits = (o: HabitlyOptions = {}): ValidationIssue[] => run(habitly(o));
const routes = (o: RoutePortalOptions): ValidationIssue[] => run(routePortalTree(o));
const byCode = (issues: ValidationIssue[], code: string): ValidationIssue[] => issues.filter(i => i.code === code);
const said = (issues: ValidationIssue[]): string => issues.map(i => `${i.code}: ${i.message.slice(0, 400)}`).join('\n');
const messages = (issues: ValidationIssue[], code: string): string => byCode(issues, code).map(i => i.message).join('\n');

describe('1. parameter conformance: `_` means unused, pairing is tail-first and kind-aware', () => {
  it('a USED `_secret` ahead of the contract\'s id → UNDECLARED_PARAM naming it', () => {
    const issues = habits({ portal: portalFile({ signature: '_secret: string, id: string', body: 'void _secret;', field: NO_FIELD, head: '' }) });
    expect(messages(issues, 'UNDECLARED_PARAM'), said(issues)).toContain('"_secret"');
  });

  it('a used `_apiKey` AFTER the contract\'s id → UNDECLARED_PARAM naming it', () => {
    const issues = habits({ portal: portalFile({ signature: 'id: string, _apiKey: string', body: 'void _apiKey;', field: NO_FIELD, head: '' }) });
    expect(messages(issues, 'UNDECLARED_PARAM'), said(issues)).toContain('"_apiKey"');
  });

  it('control: an UNUSED `_req` ahead of the contract\'s id → nothing', () => {
    const issues = habits({ portal: portalFile({ signature: '_req: object, id: string', field: NO_FIELD, head: '' }) });
    expect(byCode(issues, 'UNDECLARED_PARAM'), said(issues)).toEqual([]);
    expect(byCode(issues, 'UNREALIZED_PARAM')).toEqual([]);
  });

  it('`planRoute(apiKey, req)` for `planRoute(request)` names the inserted apiKey, and req only as the transport handle it is (round 8)', () => {
    const issues = routes({ planRoute: 'apiKey: string, req: IncomingMessage' });
    const undeclared = messages(issues, 'UNDECLARED_PARAM');
    expect(undeclared, said(issues)).toContain('"apiKey"');
    // Round 8: a transport object where a domain record is declared is a
    // substitution, never a silent pairing — req is named as that.
    expect(undeclared).toContain('"req" (a transport handle in the place of the contract\'s "request"');
  });

  it('a same-position parameter of a different kind (`params: Record` for `id: string`) → UNREALIZED_PARAM id + UNDECLARED_PARAM params', () => {
    const issues = routes({ getRoute: '_req: IncomingMessage, _url: RequestUrl, params: Record<string, string>' });
    expect(messages(issues, 'UNREALIZED_PARAM'), said(issues)).toContain('"id" (the code takes "params", an object, where the contract declares a string)');
    expect(messages(issues, 'UNDECLARED_PARAM')).toContain('"params"');
  });

  it('the honest node:http shape `(req, url, params)` → no PARAM_OPTIONALITY, and the finding names the injectedParams green path', () => {
    const issues = routes({ getRouteTiles: 'req: IncomingMessage, url: RequestUrl, params: Record<string, string>' });
    expect(byCode(issues, 'PARAM_OPTIONALITY'), said(issues)).toEqual([]);
    const text = messages(issues, 'UNDECLARED_PARAM');
    expect(text).toContain('`injectedParams` — [req, url]');
    expect(text).toContain('getRouteTiles(req, url, id, zoom?)');
  });

  it('control: the green path it names — `(req, url, id, zoom?)` with injectedParams [req, url] → nothing', () => {
    const issues = routes({ getRouteTiles: 'req: IncomingMessage, url: RequestUrl, id: string, zoom?: number', injectedParams: ['req', 'url'] });
    for (const code of ['UNDECLARED_PARAM', 'UNREALIZED_PARAM', 'PARAM_OPTIONALITY', 'PARAM_NAME_MISMATCH']) {
      expect(byCode(issues, code), said(issues)).toEqual([]);
    }
  });

  it('control: the same handler with an unused `_req`, `_url` and no injection → nothing', () => {
    const issues = routes({ getRouteTiles: '_req: IncomingMessage, _url: RequestUrl, id: string, zoom?: number' });
    expect(byCode(issues, 'UNDECLARED_PARAM'), said(issues)).toEqual([]);
    expect(byCode(issues, 'UNREALIZED_PARAM')).toEqual([]);
  });

  it('a private dispatch table keyed by the same verb names does not hide the published handler: apiKey still named', () => {
    const issues = routes({ planRoute: 'apiKey: string, req: IncomingMessage', dispatchTable: true });
    expect(messages(issues, 'UNDECLARED_PARAM'), said(issues)).toContain('"apiKey"');
  });

  it('node:http types the checker cannot resolve (no @types/node in reach): `(req, url, params)` still reads as handles + a substituted bag', () => {
    const issues = routes({ nodeHttp: true, getRouteTiles: 'req: IncomingMessage, url: URL, params: Record<string, string>' });
    expect(byCode(issues, 'PARAM_OPTIONALITY'), said(issues)).toEqual([]);
    expect(messages(issues, 'UNREALIZED_PARAM')).toContain('"zoom"');
    expect(messages(issues, 'UNDECLARED_PARAM')).toContain('`injectedParams` — [req, url]');
  });

  it('a same-arity rename of a string (`checkIn(habitId)` for `checkIn(id)`) is still a rename', () => {
    const issues = habits({ portal: portalFile({ signature: 'habitId: string', dispatch: 'habitId', field: NO_FIELD, head: '' }) });
    expect(messages(issues, 'PARAM_NAME_MISMATCH'), said(issues)).toContain('"id" (the code calls it "habitId")');
  });
});

describe('2. the fail-closed `any` check reads class code exactly as closure code', () => {
  const classShapes: Array<[string, Parameters<typeof classPortal>[0]]> = [
    ['`await (this.store as any).addCheckIn(id)` in a method that is not async', { store: 'optional', pre: 'await (this.store as any).addCheckIn(id);' }],
    ['the same with a required field', { store: 'required', pre: 'await (this.store as any).addCheckIn(id);' }],
    ['the same with `HabitStore | undefined`', { store: 'union', pre: 'await (this.store as any).addCheckIn(id);' }],
    ['a local alias cast to any', { store: 'required', pre: 'const st = this.store; await (st as any).addCheckIn(id);' }],
    ['`(this as any).store.addCheckIn(id)`', { store: 'required', pre: 'await (this as any).store.addCheckIn(id);' }],
    ['a const literal key on the cast field', { store: 'optional', pre: "const name = 'addCheckIn'; await (this.store as any)[name](id);" }],
    ['an async method, a `keyof` concatenation taken off an optional field', { store: 'optional', async: true, pre: "const k = ('add' + 'CheckIn') as keyof HabitStore; const f = this.store![k] as unknown as (x: string) => string; f.call(this.store, id);" }],
    ['an async method, a key `as string`', { store: 'required', async: true, pre: "const key = 'addCheckIn' as string; await (this.store as any)[key](id);" }],
    ['an async method, a reassigned `let` key', { store: 'required', async: true, pre: "let key = 'addCheckIn'; if (id === '') key = 'find'; await (this.store as any)[key](id);" }],
    ['an async method, an array element key', { store: 'required', async: true, pre: "const key = ['addCheckIn'][0]!; await (this.store as any)[key](id);" }],
    ['an async method, a function result key', { store: 'required', async: true, pre: "const key = (): string => 'addCheckIn'; await (this.store as any)[key()](id);" }],
    ['an async method, an environment key', { store: 'required', async: true, pre: "const key = (globalThis as unknown as { env: Record<string, string | undefined> }).env['HABIT_WRITE'] ?? 'addCheckIn'; await (this.store as any)[key](id);" }],
    ['an async method, a variable typed by an index signature', { store: 'required', async: true, pre: "const s: Record<string, (x: string) => string> = this.store as any; const name = 'addCheckIn'; s[name](id);" }],
  ];
  for (const [label, o] of classShapes) {
    it(`class Portal — ${label} → PORTAL_CALL_UNRESOLVED naming the Store's write`, () => {
      const issues = habits({ portal: classPortal(o) });
      expect(messages(issues, 'PORTAL_CALL_UNRESOLVED'), said(issues)).toContain('habit_store.addCheckIn');
    });
  }

  const closureShapes: Array<[string, string]> = [
    ['a key `as string`', "const key = 'addCheckIn' as string; (this.checkins as any)[key](id);"],
    ['a reassigned `let` key', "let key = 'addCheckIn'; if (id === '') key = 'find'; (this.checkins as any)[key](id);"],
    ['a `keyof` concatenation taken as a value', "const k = ('add' + 'CheckIn') as keyof HabitStore; const f = this.checkins[k] as unknown as (x: string) => string; f.call(this.checkins, id);"],
  ];
  for (const [label, body] of closureShapes) {
    it(`a Store typed by an interface a factory realizes — ${label} → PORTAL_CALL_UNRESOLVED`, () => {
      const issues = habits({ store: CLOSURE_STORE_FILE, portal: portalFile({ body }) });
      expect(messages(issues, 'PORTAL_CALL_UNRESOLVED'), said(issues)).toContain('habit_store.addCheckIn');
    });
  }

  it('control: a string key on a local table of formatters → nothing', () => {
    const issues = habits({ portal: classPortal({ store: 'none', async: true, pre: "const table: Record<string, (x: string) => string> = { plain: (x) => x }; const key: string = id; table[key](id);" }) });
    expect(byCode(issues, 'PORTAL_CALL_UNRESOLVED'), said(issues)).toEqual([]);
  });

  it('control: the class Portal reading the Store through the cast → nothing', () => {
    const issues = habits({ portal: classPortal({ store: 'required', async: true, pre: 'await (this.store as any).find(id);' }) });
    expect(byCode(issues, 'PORTAL_CALL_UNRESOLVED'), said(issues)).toEqual([]);
  });
});


describe('3. an unnarrated write through a port to a Store whose code is not written', () => {
  const portPortal = (call: string): string => [
    "import type { HabitOrchestrator } from './habit-orchestrator.js';",
    'export interface CheckinSink { addCheckIn(id: string): string; find(id: string): string; }',
    'export class HabitPortal {',
    '  constructor(private readonly habits: HabitOrchestrator, private readonly sink: CheckinSink) {}',
    `  checkIn(id: string): string { this.sink.${call}(id); return this.habits.checkIn(id); }`,
    '}', '',
  ].join('\n');

  it('the Store planned, the Portal writing through its own port → PORTAL_CALL_UNRESOLVED naming the planned write', () => {
    const issues = habits({ store: null, portal: portPortal('addCheckIn') });
    const text = messages(issues, 'PORTAL_CALL_UNRESOLVED');
    expect(text, said(issues)).toContain('habit_store.addCheckIn');
    expect(text).toContain('has no code yet');
  });

  it('control: the same port read → nothing', () => {
    const issues = habits({ store: null, portal: portPortal('find') });
    expect(byCode(issues, 'PORTAL_CALL_UNRESOLVED'), said(issues)).toEqual([]);
  });

  it('control: once the Store is written, the same write is PORTAL_WRITE_SHORTCUT_IN_CODE', () => {
    const issues = habits({ portal: portPortal('addCheckIn') });
    expect(messages(issues, 'PORTAL_WRITE_SHORTCUT_IN_CODE'), said(issues)).toContain('habit_store.addCheckIn');
  });
});

describe('4. a code-only rename of an Orchestrator verb is reported as the rename it is', () => {
  const renamedOrchestrator = orchestratorFile().replace('checkIn(id: string): string {', 'complete(id: string): string {');
  const callingPortal = (calls: string): string => [
    "import type { HabitOrchestrator } from './habit-orchestrator.js';",
    'export class HabitPortal {',
    '  constructor(private readonly habits: HabitOrchestrator) {}',
    `  checkIn(id: string): string { ${calls} }`,
    '}', '',
  ].join('\n');

  it('the Portal calls the renamed `complete` → CALL_STEP_UNREALIZED naming the rename, never PORTAL_WRITE_SHORTCUT_IN_CODE', () => {
    const issues = habits({ orchestrator: renamedOrchestrator, portal: callingPortal('return this.habits.complete(id);') });
    expect(byCode(issues, 'PORTAL_WRITE_SHORTCUT_IN_CODE'), said(issues)).toEqual([]);
    expect(byCode(issues, 'UNDECLARED_WRITE_CALL')).toEqual([]);
    expect(messages(issues, 'CALL_STEP_UNREALIZED')).toContain('the function calls "complete" on habit_orchestrator\'s code instead');
  });

  it('a Portal calling an Orchestrator method its contract does not declare (beside the narrated one) → UNDECLARED_WRITE_CALL, never a shortcut', () => {
    const orchestrator = orchestratorFile().replace('  archive(id: string): string { return id; }', '  archive(id: string): string { return id; }\n  purge(id: string): string { return this.checkins.addCheckIn(id); }');
    const issues = habits({ orchestrator, portal: callingPortal('this.habits.purge(id); return this.habits.checkIn(id);') });
    expect(byCode(issues, 'PORTAL_WRITE_SHORTCUT_IN_CODE'), said(issues)).toEqual([]);
    expect(messages(issues, 'UNDECLARED_WRITE_CALL')).toContain('habit_orchestrator.purge');
  });

  it('control: the Portal calling the narrated verb → nothing', () => {
    const issues = habits({ portal: callingPortal('return this.habits.checkIn(id);') });
    expect(byCode(issues, 'CALL_STEP_UNREALIZED'), said(issues)).toEqual([]);
    expect(byCode(issues, 'UNDECLARED_WRITE_CALL')).toEqual([]);
  });
});

describe('5. the route reader: stripped prefixes, constants and route tables', () => {
  const routeCodes = (issues: ValidationIssue[]): ValidationIssue[] =>
    issues.filter(i => ['UNDECLARED_ROUTE', 'UNROUTED_ENDPOINT', 'UNREADABLE_ROUTER'].includes(i.code));

  it('a router stripping BASE = /v1/habits under basePath /v1 → no phantom route; only the unrouted /me', () => {
    const issues = run(routerTree(PREFIX_ROUTER));
    expect(byCode(issues, 'UNDECLARED_ROUTE'), said(issues)).toEqual([]);
    const unrouted = byCode(issues, 'UNROUTED_ENDPOINT');
    expect(unrouted).toHaveLength(1);
    expect(unrouted[0].message).toContain('"GET /me"');
    expect(unrouted[0].message).not.toContain('/habits');
  });

  it('a route TABLE read through a helper, its values settled through constants and a template → nothing', () => {
    const issues = run(routerTree(`${TABLE_CONSTANTS}\n${tableRouter(HABIT_TABLE)}`));
    expect(routeCodes(issues), said(issues)).toEqual([]);
  });

  it('a regular-expression table written under the full path (/v1/...) → nothing', () => {
    const regexTable = tableRouter([
      "{ method: 'GET', pattern: /^\\/v1\\/habits$/, verb: 'listHabits' }",
      "{ method: 'GET', pattern: HABIT, verb: 'getHabit' }",
      "{ method: 'POST', pattern: /^\\/v1\\/habits\\/([^/]+)\\/archive$/, verb: 'archiveHabit' }",
      "{ method: 'GET', pattern: /^\\/v1\\/me$/, verb: 'getMe' }",
    ]).replace('route.path === path', 'route.pattern.test(path)');
    const issues = run(routerTree(`const HABIT = /^\\/v1\\/habits\\/([^/]+)$/;\n${regexTable}`));
    expect(routeCodes(issues), said(issues)).toEqual([]);
  });

  it('a table entry no endpoint declares → UNDECLARED_ROUTE naming it', () => {
    const issues = run(routerTree(`${TABLE_CONSTANTS}\n${tableRouter([...HABIT_TABLE, "{ method: 'DELETE', path: '/habits/:habitId', verb: 'deleteHabit' }"])}`));
    expect(messages(issues, 'UNDECLARED_ROUTE'), said(issues)).toContain('"DELETE /habits/*"');
  });

  it('a table with an entry whose path does not settle → UNREADABLE_ROUTER, never a partial reading', () => {
    const issues = run(routerTree(`${TABLE_CONSTANTS}\n${tableRouter([...HABIT_TABLE, "{ method: 'GET', path: String(Date.now()), verb: 'clock' }"])}`));
    expect(byCode(issues, 'UNREADABLE_ROUTER'), said(issues)).toHaveLength(1);
    expect(byCode(issues, 'UNROUTED_ENDPOINT')).toEqual([]);
  });

  it('control: the endpoint list matches the table exactly when getMe is dropped from both', () => {
    const endpoints = HABIT_ENDPOINTS.filter(e => e.name !== 'getMe');
    const issues = run(routerTree(`${TABLE_CONSTANTS}\n${tableRouter(HABIT_TABLE.slice(0, 3))}`, endpoints));
    expect(routeCodes(issues), said(issues)).toEqual([]);
  });
});

describe('6. an import from another project\'s source that resolves to nothing', () => {
  const platform = (importLine: string): ValidationIssue[] => {
    const dir = tempDir();
    const { platform: tree, contracts } = crossProjectPlatform(importLine);
    const root = path.join(dir, 'platform');
    fs.mkdirSync(root, { recursive: true });
    materialize(root, tree);
    for (const [rel, text] of Object.entries(contracts)) {
      fs.mkdirSync(path.dirname(path.join(dir, 'contracts', rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, 'contracts', rel), text);
    }
    setProjectRoot(root);
    invalidateSpecCache();
    return validateProject().issues;
  };

  it('`import type { CustomerId }` from a contracts file that exports only CustomerRef → CROSS_PROJECT_IMPORT_UNRESOLVED', () => {
    const issues = platform("import type { CustomerId } from '../../contracts/src/ids.js';");
    const text = messages(issues, 'CROSS_PROJECT_IMPORT_UNRESOLVED');
    expect(text, said(issues)).toContain('"CustomerId" from "../../contracts/src/ids.js"');
    expect(text).toContain('type-only');
  });

  it('a module of the other project that is gone → CROSS_PROJECT_IMPORT_UNRESOLVED', () => {
    const issues = platform("import { CustomerId } from '../../contracts/src/gone.js';");
    expect(messages(issues, 'CROSS_PROJECT_IMPORT_UNRESOLVED'), said(issues)).toContain('has no such module');
  });

  it('control: importing the name the contracts file exports → nothing', () => {
    const issues = platform("import type { CustomerRef } from '../../contracts/src/ids.js';");
    expect(byCode(issues, 'CROSS_PROJECT_IMPORT_UNRESOLVED'), said(issues)).toEqual([]);
  });
});
