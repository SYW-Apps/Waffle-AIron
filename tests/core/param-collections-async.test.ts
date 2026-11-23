import { describe, it, expect } from 'vitest';
import { defineRuleFixture, runRuleFixture, type FixtureTree } from '../rules-matrix/harness.js';

const issuesOf = (tree: FixtureTree) =>
  runRuleFixture(defineRuleFixture({ code: 'NONE', expectFire: false, reason: 'probe', scenario: 'A probe tree whose findings the test reads directly.', tree })).issues;
const found = (tree: FixtureTree, code: string) => {
  const r = issuesOf(tree);
  if (process.env.R2A_DBG) console.log(r.map((i) => `${i.code} ${i.specId} ${i.message.slice(0, 220)}`).join(String.fromCharCode(10)));
  return r.filter((i) => i.code === code);
};
const SUB = { id: 'notifications', description: 'Order notification delivery.' };

/** An abstraction with one implementer, in Python or TypeScript; the method is `rate(text) -> returns`. */
function tree(lang: 'python' | 'typescript', opts: { returns: string; param?: string; base: string; implementer: string; extra?: Record<string, string>; types?: unknown[] }): FixtureTree {
  const py = lang === 'python';
  const name = py ? 'rate' : 'rate';
  const method = { name, description: 'Rate one text.', params: [{ name: opts.param ? 'items' : 'text', type: opts.param ?? 'string' }], returns: opts.returns };
  const ext = py ? 'py' : 'ts';
  return {
    system: { name: 'Rating', vision: 'Rates texts through several raters.', targetLanguage: lang },
    subsystems: [SUB],
    components: [
      { id: 'text-rater', subsystem: SUB.id, componentType: 'Adapter', abstract: true, description: 'Rates one text.' },
      { id: 'fast-rater', subsystem: SUB.id, componentType: 'Adapter', description: 'Rates quickly.' },
      { id: 'rating-flow', subsystem: SUB.id, componentType: 'Orchestrator', description: 'Rates texts.', dependsOn: ['text-rater'], invokedBy: { kind: 'runtime', caller: 'The composition root calls the flow at boot.' } },
    ],
    interfaces: [
      { id: 'itext_rater', component: 'text-rater', methods: [method] },
      { id: 'ifast_rater', component: 'fast-rater', implements: ['text-rater'], methods: [method] },
      { id: 'irating_flow', component: 'rating-flow', methods: [{ name: 'run', description: 'Rate.', returns: 'async void' }] },
    ],
    implementations: [
      { id: 'text_rater_impl', contract: 'itext_rater', sourcePath: `src/text_rater.${ext}`, methods: [{ name }] },
      { id: 'fast_rater_impl', contract: 'ifast_rater', sourcePath: `src/fast_rater.${ext}`, methods: [{ name, narrative: [{ stepNumber: 1, type: 'local', description: 'Rate the text.' }] }] },
      { id: 'rating_flow_impl', contract: 'irating_flow', sourcePath: `src/rating_flow.${ext}`, methods: [{ name: 'run', narrative: [{ stepNumber: 1, type: 'call', description: 'Rate.', targetComponent: 'text-rater', targetMethod: name }] }] },
    ],
    ...(opts.types ? { types: opts.types } : {}),
    files: {
      ...(py ? { 'src/__init__.py': '' } : {}),
      [`src/text_rater.${ext}`]: opts.base,
      [`src/fast_rater.${ext}`]: opts.implementer,
      [`src/rating_flow.${ext}`]: py
        ? 'from .text_rater import TextRater\n\n\nclass RatingFlow:\n    def __init__(self, rater: TextRater) -> None:\n        self.rater = rater\n\n    async def run(self) -> None:\n        await self.rater.rate("c")\n'
        : "import type { TextRater } from './text_rater.js';\n\nexport class RatingFlow {\n  constructor(private readonly rater: TextRater) {}\n  async run(): Promise<void> { await this.rater.rate('c'); }\n}\n",
      ...(opts.extra ?? {}),
    },
  } as unknown as FixtureTree;
}

const PY_BASE = (sig: string) => `from abc import ABC, abstractmethod\nfrom typing import Awaitable, Coroutine, Any, Sequence, List, Dict, Set, Tuple\n\n\nclass TextRater(ABC):\n    @abstractmethod\n    ${sig}: ...\n`;
const PY_IMPL = (sig: string) => `from typing import Awaitable, Coroutine, Any, Sequence, List\nfrom .text_rater import TextRater\n\n\nclass FastRater(TextRater):\n    ${sig}:\n        return 1\n`;

describe('Python async', () => {
  const async_ = (impl: string, base = 'async def rate(self, text: str) -> int') => tree('python', { returns: 'async int', base: PY_BASE(base), implementer: PY_IMPL(impl) });
  it('flags an implementer that drops async', () => {
    expect(found(async_('def rate(self, text: str) -> int'), 'ASYNC_MISMATCH').map((i) => i.specId)).toEqual(['fast_rater_impl']);
  });
  it('accepts async def, and a non-async def returning Awaitable or Coroutine, on both sides', () => {
    for (const sig of ['async def rate(self, text: str) -> int', 'def rate(self, text: str) -> Awaitable[int]', 'def rate(self, text: str) -> Coroutine[Any, Any, int]']) {
      expect(found(async_(sig, sig), 'ASYNC_MISMATCH')).toEqual([]);
    }
  });
  it('flags an async def against a contract that completes now', () => {
    const t = tree('python', { returns: 'int', base: PY_BASE('def rate(self, text: str) -> int'), implementer: PY_IMPL('async def rate(self, text: str) -> int') });
    expect(found(t, 'ASYNC_MISMATCH').map((i) => i.specId)).toEqual(['fast_rater_impl']);
  });
});

describe('TypeScript async', () => {
  const ts = (decl: string, impl: string, extra = '') => tree('typescript', {
    returns: 'async int',
    base: `${extra}export interface TextRater { rate(text: string): ${decl} }\n`,
    implementer: `import type { TextRater } from './text_rater.js';\n${extra}export class FastRater implements TextRater {\n  rate(text: string): ${impl} { return Promise.resolve(text.length); }\n}\n`,
  });
  it('accepts PromiseLike', () => {
    expect(found(ts('PromiseLike<number>', 'PromiseLike<number>'), 'ASYNC_MISMATCH')).toEqual([]);
  });
  it('accepts an alias of Promise', () => {
    expect(found(ts('Promise<number>', 'Out', 'type Out = Promise<number>;\n'), 'ASYNC_MISMATCH')).toEqual([]);
  });
  it('still flags a plain number', () => {

    const t = tree('typescript', { returns: 'async int', base: 'export interface TextRater { rate(text: string): Promise<number> }\n', implementer: "import type { TextRater } from './text_rater.js';\nexport class FastRater implements TextRater {\n  rate(text: string): number { return 1; }\n}\n" });
    expect(found(t, 'ASYNC_MISMATCH').map((i) => i.specId)).toEqual(['fast_rater_impl']);
  });
});

describe('UNDECLARED_PARAM wording', () => {
  const tsImpl = (sig: string) => tree('typescript', {
    returns: 'async int',
    base: 'export interface TextRater { rate(text: string): Promise<number> }\n',
    implementer: `import type { TextRater } from './text_rater.js';\nexport class FastRater implements TextRater {\n  async rate(${sig}): Promise<number> { return 1; }\n}\n`,
  });
  const pyImpl = (sig: string) => tree('python', { returns: 'async int', base: PY_BASE('async def rate(self, text: str) -> int'), implementer: PY_IMPL(`async def rate(${sig}) -> int`) });
  it.each([
    ['TS optional', tsImpl('text: string, extra?: number')],
    ['TS default', tsImpl('text: string, extra = 0')],
    ['TS rest', tsImpl('text: string, ...more: number[]')],
    ['Python default', pyImpl('self, text: str, extra: int = 0')],
    ['Python *args', pyImpl('self, text: str, *args: int')],
    ['Python **kwargs', pyImpl('self, text: str, **kwargs: int')],
  ])('%s stays a warning and never says a caller must pass it', (_name, t) => {
    const hits = found(t, 'UNDECLARED_PARAM').filter((i) => i.specId === 'fast_rater_impl');
    expect(hits).toHaveLength(1);
    expect(hits[0].severity).toBe('warning');
    expect(hits[0].message).not.toMatch(/must/);
    expect(hits[0].message).toMatch(/never passes it/);
  });
  it('a required extra parameter keeps the must wording', () => {
    const hits = found(tsImpl('text: string, extra: number'), 'UNDECLARED_PARAM').filter((i) => i.specId === 'fast_rater_impl');
    expect(hits).toHaveLength(1);
    expect(hits[0].message).toMatch(/must supply/);
  });
});

describe('durability round trip and abstract Stores', () => {
  const store = (abstractOnly: boolean): FixtureTree => ({
    system: { name: 'Ledger', vision: 'Keeps a ledger of entries.', targetLanguage: 'typescript' },
    subsystems: [{ id: 'ledger', description: 'The ledger.' }],
    components: [
      { id: 'entry-store', subsystem: 'ledger', componentType: 'Store', abstract: true, durability: 'durable', description: 'Holds entries.' },
      { id: 'file-entry-store', subsystem: 'ledger', componentType: 'Store', durability: 'durable', description: 'Holds entries in a file.' },
    ],
    interfaces: [
      { id: 'ientry_store', component: 'entry-store', methods: [{ name: 'put', description: 'Put one.', params: [{ name: 'entry', type: 'string' }], returns: 'void' }] },
      { id: 'ifile_entry_store', component: 'file-entry-store', implements: ['entry-store'], methods: [{ name: 'put', description: 'Put one.', params: [{ name: 'entry', type: 'string' }], returns: 'void', ...(abstractOnly ? { effect: 'write' } : {}) }] },
    ],
    implementations: [],
  }) as unknown as FixtureTree;
  it('does not judge an abstract Store, and still judges its implementer', () => {
    const hits = issuesOf(store(false)).filter((i) => i.code === 'MISSING_EFFECT_TAG' || i.code === 'MISSING_HYDRATION');
    expect(hits.map((i) => i.specId)).toEqual(['file-entry-store']);
  });
});

describe('collection parameters', () => {
  const mismatches = (lang: 'python' | 'typescript', annotation: string) => {
    const py = lang === 'python';
    const t = tree(lang, {
      returns: 'void',
      param: 'list<string>',
      base: py ? PY_BASE('def rate(self, items: List[str]) -> None') : 'export interface TextRater { rate(items: string[]): void }\n',
      implementer: py
        ? PY_IMPL(`def rate(self, items: ${annotation}) -> None`).replace('return 1', 'return None')
        : `import type { TextRater } from './text_rater.js';\nexport class FastRater implements TextRater {\n  rate(items: ${annotation}): void { void items; }\n}\n`,
    });
    return found(t, 'PARAM_TYPE_MISMATCH').filter((i) => i.specId === 'fast_rater_impl').length;
  };
  it.each([
    ['typescript', 'Set<string>'], ['typescript', 'Record<string, string>'], ['typescript', '[string, string]'],
    ['typescript', 'readonly [string, string]'], ['typescript', 'Map<string, string>'], ['typescript', 'string[][]'],
    ['typescript', 'number[]'], ['typescript', 'Array<Array<string>>'],
    ['python', 'dict[str, str]'], ['python', 'tuple[str, ...]'], ['python', 'set[str]'], ['python', 'list[list[str]]'],
    ['python', 'Tuple[str, str]'], ['python', 'list[int]'],
  ] as const)('%s %s is a PARAM_TYPE_MISMATCH against list<string>', (lang, annotation) => {
    expect(mismatches(lang, annotation)).toBe(1);
  });
  it.each([
    ['typescript', 'string[]'], ['typescript', 'Array<string>'], ['typescript', 'readonly string[]'], ['typescript', 'ReadonlyArray<string>'],
    ['typescript', 'any'], ['typescript', 'unknown[]'], ['typescript', 'any[]'], ['typescript', 'unknown'],
    ['python', 'list[str]'], ['python', 'List[str]'], ['python', 'Sequence[str]'], ['python', 'Any'], ['python', 'list[Any]'],
  ] as const)('%s %s stays clean against list<string>', (lang, annotation) => {
    expect(mismatches(lang, annotation)).toBe(0);
  });
});

describe('an interface extending a base imported from another file', () => {
  it.each([['claimed', true], ['claimed by no spec', false]])('raises no UNREALIZED_METHOD for the inherited member (%s)', (_name, _claimed) => {
    const t = tree('typescript', {
      returns: 'async int',
      base: "import type { RateBase } from './rate_base.js';\nexport interface TextRater extends RateBase { reset(): void }\n",
      implementer: "import type { TextRater } from './text_rater.js';\nexport class FastRater implements TextRater {\n  async rate(text: string): Promise<number> { return text.length; }\n  reset(): void {}\n}\n",
      extra: { 'src/rate_base.ts': 'export interface RateBase { rate(text: string): Promise<number> }\n' },
    });
    expect(found(t, 'UNREALIZED_METHOD').filter((i) => i.specId === 'text_rater_impl')).toEqual([]);
  });
});

describe('collection elements that are named types the design knows', () => {
  const types = [
    { id: 'order_item', name: 'OrderItem', kind: 'value-object', sourcePath: 'src/types.ts', fields: [{ name: 'sku', type: 'string', optional: false }] },
    { id: 'shipping_label', name: 'ShippingLabel', kind: 'value-object', sourcePath: 'src/types.ts', fields: [{ name: 'bar', type: 'string', optional: false }] },
  ];
  const mismatches = (param: string, annotation: string) => {
    const t = tree('typescript', {
      returns: 'void',
      param,
      types,
      base: 'export interface TextRater { rate(items: unknown): void }\n',
      implementer: `import type { TextRater } from './text_rater.js';\nexport class FastRater implements TextRater {\n  rate(items: ${annotation}): void { void items; }\n}\n`,
      extra: { 'src/types.ts': 'export interface OrderItem { sku: string }\nexport interface ShippingLabel { bar: string }\n' },
    });
    return found(t, 'PARAM_TYPE_MISMATCH').filter((i) => i.specId === 'fast_rater_impl').length;
  };
  it.each([
    ['list<order_item>', 'ShippingLabel[]'],
    ['list<order_item>', 'string[]'],
    ['list<order_item>', 'OrderItem[][]'],
    ['list<list<order_item>>', 'OrderItem[]'],
    ['list<list<order_item>>', 'ShippingLabel[][]'],
    ['map<string, order_item>', 'Record<string, ShippingLabel>'],
    ['map<string, order_item>', 'Record<number, OrderItem>'],
  ])('%s realized by %s is a mismatch', (param, annotation) => {
    expect(mismatches(param, annotation)).toBe(1);
  });
  it.each([
    ['list<order_item>', 'OrderItem[]'],
    ['list<order_item>', 'ReadonlyArray<OrderItem>'],
    ['list<list<order_item>>', 'OrderItem[][]'],
    ['map<string, order_item>', 'Record<string, OrderItem>'],
    ['map<string, list<order_item>>', 'Record<string, OrderItem[]>'],
  ])('%s realized by %s stays clean', (param, annotation) => {
    expect(mismatches(param, annotation)).toBe(0);
  });
});
