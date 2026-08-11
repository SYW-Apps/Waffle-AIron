import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  createScratchProject,
  authorJourneyTree,
  callToolOk,
  findSpecOnDisk,
  JOURNEY,
  type ScratchProject,
} from './helpers';

// ---------------------------------------------------------------------------
// The full agent authoring flow, black-box: a REAL built server
// (node dist/cli/index.js mcp serve) spawned against an empty scratch project,
// driven through actual MCP stdio exactly as an agent session would drive it —
// initialize → subsystem → components → interfaces → narratives → validate →
// status → live agent brief. Both halves of the contract are asserted: the
// tool results AND the YAML that lands in .wai/specs on disk.
// ---------------------------------------------------------------------------

describe('e2e authoring journey (built server, empty project)', () => {
  let proj: ScratchProject;

  beforeAll(async () => {
    proj = await createScratchProject('authoring-journey');
    await authorJourneyTree(proj.client);
  });

  afterAll(async () => {
    await proj?.cleanup();
  });

  it('sdd_validate_tree reports zero errors on the authored tree', async () => {
    const out = await callToolOk(proj.client, 'sdd_validate_tree', {});
    const report = out.json as { valid: boolean; errors: unknown[]; warnings: unknown[] };
    expect(report.errors, JSON.stringify(report.errors, null, 2)).toEqual([]);
    // Warnings are tolerated — but nothing of severity error may hide among them.
    for (const w of report.warnings as Array<{ severity?: string }>) {
      expect(w.severity ?? 'warning').not.toBe('error');
    }
  });

  it('sdd_get_status reflects the subsystem and its components', async () => {
    const out = await callToolOk(proj.client, 'sdd_get_status', {});
    expect(out.text).toContain(JOURNEY.subsystem);
    expect(out.text).toContain(JOURNEY.orch);
    expect(out.text).toContain(JOURNEY.worker);
  });

  it('sdd_get_agent_brief composes a live brief for the architect', async () => {
    const out = await callToolOk(proj.client, 'sdd_get_agent_brief', { agentId: 'system-architect' });
    const brief = out.json as { agentId: string; instructions: string; ownedPaths: string[] };
    expect(brief.agentId).toBe('system-architect');
    expect(brief.ownedPaths).toContain('.wai/specs/**');
    expect(typeof brief.instructions).toBe('string');
    expect(brief.instructions.length).toBeGreaterThan(0);
  });

  it('sdd_get_agent_brief composes a live brief for the subsystem owner', async () => {
    const out = await callToolOk(proj.client, 'sdd_get_agent_brief', { agentId: `${JOURNEY.subsystem}-owner` });
    const brief = out.json as { agentId: string; domainRoot?: string; instructions: string };
    expect(brief.agentId).toBe(`${JOURNEY.subsystem}-owner`);
    expect(brief.domainRoot).toBe(JOURNEY.subsystem);
    expect(brief.instructions.length).toBeGreaterThan(0);
  });

  it('the subsystem and components landed on disk with their key fields intact', () => {
    const sub = findSpecOnDisk(proj.dir, JOURNEY.subsystem);
    expect(sub, 'subsystem spec not found on disk').not.toBeNull();
    expect(sub!['name']).toBe('Journey');

    const worker = findSpecOnDisk(proj.dir, JOURNEY.worker);
    expect(worker, 'worker component spec not found on disk').not.toBeNull();
    expect(worker!['componentType']).toBe('Specialist');
    expect(worker!['subsystem']).toBe(JOURNEY.subsystem);

    const orch = findSpecOnDisk(proj.dir, JOURNEY.orch);
    expect(orch, 'orchestrator component spec not found on disk').not.toBeNull();
    expect(orch!['componentType']).toBe('Orchestrator');
    expect(orch!['dependsOn']).toEqual([JOURNEY.worker]);
  });

  it('the interfaces landed on disk with structured params exactly as authored', () => {
    const workerIntf = findSpecOnDisk(proj.dir, JOURNEY.workerInterface);
    expect(workerIntf, 'worker interface not found on disk').not.toBeNull();
    const enrich = (workerIntf!['methods'] as Array<Record<string, unknown>>).find((m) => m['name'] === 'enrich');
    expect(enrich).toBeDefined();
    expect(enrich!['returns']).toBe('Promise<string>');
    expect(enrich!['params']).toEqual([
      { name: 'payload', type: 'string', description: 'The raw journey payload to enrich' },
    ]);

    const orchIntf = findSpecOnDisk(proj.dir, JOURNEY.orchInterface);
    expect(orchIntf, 'orchestrator interface not found on disk').not.toBeNull();
    const run = (orchIntf!['methods'] as Array<Record<string, unknown>>).find((m) => m['name'] === 'runJourney');
    expect(run).toBeDefined();
    expect(run!['params']).toEqual([
      { name: 'journeyId', type: 'string', description: 'The id of the journey to run' },
    ]);
  });

  it('the narratives landed on disk with step types and call targets intact', () => {
    const orchImpl = findSpecOnDisk(proj.dir, JOURNEY.orchImpl);
    expect(orchImpl, 'orchestrator implementation not found on disk').not.toBeNull();
    expect(orchImpl!['contract']).toBe(JOURNEY.orchInterface);
    const methods = orchImpl!['methods'] as Array<{ name: string; narrative: Array<Record<string, unknown>> }>;
    const run = methods.find((m) => m.name === 'runJourney');
    expect(run).toBeDefined();
    expect(run!.narrative.map((s) => s['type'])).toEqual(['local', 'call', 'return']);
    const call = run!.narrative[1];
    expect(call['targetComponent']).toBe(JOURNEY.worker);
    expect(call['targetMethod']).toBe('enrich');

    const workerImpl = findSpecOnDisk(proj.dir, JOURNEY.workerImpl);
    expect(workerImpl, 'worker implementation not found on disk').not.toBeNull();
    const enrich = (workerImpl!['methods'] as Array<{ name: string; narrative: Array<Record<string, unknown>> }>)
      .find((m) => m.name === 'enrich');
    expect(enrich).toBeDefined();
    expect(enrich!.narrative.map((s) => s['type'])).toEqual(['local', 'return']);
  });
});
