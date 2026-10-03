import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  createScratchProject,
  authorJourneyTree,
  callTool,
  callToolOk,
  findSpecOnDisk,
  snapshotSpecTree,
  JOURNEY,
  type ScratchProject,
} from './helpers';

// ---------------------------------------------------------------------------
// Stage 2 type grammar, wave 3, black-box against the BUILT server: an alias
// goes in and comes back canonical, with the respelling named in the answer;
// `number` is refused with "int or float?" and writes nothing; an enum is
// authored with its values; a delta's alias is respelled and reported.
// ---------------------------------------------------------------------------

type DiskMethod = Record<string, unknown> & { name: string };
const methodsOnDisk = (proj: ScratchProject, id: string): DiskMethod[] =>
  ((findSpecOnDisk(proj.dir, id) as { methods?: DiskMethod[] } | null)?.methods ?? []);
const structured = (out: { raw?: unknown }): any => (out.raw as { structuredContent?: unknown }).structuredContent;

describe('e2e type grammar (built server)', () => {
  let proj: ScratchProject;

  beforeAll(async () => {
    proj = await createScratchProject('type-grammar');
    await authorJourneyTree(proj.client);
  });

  afterAll(async () => {
    await proj?.cleanup();
  });

  it('the journey tree written with TypeScript spellings is stored canonical', () => {
    const run = methodsOnDisk(proj, JOURNEY.orchInterface).find((m) => m.name === 'runJourney')!;
    expect(run.returns).toBe('async void');
    expect(run.signature).toBe('runJourney(journeyId: string): async void');
  });

  it('an alias goes in and comes back canonical, the receipt naming each respelling', async () => {
    const out = await callToolOk(proj.client, 'sdd_define_interface', {
      id: JOURNEY.workerInterface,
      name: 'IJourneyWorker',
      description: 'Contract for enriching journey payloads',
      component: JOURNEY.worker,
      methods: [{
        name: 'enrich',
        description: 'Enrich a raw journey payload with derived fields',
        returns: 'Promise<string | null>',
        params: [
          { name: 'payload', type: 'string', description: 'The raw journey payload to enrich' },
          { name: 'tags', type: 'string[]', optional: true },
          { name: 'strict', type: 'boolean', optional: true },
        ],
      }],
    });
    expect(structured(out).respellings).toEqual([
      { specId: JOURNEY.workerInterface, kind: 'interface', path: 'methods.enrich.params.tags', written: 'string[]', stored: 'list<string>' },
      { specId: JOURNEY.workerInterface, kind: 'interface', path: 'methods.enrich.params.strict', written: 'boolean', stored: 'bool' },
      { specId: JOURNEY.workerInterface, kind: 'interface', path: 'methods.enrich.returns', written: 'Promise<string | null>', stored: 'async string?' },
    ]);
    expect(out.text).toContain('RESPELLED');
    const enrich = methodsOnDisk(proj, JOURNEY.workerInterface)[0];
    expect(enrich.returns).toBe('async string?');
    expect(enrich.signature).toBe('enrich(payload: string, tags?: list<string>, strict?: bool): async string?');
  });

  it('`number` is refused with "int or float?", and nothing is written', async () => {
    const before = snapshotSpecTree(proj.dir);
    const out = await callTool(proj.client, 'sdd_add_type', {
      kind: 'value-object', id: 'journey-stats', name: 'JourneyStats', subsystem: JOURNEY.subsystem,
      fields: [{ name: 'count', type: 'number' }],
    });
    expect(out.ok).toBe(false);
    expect(out.text).toContain('TYPE_NOT_NEUTRAL');
    expect(out.text).toContain('int or float?');
    expect(snapshotSpecTree(proj.dir)).toEqual(before);
    expect(findSpecOnDisk(proj.dir, 'journey-stats')).toBeNull();
  });

  it('an enum is authored with its values in declared order', async () => {
    await callToolOk(proj.client, 'sdd_add_type', {
      kind: 'enum', id: 'journey-stage', name: 'JourneyStage', description: 'Where a journey stands, first to last',
      values: [{ name: 'queued', description: 'Waiting for a worker' }, { name: 'running' }, { name: 'done' }],
    });
    const stored = findSpecOnDisk(proj.dir, 'journey-stage') as { kind: string; values: { name: string }[] };
    expect(stored.kind).toBe('enum');
    expect(stored.values).toEqual([{ name: 'queued', description: 'Waiting for a worker' }, { name: 'running' }, { name: 'done' }]);
  });

  it('a delta\'s alias is stored canonical and reported; one with no canonical spelling is refused', async () => {
    const out = await callToolOk(proj.client, 'sdd_update_spec', {
      kind: 'interface', id: JOURNEY.workerInterface,
      delta: { methods: [{ name: 'enrich', params: [{ name: 'tags', type: 'Set<string>', optional: true }] }] },
    });
    expect(structured(out).respellings).toEqual([
      { specId: JOURNEY.workerInterface, kind: 'interface', path: 'methods.enrich.params.tags', written: 'Set<string>', stored: 'set<string>' },
    ]);
    expect(methodsOnDisk(proj, JOURNEY.workerInterface)[0].params).toContainEqual({ name: 'tags', type: 'set<string>', optional: true });

    const refused = await callTool(proj.client, 'sdd_update_spec', {
      kind: 'interface', id: JOURNEY.workerInterface,
      delta: { methods: [{ name: 'enrich', params: [{ name: 'strict', type: 'boolean | string', optional: true }] }] },
    });
    expect(refused.ok).toBe(false);
    expect(refused.text).toContain('TYPE_FORM_UNSUPPORTED');
  });
});
