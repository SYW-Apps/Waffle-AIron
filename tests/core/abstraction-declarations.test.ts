import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { buildCodeModel } from '../../src/core/source-analysis.js';
import type { ImplementationSpec } from '../../src/models/specs.js';
import type { SourceFileFacts } from '../../src/models/index.js';
import { defineRuleFixture, runRuleFixture, type FixtureTree } from '../rules-matrix/harness.js';

// ---------------------------------------------------------------------------
// An abstraction's declaration is an interface, trait, Protocol or abstract
// class, whatever constructor, helpers or default bodies the class holds
// (type_shape_fact.declaration); an interface that extends another and an
// intersection alias read as one shape; a declaration nothing could compare is
// ABSTRACTION_DECLARATION_UNCOMPARED; two lists compare their element types.
// ---------------------------------------------------------------------------

const temps: string[] = [];
afterEach(() => {
  for (const t of temps.splice(0)) fs.rmSync(t, { recursive: true, force: true });
});

function readAll(files: Record<string, string>, entry: string): SourceFileFacts {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'abstraction-declarations-')));
  temps.push(root);
  for (const [file, text] of Object.entries(files)) {
    fs.mkdirSync(path.join(root, path.dirname(file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), text);
  }
  const impls = Object.keys(files).map((file, i) => ({ id: `impl-${i}`, contract: 'ia', sourcePath: file, methods: [] })) as unknown as ImplementationSpec[];
  const facts = buildCodeModel(impls, [], root).files.find((f) => f.path === entry);
  if (!facts) throw new Error(`no facts for ${entry}`);
  return facts;
}
const read = (file: string, text: string): SourceFileFacts => readAll({ [file]: text }, file);

describe('the declaration flag: the exact TypeScript reader', () => {
  it('is true for an interface, a type literal and an abstract class, whatever the class holds', () => {
    const facts = read('src/a.ts', [
      'export interface I { ship(order: string): string }',
      'export type T = { ship(order: string): string };',
      'export abstract class A {',
      '  constructor(private readonly name: string) {}',
      '  abstract ship(order: string): string;',
      '  protected trim(value: string): string { return value.trim(); }',
      '}',
      'export abstract class B { ship(order: string): string { return order; } }',
      '',
    ].join('\n'));
    expect(facts.typeShapes!.I.declaration).toBe(true);
    expect(facts.typeShapes!.T.declaration).toBe(true);
    expect(facts.typeShapes!.A.declaration).toBe(true);
    expect(facts.typeShapes!.B.declaration).toBe(true);
  });

  it('is false for a concrete class', () => {
    const facts = read('src/a.ts', 'export class C { ship(order: string): string { return order; } }\n');
    expect(facts.typeShapes!.C.declaration).toBeFalsy();
  });

  it('reads the members of an extended interface and of an intersection through the checker', () => {
    const facts = readAll({
      'src/animal.ts': 'export interface Animal { eat(food: string): void }\nexport interface Walker { walk(steps: number): void }\n',
      'src/dog.ts': [
        "import type { Animal, Walker } from './animal.js';",
        'export interface Dog extends Animal { bark(loud: boolean): string }',
        'export type Pup = Animal & Walker;',
        '',
      ].join('\n'),
    }, 'src/dog.ts');
    const dog = facts.typeShapes!.Dog.signatures!;
    expect(Object.keys(dog).sort()).toEqual(['bark', 'eat']);
    expect(dog.eat[0].params[0]).toMatchObject({ name: 'food', type: 'string' });
    const pup = facts.typeShapes!.Pup;
    expect(Object.keys(pup.signatures!).sort()).toEqual(['eat', 'walk']);
    expect(pup.declaration).toBe(true);
  });
});

describe('the declaration flag: the Python reader', () => {
  const ABC = 'from abc import ABC, abstractmethod\n\n\nclass Carrier(ABC):\n';
  it('reads an ABC with an __init__ and a helper as a declaration, recording every method', () => {
    const facts = read('src/carrier.py', ABC + [
      '    def __init__(self) -> None:',
      '        self.ready = True',
      '',
      '    @abstractmethod',
      '    def ship(self, order: str) -> str: ...',
      '',
      '    def trim(self, value: str) -> str:',
      '        return value.strip()',
      '',
    ].join('\n'));
    const shape = facts.typeShapes!.Carrier;
    expect(shape.declaration).toBe(true);
    expect(Object.keys(shape.signatures!).sort()).toEqual(['ship', 'trim']);
  });

  it('reads an ABC without an @abstractmethod as concrete: it declares nothing', () => {
    const facts = read('src/carrier.py', ABC + '    def ship(self, order: str) -> str:\n        return order\n');
    expect(facts.typeShapes?.Carrier).toBeUndefined();
  });

  it('reads a Protocol as a declaration', () => {
    const facts = read('src/carrier.py', 'from typing import Protocol\n\n\nclass Carrier(Protocol):\n    def ship(self, order: str) -> str: ...\n');
    expect(facts.typeShapes!.Carrier.declaration).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The rules over a tree whose abstraction is written in several ways.
// ---------------------------------------------------------------------------

const SUB = { id: 'shipping', description: 'Ships orders with a carrier.' };

function carriers(language: 'typescript' | 'python' | 'rust', files: Record<string, string>, params: { name: string; type: string }[] = [{ name: 'order', type: 'string' }], ext = 'ts'): FixtureTree {
  const method = { name: 'ship', description: 'Ship one order.', params, returns: 'string' };
  const src = (n: string): string => `src/${n}.${ext}`;
  return {
    system: { name: 'ShippingService', vision: 'Ships orders with one of several carriers.', targetLanguage: language },
    subsystems: [SUB],
    components: [
      { id: 'carrier', subsystem: SUB.id, componentType: 'Adapter', abstract: true, description: 'Ships one order.' },
      { id: 'dhl', subsystem: SUB.id, componentType: 'Adapter', description: 'Ships by DHL.' },
      { id: 'ups', subsystem: SUB.id, componentType: 'Adapter', description: 'Ships by UPS.' },
      { id: 'desk', subsystem: SUB.id, componentType: 'Orchestrator', description: 'Dispatches orders.', dependsOn: ['carrier'], invokedBy: { kind: 'runtime', caller: 'The composition root calls the desk once per order.' } },
    ],
    interfaces: [
      { id: 'icarrier', component: 'carrier', methods: [method] },
      { id: 'idhl', component: 'dhl', implements: ['carrier'], methods: [method] },
      { id: 'iups', component: 'ups', implements: ['carrier'], methods: [method] },
      { id: 'idesk', component: 'desk', methods: [{ name: 'dispatch', description: 'Dispatch one order.', params: [{ name: 'order', type: 'string' }], returns: 'string' }] },
    ],
    implementations: [
      { id: 'carrier_impl', contract: 'icarrier', sourcePath: src('carrier'), methods: [{ name: 'ship' }] },
      { id: 'dhl_impl', contract: 'idhl', sourcePath: src('dhl'), methods: [{ name: 'ship', narrative: [{ stepNumber: 1, type: 'local', description: 'Return the DHL tracking code.' }] }] },
      { id: 'ups_impl', contract: 'iups', sourcePath: src('ups'), methods: [{ name: 'ship', narrative: [{ stepNumber: 1, type: 'local', description: 'Return the UPS tracking code.' }] }] },
      { id: 'desk_impl', contract: 'idesk', sourcePath: src('desk'), methods: [{ name: 'dispatch', narrative: [{ stepNumber: 1, type: 'call', description: 'Ship with the carrier.', targetComponent: 'carrier', targetMethod: 'ship' }] }] },
    ],
    files,
  } as unknown as FixtureTree;
}

const issuesOf = (tree: FixtureTree) =>
  runRuleFixture(defineRuleFixture({ code: 'NONE', expectFire: false, reason: 'probe', scenario: 'A probe tree whose findings the test reads directly.', tree })).issues;
const codes = (tree: FixtureTree): string[] => issuesOf(tree).filter((i) => i.severity !== 'notice').map((i) => `${i.code}@${i.specId}`);
const found = (tree: FixtureTree, code: string) => issuesOf(tree).filter((i) => i.code === code);

const tsFiles = (carrier: string, kind: 'extends' | 'implements', body = true): Record<string, string> => {
  const impl = (n: string, cls: string): string => [
    "import { Carrier } from './carrier.js';", '',
    `export class ${cls} ${kind} Carrier {`,
    ...(body ? ['  ship(order: string): string {', `    return '${n}' + order;`, '  }'] : []),
    '}', '',
  ].join('\n');
  return {
    'src/carrier.ts': carrier,
    'src/dhl.ts': impl('dhl', 'Dhl'),
    'src/ups.ts': impl('ups', 'Ups'),
    'src/desk.ts': "import { Carrier } from './carrier.js';\n\nexport class Desk {\n  constructor(private readonly carrier: Carrier) {}\n\n  dispatch(order: string): string {\n    return this.carrier.ship(order);\n  }\n}\n",
  };
};
const ts = (carrier: string, kind: 'extends' | 'implements' = 'extends', body = true): FixtureTree => carriers('typescript', tsFiles(carrier, kind, body));

describe('a TypeScript abstract class as the declaration of an abstraction', () => {
  const t = (type: string): Record<string, string> => ({
    helper: `export abstract class Carrier {\n  abstract ship(order: ${type}): string;\n\n  protected trim(value: string): string {\n    return value.trim();\n  }\n}\n`,
    body: `export abstract class Carrier {\n  ship(order: ${type}): string {\n    return String(order);\n  }\n}\n`,
    ctor: `export abstract class Carrier {\n  constructor() {\n    void 0;\n  }\n\n  abstract ship(order: ${type}): string;\n}\n`,
  });
  for (const [label, key] of [['a protected helper', 'helper'], ['a default body', 'body'], ['a constructor', 'ctor']] as const) {
    it(`draws nothing when it holds ${label} and states the contract`, () => {
      expect(codes(ts(t('string')[key]))).toEqual([]);
    });
    it(`catches a drifted parameter type when it holds ${label}`, () => {
      expect(found(ts(t('number')[key]), 'PARAM_TYPE_MISMATCH').map((i) => i.specId)).toEqual(['carrier_impl']);
    });
  }

  it('leaves an implementer that relies on the inherited default body UNREALIZED_METHOD', () => {
    const tree = ts(t('string').body, 'extends', false);
    expect(found(tree, 'UNREALIZED_METHOD').map((i) => i.specId).sort()).toEqual(['dhl_impl', 'ups_impl']);
  });

  it('is promised surface: no undeclared export or public member', () => {
    const issues = issuesOf(ts(t('string').helper)).filter((i) => i.code === 'UNDECLARED_EXPORT' || i.code === 'UNDECLARED_PUBLIC_MEMBER');
    expect(issues).toEqual([]);
  });

  it('is compared on completing later', () => {
    const tree = ts('export abstract class Carrier {\n  abstract ship(order: string): Promise<string>;\n  protected trim(v: string): string { return v; }\n}\n');
    expect(found(tree, 'ASYNC_MISMATCH').map((i) => i.specId)).toContain('carrier_impl');
  });

  it('a concrete class holding the method declares nothing: the notice says so, with no mismatch', () => {
    const tree = ts('export class Carrier {\n  ship(order: number): string {\n    return String(order);\n  }\n}\n', 'extends');
    expect(found(tree, 'PARAM_TYPE_MISMATCH').filter((i) => i.specId === 'carrier_impl')).toEqual([]);
    const notice = found(tree, 'ABSTRACTION_DECLARATION_UNCOMPARED');
    expect(notice.map((i) => i.specId)).toEqual(['carrier_impl']);
    expect(notice[0].severity).toBe('notice');
  });

  it('says nothing about a declaration that was compared', () => {
    expect(found(ts('export interface Carrier {\n  ship(order: string): string;\n}\n', 'implements'), 'ABSTRACTION_DECLARATION_UNCOMPARED')).toEqual([]);
  });
});

describe('a Python abstract base class with an __init__ or a helper', () => {
  const abc = (type: string, extra: string[]): string => ['from abc import ABC, abstractmethod', '', '', 'class Carrier(ABC):', ...extra, '    @abstractmethod', `    def ship(self, order: ${type}) -> str: ...`, ''].join('\n');
  const tree = (carrier: string): FixtureTree => carriers('python', {
    'src/__init__.py': '',
    'src/carrier.py': carrier,
    'src/dhl.py': 'from .carrier import Carrier\n\n\nclass Dhl(Carrier):\n    def ship(self, order: str) -> str:\n        return "dhl" + order\n',
    'src/ups.py': 'from .carrier import Carrier\n\n\nclass Ups(Carrier):\n    def ship(self, order: str) -> str:\n        return "ups" + order\n',
    'src/desk.py': 'from .carrier import Carrier\n\n\nclass Desk:\n    def __init__(self, carrier: Carrier) -> None:\n        self._carrier = carrier\n\n    def dispatch(self, order: str) -> str:\n        return self._carrier.ship(order)\n',
  }, undefined, 'py');
  const init = ['    def __init__(self) -> None:', '        self.ready = True', ''];
  const helper = ['    def _trim(self, value: str) -> str:', '        return value.strip()', ''];
  it.each([['an __init__', init], ['a helper', helper]])('is clean with %s, and a drifted type is caught', (_n, extra) => {
    expect(codes(tree(abc('str', extra)))).toEqual([]);
    expect(found(tree(abc('int', extra)), 'PARAM_TYPE_MISMATCH').map((i) => i.specId)).toEqual(['carrier_impl']);
  });
  it('a class with no @abstractmethod is concrete: compared with nothing, the notice says so', () => {
    const concrete = 'from abc import ABC\n\n\nclass Carrier(ABC):\n    def ship(self, order: int) -> str:\n        return str(order)\n';
    const t = tree(concrete);
    expect(found(t, 'PARAM_TYPE_MISMATCH').filter((i) => i.specId === 'carrier_impl')).toEqual([]);
    expect(found(t, 'ABSTRACTION_DECLARATION_UNCOMPARED').map((i) => i.specId)).toEqual(['carrier_impl']);
  });
});

describe('a Rust trait', () => {
  it('is no member-signature reader: one notice on the abstraction, never an error', () => {
    const tree = carriers('rust', {
      'src/carrier.rs': 'pub trait Carrier {\n    fn ship(&self, order: String) -> String;\n}\n',
      'src/dhl.rs': 'use crate::carrier::Carrier;\n\npub struct Dhl;\n\nimpl Carrier for Dhl {\n    fn ship(&self, order: String) -> String {\n        order\n    }\n}\n',
      'src/ups.rs': 'use crate::carrier::Carrier;\n\npub struct Ups;\n\nimpl Carrier for Ups {\n    fn ship(&self, order: String) -> String {\n        order\n    }\n}\n',
      'src/desk.rs': 'use crate::carrier::Carrier;\n\npub struct Desk<C: Carrier> {\n    carrier: C,\n}\n\nimpl<C: Carrier> Desk<C> {\n    pub fn dispatch(&self, order: String) -> String {\n        self.carrier.ship(order)\n    }\n}\n',
    }, undefined, 'rs');
    const notice = found(tree, 'ABSTRACTION_DECLARATION_UNCOMPARED');
    expect(notice.map((i) => i.specId)).toEqual(['carrier_impl']);
    expect(notice[0].severity).toBe('notice');
  });
});

describe('two lists compare their element types', () => {
  const impl = (type: string): FixtureTree => carriers('typescript', {
    'src/carrier.ts': `export interface Carrier {\n  ship(ids: ${type}): string;\n}\n`,
    'src/dhl.ts': "import { Carrier } from './carrier.js';\n\nexport class Dhl implements Carrier {\n  ship(ids: string[]): string {\n    return ids.join(',');\n  }\n}\n",
    'src/ups.ts': "import { Carrier } from './carrier.js';\n\nexport class Ups implements Carrier {\n  ship(ids: string[]): string {\n    return ids.join(',');\n  }\n}\n",
    'src/desk.ts': "import { Carrier } from './carrier.js';\n\nexport class Desk {\n  constructor(private readonly carrier: Carrier) {}\n\n  dispatch(order: string): string {\n    return this.carrier.ship([order]);\n  }\n}\n",
  }, [{ name: 'ids', type: 'list<string>' }]);
  it('reports number[] realizing list<string>, naming both', () => {
    const issues = found(impl('number[]'), 'PARAM_TYPE_MISMATCH').filter((i) => i.specId === 'carrier_impl');
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('number[]');
    expect(issues[0].message).toContain('list<string>');
  });
  it('is quiet where the elements agree or do not read as one scalar', () => {
    expect(found(impl('string[]'), 'PARAM_TYPE_MISMATCH')).toEqual([]);
    expect(found(impl('Array<string | number>'), 'PARAM_TYPE_MISMATCH')).toEqual([]);
  });
  it('compares a Python list[int] with list<string>', () => {
    const tree = carriers('python', {
      'src/__init__.py': '',
      'src/carrier.py': 'from abc import ABC, abstractmethod\n\n\nclass Carrier(ABC):\n    @abstractmethod\n    def ship(self, ids: list[int]) -> str: ...\n',
      'src/dhl.py': 'from .carrier import Carrier\n\n\nclass Dhl(Carrier):\n    def ship(self, ids: list[str]) -> str:\n        return ",".join(ids)\n',
      'src/ups.py': 'from .carrier import Carrier\n\n\nclass Ups(Carrier):\n    def ship(self, ids: list[str]) -> str:\n        return ",".join(ids)\n',
      'src/desk.py': 'from .carrier import Carrier\n\n\nclass Desk:\n    def __init__(self, carrier: Carrier) -> None:\n        self._carrier = carrier\n\n    def dispatch(self, order: str) -> str:\n        return self._carrier.ship([order])\n',
    }, [{ name: 'ids', type: 'list<string>' }], 'py');
    expect(found(tree, 'PARAM_TYPE_MISMATCH').map((i) => i.specId)).toContain('carrier_impl');
  });
});

describe('contract symmetry on an abstract component', () => {
  it('asks no method entries of an abstraction implementation, and still reports one the contract lacks', () => {
    const tree = ts('export interface Carrier {\n  ship(order: string): string;\n}\n', 'implements');
    const bare = JSON.parse(JSON.stringify(tree)) as FixtureTree & { implementations: { id: string; methods: unknown[] }[] };
    bare.implementations.find((i) => i.id === 'carrier_impl')!.methods = [];
    expect(found(bare, 'MISSING_IMPLEMENTATION_METHOD').filter((i) => i.specId === 'carrier_impl')).toEqual([]);
    bare.implementations.find((i) => i.id === 'carrier_impl')!.methods = [{ name: 'ship' }, { name: 'extra' }];
    expect(found(bare, 'UNEXPECTED_IMPLEMENTATION_METHOD').filter((i) => i.specId === 'carrier_impl').length).toBeGreaterThan(0);
  });
});

describe('an abstraction implementation that lists no methods (linkage only)', () => {
  const bare = (type: string): FixtureTree => {
    const tree = carriers('typescript', tsFiles(`export interface Carrier {
  ship(order: ${type}): string;
}
`, 'implements'));
    (tree as unknown as { implementations: { id: string; methods: unknown[] }[] }).implementations.find((i) => i.id === 'carrier_impl')!.methods = [];
    return tree;
  };
  it('is still compared with its declaration, method by method', () => {
    expect(codes(bare('string'))).toEqual([]);
    expect(found(bare('number'), 'PARAM_TYPE_MISMATCH').map((i) => i.specId)).toEqual(['carrier_impl']);
  });
});
