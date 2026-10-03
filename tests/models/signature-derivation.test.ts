import { describe, it, expect } from 'vitest';
import {
  InterfaceSpecSchema,
  MethodSignatureSchema,
  TypeSpecSchema,
  deriveMethodSignature,
  deriveTypeSignature,
  methodTypeRefs,
  signatureTypeRefs,
  storedMethodSignature,
  storedTypeMethod,
} from '../../src/models/index.js';

// ---------------------------------------------------------------------------
// Stage 1 signatures, wave 1: the derived text, the stored form, and the
// stored-vs-resolved schema split (docs/design/generic-design-model/
// stage-1-signatures.md D1, D2, D4, D9, D10).
// ---------------------------------------------------------------------------

const STAMP = '2026-10-03T00:00:00.000Z';

describe('method_signature.derivedSignature — the text params determine', () => {
  it('writes each param as `name: type` in declared order, then the returns', () => {
    expect(deriveMethodSignature({
      name: 'commitScoped',
      params: [{ name: 'message', type: 'string' }, { name: 'subpaths', type: 'string[]' }],
      returns: 'Promise<void>',
    })).toBe('commitScoped(message: string, subpaths: string[]): Promise<void>');
  });

  it('marks an optional param with `?` after its name', () => {
    expect(deriveMethodSignature({
      name: 'find',
      params: [{ name: 'id', type: 'string' }, { name: 'opts', type: 'FindOptions', optional: true }],
      returns: 'Invoice | null',
    })).toBe('find(id: string, opts?: FindOptions): Invoice | null');
  });

  it('keeps the types exactly as the params write them (no normalisation)', () => {
    expect(deriveMethodSignature({
      name: 'map',
      params: [{ name: 'entries', type: 'Map<string,  billing::Invoice | null>' }],
      returns: 'void',
    })).toBe('map(entries: Map<string,  billing::Invoice | null>): void');
  });

  it('derives `name(): R` for an empty params list', () => {
    expect(deriveMethodSignature({ name: 'snapshot', params: [], returns: 'Map<string, string>' })).toBe('snapshot(): Map<string, string>');
  });

  it('is undefined for a method without params, whose prose is its signature', () => {
    expect(deriveMethodSignature({ name: 'run', returns: 'void', signature: 'run(anything goes)' })).toBeUndefined();
  });

  it('carries over a generic list the stored text opens with', () => {
    expect(deriveMethodSignature({
      name: 'find',
      signature: 'find<T extends Entity<K>, K>(id: K): T',
      params: [{ name: 'id', type: 'K' }],
      returns: 'T',
    })).toBe('find<T extends Entity<K>, K>(id: K): T');
  });

  it('carries no generic list from a stored text naming another method, or one with no parameter list after it', () => {
    expect(deriveMethodSignature({ name: 'find', signature: 'other<T>(x: T): T', params: [], returns: 'T' })).toBe('find(): T');
    expect(deriveMethodSignature({ name: 'find', signature: 'find<T> later', params: [], returns: 'T' })).toBe('find(): T');
  });
});

describe('type_spec.derivedSignature — a signature type\'s text', () => {
  it('is the method form without a name', () => {
    expect(deriveTypeSignature({
      kind: 'signature',
      params: [{ name: 'event', type: 'ChangeEvent' }, { name: 'ctx', type: 'Context', optional: true }],
      returns: 'void',
    })).toBe('(event: ChangeEvent, ctx?: Context): void');
  });

  it('is undefined on an entity or a value-object', () => {
    expect(deriveTypeSignature({ kind: 'entity', params: [{ name: 'x', type: 'string' }], returns: 'void' })).toBeUndefined();
    expect(deriveTypeSignature({ kind: 'value-object' })).toBeUndefined();
  });
});

describe('method_signature.storedForm — what every save writes', () => {
  it('keeps only the source of a sourced method, dropping params, returns and signature', () => {
    const stored = storedMethodSignature({
      name: 'run', description: 'Run it', signatureFrom: 'engine.run',
      signature: 'run(values: Values): void', returns: 'void', params: [{ name: 'values', type: 'Values' }],
      guarantees: ['idempotent'],
    });
    expect(stored).toEqual({ name: 'run', description: 'Run it', signatureFrom: 'engine.run', guarantees: ['idempotent'] });
  });

  it('replaces a params-bearing method\'s text with the derived one', () => {
    const stored = storedMethodSignature({
      name: 'commitScoped', description: 'Commit', signature: 'commitScoped(subpaths, message)', returns: 'void',
      params: [{ name: 'message', type: 'string' }, { name: 'subpaths', type: 'string[]', optional: true }],
    });
    expect(stored.signature).toBe('commitScoped(message: string, subpaths?: string[]): void');
  });

  it('returns a prose method as it is', () => {
    const method = { name: 'run', description: 'Run', signature: 'run(whatever): void', returns: 'void' };
    expect(storedMethodSignature(method)).toBe(method);
  });

  it('derives a type method\'s text from its params, and leaves a prose one alone', () => {
    expect(storedTypeMethod({ name: 'matches', signature: 'stale', params: [{ name: 'ref', type: 'string' }], returns: 'boolean' }).signature)
      .toBe('matches(ref: string): boolean');
    const prose = { name: 'qualifiedId', signature: 'qualifiedId(): string', returns: 'string' };
    expect(storedTypeMethod(prose)).toBe(prose);
  });
});

describe('the stored method schema', () => {
  const method = (over: Record<string, unknown>): Record<string, unknown> => ({ name: 'run', description: 'Run it', ...over });
  const contract = (methods: Record<string, unknown>[]): Record<string, unknown> => ({
    id: 'iengine', name: 'iengine', description: 'd', component: 'engine', methods, createdAt: STAMP, updatedAt: STAMP,
  });

  it('accepts a sourced method stating nothing else', () => {
    expect(InterfaceSpecSchema.safeParse(contract([method({ signatureFrom: 'engine.run' })])).success).toBe(true);
  });

  it('accepts a params-bearing method without a stored text', () => {
    expect(InterfaceSpecSchema.safeParse(contract([method({ params: [], returns: 'void' })])).success).toBe(true);
  });

  it('still parses a sourced method that restates params (the source wins at load; the rule reports it)', () => {
    expect(InterfaceSpecSchema.safeParse(contract([method({ signatureFrom: 'engine.run', params: [], returns: 'void' })])).success).toBe(true);
  });

  it('refuses a method without a source and without returns', () => {
    const result = InterfaceSpecSchema.safeParse(contract([method({ signature: 'run(): void' })]));
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain('returns');
  });

  it('refuses a method stating neither params, a source nor a prose signature', () => {
    const result = InterfaceSpecSchema.safeParse(contract([method({ returns: 'void' })]));
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain('signature');
  });

  it('keeps the method object\'s shape readable field by field (the MCP coverage suite reads it)', () => {
    expect(Object.keys(MethodSignatureSchema.shape)).toEqual(expect.arrayContaining(['signature', 'returns', 'params', 'signatureFrom']));
  });
});

describe('the type kinds and type-method params', () => {
  const type = (over: Record<string, unknown>): Record<string, unknown> => ({
    kind: 'value-object', id: 't', name: 't', fields: [], methods: [], createdAt: STAMP, updatedAt: STAMP, ...over,
  });

  it('parses a signature type with params and returns, and no fields', () => {
    const parsed = TypeSpecSchema.parse(type({
      kind: 'signature', fields: undefined, params: [{ name: 'event', type: 'ChangeEvent' }], returns: 'void',
    }));
    expect(parsed.kind).toBe('signature');
    expect(parsed.fields).toEqual([]);
    expect(parsed.params).toEqual([{ name: 'event', type: 'ChangeEvent' }]);
  });

  it('parses a type method with params and no stored text, and refuses one with neither', () => {
    expect(TypeSpecSchema.safeParse(type({ methods: [{ name: 'm', params: [{ name: 'x', type: 'string' }], returns: 'boolean' }] })).success).toBe(true);
    expect(TypeSpecSchema.safeParse(type({ methods: [{ name: 'm', returns: 'boolean' }] })).success).toBe(false);
  });

  it('reads a type method\'s params as its type references', () => {
    expect(methodTypeRefs({ params: [{ name: 'ref', type: 'billing.Invoice' }], returns: 'boolean' })).toEqual(['billing.Invoice', 'boolean']);
  });

  it('reads a signature type\'s params and returns as its type references, and none from a data type', () => {
    expect(signatureTypeRefs({ kind: 'signature', params: [{ name: 'e', type: 'ChangeEvent' }, { name: 'c', type: 'Context' }], returns: 'Result<Ack>' }))
      .toEqual(['ChangeEvent', 'Context', 'Result', 'Ack']);
    expect(signatureTypeRefs({ kind: 'entity', params: [{ name: 'e', type: 'ChangeEvent' }] })).toEqual([]);
  });

  it('reads nothing from a stored sourced method, which states no text and no returns', () => {
    expect(methodTypeRefs({})).toEqual([]);
  });
});
