import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  createScratchProject,
  authorJourneyTree,
  callTool,
  callToolOk,
  findSpecOnDisk,
  JOURNEY,
  type ScratchProject,
} from './helpers';

// ---------------------------------------------------------------------------
// Stage 1 signatures, wave 3, black-box against the BUILT server: a method
// that takes its signature from a source is authored with the source alone,
// stored with the source alone, read back in stored form with its resolved
// signature beside it, and adopted onto a method that stated its own only by
// unsetting what it stated. A source stated beside params is refused.
// ---------------------------------------------------------------------------

type DiskMethod = Record<string, unknown> & { name: string };
const methodsOnDisk = (proj: ScratchProject, id: string): DiskMethod[] =>
  ((findSpecOnDisk(proj.dir, id) as { methods?: DiskMethod[] } | null)?.methods ?? []);

describe('e2e signature sources (built server)', () => {
  let proj: ScratchProject;

  beforeAll(async () => {
    proj = await createScratchProject('signature-sources');
    await authorJourneyTree(proj.client);
  });

  afterAll(async () => {
    await proj?.cleanup();
  });

  it('defines a method by its source alone, and stores the source alone', async () => {
    await callToolOk(proj.client, 'sdd_define_interface', {
      id: JOURNEY.orchInterface,
      name: 'IJourneyOrchestrator',
      description: 'Contract for running one journey end to end',
      component: JOURNEY.orch,
      methods: [
        {
          name: 'runJourney',
          description: 'Run a single journey from validation to completion',
          returns: 'Promise<void>',
          params: [{ name: 'journeyId', type: 'string', description: 'The id of the journey to run' }],
          invokedBy: { kind: 'runtime', caller: JOURNEY.invokedByCaller },
        },
        { name: 'enrichFor', description: 'Enrich a payload for a journey, as the worker does', signatureFrom: `${JOURNEY.worker}.enrich` },
      ],
    });
    const methods = methodsOnDisk(proj, JOURNEY.orchInterface);
    expect(methods.find((m) => m.name === 'enrichFor')).toEqual({
      name: 'enrichFor', description: 'Enrich a payload for a journey, as the worker does', signatureFrom: `${JOURNEY.worker}.enrich`,
    });
    // The server derived the text of a method stated with params and no text.
    expect(methods.find((m) => m.name === 'runJourney')!.signature).toBe('runJourney(journeyId: string): Promise<void>');
  });

  it('sdd_get_spec answers the stored form, with the resolved signature beside it', async () => {
    const out = await callToolOk(proj.client, 'sdd_get_spec', { kind: 'interface', id: JOURNEY.orchInterface });
    const answer = (out.raw as { structuredContent?: any }).structuredContent;
    const enrichFor = answer.spec.methods.find((m: DiskMethod) => m.name === 'enrichFor');
    expect(enrichFor.params).toBeUndefined();
    expect(enrichFor.signatureFrom).toBe(`${JOURNEY.worker}.enrich`);
    expect(answer.resolvedSignatures).toEqual([{
      method: 'enrichFor',
      signatureFrom: `${JOURNEY.worker}.enrich`,
      signature: 'enrichFor(payload: string): Promise<string>',
      params: [{ name: 'payload', type: 'string', description: 'The raw journey payload to enrich' }],
      returns: 'Promise<string>',
    }]);
  });

  it('a contract can be re-authored from its sdd_get_spec answer as it is', async () => {
    const out = await callToolOk(proj.client, 'sdd_get_spec', { kind: 'interface', id: JOURNEY.orchInterface });
    const spec = (out.raw as { structuredContent?: any }).structuredContent.spec;
    const restated = await callTool(proj.client, 'sdd_define_interface', {
      id: spec.id, name: spec.name, description: spec.description, component: spec.component,
      methods: spec.methods.map(({ endpoint: _e, ...m }: Record<string, unknown>) => m),
    });
    expect(restated.ok, restated.text).toBe(true);
  });

  it('refuses a source stated beside params (SIGNATURE_SOURCE_RESTATED), writing nothing', async () => {
    const before = JSON.stringify(methodsOnDisk(proj, JOURNEY.orchInterface));
    const out = await callTool(proj.client, 'sdd_define_interface', {
      id: JOURNEY.orchInterface,
      name: 'IJourneyOrchestrator',
      description: 'Contract for running one journey end to end',
      component: JOURNEY.orch,
      methods: [{
        name: 'enrichFor', description: 'Enrich a payload for a journey', signatureFrom: `${JOURNEY.worker}.enrich`,
        params: [{ name: 'payload', type: 'string' }], returns: 'Promise<string>',
      }],
    });
    expect(out.ok).toBe(false);
    expect(out.text).toContain('SIGNATURE_SOURCE_RESTATED');
    expect(JSON.stringify(methodsOnDisk(proj, JOURNEY.orchInterface))).toBe(before);
  });

  it('adopting a source by delta is refused until the delta unsets the method\'s params and returns', async () => {
    // A method that restates the worker's signature, to adopt the source on.
    await callToolOk(proj.client, 'sdd_update_spec', {
      kind: 'interface', id: JOURNEY.orchInterface,
      delta: { methods: [{ name: 'enrichNow', description: 'Enrich a payload right away, as the worker does', returns: 'Promise<string>', params: [{ name: 'payload', type: 'string' }] }] },
    });
    const refused = await callTool(proj.client, 'sdd_update_spec', {
      kind: 'interface', id: JOURNEY.orchInterface,
      delta: { methods: [{ name: 'enrichNow', signatureFrom: `${JOURNEY.worker}.enrich` }] },
    });
    expect(refused.ok).toBe(false);
    expect(refused.text).toContain('SIGNATURE_SOURCE_RESTATED');

    await callToolOk(proj.client, 'sdd_update_spec', {
      kind: 'interface', id: JOURNEY.orchInterface,
      delta: { methods: [{ name: 'enrichNow', signatureFrom: `${JOURNEY.worker}.enrich`, unset: ['params', 'returns'] }] },
    });
    expect(methodsOnDisk(proj, JOURNEY.orchInterface).find((m) => m.name === 'enrichNow')).toEqual({
      name: 'enrichNow', description: 'Enrich a payload right away, as the worker does', signatureFrom: `${JOURNEY.worker}.enrich`,
    });
  });

  it('defines a signature type and a method that takes its signature from it', async () => {
    await callToolOk(proj.client, 'sdd_add_type', {
      kind: 'signature', id: 'journey_listener', name: 'JourneyListener', subsystem: JOURNEY.subsystem,
      description: 'Called once a journey completes',
      params: [{ name: 'journeyId', type: 'string' }, { name: 'note', type: 'string', optional: true }],
      returns: 'void',
    });
    const type = findSpecOnDisk(proj.dir, 'journey_listener')!;
    expect(type).toMatchObject({ kind: 'signature', returns: 'void', fields: [] });
    await callToolOk(proj.client, 'sdd_update_spec', {
      kind: 'interface', id: JOURNEY.orchInterface,
      delta: { methods: [{ name: 'onJourneyDone', description: 'Hear that a journey completed, as any listener does', signatureFrom: 'journey_listener' }] },
    });
    const out = await callToolOk(proj.client, 'sdd_get_spec', { kind: 'interface', id: JOURNEY.orchInterface, methods: ['onJourneyDone'] });
    const resolved = (out.raw as { structuredContent?: any }).structuredContent.resolvedSignatures;
    expect(resolved).toEqual([expect.objectContaining({ method: 'onJourneyDone', signature: 'onJourneyDone(journeyId: string, note?: string): void' })]);
  });

  it('defines a type method by its params, the server deriving its text', async () => {
    await callToolOk(proj.client, 'sdd_add_type', {
      kind: 'value-object', id: 'journey_ref', name: 'JourneyRef', subsystem: JOURNEY.subsystem,
      fields: [{ name: 'id', type: 'string' }],
      methods: [{ name: 'sameAs', params: [{ name: 'other', type: 'string' }], returns: 'boolean', description: 'Whether another id names this journey' }],
    });
    const type = findSpecOnDisk(proj.dir, 'journey_ref') as { methods: DiskMethod[] };
    expect(type.methods[0].signature).toBe('sameAs(other: string): boolean');
  });
});
