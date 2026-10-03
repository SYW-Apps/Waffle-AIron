import { describe, it, expect } from 'vitest';
import { resolveTree } from '../../src/core/signature-sources.js';
import type { ComponentSpec, InterfaceSpec, MethodSignature, TypeSpec } from '../../src/models/index.js';

// ---------------------------------------------------------------------------
// signature_resolver.resolveTree (stage 1 signatures, wave 2): a signatureFrom
// read BOTH ways, exactly one reading deciding it; never a refusal, every
// problem a fact; the specs handed in never mutated.
// ---------------------------------------------------------------------------

const STAMP = '2026-10-03T00:00:00.000Z';

const component = (id: string, over: Partial<ComponentSpec> = {}): ComponentSpec => ({
  id, name: id, description: 'd', subsystem: 'core', componentType: 'Orchestrator',
  owns: [], dependsOn: [], status: 'complete', createdAt: STAMP, updatedAt: STAMP, ...over,
} as ComponentSpec);

const contract = (comp: string, methods: Partial<MethodSignature>[]): InterfaceSpec => ({
  id: `i${comp}`,
  name: `i${comp}`, description: 'd', component: comp, status: 'complete', createdAt: STAMP, updatedAt: STAMP,
  methods: methods.map((m) => ({ name: 'm', description: 'd', ...m })) as MethodSignature[],
});

const signatureType = (id: string, over: Partial<TypeSpec> = {}): TypeSpec => ({
  kind: 'signature', id, name: id, fields: [], methods: [], params: [{ name: 'event', type: 'ChangeEvent' }],
  returns: 'void', createdAt: STAMP, updatedAt: STAMP, ...over,
} as TypeSpec);

const RUN = {
  name: 'run', description: 'Run the engine', signature: 'run(values: Values, mode?: Mode): Result',
  params: [{ name: 'values', type: 'Values' }, { name: 'mode', type: 'Mode', optional: true }], returns: 'Result',
};

describe('a method source `component.method`', () => {
  const components = [component('portal', { dependsOn: ['engine'] }), component('engine')];

  it('puts the source\'s params and returns on the method, and derives its text under its own name', () => {
    const result = resolveTree([
      contract('portal', [{ name: 'execute', signatureFrom: 'engine.run' }]),
      contract('engine', [RUN]),
    ], components, []);
    const execute = result.interfaces[0].methods[0];
    expect(execute.params).toEqual(RUN.params);
    expect(execute.returns).toBe('Result');
    expect(execute.signature).toBe('execute(values: Values, mode?: Mode): Result');
    expect(execute.signatureFrom).toBe('engine.run');
    expect(result.facts.sources).toEqual([{
      interfaceId: 'iportal', component: 'portal', method: 'execute', source: 'engine.run',
      form: 'method', target: 'engine.run', outcome: 'resolved',
    }]);
  });

  it('resolves a source off the dependsOn/owns edges all the same — the resolver judges no edge', () => {
    const result = resolveTree([
      contract('portal', [{ name: 'execute', signatureFrom: 'engine.run' }]),
      contract('engine', [RUN]),
    ], [component('portal'), component('engine')], []);
    expect(result.interfaces[0].methods[0].params).toEqual(RUN.params);
    expect(result.facts.sources[0].outcome).toBe('resolved');
  });

  it('binds a head keyed under the owning interface\'s project (`alias::component` bound by the scan)', () => {
    const result = resolveTree([
      { ...contract('app::shell', [{ name: 'execute', signatureFrom: 'core::engine.run' }]), id: 'app::ishell' },
      { ...contract('core::engine', [RUN]), id: 'core::iengine' },
    ], [component('app::shell'), component('core::engine')], []);
    expect(result.interfaces[0].methods[0].params).toEqual(RUN.params);
    expect(result.facts.sources[0]).toMatchObject({ form: 'method', target: 'core::engine.run', outcome: 'resolved' });
  });

  it('binds a bare head inside a member project to that project\'s component', () => {
    const result = resolveTree([
      { ...contract('core::portal', [{ name: 'execute', signatureFrom: 'engine.run' }]), id: 'core::iportal' },
      { ...contract('core::engine', [RUN]), id: 'core::iengine' },
    ], [component('core::portal'), component('core::engine')], []);
    expect(result.facts.sources[0]).toMatchObject({ target: 'core::engine.run', outcome: 'resolved' });
  });
});

describe('a signature type source', () => {
  it('puts the signature\'s params and returns on the method', () => {
    const result = resolveTree(
      [contract('portal', [{ name: 'onChange', signatureFrom: 'change_listener' }])],
      [component('portal')],
      [signatureType('change_listener', { subsystem: 'billing' })],
    );
    const method = result.interfaces[0].methods[0];
    expect(method.signature).toBe('onChange(event: ChangeEvent): void');
    expect(result.facts.sources[0]).toMatchObject({ form: 'signature', target: 'billing::change_listener', outcome: 'resolved' });
  });

  it('matches a qualified reference as every type reference is matched', () => {
    const result = resolveTree(
      [contract('portal', [{ name: 'onChange', signatureFrom: 'billing.change_listener' }])],
      [component('portal')],
      [signatureType('change_listener', { subsystem: 'billing' })],
    );
    expect(result.facts.sources[0].outcome).toBe('resolved');
  });
});

describe('a source that does not decide', () => {
  it('is ambiguous when the value names both a method and a signature type, naming both candidates', () => {
    const result = resolveTree(
      [contract('portal', [{ name: 'execute', signatureFrom: 'engine.run' }]), contract('engine', [RUN])],
      [component('portal'), component('engine')],
      [signatureType('run', { subsystem: 'engine' })],
    );
    const method = result.interfaces[0].methods[0];
    expect(method.params).toBeUndefined();
    expect(method.returns).toBe('unknown');
    expect(result.facts.sources).toEqual([expect.objectContaining({
      outcome: 'ambiguous', candidates: ['engine.run', 'engine::run'],
    })]);
    expect(result.facts.sources[0].form).toBeUndefined();
  });

  it('is unresolved when neither reading finds anything, the method left without params', () => {
    const result = resolveTree([contract('portal', [{ name: 'execute', signatureFrom: 'nowhere.run' }])], [component('portal')], []);
    expect(result.interfaces[0].methods[0]).toMatchObject({ returns: 'unknown', signature: 'execute(...): unknown' });
    expect(result.interfaces[0].methods[0].params).toBeUndefined();
    expect(result.facts.sources[0]).toMatchObject({ outcome: 'unresolved' });
  });

  it('is unresolved when the value names a data type, and says what kind it found', () => {
    const result = resolveTree(
      [contract('portal', [{ name: 'execute', signatureFrom: 'invoice' }])],
      [component('portal')],
      [{ ...signatureType('invoice'), kind: 'entity' } as TypeSpec],
    );
    expect(result.facts.sources[0].outcome).toBe('unresolved');
    expect(result.facts.sources[0].detail).toContain('kind entity');
  });

  it('is unresolved when the component exists but declares no such method', () => {
    const result = resolveTree(
      [contract('portal', [{ name: 'execute', signatureFrom: 'engine.missing' }]), contract('engine', [RUN])],
      [component('portal'), component('engine')], [],
    );
    expect(result.facts.sources[0].outcome).toBe('unresolved');
  });

  it('is chained when the source names a source of its own, which is never followed', () => {
    const result = resolveTree([
      contract('portal', [{ name: 'execute', signatureFrom: 'facade.run' }]),
      contract('facade', [{ name: 'run', signatureFrom: 'change_listener' }]),
    ], [component('portal'), component('facade')], [signatureType('change_listener')]);
    const execute = result.interfaces[0].methods[0];
    expect(execute.params).toBeUndefined();
    expect(execute.returns).toBe('unknown');
    const chained = result.facts.sources.find((f) => f.method === 'execute');
    // The finding names the source's own source — here a signature type the method could name directly.
    expect(chained).toMatchObject({ outcome: 'chained', target: 'facade.run', detail: 'change_listener' });
    // The facade itself resolves: its source is a signature type.
    expect(result.interfaces[1].methods[0].signature).toBe('run(event: ChangeEvent): void');
  });
});

describe('a stored method that restates its source', () => {
  const components = [component('portal'), component('engine')];

  it('records an equal restatement as not differing; the source\'s params are in force', () => {
    const result = resolveTree([
      contract('portal', [{ name: 'execute', signatureFrom: 'engine.run', params: RUN.params, returns: 'Result' }]),
      contract('engine', [RUN]),
    ], components, []);
    expect(result.facts.sources.map((f) => f.outcome)).toEqual(['restated', 'resolved']);
    expect(result.facts.sources[0]).toMatchObject({ differs: false });
  });

  it('records a differing restatement, and the source still wins', () => {
    const result = resolveTree([
      contract('portal', [{ name: 'execute', signatureFrom: 'engine.run', params: [{ name: 'mode', type: 'Mode' }, { name: 'values', type: 'Values' }], returns: 'Result' }]),
      contract('engine', [RUN]),
    ], components, []);
    expect(result.facts.sources[0]).toMatchObject({ outcome: 'restated', differs: true });
    expect(result.interfaces[0].methods[0].params).toEqual(RUN.params);
  });

  it('compares the optional marker and the returns too', () => {
    const optional = resolveTree([
      contract('portal', [{ name: 'execute', signatureFrom: 'engine.run', params: [{ name: 'values', type: 'Values' }, { name: 'mode', type: 'Mode' }] }]),
      contract('engine', [RUN]),
    ], components, []);
    expect(optional.facts.sources[0]).toMatchObject({ differs: true });
    const returns = resolveTree([
      contract('portal', [{ name: 'execute', signatureFrom: 'engine.run', returns: 'void' }]),
      contract('engine', [RUN]),
    ], components, []);
    expect(returns.facts.sources[0]).toMatchObject({ outcome: 'restated', differs: true });
    expect(returns.facts.sources[0].detail).toContain('"void"');
  });
});

describe('derived texts and stale texts', () => {
  it('derives every params-bearing method\'s text and records a stored text that differed', () => {
    const result = resolveTree(
      [contract('engine', [{ ...RUN, signature: 'run(mode, values): Result' }, { name: 'prose', signature: 'prose(anything): void', returns: 'void' }])],
      [component('engine')],
      [],
    );
    expect(result.interfaces[0].methods[0].signature).toBe('run(values: Values, mode?: Mode): Result');
    expect(result.interfaces[0].methods[1].signature).toBe('prose(anything): void');
    expect(result.facts.staleTexts).toEqual([{
      specId: 'iengine', kind: 'interface', method: 'run',
      stored: 'run(mode, values): Result', derived: 'run(values: Values, mode?: Mode): Result',
    }]);
  });

  it('reports only the `?` markers when that is all that differs', () => {
    const result = resolveTree([contract('engine', [{ ...RUN, signature: 'run(values: Values, mode: Mode): Result' }])], [component('engine')], []);
    expect(result.facts.staleTexts).toHaveLength(1);
  });

  it('records nothing for a params-bearing method that stores no text at all', () => {
    const { signature: _omit, ...unstored } = RUN;
    const result = resolveTree([contract('engine', [unstored])], [component('engine')], []);
    expect(result.interfaces[0].methods[0].signature).toBe('run(values: Values, mode?: Mode): Result');
    expect(result.facts.staleTexts).toEqual([]);
  });

  it('derives a type method\'s text from its params, recording a stale stored one', () => {
    const result = resolveTree([], [], [{
      kind: 'value-object', id: 'ref', name: 'ref', fields: [], createdAt: STAMP, updatedAt: STAMP,
      methods: [{ name: 'matches', signature: 'matches(x)', params: [{ name: 'ref', type: 'string' }], returns: 'boolean' }],
    } as TypeSpec]);
    expect(result.types[0].methods[0].signature).toBe('matches(ref: string): boolean');
    expect(result.facts.staleTexts).toEqual([expect.objectContaining({ specId: 'ref', kind: 'type', method: 'matches' })]);
  });

  it('never mutates the specs it is handed', () => {
    const portal = contract('portal', [{ name: 'execute', signatureFrom: 'engine.run' }]);
    const engine = contract('engine', [{ ...RUN, signature: 'stale' }]);
    const before = JSON.stringify([portal, engine]);
    resolveTree([portal, engine], [component('portal'), component('engine')], []);
    expect(JSON.stringify([portal, engine])).toBe(before);
  });
});
