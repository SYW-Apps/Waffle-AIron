import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  createScratchProject,
  callTool,
  callToolOk,
  findSpecOnDisk,
  snapshotSpecTree,
  type ScratchProject,
} from './helpers';

// ---------------------------------------------------------------------------
// Agent-mistake journeys against the BUILT server: every refusal must be clean
// (a legible error naming the offending value) AND leave the spec tree
// byte-identical — no partial writes, no half-created specs. The refusal
// channel is normalized by callTool (isError result vs thrown InvalidParams),
// so assertions target message content, never formatting.
// ---------------------------------------------------------------------------

/** Assert two spec-tree snapshots are byte-identical, file by file. */
function expectTreeUnchanged(before: Map<string, string>, after: Map<string, string>): void {
  expect([...after.keys()].sort()).toEqual([...before.keys()].sort());
  for (const [rel, bytes] of before) {
    expect(after.get(rel), `spec file changed by a refused write: ${rel}`).toBe(bytes);
  }
}

describe('e2e failure paths (clean refusal, no partial write)', () => {
  let proj: ScratchProject;

  beforeAll(async () => {
    proj = await createScratchProject('failure-paths');
    const { client } = proj;
    await callToolOk(client, 'sdd_initialize_system', {
      name: 'FailurePathSystem',
      vision: 'Agent-mistake journeys over the built server',
      targetLanguage: 'typescript',
    });
    await callToolOk(client, 'sdd_add_subsystem', {
      id: 'fp',
      name: 'FailurePaths',
      description: 'Bounded context for refusal journeys',
    });
    await callToolOk(client, 'sdd_add_component', {
      id: 'fp-comp',
      name: 'FP Component',
      description: 'Specialist used as the refusal target',
      subsystem: 'fp',
      componentType: 'Specialist',
    });
    await callToolOk(client, 'sdd_define_interface', {
      id: 'ifp-comp',
      name: 'IFPComponent',
      description: 'Contract of the refusal target',
      component: 'fp-comp',
      methods: [
        {
          name: 'run',
          description: 'Do the work once',
          signature: 'run(): Promise<void>',
          returns: 'Promise<void>',
        },
      ],
    });
    // A valid narrative FIRST, so the invalid re-authoring attempt below has an
    // existing on-disk implementation spec to (not) clobber.
    await callToolOk(client, 'sdd_write_narrative', {
      id: 'fp-comp-impl',
      name: 'FP Component Impl',
      description: 'The valid baseline narrative',
      contract: 'ifp-comp',
      methods: [
        {
          name: 'run',
          narrative: [
            { description: 'Do the work', type: 'local' },
            { description: 'Done', type: 'return', outcome: 'success' },
          ],
        },
      ],
    });
  });

  afterAll(async () => {
    await proj?.cleanup();
  });

  it('rejects a narrative step with an invalid type and leaves the impl byte-identical', async () => {
    const before = snapshotSpecTree(proj.dir);

    const out = await callTool(proj.client, 'sdd_write_narrative', {
      id: 'fp-comp-impl',
      name: 'FP Component Impl',
      description: 'Attempted rewrite with a bogus step type',
      contract: 'ifp-comp',
      methods: [
        {
          name: 'run',
          narrative: [
            { description: 'This step type does not exist', type: 'invoke' },
          ],
        },
      ],
    });

    expect(out.ok).toBe(false);
    // The refusal names the offending value and reads as an enum violation.
    expect(out.text).toContain('invoke');
    expect(out.text.toLowerCase()).toMatch(/invalid|enum|expected/);

    expectTreeUnchanged(before, snapshotSpecTree(proj.dir));
  });

  it('rejects an interface for a nonexistent component and creates nothing on disk', async () => {
    const before = snapshotSpecTree(proj.dir);

    const out = await callTool(proj.client, 'sdd_define_interface', {
      id: 'ifp-ghost',
      name: 'IGhost',
      description: 'Contract pointed at a component that does not exist',
      component: 'ghost-component',
      methods: [
        {
          name: 'haunt',
          description: 'Never lands',
          signature: 'haunt(): Promise<void>',
          returns: 'Promise<void>',
        },
      ],
    });

    expect(out.ok).toBe(false);
    expect(out.text).toContain('ghost-component');

    expect(findSpecOnDisk(proj.dir, 'ifp-ghost')).toBeNull();
    expectTreeUnchanged(before, snapshotSpecTree(proj.dir));
  });

  it('rejects a component with an invalid componentType and creates nothing on disk', async () => {
    const before = snapshotSpecTree(proj.dir);

    const out = await callTool(proj.client, 'sdd_add_component', {
      id: 'fp-manager',
      name: 'FP Manager',
      description: 'Generic-suffix stereotype that the vocabulary refuses',
      subsystem: 'fp',
      componentType: 'Manager',
    });

    expect(out.ok).toBe(false);
    expect(out.text.toLowerCase()).toMatch(/invalid|enum|expected/);

    expect(findSpecOnDisk(proj.dir, 'fp-manager')).toBeNull();
    expectTreeUnchanged(before, snapshotSpecTree(proj.dir));
  });
});
