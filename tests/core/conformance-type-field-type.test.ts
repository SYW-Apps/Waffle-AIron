/**
 * type-shape, TYPE_FIELD_TYPE_MISMATCH: a field present on both sides whose code
 * annotation reads as another scalar than the spec's, in TypeScript and Python.
 * Honest spellings stay silent, and an annotation either side does not read as
 * one scalar is not compared.
 */
import { describe, expect, it } from 'vitest';
import { defineRuleFixture, runRuleFixture, type FixtureTree } from '../rules-matrix/harness.js';

type SpecField = { name: string; type: string; optional?: boolean };

function tree(python: boolean, fields: SpecField[], code: string, extraTypes: Record<string, unknown>[] = []): FixtureTree {
  const ext = python ? 'py' : 'ts';
  const deskFile = python ? 'src/orders/desk.py' : 'src/orders/desk.ts';
  const modelFile = python ? 'src/orders/models.py' : 'src/orders/models.ts';
  return {
    system: { targetLanguage: python ? 'python' : 'typescript' },
    subsystems: [{ id: 'ordering', description: 'Takes and answers orders.' }],
    components: [{ id: 'order-desk', componentType: 'Orchestrator', description: 'Takes orders.', invokedBy: { kind: 'entry', caller: 'the shop' } }],
    interfaces: [{ id: 'iorder_desk', component: 'order-desk', methods: [{ name: 'take', description: 'Take an order.', signature: 'take(): void', returns: 'void', params: [] }] }],
    implementations: [{ id: 'order_desk_impl', contract: 'iorder_desk', sourcePath: deskFile, methods: [{ name: 'take', detail: 'intent', narrative: [], intent: 'Takes an order; it never fails.' }] }],
    types: [
      { id: 'order', name: 'Order', kind: 'value-object', sourcePath: modelFile, fields: fields.map(f => ({ optional: false, ...f })) },
      ...extraTypes,
    ],
    files: {
      ...(python ? { 'src/orders/__init__.py': '' } : {}),
      [deskFile]: python ? 'def take() -> None:\n    pass\n' : 'export function take(): void {}\n',
      [modelFile]: code,
    },
  } as unknown as FixtureTree;
}

function mismatches(t: FixtureTree): string[] {
  const run = runRuleFixture(defineRuleFixture({ code: 'TYPE_FIELD_TYPE_MISMATCH', expectFire: false, reason: 'probe', scenario: 'A service whose data the gate reads.', tree: t }));
  return run.issues.filter(i => i.code === 'TYPE_FIELD_TYPE_MISMATCH').map(i => i.message);
}

const tsShape = (...lines: string[]): string => ['export interface Order {', ...lines.map(l => `  ${l}`), '}', ''].join('\n');
const pyDataclass = (...lines: string[]): string => ['from dataclasses import dataclass', 'from typing import Optional', '', '', '@dataclass', 'class Order:', ...lines.map(l => `    ${l}`), ''].join('\n');

describe('TYPE_FIELD_TYPE_MISMATCH in TypeScript', () => {
  it('fires for a number where the spec declares a string, naming both types', () => {
    const found = mismatches(tree(false, [{ name: 'orderId', type: 'string' }], tsShape('orderId: number;')));
    expect(found).toHaveLength(1);
    expect(found[0]).toContain('"orderId"');
    expect(found[0]).toContain('string');
    expect(found[0]).toContain('number');
  });
  it('fires for a string where the spec declares an int', () => {
    expect(mismatches(tree(false, [{ name: 'count', type: 'int' }], tsShape('count: string;')))).toHaveLength(1);
  });
  it('fires for a boolean where the spec declares a string, and names every field', () => {
    const found = mismatches(tree(false, [{ name: 'a', type: 'string' }, { name: 'b', type: 'int' }], tsShape('a: boolean;', 'b: string;')));
    expect(found).toHaveLength(1);
    expect(found[0]).toContain('"a"');
    expect(found[0]).toContain('"b"');
  });
  it('is quiet for honest spellings: number for int and float, Date or string for a datetime, string for a duration', () => {
    const t = tree(false, [
      { name: 'quantity', type: 'int' },
      { name: 'amount', type: 'float' },
      { name: 'createdAt', type: 'datetime' },
      { name: 'shippedAt', type: 'datetime' },
      { name: 'placedOn', type: 'date' },
      { name: 'ttl', type: 'duration' },
      { name: 'ttlMs', type: 'duration' },
      { name: 'paid', type: 'bool' },
    ], tsShape('quantity: number;', 'amount: number;', 'createdAt: Date;', 'shippedAt: string;', 'placedOn: string;', 'ttl: string;', 'ttlMs: number;', 'paid: boolean;'));
    expect(mismatches(t)).toEqual([]);
  });
  it('compares an optional field on the type it holds', () => {
    expect(mismatches(tree(false, [{ name: 'note', type: 'string', optional: true }], tsShape('note?: string;')))).toEqual([]);
    expect(mismatches(tree(false, [{ name: 'note', type: 'string', optional: true }], tsShape('note?: number;')))).toHaveLength(1);
  });
  it('is quiet for a union, a list, a record, any, and a named type the design does not know', () => {
    const t = tree(false, [
      { name: 'a', type: 'string' }, { name: 'b', type: 'string' }, { name: 'c', type: 'string' }, { name: 'd', type: 'string' }, { name: 'e', type: 'string' },
    ], tsShape('a: number | string;', 'b: string[];', 'c: Record<string, string>;', 'd: any;', 'e: Currency;'));
    expect(mismatches(t)).toEqual([]);
  });
  it('is quiet where the spec declares a list or a named type the code spells differently', () => {
    expect(mismatches(tree(false, [{ name: 'tags', type: 'list<string>' }, { name: 'price', type: 'money' }], tsShape('tags: number;', 'price: string;')))).toEqual([]);
  });
  it('reads a named scalar as what it holds and an enum as a string', () => {
    const extra = [
      { id: 'order-ref', name: 'OrderRef', kind: 'value-object', holds: 'string', sourcePath: 'src/orders/models.ts' },
      { id: 'order-state', name: 'OrderState', kind: 'enum', sourcePath: 'src/orders/models.ts', values: [{ name: 'open' }, { name: 'closed' }] },
    ];
    const code = ['export type OrderRef = string;', "export type OrderState = 'open' | 'closed';", tsShape('ref: string;', 'state: string;', 'wrong: number;')].join('\n');
    const t = tree(false, [{ name: 'ref', type: 'order-ref' }, { name: 'state', type: 'order-state' }, { name: 'wrong', type: 'order-ref' }], code, extra);
    const found = mismatches(t);
    expect(found).toHaveLength(1);
    expect(found[0]).toContain('"wrong"');
    expect(found[0]).not.toContain('"ref"');
    expect(found[0]).not.toContain('"state"');
  });
  it('reads a constructor parameter property as a field', () => {
    const code = ['export class Order {', '  constructor(public readonly amount: string) {}', '}', ''].join('\n');
    expect(mismatches(tree(false, [{ name: 'amount', type: 'float' }], code))).toHaveLength(1);
  });
});

describe('TYPE_FIELD_TYPE_MISMATCH in Python', () => {
  it('fires for a str where the spec declares an int, naming both types', () => {
    const found = mismatches(tree(true, [{ name: 'count', type: 'int' }], pyDataclass('count: str')));
    expect(found).toHaveLength(1);
    expect(found[0]).toContain('"count"');
    expect(found[0]).toContain('int');
    expect(found[0]).toContain('str');
  });
  it('fires for an int where the spec declares a string, matching names by nameKey', () => {
    expect(mismatches(tree(true, [{ name: 'orderId', type: 'string' }], pyDataclass('order_id: int')))).toHaveLength(1);
  });
  it('is quiet for honest spellings: int, float, str, bool, Optional[int] for int?, a datetime for a datetime', () => {
    const t = tree(true, [
      { name: 'count', type: 'int' },
      { name: 'amount', type: 'float' },
      { name: 'label', type: 'string' },
      { name: 'paid', type: 'bool' },
      { name: 'limit', type: 'int', optional: true },
      { name: 'createdAt', type: 'datetime' },
    ], ['from dataclasses import dataclass', 'from datetime import datetime', 'from typing import Optional', '', '', '@dataclass', 'class Order:', '    count: int', '    amount: float', '    label: str', '    paid: bool', '    limit: Optional[int] = None', '    created_at: datetime', ''].join('\n'));
    expect(mismatches(t)).toEqual([]);
  });
  it('compares Optional[str] on the type it holds', () => {
    expect(mismatches(tree(true, [{ name: 'note', type: 'int', optional: true }], pyDataclass('note: Optional[str] = None')))).toHaveLength(1);
  });
  it('is quiet for a union, a list, a dict, Any and a named type the design does not know', () => {
    const code = ['from dataclasses import dataclass', 'from typing import Any, Union', '', '', '@dataclass', 'class Order:', '    a: Union[int, str]', '    b: list[str]', '    c: dict[str, str]', '    d: Any', '    e: Currency', ''].join('\n');
    const t = tree(true, ['a', 'b', 'c', 'd', 'e'].map(name => ({ name, type: 'string' })), code);
    expect(mismatches(t)).toEqual([]);
  });
  it('reads a Pydantic model and a TypedDict (NotRequired read through)', () => {
    const pydantic = ['from pydantic import BaseModel', '', '', 'class Order(BaseModel):', '    count: str', ''].join('\n');
    expect(mismatches(tree(true, [{ name: 'count', type: 'int' }], pydantic))).toHaveLength(1);
    const typed = ['from typing import NotRequired, TypedDict', '', '', 'class Order(TypedDict):', '    count: int', '    note: NotRequired[int]', ''].join('\n');
    const found = mismatches(tree(true, [{ name: 'count', type: 'int' }, { name: 'note', type: 'string', optional: true }], typed));
    expect(found).toHaveLength(1);
    expect(found[0]).toContain('"note"');
    expect(found[0]).not.toContain('"count"');
  });
});
