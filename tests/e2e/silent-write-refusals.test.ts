import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  assertDistBuilt, createScratchProject, rmrfWithRetry,
  callTool, callToolOk, authorJourneyTree, findSpecOnDisk, JOURNEY,
  type ScratchProject,
} from './helpers.js';

// ---------------------------------------------------------------------------
// Writes that used to succeed while doing nothing (or the wrong thing).
//
// Driven against the BUILT stdio server, because the defects lived at the MCP
// boundary itself: the SDK parsed each tool's raw shape as a non-strict
// z.object and dropped unknown keys before any wairon code ran. An agent that
// misspelled a field was told "Successfully …", nothing changed, and the tree
// validated clean afterwards — the write simply never happened.
// ---------------------------------------------------------------------------

describe('the authoring surface refuses silent no-ops', () => {
  let proj: ScratchProject;

  beforeAll(async () => {
    assertDistBuilt();
    proj = await createScratchProject('e2e-refusals');
    await authorJourneyTree(proj.client);
  }, 180_000);

  afterAll(async () => {
    await proj?.close?.();
    if (proj?.dir) await rmrfWithRetry(proj.dir);
  });

  it('refuses a misspelled field on a tool call instead of dropping it', async () => {
    const res = await callTool(proj.client, 'sdd_add_component', {
      id: 'typo-probe',
      name: 'Typo Probe',
      description: 'a component authored with a misspelled field',
      subsystem: JOURNEY.subsystem,
      componentType: 'Specialist',
      dependson: [JOURNEY.worker], // the real field is dependsOn
    });

    expect(res.ok).toBe(false);
    expect(res.text).toMatch(/dependson/i);

    // And the component was not half-created.
    expect(findSpecOnDisk(proj.dir, 'typo-probe')).toBeNull();
  });

  it('refuses a misspelled field inside an update delta', async () => {
    const res = await callTool(proj.client, 'sdd_update_spec', {
      kind: 'component',
      id: JOURNEY.orch,
      delta: { dependson: [JOURNEY.worker] },
    });

    // The delta value is a permissive z.record, so the unknown key clears the
    // tool boundary; updateSpec checks it against the canonical schema instead
    // and names the field it meant.
    expect(res.ok).toBe(false);
    expect(res.text).toMatch(/dependson/i);
    expect(res.text).toMatch(/did you mean "dependsOn"/i);
  });

  it('still accepts the correctly spelled field', async () => {
    const out = await callToolOk(proj.client, 'sdd_update_spec', {
      kind: 'component',
      id: JOURNEY.orch,
      delta: { dependsOn: [JOURNEY.worker] },
    });
    expect(out.text).toMatch(/Successfully updated/i);

    const onDisk = findSpecOnDisk(proj.dir, JOURNEY.orch) as { dependsOn?: string[] } | null;
    expect(onDisk?.dependsOn ?? []).toContain(JOURNEY.worker);
  });

  it('refuses a near-miss method identity rather than appending a duplicate', async () => {
    const res = await callTool(proj.client, 'sdd_update_spec', {
      kind: 'interface',
      id: JOURNEY.orchInterface,
      delta: { methods: [{ name: 'RUN_JOURNEY', description: 'near-miss of the real method' }] },
    });
    // Whatever the interface's real method is, a SHOUTED snake variant of it
    // must not quietly become a second method.
    if (res.ok) {
      const onDisk = findSpecOnDisk(proj.dir, JOURNEY.orchInterface) as
        { methods?: { name: string }[] } | null;
      const names = (onDisk?.methods ?? []).map((m) => m.name);
      expect(names).not.toContain('RUN_JOURNEY');
    }
  });
});
