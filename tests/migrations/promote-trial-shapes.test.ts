import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { setProjectRoot } from '../../src/utils/fs.js';
import { invalidateSpecCache } from '../../src/core/specs.js';
import { validateFamily, validateProject, type ValidationIssue } from '../../src/core/validation.js';
import { run as runMcpMigration } from '../../src/mcp/migrations.js';
import { at, migrate, plan } from '../helpers/family-verbs.js';
import { tempDir, isolateGlobals, specs, component, contract, implementation, subsystem, type, projectYaml, system } from '../helpers/stage8-family.js';

// ---------------------------------------------------------------------------
// Round-3 tinkerer trial (famlab / famlab2): promoting a real subsystem — one
// the parent's L0 re-exports at audience instance under its own public names,
// whose code is planned outside the new root, and whose type a parent contract
// takes as a param — used to write a tree its own validator rejected:
// EXPORT_INVALID and EXPORT_WIDENS_AUDIENCE on the parent's export table,
// SOURCE_PATH_ESCAPES_ROOT and SIM_FILE_MISSING in the new project, and
// SIGNATURE_TEXT_STALE on the respelled param — with none of it in the plan.
// The tool route also left the new project without a session scaffold.
// ---------------------------------------------------------------------------

/** The trial's linkshort shape: links calls analytics over a client; the L0 re-exports analytics' stats Portal and hit_stats type. */
function linkshort(root: string): void {
  projectYaml(root, { id: 'linkshort', name: 'Linkshort', targets: [{ type: 'claude', outputDir: '.claude/agents', enabled: true }] });
  system(root, 'Linkshort', [
    { component: 'reporting_portal', interface: 'ireporting_portal', from: 'analytics', as: 'stats', details: 'GET /stats/{code}', audience: 'instance' },
    { from: 'analytics', typeDef: 'hit_stats', as: 'hit_stats', details: 'The stats shape', audience: 'instance' },
  ]);
  subsystem(root, 'Linkshort', 'analytics', {
    publicInterfaces: [
      { component: 'reporting_portal', interface: 'ireporting_portal', details: 'Stats' },
      { component: 'ingestion_portal', interface: 'iingestion_portal', details: 'Hits' },
      { typeDef: 'hit_stats' },
      { typeDef: 'hit' },
    ],
  });
  subsystem(root, 'Linkshort', 'links');
  type(specs(root, 'analytics', 'types', 'hit.yaml'), 'hit', [{ name: 'code', type: 'string' }], { subsystem: 'analytics' });
  type(specs(root, 'analytics', 'types', 'hit_stats.yaml'), 'hit_stats', [{ name: 'hits', type: 'int' }], { subsystem: 'analytics' });
  component(root, 'analytics', 'reporting_portal', 'Portal');
  contract(root, 'analytics', 'reporting_portal', [{
    name: 'getStats', description: 'The stats of one code', signature: 'getStats(code: string): hit_stats', returns: 'hit_stats',
    params: [{ name: 'code', type: 'string', description: 'The short code' }],
    invokedBy: { kind: 'entry', caller: 'The platform team dashboard, reading the stats of one short code.' },
  }]);
  component(root, 'analytics', 'ingestion_portal', 'Portal');
  contract(root, 'analytics', 'ingestion_portal', [{
    name: 'recordHit', description: 'Record one hit', signature: 'recordHit(hit: hit): void', returns: 'void',
    params: [{ name: 'hit', type: 'hit', description: 'The hit' }],
  }]);
  for (const [comp, file] of [['reporting_portal', 'reporting-portal'], ['ingestion_portal', 'ingestion-portal']]) {
    const raw = { methods: comp === 'reporting_portal' ? [{ name: 'getStats' }] : [{ name: 'recordHit' }] };
    implementation(root, 'analytics', comp, `i${comp}`, raw.methods);
    const implFile = specs(root, 'analytics', comp, '.implementation.yaml');
    const stored = yaml.load(fs.readFileSync(implFile, 'utf-8')) as Record<string, unknown>;
    fs.writeFileSync(implFile, yaml.dump({ ...stored, sourcePath: `src/analytics/${file}.ts`, simPath: 'src/analytics/analytics.sim.test.ts' }));
  }
  component(root, 'links', 'hit_client', 'Adapter', ['ingestion_portal']);
  contract(root, 'links', 'hit_client', [{
    name: 'reportHit', description: 'Report one hit', signature: 'reportHit(hit: hit): void', returns: 'void',
    params: [{ name: 'hit', type: 'hit', description: 'The hit to report' }],
    invokedBy: { kind: 'runtime', caller: 'The redirect handler, once per redirect it answers.' },
  }]);
  implementation(root, 'links', 'hit_client', 'ihit_client', [{
    name: 'reportHit', narrative: [{ stepNumber: 1, description: 'Record the hit', type: 'call', targetComponent: 'ingestion_portal', targetMethod: 'recordHit' }],
  }]);
}

/** The findings the trial hit, over both sides. */
const TRIAL_CODES = ['EXPORT_INVALID', 'EXPORT_WIDENS_AUDIENCE', 'SIGNATURE_TEXT_STALE', 'SOURCE_PATH_ESCAPES_ROOT', 'SIM_FILE_MISSING'];
const trialFindings = (issues: ValidationIssue[]): string[] => issues.filter((i) => TRIAL_CODES.includes(i.code)).map((i) => `${i.code}: ${i.message}`);

const readYaml = (file: string): Record<string, unknown> => yaml.load(fs.readFileSync(file, 'utf-8')) as Record<string, unknown>;

describe('promote / externalize --as project on the trial shape', () => {
  const cleanups: (() => void)[] = [];
  beforeEach(() => {
    cleanups.push(isolateGlobals(cleanups));
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    setProjectRoot(null);
    invalidateSpecCache();
    for (const c of cleanups.splice(0).reverse()) {
      try { c(); } catch { /* windows locks */ }
    }
  });

  function made(): { root: string; member: string } {
    const root = path.join(tempDir(cleanups, 'wairon-promote-trial-'), 'linkshort');
    linkshort(root);
    return { root, member: path.join(root, 'parts', 'analytics') };
  }

  /** Both sides, judged: the family run at the root and the new project's own gate. */
  function judged(root: string, member: string): string[] {
    return [...trialFindings(at(root, () => validateFamily({ family: true })).issues), ...trialFindings(at(member, () => validateProject()).issues)];
  }

  it('externalize --as project: re-points the parent re-exports, keeps paths inside the root, re-derives the signature — and the plan says so', () => {
    const { root, member } = made();
    const request = { verb: 'externalize' as const, subsystem: 'analytics', path: 'parts/analytics', as: 'project' as const };
    const planned = plan(root, request);
    expect(planned.refusals).toEqual([]);
    const lines = planned.edits.map((e) => e.detail);
    expect(lines).toEqual(expect.arrayContaining([
      expect.stringMatching(/analytics L0: reporting_portal as stats at instance \(re-exported by the parent\)/),
      expect.stringMatching(/analytics L0: hit_stats at instance \(re-exported by the parent\)/),
      expect.stringMatching(/linkshort L0: stats re-exported through analytics as stats at instance/),
      expect.stringMatching(/signature text re-derived — ihit_client\.reportHit: reportHit\(hit: hit\): void → reportHit\(hit: analytics::hit\): void/),
      expect.stringMatching(/path re-expressed under the new root — reporting_portal_impl sourcePath: \.\.\/\.\.\/src\/analytics\/reporting-portal\.ts → src\/analytics\/reporting-portal\.ts/),
      expect.stringMatching(/path re-expressed under the new root — reporting_portal_impl simPath: /),
    ]));
    migrate(root, request);
    expect(judged(root, member)).toEqual([]);
    // The parent re-exports the member's public names, audience kept.
    const l0 = readYaml(specs(root, '.index.yaml')).publicInterfaces as Record<string, unknown>[];
    expect(l0).toEqual(expect.arrayContaining([
      expect.objectContaining({ from: 'analytics', component: 'stats', as: 'stats', audience: 'instance' }),
      expect.objectContaining({ from: 'analytics', typeDef: 'hit_stats', as: 'hit_stats', audience: 'instance' }),
    ]));
    // The member exports them at least as wide, under the parent's public names.
    const own = readYaml(specs(member, '.index.yaml')).publicInterfaces as Record<string, unknown>[];
    expect(own).toEqual(expect.arrayContaining([
      expect.objectContaining({ component: 'reporting_portal', interface: 'ireporting_portal', as: 'stats', audience: 'instance' }),
      expect.objectContaining({ typeDef: 'hit_stats', audience: 'instance' }),
    ]));
    // Member-relative paths, never escaping the root.
    const impl = readYaml(specs(member, 'analytics', 'reporting_portal', '.implementation.yaml'));
    expect(impl.sourcePath).toBe('src/analytics/reporting-portal.ts');
    expect(impl.simPath).toBe('src/analytics/analytics.sim.test.ts');
    // The stored signature text follows the respelled param.
    const client = readYaml(specs(root, 'links', 'hit_client', '.interface.yaml')) as { methods: { signature: string }[] };
    expect(client.methods[0].signature).toBe('reportHit(hit: analytics::hit): void');
  });

  it('externalize into a part, then promote it: the same valid tree, and the CLI-shaped plan lists every edit', () => {
    const { root, member } = made();
    migrate(root, { verb: 'externalize', subsystem: 'analytics', path: 'parts/analytics' });
    const planned = plan(root, { verb: 'promote', alias: 'analytics' });
    expect(planned.refusals).toEqual([]);
    const lines = planned.edits.map((e) => e.detail);
    expect(lines.filter((l) => l.startsWith('path re-expressed'))).toHaveLength(4);
    expect(lines.filter((l) => l.startsWith('signature text re-derived'))).toHaveLength(1);
    expect(lines.filter((l) => / re-exported through analytics /.test(l))).toHaveLength(2);
    migrate(root, { verb: 'promote', alias: 'analytics' });
    expect(judged(root, member)).toEqual([]);
  });

  it('demote after the promote round-trips without a stale signature text', () => {
    const { root } = made();
    migrate(root, { verb: 'externalize', subsystem: 'analytics', path: 'parts/analytics', as: 'project' });
    migrate(root, { verb: 'demote', alias: 'analytics' });
    const issues = at(root, () => validateFamily({ family: true })).issues;
    expect(issues.filter((i) => ['SIGNATURE_TEXT_STALE', 'EXPORT_INVALID', 'EXPORT_WIDENS_AUDIENCE'].includes(i.code))).toEqual([]);
  });

  it('the tool route (sdd_externalize_subsystem as: project) sets the new project up for its own sessions, as the CLI does', () => {
    const { root, member } = made();
    const report = at(root, () => runMcpMigration({ verb: 'externalize', subsystem: 'analytics', path: 'parts/analytics', as: 'project' }));
    expect(report.applied).toBe(true);
    expect(fs.existsSync(path.join(member, '.mcp.json'))).toBe(true);
    const server = JSON.parse(fs.readFileSync(path.join(member, '.mcp.json'), 'utf-8')) as { mcpServers: Record<string, { command: string; args: string[] }> };
    expect(server.mcpServers.wairon).toEqual({ command: 'wairon', args: ['mcp', 'serve'] });
    expect(fs.existsSync(path.join(member, '.claude', 'CLAUDE.md'))).toBe(true);
    expect(fs.existsSync(path.join(member, 'CLAUDE.md'))).toBe(true);
    expect(report.sessionScaffold).toEqual(expect.arrayContaining(['.mcp.json', '.claude/CLAUDE.md']));
    // A dry run writes no scaffold.
    const again = made();
    const dry = at(again.root, () => runMcpMigration({ verb: 'externalize', subsystem: 'analytics', path: 'parts/analytics', as: 'project' }, true));
    expect(dry.sessionScaffold).toBeUndefined();
    expect(fs.existsSync(path.join(again.member, '.mcp.json'))).toBe(false);
  });
});
