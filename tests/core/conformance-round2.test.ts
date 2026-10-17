import { describe, it, expect, vi, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { validateProject } from '../../src/core/validation.js';
import { invalidateSpecCache } from '../../src/core/specs.js';

// ---------------------------------------------------------------------------
// The code<->spec gaps the second round of user trials found:
//
//   1. A Portal calling a Repository write through a constructor-injected,
//      TYPE-ONLY-imported collaborator its design never declared passed
//      silently: a type-only import never accused, and the design rule
//      PORTAL_WRITE_SHORTCUT reads narratives only. The call is runtime
//      collaboration (UNDECLARED_DEPENDENCY), and the write is the shortcut
//      written in code (PORTAL_WRITE_SHORTCUT_IN_CODE).
//   2. A Portal importing a technology's package (pg) that another component
//      binds was never judged: TECH_LEAKAGE read the spec tree only.
//   3. An Adapter's call step to a remote Portal verb — the link the
//      reachability model needs — could never resolve to the remote file and
//      kept the gate red (CALL_ORIGIN_UNRESOLVED / CALL_STEP_UNREALIZED).
// ---------------------------------------------------------------------------

function createTempProject() {
  invalidateSpecCache();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-round2-'));
  const waiDir = path.join(tempDir, '.wai');
  fs.mkdirSync(waiDir);
  fs.writeFileSync(path.join(waiDir, 'project.yaml'), JSON.stringify({
    schemaVersion: '1.0.0',
    name: 'test-project',
    targets: [{ type: 'claude', outputDir: '.claude/agents', enabled: true }],
    rules: {},
  }));
  const specsDir = path.join(waiDir, 'specs');
  for (const d of ['subsystems', 'components', 'interfaces', 'implementations', 'types']) {
    fs.mkdirSync(path.join(specsDir, d), { recursive: true });
  }
  const stamp = "createdAt: '2026-10-05T10:00:00Z'\nupdatedAt: '2026-10-05T10:00:00Z'";
  const writeSpec = (type: string, name: string, content: string) => {
    const filePath = type === 'system'
      ? path.join(specsDir, '.index.yaml')
      : path.join(specsDir, `${type}s`, `${name}.yaml`);
    fs.writeFileSync(filePath, `${content}\n${stamp}\n`);
  };
  writeSpec('system', 'system', 'schemaVersion: 1.0.0\nname: TestSystem\nvision: testing');
  writeSpec('subsystem', 'sub-a', 'schemaVersion: 1.0.0\nid: sub-a\nname: SubA\ndescription: d\nparentSystem: TestSystem');
  return {
    tempDir,
    component: (id: string, type: string, extra = '') =>
      writeSpec('component', id, `schemaVersion: 1.0.0\nid: ${id}\nname: ${id}\ndescription: d\nsubsystem: sub-a\ncomponentType: ${type}\n${extra}`),
    contract: (compId: string, methods: Array<[string, string?]>) =>
      writeSpec('interface', `i${compId}`, [
        'schemaVersion: 1.0.0', `id: i${compId}`, `name: I${compId}`, 'description: contract', `component: ${compId}`, 'methods:',
        ...methods.map(([m, effect]) => [
          `  - name: ${m}`,
          `    description: ${m} does its one thing, carefully and observably`,
          `    signature: "${m}(id: string): string"`,
          '    params: [{ name: id, type: string }]',
          '    returns: string',
          ...(effect ? [`    effect: ${effect}`] : []),
        ].join('\n')),
      ].join('\n')),
    impl: (compId: string, body: string) =>
      writeSpec('implementation', `impl-${compId}`, `schemaVersion: 1.0.0\nid: impl-${compId}\nname: Impl${compId}\ndescription: impl\ncontract: i${compId}\n${body}`),
    source: (relPath: string, content: string) => {
      const abs = path.join(tempDir, relPath);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content);
    },
    activate: () => { vi.spyOn(process, 'cwd').mockReturnValue(tempDir); },
    cleanup: () => {
      invalidateSpecCache();
      vi.restoreAllMocks();
      try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* win file locks */ }
    },
  };
}

type Result = { issues: { code: string; specId?: string; message: string }[] };
const byCode = (res: Result, code: string) => res.issues.filter(i => i.code === code);
const intent = (m: string) => `  - name: ${m}\n    detail: intent\n    intent: Performs its one thing against held state; failures surface as thrown errors.`;

let proj: ReturnType<typeof createTempProject> | undefined;
afterEach(() => { proj?.cleanup(); proj = undefined; });

/** Portal -> Orchestrator -> Repository, the Portal's file holding `extra` beside its declared call. */
function habitShape(p: ReturnType<typeof createTempProject>, portalBody: string, portalImports: string[]): void {
  p.component('repo-a', 'Repository');
  p.contract('repo-a', [['record', 'write'], ['find', 'read']]);
  p.impl('repo-a', `sourcePath: src/repo.ts\nmethods:\n${intent('record')}\n${intent('find')}`);
  p.source('src/repo.ts', 'export class CheckinRepository {\n  record(id: string): string { return id; }\n  find(id: string): string { return id; }\n}\n');

  p.component('tracker-a', 'Orchestrator', 'dependsOn: [repo-a]');
  p.contract('tracker-a', [['checkIn']]);
  p.impl('tracker-a', [
    'sourcePath: src/tracker.ts',
    'methods:',
    '  - name: checkIn',
    '    narrative:',
    '      - { stepNumber: 1, description: Record the check-in, type: call, targetComponent: repo-a, targetMethod: record }',
    '      - { stepNumber: 2, description: Done, type: return, outcome: done }',
  ].join('\n'));
  p.source('src/tracker.ts', [
    "import type { CheckinRepository } from './repo.js';",
    'export class HabitTracker {',
    '  constructor(private readonly checkins: CheckinRepository) {}',
    '  checkIn(id: string): string { return this.checkins.record(id); }',
    '}',
    '',
  ].join('\n'));

  p.component('web-a', 'Portal', 'transport: InProcess\ndependsOn: [tracker-a]');
  p.contract('web-a', [['checkIn']]);
  p.impl('web-a', [
    'sourcePath: src/web.ts',
    'methods:',
    '  - name: checkIn',
    '    narrative:',
    '      - { stepNumber: 1, description: Dispatch to the tracker, type: call, targetComponent: tracker-a, targetMethod: checkIn }',
    '      - { stepNumber: 2, description: Done, type: return, outcome: done }',
  ].join('\n'));
  p.source('src/web.ts', [
    "import type { HabitTracker } from './tracker.js';",
    ...portalImports,
    'export class HabitsApi {',
    '  constructor(private readonly tracker: HabitTracker, private readonly checkins: CheckinRepository) {}',
    `  checkIn(id: string): string { ${portalBody} return this.tracker.checkIn(id); }`,
    '}',
    '',
  ].join('\n'));
}

describe('a call through a type-only-imported collaborator', () => {
  it('an undeclared write from a Portal is an undeclared dependency and the write shortcut in code', () => {
    proj = createTempProject();
    habitShape(proj, 'this.checkins.record(id);', ["import type { CheckinRepository } from './repo.js';"]);
    proj.activate();
    const res = validateProject();
    const undeclared = byCode(res, 'UNDECLARED_DEPENDENCY');
    expect(undeclared.map(i => i.message).join('\n')).toContain('repo-a.record');
    expect(undeclared.some(i => i.message.includes('src/web.ts') && i.message.includes('src/repo.ts'))).toBe(true);
    const shortcut = byCode(res, 'PORTAL_WRITE_SHORTCUT_IN_CODE');
    expect(shortcut).toHaveLength(1);
    expect(shortcut[0].message).toContain('repo-a.record');
  });

  it('a read through it is no shortcut, though the edge is still owed a declaration', () => {
    proj = createTempProject();
    habitShape(proj, 'this.checkins.find(id);', ["import type { CheckinRepository } from './repo.js';"]);
    proj.activate();
    const res = validateProject();
    expect(byCode(res, 'PORTAL_WRITE_SHORTCUT_IN_CODE')).toHaveLength(0);
    expect(byCode(res, 'UNDECLARED_DEPENDENCY').some(i => i.message.includes('src/web.ts'))).toBe(true);
  });

  it('a type-only import that is never called through stays allowed', () => {
    proj = createTempProject();
    habitShape(proj, '', ["import type { CheckinRepository } from './repo.js';"]);
    proj.activate();
    const res = validateProject();
    expect(byCode(res, 'UNDECLARED_DEPENDENCY').filter(i => i.message.includes('src/web.ts'))).toHaveLength(0);
    expect(byCode(res, 'PORTAL_WRITE_SHORTCUT_IN_CODE')).toHaveLength(0);
  });
});

describe("a technology's package imported outside its home", () => {
  function storeShape(p: ReturnType<typeof createTempProject>, portalImport: string): void {
    p.component('db-store', 'Store', 'durability: read-through');
    p.contract('db-store', [['save', 'write']]);
    p.impl('db-store', `sourcePath: src/db.ts\ntechnologies: [{ name: postgres, matches: [pg, postgres] }]\nmethods:\n${intent('save')}`);
    p.source('src/db.ts', "import { Pool } from 'pg';\nexport function save(id: string): string { void Pool; return id; }\n");
    p.component('api-b', 'Portal', 'transport: InProcess');
    p.contract('api-b', [['hit']]);
    p.impl('api-b', `sourcePath: src/api.ts\nmethods:\n${intent('hit')}`);
    p.source('src/api.ts', `${portalImport}\nexport function hit(id: string): string { return id; }\n`);
  }

  it('reports the import in a file no binding component realizes', () => {
    proj = createTempProject();
    storeShape(proj, "import { Pool } from 'pg';\nvoid Pool;");
    proj.activate();
    const leaks = byCode(validateProject(), 'TECH_LEAKAGE_IN_CODE');
    expect(leaks).toHaveLength(1);
    expect(leaks[0].message).toContain('src/api.ts');
    expect(leaks[0].message).toContain('postgres');
  });

  it('never guesses: a package neither the technology nor the built-in table names is not its package', () => {
    proj = createTempProject();
    storeShape(proj, "import { Kysely } from 'kysely';\nvoid Kysely;");
    proj.activate();
    expect(byCode(validateProject(), 'TECH_LEAKAGE_IN_CODE')).toHaveLength(0);
  });
});

describe("an Adapter's call to a remote Portal verb is the link", () => {
  it('is never resolved to the remote file nor reported, while the call to the Adapter stays checked', () => {
    proj = createTempProject();
    proj.component('ingest-api', 'Portal', 'transport: HTTP');
    proj.contract('ingest-api', [['recordHit']]);
    proj.impl('ingest-api', `sourcePath: src/ingest.ts\nmethods:\n${intent('recordHit')}`);
    proj.source('src/ingest.ts', 'export function recordHit(id: string): string { return id; }\n');

    proj.component('ingest-client', 'Adapter', 'dependsOn: [ingest-api]');
    proj.contract('ingest-client', [['send']]);
    proj.impl('ingest-client', [
      'sourcePath: src/client.ts',
      'methods:',
      '  - name: send',
      '    narrative:',
      '      - { stepNumber: 1, description: POST the hit, type: call, targetComponent: ingest-api, targetMethod: recordHit }',
      '      - { stepNumber: 2, description: Done, type: return, outcome: sent }',
    ].join('\n'));
    proj.source('src/client.ts', [
      'export class IngestClient {',
      '  constructor(private readonly http: { post(url: string, body: string): string }) {}',
      "  send(id: string): string { return this.http.post('/hits', id); }",
      '  recordHit(id: string): string { return this.send(id); }',
      '}',
      '',
    ].join('\n'));
    proj.activate();
    const res = validateProject();
    const onClient = (code: string) => byCode(res, code).filter(i => i.specId === 'impl-ingest-client');
    expect(onClient('CALL_ORIGIN_UNRESOLVED')).toHaveLength(0);
    expect(onClient('CALL_STEP_UNREALIZED')).toHaveLength(0);
  });
});
