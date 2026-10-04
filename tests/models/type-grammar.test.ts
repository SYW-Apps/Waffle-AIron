import { describe, it, expect } from 'vitest';
import {
  PRIMITIVE_TYPES,
  canonicalTypeText,
  interfaceCanonicalTypes,
  isTypeVocabulary,
  parseTypeExpression,
  parseTypePosition,
  typeCanonicalTypes,
  typeIsMany,
  typeNamedRefs,
  writtenTypeRefs,
  type TypePosition,
} from '../../src/models/type-grammar.js';
import type { StoredInterfaceSpec, StoredTypeSpec } from '../../src/models/specs.js';

// ---------------------------------------------------------------------------
// The neutral type grammar: one case per alias, per problem code and per
// position rule; canonical text is a fixed point.
// ---------------------------------------------------------------------------

/** The canonical text of a position that reads cleanly; fails the test on a problem. */
function canon(text: string, position: TypePosition = 'param', omittable = false): string {
  const parse = parseTypePosition(text, position, omittable);
  expect(parse.problem, `${text} should read cleanly`).toBeNull();
  return parse.canonical;
}

/** The problem code of a position that does not read cleanly. */
function problemOf(text: string, position: TypePosition = 'param'): string | undefined {
  return parseTypeExpression(text, position).problem?.code;
}

describe('type_expression.parse — the canonical forms', () => {
  it.each(PRIMITIVE_TYPES.filter((p) => p !== 'void'))('the primitive %s is its own canonical text', (p) => {
    expect(canon(p)).toBe(p);
  });

  it('void is a whole returns', () => {
    expect(canon('void', 'returns')).toBe('void');
    expect(canon('void', 'type-method-returns')).toBe('void');
    expect(canon('void', 'signature-returns')).toBe('void');
  });

  it.each([
    ['list<string>', 'list<string>'],
    ['set<Invoice>', 'set<Invoice>'],
    ['map<string, Invoice>', 'map<string, Invoice>'],
    ['map<int, Invoice>', 'map<int, Invoice>'],
    ['map<channel, Invoice>', 'map<channel, Invoice>'],
    ['Invoice?', 'Invoice?'],
    ['(Invoice | Receipt)?', '(Invoice | Receipt)?'],
    ['Invoice | Receipt', 'Invoice | Receipt'],
    ['list<Invoice?>', 'list<Invoice?>'],
    ['map<string, list<Invoice>>', 'map<string, list<Invoice>>'],
    ['Page<Invoice>', 'Page<Invoice>'],
    ['billing::Invoice', 'billing::Invoice'],
    ['billing.Invoice', 'billing.Invoice'],
    ['::shared::error-type', '::shared::error-type'],
    ['waffler-error', 'waffler-error'],
  ])('%s reads as %s', (written, stored) => {
    expect(canon(written)).toBe(stored);
  });

  it('whitespace is free and canonical spacing is restored', () => {
    expect(canon('map<string,Invoice>')).toBe('map<string, Invoice>');
    expect(canon('  list < Invoice >  ')).toBe('list<Invoice>');
    expect(canon('billing :: Invoice')).toBe('billing::Invoice');
    expect(canon('Invoice|Receipt')).toBe('Invoice | Receipt');
  });

  it('async prefixes a returns, void included', () => {
    expect(canon('async void', 'returns')).toBe('async void');
    expect(canon('async Invoice?', 'returns')).toBe('async Invoice?');
    expect(canon('async list<Invoice>', 'type-method-returns')).toBe('async list<Invoice>');
    expect(canon('async (A | B)?', 'signature-returns')).toBe('async (A | B)?');
  });

  it('a type named "async" on its own is a named type, not a prefix', () => {
    expect(canon('async')).toBe('async');
  });
});

describe('type_expression.parse — every alias', () => {
  it.each([
    // lists
    ['string[]', 'list<string>'],
    ['Array<string>', 'list<string>'],
    ['ReadonlyArray<string>', 'list<string>'],
    ['List<string>', 'list<string>'],
    ['vec<string>', 'list<string>'],
    ['vector<string>', 'list<string>'],
    ['string[][]', 'list<list<string>>'],
    ['(Invoice | null)[]', 'list<Invoice?>'],
    ['readonly string[]', 'list<string>'],
    // sets
    ['Set<string>', 'set<string>'],
    ['ReadonlySet<string>', 'set<string>'],
    // maps
    ['Map<string, Invoice>', 'map<string, Invoice>'],
    ['Record<string, Invoice>', 'map<string, Invoice>'],
    ['ReadonlyMap<string, Invoice>', 'map<string, Invoice>'],
    ['dict<string, Invoice>', 'map<string, Invoice>'],
    ['dictionary<string, Invoice>', 'map<string, Invoice>'],
    ['HashMap<string, Invoice>', 'map<string, Invoice>'],
    ['Record<string, Record<string, boolean>>', 'map<string, map<string, bool>>'],
    // none
    ['Invoice | null', 'Invoice?'],
    ['Invoice | undefined', 'Invoice?'],
    ['Invoice | null | undefined', 'Invoice?'],
    ['null | Invoice', 'Invoice?'],
    ['Option<Invoice>', 'Invoice?'],
    ['Optional<Invoice>', 'Invoice?'],
    ['Invoice | Receipt | null', '(Invoice | Receipt)?'],
    ['Invoice[] | null', 'list<Invoice>?'],
    // primitives
    ['boolean', 'bool'],
    ['integer', 'int'],
    ['long', 'int'],
    ...['i8', 'i16', 'i32', 'i64', 'i128', 'isize', 'u8', 'u16', 'u32', 'u64', 'u128', 'usize'].map((t) => [t, 'int']),
    ['double', 'float'],
    ['f32', 'float'],
    ['f64', 'float'],
    ['Buffer', 'bytes'],
    ['Uint8Array', 'bytes'],
    ['Date', 'datetime'],
    ['timestamp', 'datetime'],
    ['object', 'any'],
    ['unknown', 'any'],
    ['json', 'any'],
    ['Json', 'any'],
    ['str', 'string'],
    // the retired vocabulary was case-insensitive, so existing trees may spell it so
    ['String', 'string'],
    ['Boolean', 'bool'],
    ['JSON', 'any'],
  ] as [string, string][])('%s → %s', (written, stored) => {
    expect(canon(written)).toBe(stored);
  });

  it('date stays a calendar day while Date is an instant', () => {
    expect(canon('date')).toBe('date');
    expect(canon('Date')).toBe('datetime');
  });

  it('Promise<T> at the top of a returns is async T', () => {
    expect(canon('Promise<void>', 'returns')).toBe('async void');
    expect(canon('Promise<Invoice | null>', 'returns')).toBe('async Invoice?');
    expect(canon('Promise<string[]>', 'type-method-returns')).toBe('async list<string>');
    expect(canon('Promise<boolean>', 'signature-returns')).toBe('async bool');
  });

  it('any? and any | null read as any', () => {
    expect(canon('any?')).toBe('any');
    expect(canon('unknown | null')).toBe('any');
  });
});

describe('optional flag and T? collapse', () => {
  it('T | undefined on an omittable position is T: the flag already says "may be left out"', () => {
    expect(canon('Invoice | undefined', 'param', true)).toBe('Invoice');
    expect(canon('string[] | undefined', 'field', true)).toBe('list<string>');
  });

  it('T | undefined elsewhere is T?', () => {
    expect(canon('Invoice | undefined', 'param', false)).toBe('Invoice?');
    expect(canon('Invoice | undefined', 'returns')).toBe('Invoice?');
  });

  it('T | null on an omittable position keeps T?: may be left out AND may be passed as none', () => {
    expect(canon('Invoice | null', 'param', true)).toBe('Invoice?');
    expect(canon('Invoice | null | undefined', 'param', true)).toBe('Invoice?');
    expect(canon('Invoice?', 'field', true)).toBe('Invoice?');
  });

  it('the collapse applies to the whole position only, never inside it', () => {
    expect(canon('list<Invoice | undefined>', 'param', true)).toBe('list<Invoice?>');
  });
});

describe('a named scalar holds one primitive (the holds position)', () => {
  it.each(['string', 'int', 'float', 'bool', 'bytes', 'date', 'datetime', 'duration'])('holds %s', (text) => {
    expect(parseTypePosition(text, 'holds')).toMatchObject({ canonical: text, problem: null });
  });

  it('an alias is respelled, and number asks int or float', () => {
    expect(parseTypePosition('boolean', 'holds')).toMatchObject({ canonical: 'bool', problem: null });
    expect(problemOf('number', 'holds')).toBe('TYPE_NOT_NEUTRAL');
  });

  it.each(['any', 'void', 'Invoice', 'string?', 'list<string>', 'map<string, int>', 'Invoice | Refund'])('%s is not a holdable primitive', (text) => {
    expect(problemOf(text, 'holds')).toBe('TYPE_POSITION_INVALID');
  });
});

describe('position rules (TYPE_POSITION_INVALID)', () => {
  it.each([
    ['void', 'param'],
    ['void', 'field'],
    ['void', 'type-method-param'],
    ['void', 'signature-param'],
    ['list<void>', 'returns'],
    ['void | Invoice', 'returns'],
    ['void?', 'returns'],
    ['void | null', 'returns'],
  ] as [string, TypePosition][])('%s in a %s', (text, position) => {
    expect(problemOf(text, position)).toBe('TYPE_POSITION_INVALID');
  });

  it.each(['param', 'field', 'type-method-param', 'signature-param'] as TypePosition[])('async is refused in a %s', (position) => {
    expect(problemOf('async Invoice', position)).toBe('TYPE_POSITION_INVALID');
    expect(problemOf('Promise<Invoice>', position)).toBe('TYPE_POSITION_INVALID');
  });

  it('async stands only at the top of a returns', () => {
    expect(problemOf('list<Promise<Invoice>>', 'returns')).toBe('TYPE_POSITION_INVALID');
    expect(problemOf('Promise<Invoice> | null', 'returns')).toBe('TYPE_POSITION_INVALID');
    expect(problemOf('Promise<Promise<Invoice>>', 'returns')).toBe('TYPE_POSITION_INVALID');
  });

  it.each(['map<bool, X>', 'map<float, X>', 'map<list<string>, X>', 'Map<any, X>', 'map<string?, X>'])('a map key must be string, int or an enum: %s', (text) => {
    expect(problemOf(text)).toBe('TYPE_POSITION_INVALID');
  });

  it('T?? is refused', () => {
    expect(problemOf('Invoice??')).toBe('TYPE_POSITION_INVALID');
    expect(problemOf('Option<Invoice>?')).toBe('TYPE_POSITION_INVALID');
  });
});

describe('forms the grammar leaves out (TYPE_FORM_UNSUPPORTED)', () => {
  it.each([
    ['{ a: string }', 'a named value-object'],
    ['(a: string) => void', 'a signature type'],
    ["'global' | 'local'", 'an enum type naming the values'],
    ['"a" | "b"', 'an enum type naming the values'],
    ['1 | 2', 'an enum type naming the values'],
    ['true', 'bool, or an enum type naming the values'],
    ['A & B', 'a named type'],
    ['[string, int]', 'a named value-object'],
    ['Partial<Invoice>', 'a named type'],
    ['Pick<Invoice, Id>', 'a named type'],
    ['keyof Invoice', 'a named type'],
    ['PackSelection | string', 'a named type (an entity, value-object or enum), or two params'],
    ['bool | float', 'a named type (an entity, value-object or enum), or two params'],
    ['(string | number)[]', 'a named type (an entity, value-object or enum), or two params'],
    ['Invoice | list<Invoice>', 'a named type (an entity, value-object or enum), or two params'],
  ])('%s names its replacement', (text, replacement) => {
    const parse = parseTypeExpression(text, 'param');
    expect(parse.problem?.code).toBe('TYPE_FORM_UNSUPPORTED');
    expect(parse.problem?.replacement).toBe(replacement);
    expect(parse.expression).toBeNull();
    expect(parse.canonical).toBe(text);
  });
});

describe('names with no neutral meaning (TYPE_NOT_NEUTRAL)', () => {
  it('number asks "int or float?" and still reads, as float', () => {
    const parse = parseTypeExpression('number', 'param');
    expect(parse.problem?.code).toBe('TYPE_NOT_NEUTRAL');
    expect(parse.problem?.detail).toContain('int or float?');
    expect(parse.problem?.replacement).toBe('int or float');
    expect(parse.expression).toEqual({ form: 'primitive', name: 'float', args: [] });
  });

  it('number keeps its own problem as a map key', () => {
    expect(problemOf('Record<number, string>')).toBe('TYPE_NOT_NEUTRAL');
  });

  it.each(['uuid', 'decimal', 'char', 'byte', 'time', 'tuple', 'result', 'error', 'never', 'box', 'arc', 'rc', 'ref', 'cell', 'refcell', 'mutex', 'rwlock', 'std', 'mcpserver', 'McpServer', 'UUID'])('%s is reported, read as any, with a replacement', (name) => {
    const parse = parseTypeExpression(name, 'param');
    expect(parse.problem?.code).toBe('TYPE_NOT_NEUTRAL');
    expect(parse.problem?.replacement).toBeTruthy();
    expect(parse.expression).toEqual({ form: 'primitive', name: 'any', args: [] });
  });

  it('a legacy generic is reported too', () => {
    expect(problemOf('Result<Invoice, Error>', 'returns')).toBe('TYPE_NOT_NEUTRAL');
    expect(problemOf('Box<Invoice>')).toBe('TYPE_NOT_NEUTRAL');
  });
});

describe('texts that do not parse (TYPE_EXPRESSION_INVALID)', () => {
  it.each([
    '',
    '   ',
    'Invoice — absent when unknown',
    'Invoice // a comment',
    'Invoice (or nothing)',
    'list<Invoice',
    'list<>',
    'Invoice Receipt',
    'Map<string>',
    'list<string, int>',
    'string<int>',
    'null',
    'undefined',
    'null | undefined',
    'list',
    'Array',
    'Promise',
    'a * b',
  ])('%j', (text) => {
    const parse = parseTypeExpression(text, 'returns');
    expect(parse.problem?.code).toBe('TYPE_EXPRESSION_INVALID');
    expect(parse.expression).toBeNull();
    expect(parse.canonical).toBe(text);
  });
});

describe('canonical text is a fixed point', () => {
  const WRITTEN: [string, TypePosition][] = [
    ['string[]', 'param'], ['Promise<Invoice[] | null>', 'returns'], ['Record<string, Set<boolean>>', 'field'],
    ['Invoice | Receipt | undefined', 'returns'], ['Option<Page<Invoice>>', 'param'], ['Promise<void>', 'returns'],
    ['(A | B)[] | null', 'field'], ['Map<string, (A | B)[]>', 'param'], ['billing::Invoice | null', 'returns'],
    ['Promise<Map<string, Invoice | null>>', 'returns'],
  ];
  it.each(WRITTEN)('%s re-reads as itself once canonical', (written, position) => {
    const once = canon(written, position);
    expect(canon(once, position)).toBe(once);
    expect(parseTypeExpression(once, position).expression).toEqual(parseTypeExpression(written, position).expression);
  });
});

describe('namedRefs and isMany', () => {
  it.each([
    ['string', []],
    ['Invoice', ['Invoice']],
    ['list<Invoice>', ['Invoice']],
    ['map<string, Invoice?>', ['Invoice']],
    ['Invoice | Receipt', ['Invoice', 'Receipt']],
    ['Page<Invoice>', ['Page', 'Invoice']],
    ['async list<billing::Invoice>', ['billing::Invoice']],
    ['map<Invoice, Invoice>', ['Invoice', 'Invoice']],
  ] as [string, string[]][])('%s names %j', (text, refs) => {
    expect(typeNamedRefs(parseTypeExpression(text, 'returns').expression!)).toEqual(refs);
  });

  it.each([
    ['list<Invoice>', true], ['set<Invoice>', true], ['map<string, Invoice>', true],
    ['list<Invoice>?', true], ['async set<Invoice>', true],
    ['Invoice', false], ['Invoice?', false], ['string', false], ['Page<Invoice>', false],
  ] as [string, boolean][])('isMany(%s) is %s', (text, many) => {
    expect(typeIsMany(parseTypeExpression(text, 'returns').expression!)).toBe(many);
  });

  it('writtenTypeRefs keeps the references of an unsupported form, and a text that does not parse names nothing', () => {
    expect(writtenTypeRefs('PackSelection | string', 'param')).toEqual(['PackSelection']);
    expect(writtenTypeRefs('(e: ChangeEvent) => Ack', 'field')).toEqual(['ChangeEvent', 'Ack']);
    expect(writtenTypeRefs('{ a: Invoice }', 'field')).toEqual(['Invoice']);
    expect(writtenTypeRefs('Invoice — trailing prose', 'field')).toEqual([]);
    expect(writtenTypeRefs('Invoice[] | null', 'field')).toEqual(['Invoice']);
  });

  it('isTypeVocabulary covers the primitives, the aliases and the legacy names, ignoring case', () => {
    for (const name of ['string', 'boolean', 'Promise', 'record', 'null', 'undefined', 'number', 'uuid', 'mcpserver', 'list', 'HashMap']) {
      expect(isTypeVocabulary(name), name).toBe(true);
    }
    expect(isTypeVocabulary('Invoice')).toBe(false);
  });

  it('canonicalTypeText wears parentheses only around an optional union', () => {
    expect(canonicalTypeText({ form: 'optional', args: [{ form: 'union', args: [{ form: 'named', name: 'A', args: [] }, { form: 'named', name: 'B', args: [] }] }] })).toBe('(A | B)?');
  });
});

describe('interface_spec.canonicalTypes and type_spec.canonicalTypes', () => {
  const stamp = { createdAt: '2026-10-04T00:00:00.000Z', updatedAt: '2026-10-04T00:00:00.000Z' };

  it('respells every structured position of a contract, records each, and leaves a problem as written', () => {
    const intf = {
      id: 'ibilling', name: 'IBilling', description: 'd', component: 'billing', status: 'complete', ...stamp,
      methods: [
        { name: 'save', description: 'd', params: [{ name: 'lines', type: 'Line[]' }, { name: 'note', type: 'string | undefined', optional: true }], returns: 'Promise<void>' },
        { name: 'find', description: 'd', signature: 'find(id: string[]): Invoice | null', returns: 'Invoice | null' },
        { name: 'count', description: 'd', params: [{ name: 'limit', type: 'number' }], returns: 'number' },
        { name: 'sourced', description: 'd', signatureFrom: 'billing.save' },
      ],
    } as unknown as StoredInterfaceSpec;
    const before = JSON.stringify(intf);
    const result = interfaceCanonicalTypes(intf);
    expect(JSON.stringify(intf)).toBe(before);
    const [save, find, count, sourced] = result.spec.methods;
    expect(save.params).toEqual([{ name: 'lines', type: 'list<Line>' }, { name: 'note', type: 'string', optional: true }]);
    expect(save.returns).toBe('async void');
    // A prose method keeps its prose; only its returns is read.
    expect(find.signature).toBe('find(id: string[]): Invoice | null');
    expect(find.returns).toBe('Invoice?');
    expect(count.params![0].type).toBe('number');
    expect(count.returns).toBe('number');
    expect(sourced).toEqual(intf.methods[3]);
    expect(result.respellings).toEqual([
      { specId: 'ibilling', kind: 'interface', path: 'methods.save.params.lines', written: 'Line[]', stored: 'list<Line>' },
      { specId: 'ibilling', kind: 'interface', path: 'methods.save.params.note', written: 'string | undefined', stored: 'string' },
      { specId: 'ibilling', kind: 'interface', path: 'methods.save.returns', written: 'Promise<void>', stored: 'async void' },
      { specId: 'ibilling', kind: 'interface', path: 'methods.find.returns', written: 'Invoice | null', stored: 'Invoice?' },
    ]);
    expect(result.problems.map((p) => [p.code, p.path, p.specId, p.kind])).toEqual([
      ['TYPE_NOT_NEUTRAL', 'methods.count.params.limit', 'ibilling', 'interface'],
      ['TYPE_NOT_NEUTRAL', 'methods.count.returns', 'ibilling', 'interface'],
    ]);
  });

  it('reads a type\'s fields, methods and a signature\'s params and returns at their own positions', () => {
    const type = {
      kind: 'value-object', id: 'invoice', name: 'Invoice', ...stamp,
      fields: [
        { name: 'lines', type: 'Line[]', optional: false },
        { name: 'paidAt', type: 'Date | undefined', optional: true },
        { name: 'onChange', type: '(e: Event) => void', optional: false },
      ],
      methods: [
        { name: 'total', params: [{ name: 'tax', type: 'boolean' }], returns: 'Promise<number>' },
        { name: 'label', signature: 'label(): string', returns: 'string' },
      ],
    } as unknown as StoredTypeSpec;
    const result = typeCanonicalTypes(type);
    expect(result.spec.fields.map((f) => f.type)).toEqual(['list<Line>', 'datetime', '(e: Event) => void']);
    expect(result.spec.methods[0].params![0].type).toBe('bool');
    // async Promise<number> holds a number: the whole position is left as written.
    expect(result.spec.methods[0].returns).toBe('Promise<number>');
    expect(result.problems.map((p) => [p.code, p.path])).toEqual([
      ['TYPE_FORM_UNSUPPORTED', 'fields.onChange'],
      ['TYPE_NOT_NEUTRAL', 'methods.total.returns'],
    ]);

    const signature = {
      kind: 'signature', id: 'listener', name: 'Listener', ...stamp, fields: [], methods: [],
      params: [{ name: 'event', type: 'ChangeEvent | null' }], returns: 'Promise<void>',
    } as unknown as StoredTypeSpec;
    const sig = typeCanonicalTypes(signature);
    expect(sig.spec.params).toEqual([{ name: 'event', type: 'ChangeEvent?' }]);
    expect(sig.spec.returns).toBe('async void');
    expect(sig.respellings.map((r) => r.path)).toEqual(['params.event', 'returns']);
  });

  it("reads a named scalar's holds at its own position, respelling an alias", () => {
    const scalar = { kind: 'value-object', id: 'pack_path', name: 'PackPath', ...stamp, fields: [], methods: [], holds: 'String' } as unknown as StoredTypeSpec;
    const result = typeCanonicalTypes(scalar);
    expect(result.spec.holds).toBe('string');
    expect(result.respellings).toEqual([{ specId: 'pack_path', kind: 'type', path: 'holds', written: 'String', stored: 'string' }]);
    expect(result.problems).toEqual([]);
  });

  it('an enum holds no type positions to read', () => {
    const enumType = { kind: 'enum', id: 'channel', name: 'Channel', ...stamp, fields: [], methods: [], values: [{ name: 'stable' }] } as unknown as StoredTypeSpec;
    const result = typeCanonicalTypes(enumType);
    expect(result.respellings).toEqual([]);
    expect(result.problems).toEqual([]);
    expect(result.spec.values).toEqual([{ name: 'stable' }]);
  });
});
