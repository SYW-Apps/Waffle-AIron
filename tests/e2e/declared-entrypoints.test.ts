import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  createScratchProject,
  callToolOk,
  findSpecOnDisk,
  type ScratchProject,
} from './helpers';

// ---------------------------------------------------------------------------
// Regression tier for this week's feature + incident class: declared
// entrypoints (interface `invokedBy`) and `register` narrative steps written
// through the BUILT server must land on disk verbatim. A long-lived server
// running an older dist silently STRIPPED newly-added schema fields on write —
// the tool answered "Successfully defined" while the YAML lost the field.
// These assertions read the YAML itself, so that failure mode is loud here.
// ---------------------------------------------------------------------------

const RICH_CALLER =
  'An upstream billing platform outside this project calls this endpoint whenever a nightly reconciliation batch completes.';

describe('e2e declared entrypoints (invokedBy + register, disk-verbatim)', () => {
  let proj: ScratchProject;

  beforeAll(async () => {
    proj = await createScratchProject('declared-entrypoints');
    const { client } = proj;
    await callToolOk(client, 'sdd_initialize_system', {
      name: 'EntrypointSystem',
      vision: 'Declared-entrypoint regression journey over the built server',
      targetLanguage: 'typescript',
    });
    await callToolOk(client, 'sdd_add_subsystem', {
      id: 'svc',
      name: 'Service',
      description: 'Bounded context for the declared-entrypoint journey',
    });
    await callToolOk(client, 'sdd_add_component', {
      id: 'svc-sink',
      name: 'Service Sink',
      description: 'Specialist draining buffered work',
      subsystem: 'svc',
      componentType: 'Specialist',
    });
    await callToolOk(client, 'sdd_add_component', {
      id: 'svc-worker',
      name: 'Service Worker',
      description: 'Specialist doing the periodic work',
      subsystem: 'svc',
      componentType: 'Specialist',
      dependsOn: ['svc-sink'],
    });
    await callToolOk(client, 'sdd_define_interface', {
      id: 'isvc-sink',
      name: 'IServiceSink',
      description: 'Sink contract',
      component: 'svc-sink',
      methods: [
        {
          name: 'flush',
          description: 'Flush the buffered work to its destination',
          signature: 'flush(): Promise<void>',
          returns: 'Promise<void>',
        },
      ],
    });
    await callToolOk(client, 'sdd_define_interface', {
      id: 'isvc-worker',
      name: 'IServiceWorker',
      description: 'Worker contract',
      component: 'svc-worker',
      methods: [
        {
          name: 'tick',
          description: 'Run one work cycle',
          signature: 'tick(): Promise<void>',
          returns: 'Promise<void>',
          invokedBy: { kind: 'external', caller: RICH_CALLER },
        },
      ],
    });
    await callToolOk(client, 'sdd_write_narrative', {
      id: 'svc-worker-impl',
      name: 'Service Worker Impl',
      description: 'The work cycle',
      contract: 'isvc-worker',
      methods: [
        {
          name: 'tick',
          narrative: [
            { description: 'Hand the sink flush to the runtime as the drain callback', type: 'register', targetComponent: 'svc-sink', targetMethod: 'flush' },
            { description: 'Cycle complete', type: 'return', outcome: 'success' },
          ],
        },
      ],
    });
  });

  afterAll(async () => {
    await proj?.cleanup();
  });

  it('invokedBy kind AND caller land on disk verbatim (the stale-server regression)', () => {
    const intf = findSpecOnDisk(proj.dir, 'isvc-worker');
    expect(intf, 'worker interface not found on disk').not.toBeNull();
    const tick = (intf!['methods'] as Array<Record<string, unknown>>).find((m) => m['name'] === 'tick');
    expect(tick, 'tick method missing from the on-disk interface').toBeDefined();
    // THE assertion: the newly-vocabulary field is present and untouched. An
    // older-dist server strips it silently while still answering success.
    expect(tick!['invokedBy']).toEqual({ kind: 'external', caller: RICH_CALLER });
  });

  it('the register step lands on disk with type and targets intact', () => {
    const impl = findSpecOnDisk(proj.dir, 'svc-worker-impl');
    expect(impl, 'worker implementation not found on disk').not.toBeNull();
    const tick = (impl!['methods'] as Array<{ name: string; narrative: Array<Record<string, unknown>> }>)
      .find((m) => m.name === 'tick');
    expect(tick).toBeDefined();
    const register = tick!.narrative[0];
    expect(register['type']).toBe('register');
    expect(register['targetComponent']).toBe('svc-sink');
    expect(register['targetMethod']).toBe('flush');
  });

  it('validate: the declared entrypoint seeds reachability — no UNUSED_METHOD, no register error', async () => {
    const out = await callToolOk(proj.client, 'sdd_validate_tree', {});
    const report = out.json as {
      errors: Array<{ code: string; message: string }>;
      warnings: Array<{ code: string; message: string }>;
    };
    expect(report.errors, JSON.stringify(report.errors, null, 2)).toEqual([]);

    const unusedMethodWarnings = report.warnings.filter((w) => w.code === 'UNUSED_METHOD');
    // The invokedBy-declared method itself is an entrypoint...
    expect(unusedMethodWarnings.filter((w) => w.message.includes('"tick"'))).toEqual([]);
    // ...and reachability follows the register edge to the handed-off callback.
    expect(unusedMethodWarnings.filter((w) => w.message.includes('"flush"'))).toEqual([]);
    // The rich prose passes the intent floor — no INVOKED_BY_UNDESCRIBED here.
    expect(report.warnings.filter((w) => w.code === 'INVOKED_BY_UNDESCRIBED')).toEqual([]);
  });

  it('a placeholder-thin caller ("timer") draws INVOKED_BY_UNDESCRIBED', async () => {
    const { client } = proj;
    await callToolOk(client, 'sdd_add_component', {
      id: 'svc-cron',
      name: 'Service Cron',
      description: 'Specialist woken by a timer',
      subsystem: 'svc',
      componentType: 'Specialist',
    });
    await callToolOk(client, 'sdd_define_interface', {
      id: 'isvc-cron',
      name: 'IServiceCron',
      description: 'Cron contract',
      component: 'svc-cron',
      methods: [
        {
          name: 'poke',
          description: 'Wake up and look for due work',
          signature: 'poke(): Promise<void>',
          returns: 'Promise<void>',
          invokedBy: { kind: 'runtime', caller: 'timer' },
        },
      ],
    });

    const out = await callToolOk(client, 'sdd_validate_tree', {});
    const report = out.json as {
      warnings: Array<{ code: string; message: string; specId?: string }>;
    };
    const undescribed = report.warnings.filter((w) => w.code === 'INVOKED_BY_UNDESCRIBED');
    expect(undescribed.length, JSON.stringify(report.warnings, null, 2)).toBeGreaterThan(0);
    expect(undescribed.some((w) => w.message.includes('poke') || w.specId === 'isvc-cron')).toBe(true);
    // The thin caller stub itself still lands on disk verbatim.
    const intf = findSpecOnDisk(proj.dir, 'isvc-cron');
    const poke = (intf!['methods'] as Array<Record<string, unknown>>).find((m) => m['name'] === 'poke');
    expect(poke!['invokedBy']).toEqual({ kind: 'runtime', caller: 'timer' });
  });
});
